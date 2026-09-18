'use strict';
/**
 * remote-mcp relay —— 自建版的「云端·闭源」那一层。
 *
 * 多租户形态下对外有四个面，**每个面的身份要求不同**：
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │ /api/mcp-info · /device/start · /device/poll      免鉴权             │
 *   │   device 进程用的。device flow 本来就是给"没有浏览器的设备"设计的，  │
 *   │   安全性来自 device_code(256bit) + PKCE + 短有效期 + 批准页必须登录。│
 *   │                                                                      │
 *   │ /mcp · /t/<token>/mcp                    Bearer 个人访问令牌         │
 *   │   AI 客户端入口。令牌 → 租户，tools/call 只路由到该租户的设备。      │
 *   │                                                                      │
 *   │ /login /signup /console /device /logout     浏览器会话 cookie        │
 *   │   人用的。批准设备、签发令牌都在这里，所以必须登录。                 │
 *   │                                                                      │
 *   │ /admin · /api/admin/status                  HTTP Basic 管理员令牌    │
 *   │   运维用的。看得到全部租户。未配置管理员令牌时整个面不可达。         │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * 中继自己不做数据库 —— 数据与实时广播交给自托管 Supabase。它只负责
 * 「身份解析 + 协议转译 + 门铃派发」。
 *
 * 一条贯穿全文件的原则：**每个需要租户身份的路由，都在调用点显式取 scope**。
 * 没有"默认租户"、没有可选的 user_id。身份从哪来（令牌/cookie）由 auth.js
 * 决定，但"这个操作属于谁"必须写在读代码时能一眼看到的地方。
 */

const http = require('node:http');
const { URL } = require('node:url');

const cfg = require('./config');
const supa = require('./supa');
const deviceflow = require('./deviceflow');
const oauth = require('./oauth');
const mcp = require('./mcp');
const tokens = require('./tokens');
const session = require('./session');
const auth = require('./auth');
const accounts = require('./accounts');
const consoleViews = require('./console');
const adminViews = require('./admin');
const layout = require('./layout');
const { makeLimiter } = require('./ratelimit');
const { esc } = layout;

const SERVER_NAME = 'remote-mcp-relay';
const SERVER_VERSION = require('../package.json').version;

/* ------------------------------------------------------------------- 限速器 */

const limiters = {
  approve: makeLimiter({ max: cfg.RL_APPROVE_MAX, windowMs: cfg.RL_APPROVE_WINDOW_MS, name: 'approve' }),
  login: makeLimiter({ max: cfg.RL_LOGIN_MAX, windowMs: cfg.RL_LOGIN_WINDOW_MS, name: 'login' }),
  mcpAuth: makeLimiter({ max: cfg.RL_MCP_AUTH_MAX, windowMs: cfg.RL_MCP_AUTH_WINDOW_MS, name: 'mcpAuth' }),
};

/* ------------------------------------------------------------------- 小工具 */

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

function sendJson(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    // 管理页/控制台含账号信息，禁止被任何中间层缓存或嵌入 iframe
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' }).end();
}

/**
 * 在回调地址上附加查询参数（授权码 / state / iss / error）。
 *
 * 用 URL 对象拼接而不是字符串相加：真实客户端的回调地址往往本身就带查询串
 * （ChatGPT 的回调带 connector 标识），字符串相加会造出 `?a=1?code=x` 这种
 * 非法 URL，现象是"授权走完但回调解析失败"。
 */
function buildRedirect(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * 授权端点的错误出口。
 *
 * 分两种，区别很重要：
 *   · redirectable（client 与 redirect_uri 都已验证）→ 按规范重定向回
 *     redirect_uri 带 error 参数，客户端能正常收到失败通知。
 *   · 否则 → 渲染一个错误页，**绝不重定向** —— 那会把错误送到一个
 *     未经验证的地址上，等于给攻击者一个开放的反射点。
 */
function sendAuthorizationError(res, err) {
  if (err.redirectable && err.redirectUri) {
    log(`[oauth] ✗ authorize（重定向回客户端）：${err.oauthError}`);
    return redirect(
      res,
      buildRedirect(err.redirectUri, {
        error: err.oauthError,
        error_description: err.message,
        state: err.state,
        iss: cfg.RELAY_PUBLIC_URL,
      })
    );
  }
  log(`[oauth] ✗ authorize（硬拒绝）：${err.oauthError} —— ${err.message}`);
  return sendHtml(
    res,
    err.status || 400,
    layout.page(
      `<h1>授权请求被拒绝</h1>
<p>${esc(err.message)}</p>
<p class="dim">错误码：<code>${esc(err.oauthError)}</code>。请回到客户端重新发起连接。</p>`,
      { title: '授权请求被拒绝 · Remote MCP Relay' }
    )
  );
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

async function readAnyBody(req) {
  const raw = await readBody(req);
  const type = req.headers['content-type'] || '';
  if (!raw.trim()) return {};
  if (type.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function mcpPathMatches(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (cfg.MCP_PATH_TOKEN) return clean === `/t/${cfg.MCP_PATH_TOKEN}/mcp`;
  return clean === '/mcp';
}

/**
 * 同源校验，用于所有会改变状态的表单 POST。
 *
 * 主防线其实是 cookie 上的 SameSite=Lax（跨站 POST 根本不会带上会话 cookie），
 * 这里是第二层：万一以后有人把 cookie 改成 SameSite=None，或者浏览器行为有差异，
 * 同源检查仍然拦得住。
 *
 * 两个头都没有则拒绝。实测所有现代浏览器对表单 POST 都会带 Origin，
 * 旧浏览器会带 Referer —— 两者都没有的情况只会出现在非浏览器客户端上，
 * 而那些客户端本来也不该打这些路由。
 */
function sameOrigin(req) {
  const host = req.headers.host;
  if (!host) return false;
  for (const header of ['origin', 'referer']) {
    const v = req.headers[header];
    if (!v) continue;
    try {
      if (new URL(v).host === host) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** 只允许站内相对路径，避免登录后的 next 参数变成开放重定向。 */
function safeNext(raw, fallback = '/console') {
  const s = String(raw || '').trim();
  if (!s.startsWith('/') || s.startsWith('//')) return fallback;
  return s;
}

/** flash 文案走白名单字典，不用 URL 里的任意文本。 */
const FLASH = {
  ok: {
    token_revoked: '令牌已吊销。',
    grant_revoked: '已撤销该 AI 客户端的接入，它拿到的令牌同时被吊销，立即生效。',
    device_approved: '设备已批准接入。',
    device_denied: '已拒绝该授权请求。',
    logged_out: '已退出登录。',
  },
  err: {
    token_not_found: '找不到该令牌，或它不属于当前账号。',
    grant_not_found: '找不到该授权记录，或它不属于当前账号。',
    rate_limited: '尝试过于频繁，请稍后再试。',
    csrf: '请求来源校验未通过，请从控制台页面重新操作。',
  },
};

function flashFromQuery(url) {
  const ok = FLASH.ok[url.searchParams.get('ok')];
  const err = FLASH.err[url.searchParams.get('err')];
  if (ok) return layout.alertBox('ok', esc(ok));
  if (err) return layout.alertBox('error', esc(err));
  return null;
}

/* -------------------------------------------------------------------- 会话 */

const sessions = new Map();
const MAX_SESSIONS = 200;

function ensureSession(req, res, isInitialize) {
  const incoming = req.headers['mcp-session-id'];
  if (incoming && sessions.has(incoming)) {
    const s = sessions.get(incoming);
    s.lastSeen = Date.now();
    return { id: incoming, session: s, isNew: false };
  }
  if (!isInitialize) {
    // 客户端没带（或带了失效的）会话 ID。协议允许服务端要求先 initialize，
    // 但很多客户端在重连后会复用旧 ID —— 直接放行会更皮实。
    const id = incoming || supa.randomId();
    const s = { id, createdAt: Date.now(), lastSeen: Date.now(), clientInfo: null, userId: null };
    sessions.set(id, s);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest) sessions.delete(oldest.id);
    }
    return { id, session: s, isNew: true };
  }
  const id = supa.randomId();
  const s = { id, createdAt: Date.now(), lastSeen: Date.now(), clientInfo: null, userId: null };
  sessions.set(id, s);
  return { id, session: s, isNew: true };
}

/* --------------------------------------------------------------- MCP 端点 */

/**
 * 未授权时的 401。
 *
 * 这个响应是**整个 OAuth 流程的起点** —— 客户端（ChatGPT/Claude/Codex）
 * 收到它之后会顺着 resource_metadata 去找授权服务器，然后把用户送去登录。
 * 所以头里的两样东西缺一不可：
 *
 *   resource_metadata  PRM 的地址。客户端从这里知道授权服务器是谁。
 *   scope              明确告诉客户端要申请哪个 scope，它会在授权请求里带上。
 *
 * 响应体里刻意只放一句人话 + 统一文案：reason 区分了"格式错/不存在/已吊销/
 * 已过期"，写进响应体就等于给了攻击者一个 prefix 存在性探测器。
 */
function unauthorizedMcp(res, req, reason) {
  const challenge =
    `Bearer realm="${SERVER_NAME}", ` +
    `resource_metadata="${cfg.RELAY_PUBLIC_URL}/.well-known/oauth-protected-resource", ` +
    `scope="${oauth.SCOPE_DEFAULT}"`;
  sendJson(
    res,
    401,
    {
      error: 'unauthorized',
      error_description:
        '需要在 Authorization 头里带 Bearer 令牌。' +
        '支持 OAuth 2.1 的客户端（ChatGPT / Claude / Codex）会自动走授权流程：' +
        '收到本响应后读取 resource_metadata 指向的文档，然后把用户送到授权页登录。' +
        '不支持 OAuth 的客户端可改用在控制台「我的访问令牌」里创建的个人访问令牌。',
    },
    { 'www-authenticate': challenge }
  );
  log(`[mcp] ✗ 未授权请求（${reason}）from ${auth.clientIp(req)}`);
}

async function handleMcp(req, res, pathname) {
  if (req.method === 'GET') {
    // 本服务没有 server-initiated 流，规范允许 405。
    res.writeHead(405, { allow: 'POST, DELETE', 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }
  if (req.method === 'DELETE') {
    const sid = req.headers['mcp-session-id'];
    if (sid) sessions.delete(sid);
    res.writeHead(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST, DELETE', 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }

  /* 身份解析 —— 每个 POST 都做一次，不依赖会话里缓存的身份。
     理由：令牌可能在中途被吊销，而会话可能活得很久。每次重新校验的代价是
     一次内存缓存查找（30s TTL 内的同前缀直接命中），很便宜。 */
  const limited = limiters.mcpAuth.hit(auth.clientIp(req));
  if (!limited.ok) {
    sendJson(res, 429, { error: 'rate_limited', retry_after_s: limited.retryAfterS }, {
      'retry-after': String(limited.retryAfterS),
    });
    return;
  }

  const ident = await auth.resolveMcpIdentity(req);
  if (!ident.ok) {
    if (ident.prefix) {
      await supa.audit({
        actor: 'anonymous',
        action: 'security.mcp_token_rejected',
        target: ident.prefix,
        detail: { reason: ident.reason },
        ip: ident.ip,
      });
    }
    return unauthorizedMcp(res, req, ident.reason);
  }

  // 反向断言：会话先前绑的是另一个租户 → 这是会话 ID 被跨租户复用，拒绝。
  // （MCP 会话 ID 是客户端自带的，不能被当作身份凭据。）
  const boundUserId = ident.userId;

  let msg;
  try {
    msg = await readJson(req);
  } catch (err) {
    sendJson(res, err.status || 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: err.message } });
    return;
  }

  const isInitialize = !Array.isArray(msg) && msg.method === 'initialize';
  const incomingSid = req.headers['mcp-session-id'];
  const { id: sid, session: sess } = ensureSession(req, res, isInitialize);

  if (sess.userId && sess.userId !== boundUserId) {
    log(`[security] 会话 ${sid.slice(0, 8)} 原属租户 ${sess.userId.slice(0, 8)}，本次请求来自 ${boundUserId.slice(0, 8)} —— 拒绝`);
    await supa.audit({
      userId: boundUserId,
      actor: 'tenant',
      action: 'security.session_tenant_mismatch',
      target: sid,
      detail: { session_owner: sess.userId },
      ip: ident.ip,
    });
    sessions.delete(sid);
    return unauthorizedMcp(res, req, 'session_tenant_mismatch');
  }
  sess.userId = boundUserId;
  if (isInitialize && msg.params?.clientInfo) {
    sess.clientInfo = msg.params.clientInfo;
  }

  const extraHeaders = { 'mcp-session-id': sid };

  async function one(m) {
    const label = m.method || '(无 method)';
    const who = `${m.id === undefined || m.id === null ? 'notif' : 'id=' + m.id}`;
    if (m.id === undefined || m.id === null) {
      try {
        await mcp.handle(m, sess);
        log(`[mcp] ← 通知 ${label}（${who}）`);
      } catch (err) {
        // -32601 = 不认识的方法。通知（无 id）本来就不需要响应，未知通知是协议上
        // 合法的噪音（实测 tunnel-client 启动探测会发一条无 method 的消息）。
        if (err.code === -32601) {
          if (m.method) log(`[mcp] ← 通知 ${label}（${who}）·忽略未知方法`);
        } else {
          log(`[mcp] ← 通知 ${label}（${who}）·处理出错：${err.message}`);
        }
      }
      return null;
    }
    try {
      const result = await mcp.handle(m, sess);
      const detail =
        label === 'tools/list'
          ? `·${result.tools.length} 个工具`
          : label === 'initialize'
            ? `·client=${sess.clientInfo?.name || '?'} proto=${result.protocolVersion}`
            : '';
      log(
        `[mcp] ← ${label}（${who}，session ${incomingSid ? '沿用' : '新建'}=${sid.slice(0, 8)}）` +
          `·tenant=${boundUserId.slice(0, 8)}${detail}`
      );
      return { jsonrpc: '2.0', id: m.id, result: result === undefined ? {} : result };
    } catch (err) {
      const code = typeof err.code === 'number' ? err.code : -32603;
      log(`[mcp] ✗ ${label}（${who}）→ ${code} ${err.message}`);
      return {
        jsonrpc: '2.0',
        id: m.id,
        error: { code, message: err.message },
      };
    }
  }

  if (Array.isArray(msg)) {
    const out = [];
    for (const m of msg) {
      const r = await one(m);
      if (r) out.push(r);
    }
    if (out.length === 0) res.writeHead(202, extraHeaders).end();
    else sendJson(res, 200, out, extraHeaders);
    return;
  }

  const response = await one(msg);
  if (response === null) {
    res.writeHead(202, extraHeaders).end();
    return;
  }
  sendJson(res, 200, response, extraHeaders);
}

/* --------------------------------------------------------- 授权页 / 控制台 */

function requireUser(req, res, next) {
  const user = auth.currentUser(req);
  if (user) return user;
  const next_ = safeNext(req.url || '/console');
  redirect(res, `/login?next=${encodeURIComponent(next_)}`);
  return null;
}

/** 授权页主体（批准单个验证码）。 */
function renderApprovePage({ user, focusCode, message }) {
  const pending = deviceflow.listPending();
  return `
<h1>授权设备接入</h1>
<p>设备上运行的 <code>desktop-commander remote</code> 请求接入本中继。
批准后，该设备会绑定到**你**的账号 <code>${esc(user.email || user.uid)}</code>，
此后只有你的访问令牌能把工具调用派发到它上面。</p>
${message || ''}
<form method="post" action="/device/approve">
  <div class="row">
    <label style="margin:0"><span>验证码</span>
      <input class="code" type="text" name="user_code" value="${esc(focusCode || '')}" placeholder="XXXX-XXXX" required></label>
    <button type="submit">批准</button>
    <button class="deny" type="submit" formaction="/device/deny">拒绝</button>
  </div>
</form>
<h2>待处理的授权（${pending.filter((p) => p.status === 'pending').length}）</h2>
${consoleViews.pendingTable(pending, focusCode)}`;
}

function sendConsole(res, req, opts = {}) {
  const user = opts.user || auth.currentUser(req);
  if (!user) return redirect(res, '/login');
  const url = new URL(req.url || '/console', `http://${req.headers.host || 'localhost'}`);
  const scope = supa.tenantScope(user.uid);

  return (async () => {
    let devices = [];
    let callRows = [];
    let tokenRows = [];
    let grantRows = [];
    let dbError = null;
    try {
      devices = await mcp.listDevices(scope);
      const calls = await scope.select('mcp_remote_calls', {
        select: 'id,device_id,tool_name,tool_args,status,error_message,created_at,completed_at',
        order: 'created_at.desc',
        limit: '20',
      });
      callRows = Array.isArray(calls) ? calls : [];
      tokenRows = await tokens.list(user.uid);
      // 已授权的 AI 客户端。这是"我的账号被哪些外部应用接入了"的唯一视图 ——
      // 也是用户唯一能自助断开的入口。
      grantRows = await oauth.listGrants(user.uid);
    } catch (err) {
      dbError = err.message;
    }

    const html = consoleViews.consolePage({
      user,
      devices,
      pending: deviceflow.listPending(),
      tokens: tokenRows,
      grants: grantRows,
      calls: callRows,
      newToken: opts.newToken || null,
      flash:
        opts.flash !== undefined
          ? opts.flash
          : dbError
            ? layout.alertBox('error', `读取数据失败，下面的内容可能不完整：${esc(dbError)}`)
            : flashFromQuery(url),
      focusCode: url.searchParams.get('user_code'),
      stats: {
        mcpEndpoint: `${cfg.RELAY_PUBLIC_URL}${cfg.MCP_PATH_TOKEN ? `/t/${cfg.MCP_PATH_TOKEN}` : ''}/mcp`,
        routePolicy: cfg.ROUTE_POLICY,
        server: SERVER_NAME,
        version: SERVER_VERSION,
        deviceCodeTtlS: cfg.DEVICE_CODE_TTL_S,
      },
    });
    return sendHtml(res, 200, html);
  })();
}

/* --------------------------------------------------------------- 管理员面 */

async function buildAdminView() {
  const [usersRaw, devicesRaw, tokensRaw, auditRows, grantsRaw, clientsRaw] = await Promise.all([
    supa.request(`${cfg.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=200`, {
      headers: supa.secretKeyHeaders(),
      timeoutMs: 20000,
    }).then((r) => r.data).catch(() => null),
    supa.rest.select('mcp_devices', { select: '*', order: 'last_seen.desc', limit: '500' }).catch(() => []),
    supa.rest.select('mcp_api_tokens', { select: 'user_id,revoked_at,kind', limit: '1000' }).catch(() => []),
    supa.auditTail({ limit: 60 }).catch(() => []),
    supa.rest.select('mcp_oauth_grants', { select: '*', order: 'created_at.desc', limit: '500' }).catch(() => []),
    supa.rest.select('mcp_oauth_clients', { select: '*', order: 'created_at.desc', limit: '200' }).catch(() => []),
  ]);

  const users = usersRaw?.users || (Array.isArray(usersRaw) ? usersRaw : []);
  const devices = Array.isArray(devicesRaw) ? devicesRaw : [];
  const tokenRows = Array.isArray(tokensRaw) ? tokensRaw : [];
  const tokenCounts = {};
  const oauthTokenCounts = {};
  for (const t of tokenRows) {
    if (t.revoked_at) continue;
    tokenCounts[t.user_id] = (tokenCounts[t.user_id] || 0) + 1;
    if (t.kind === 'oauth') oauthTokenCounts[t.user_id] = (oauthTokenCounts[t.user_id] || 0) + 1;
  }

  return {
    users,
    userListTruncated: users.length >= 200,
    devices,
    tokenCounts,
    oauthTokenCounts,
    grants: Array.isArray(grantsRaw) ? grantsRaw : [],
    clients: Array.isArray(clientsRaw) ? clientsRaw : [],
    audit: Array.isArray(auditRows) ? auditRows : [],
    pending: deviceflow.listPending(),
    stats: {
      server: SERVER_NAME,
      version: SERVER_VERSION,
      uptimeS: Math.round(process.uptime()),
      toolCount: mcp.getCatalog().toolCount,
      catalogSource: `${mcp.getCatalog().source.entry} v${mcp.getCatalog().source.version}`,
      sessions: sessions.size,
      broadcast: supa.broadcastStatsSnapshot(),
      tokenCache: tokens.cacheStats(),
      rateLimiters: Object.fromEntries(Object.entries(limiters).map(([k, l]) => [k, l.stats()])),
      securityWarnings: cfg.securityWarnings(),
      mcpEndpoint: `${cfg.RELAY_PUBLIC_URL}${cfg.MCP_PATH_TOKEN ? `/t/${cfg.MCP_PATH_TOKEN}` : ''}/mcp`,
      oauthIssuer: cfg.RELAY_PUBLIC_URL,
      supabaseUrl: cfg.SUPABASE_URL,
    },
  };
}

/* ---------------------------------------------------------------------- 路由 */

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      /* ------------------------------------------------------------ MCP */
      if (mcpPathMatches(pathname)) return await handleMcp(req, res, pathname);

      /* ------------------------------------------------ OAuth 发现与授权 */
      // RFC 9728 允许两种形式：资源在 / 用根路径，资源带路径时用「路径插入」形式
      // （/.well-known/oauth-protected-resource/mcp）。隧道两种都会探，只实现根路径
      // 会让带路径那种拿到 404。两边都答，内容相同。
      if (
        pathname === '/.well-known/oauth-protected-resource' ||
        pathname.startsWith('/.well-known/oauth-protected-resource/')
      ) {
        return sendJson(res, 200, oauth.protectedResourceMetadata(req));
      }

      // RFC 8414 的路径插入形式同理（/.well-known/oauth-authorization-server/mcp）。
      if (
        pathname === '/.well-known/oauth-authorization-server' ||
        pathname.startsWith('/.well-known/oauth-authorization-server/')
      ) {
        return sendJson(res, 200, oauth.authorizationServerMetadata(req));
      }

      /* 动态客户端注册（RFC 7591）。
         ChatGPT/Claude/Codex 各家回调地址不同且会变，所以不做白名单预置 ——
         安全边界不在"谁注册了"，而在 redirect_uri 精确比对 + 强制 PKCE +
         授权页里那个真人点下的"批准"。 */
      if (pathname === '/oauth/register') {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { error: 'invalid_request', error_description: '请用 POST' }, { allow: 'POST' });
        }
        const body = await readAnyBody(req);
        try {
          return sendJson(res, 201, await oauth.register(body, { ip: auth.clientIp(req) }));
        } catch (err) {
          if (err instanceof oauth.OAuthError) return sendJson(res, err.status, err.body());
          log(`[oauth] ✗ register 失败：${err.message}`);
          return sendJson(res, 500, { error: 'server_error', error_description: '客户端注册失败' });
        }
      }

      /* 令牌端点。客户端按 RFC 6749 用 application/x-www-form-urlencoded 提交
         （readAnyBody 已兼容 JSON），**不能用** readJson —— 那会对真实客户端
         一律 400，而且现象是"授权页走完了、最后一步失败"，很难定位。 */
      if (pathname === '/oauth/token') {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { error: 'invalid_request', error_description: '请用 POST' }, { allow: 'POST' });
        }
        const body = await readAnyBody(req);
        try {
          return sendJson(res, 200, await oauth.token(body, { ip: auth.clientIp(req) }));
        } catch (err) {
          if (err instanceof oauth.OAuthError) {
            log(`[oauth] ✗ token（${body?.grant_type}）：${err.oauthError}`);
            return sendJson(res, err.status, err.body());
          }
          log(`[oauth] ✗ token 内部错误：${err.message}`);
          return sendJson(res, 500, { error: 'server_error', error_description: '令牌签发失败' });
        }
      }

      /* 授权端点。
         GET  —— 校验参数；没登录就先去登录（登录后原样回到这里，参数不丢）
         POST —— 用户在同意页点下"批准"或"拒绝"，签发授权码并重定向回去 */
      if (pathname === '/oauth/authorize') {
        if (req.method === 'GET') {
          let v;
          try {
            v = await oauth.validateAuthorizeRequest(Object.fromEntries(url.searchParams));
          } catch (err) {
            if (err instanceof oauth.OAuthError) return sendAuthorizationError(res, err);
            throw err;
          }
          const user = auth.currentUser(req);
          if (!user) {
            // 带上完整原始查询串 —— 登录回来时必须能重放出同一个授权请求。
            return redirect(res, `/login?next=${encodeURIComponent(req.url || '/')}`);
          }
          return sendHtml(
            res,
            200,
            consoleViews.consentPage({
              user,
              client: v.client,
              scope: v.scope,
              params: Object.fromEntries(url.searchParams),
            })
          );
        }

        if (req.method !== 'POST') {
          return sendJson(res, 405, { error: 'invalid_request', error_description: '请用 GET 或 POST' }, { allow: 'GET, POST' });
        }

        const user = auth.currentUser(req);
        if (!user) return redirect(res, '/login?next=%2Fconsole');
        // 同意页是表单 POST —— 与其它会改变状态的表单一致，做同源校验。
        if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden', error_description: '跨站提交被拒' });

        const form = await readAnyBody(req);
        let v;
        try {
          v = await oauth.validateAuthorizeRequest(form);
        } catch (err) {
          if (err instanceof oauth.OAuthError) return sendAuthorizationError(res, err);
          throw err;
        }

        if (form.decision === 'deny') {
          await supa.audit({
            userId: user.uid,
            actor: 'tenant',
            action: 'oauth.authorize.deny',
            target: v.client.client_id,
            detail: { client_name: v.client.client_name },
            ip: auth.clientIp(req),
          });
          return redirect(
            res,
            buildRedirect(form.redirect_uri, {
              error: 'access_denied',
              error_description: '用户拒绝了本次授权',
              state: form.state,
              iss: cfg.RELAY_PUBLIC_URL,
            })
          );
        }

        const code = await oauth.issueCode({
          user,
          client: v.client,
          redirectUri: form.redirect_uri,
          scope: v.scope,
          resource: v.resource,
          codeChallenge: form.code_challenge,
          ip: auth.clientIp(req),
        });

        log(
          `[oauth] ✓ 授权码已签发 client="${v.client.client_name || v.client.client_id.slice(0, 12)}" ` +
            `→ tenant ${user.uid.slice(0, 8)}`
        );

        return redirect(
          res,
          buildRedirect(form.redirect_uri, { code, state: form.state, iss: cfg.RELAY_PUBLIC_URL })
        );
      }

      /* ------------------------------------------------ device 免鉴权面 */
      if (pathname === '/api/mcp-info') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
        // 免鉴权公开端点 —— 与官方契约一致（device.ts:313 不带任何 Authorization）。
        // 安全性由 Supabase 侧的 RLS 兜底，不靠这里藏密钥。
        return sendJson(res, 200, {
          supabaseUrl: cfg.PUBLIC_SUPABASE_URL,
          supabasePublishableKey: cfg.SUPABASE_PUBLISHABLE_KEY,
        });
      }

      if (pathname === '/device/start') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
        const body = await readJson(req);
        return sendJson(res, 200, deviceflow.start(body));
      }

      if (pathname === '/device/poll') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
        const body = await readJson(req);
        const { httpStatus, body: payload } = deviceflow.poll(body);
        return sendJson(res, httpStatus, payload);
      }

      /* ---------------------------------------------------------- 账号 */
      if (pathname === '/login') {
        const next_ = safeNext(url.searchParams.get('next'));
        if (req.method === 'GET') {
          const already = auth.currentUser(req);
          if (already) return redirect(res, next_);
          return sendHtml(res, 200, consoleViews.loginPage({ next: next_ }));
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
        if (!sameOrigin(req)) return redirect(res, `/login?next=${encodeURIComponent(next_)}`);

        const ip = auth.clientIp(req);
        const gate = limiters.login.hit(ip);
        if (!gate.ok) {
          await supa.audit({ actor: 'anonymous', action: 'security.login_rate_limited', ip });
          return sendHtml(
            res,
            429,
            consoleViews.loginPage({ next: next_, info: `尝试过于频繁，请 ${gate.retryAfterS} 秒后再试。` })
          );
        }

        const body = await readAnyBody(req);
        const postNext = safeNext(body.next, next_);
        const result = await accounts.login(body.email, body.password, { ip });
        if (!result.ok) {
          return sendHtml(res, 401, consoleViews.loginPage({ next: postNext, error: result.error, email: body.email }));
        }
        limiters.login.reset(ip);
        session.setSession(res, { userId: result.userId, email: result.email });
        log(`[auth] 登录成功 ${result.email}（${result.userId.slice(0, 8)}）`);
        return redirect(res, postNext);
      }

      if (pathname === '/signup') {
        const next_ = safeNext(url.searchParams.get('next'));
        if (!cfg.ALLOW_SIGNUP) {
          if (req.method === 'GET') {
            return sendHtml(res, 200, consoleViews.loginPage({ next: next_, info: '本服务已关闭自助注册，请联系管理员开通账号。' }));
          }
          return sendHtml(res, 403, consoleViews.loginPage({ next: next_, info: '本服务已关闭自助注册。' }));
        }
        if (req.method === 'GET') {
          const already = auth.currentUser(req);
          if (already) return redirect(res, next_);
          return sendHtml(res, 200, consoleViews.signupPage({ next: next_ }));
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
        if (!sameOrigin(req)) return redirect(res, `/signup?next=${encodeURIComponent(next_)}`);

        const ip = auth.clientIp(req);
        const gate = limiters.login.hit(ip);
        if (!gate.ok) {
          return sendHtml(res, 429, consoleViews.signupPage({ next: next_, error: `尝试过于频繁，请 ${gate.retryAfterS} 秒后再试。` }));
        }

        const body = await readAnyBody(req);
        const postNext = safeNext(body.next, next_);
        const result = await accounts.signup(body.email, body.password, { ip });
        if (!result.ok) {
          return sendHtml(res, 400, consoleViews.signupPage({ next: postNext, error: result.error, email: body.email }));
        }
        session.setSession(res, { userId: result.userId, email: result.email });
        log(`[auth] 新账号 ${result.email}（${result.userId.slice(0, 8)}）`);
        return redirect(res, postNext);
      }

      if (pathname === '/logout') {
        session.clearSession(res);
        return redirect(res, '/login');
      }

      /* -------------------------------------------------------- 控制台 */
      if (pathname === '/console' || pathname === '/console/') {
        const user = requireUser(req, res);
        if (!user) return;
        return await sendConsole(res, req, { user });
      }

      if (pathname === '/console/tokens' && req.method === 'POST') {
        const user = auth.currentUser(req);
        if (!user) return redirect(res, '/login');
        if (!sameOrigin(req)) return redirect(res, '/console?err=csrf');
        const body = await readAnyBody(req);
        const ip = auth.clientIp(req);
        try {
          const { token } = await tokens.create(user.uid, {
            label: body.label,
            expiresInDays: body.expires_in_days,
            ip,
          });
          log(`[auth] 令牌已创建 tenant=${user.uid.slice(0, 8)}（明文仅本次响应展示）`);
          // 刻意不重定向：令牌明文只在这一次响应体里出现，不进 URL、不进历史。
          return await sendConsole(res, req, { user, newToken: token, flash: null });
        } catch (err) {
          return await sendConsole(res, req, {
            user,
            flash: layout.alertBox('error', `创建令牌失败：${esc(err.message)}`),
          });
        }
      }

      if (pathname === '/console/tokens/revoke' && req.method === 'POST') {
        const user = auth.currentUser(req);
        if (!user) return redirect(res, '/login');
        if (!sameOrigin(req)) return redirect(res, '/console?err=csrf');
        const body = await readAnyBody(req);
        const result = await tokens.revoke(user.uid, body.token_id, { ip: auth.clientIp(req) });
        log(`[auth] 令牌吊销 tenant=${user.uid.slice(0, 8)} → ${result.ok ? result.prefix : result.reason}`);
        return redirect(res, result.ok ? '/console?ok=token_revoked' : '/console?err=token_not_found');
      }

      /* 撤销一条 OAuth 授权。
         与"吊销单个令牌"的区别：这是"断开整个 AI 客户端的接入"——
         同时置 grant.revoked_at 并吊销该客户端下的全部令牌，让撤销立即生效。 */
      if (pathname === '/console/grants/revoke' && req.method === 'POST') {
        const user = auth.currentUser(req);
        if (!user) return redirect(res, '/login');
        if (!sameOrigin(req)) return redirect(res, '/console?err=csrf');
        const body = await readAnyBody(req);
        const result = await oauth.revokeGrant(user.uid, String(body.client_id || ''), {
          ip: auth.clientIp(req),
        });
        log(
          `[oauth] 撤销授权 tenant=${user.uid.slice(0, 8)} client=${String(body.client_id || '').slice(0, 14)} ` +
            `→ ${result.ok ? `已吊销 ${result.revokedTokens} 枚令牌` : result.reason}`
        );
        return redirect(res, result.ok ? '/console?ok=grant_revoked' : '/console?err=grant_not_found');
      }

      /* -------------------------------------------------- 授权页（需登录） */
      if (pathname === '/device' && req.method === 'GET') {
        const user = requireUser(req, res);
        if (!user) return;
        return sendHtml(
          res,
          200,
          deviceflow.page(
            renderApprovePage({ user, focusCode: url.searchParams.get('user_code'), message: null }),
            { title: '授权设备接入 · Remote MCP Relay', nav: consoleViews.nav(user, '/device') }
          )
        );
      }

      if (pathname === '/device/approve' && req.method === 'POST') {
        const user = auth.currentUser(req);
        if (!user) return redirect(res, '/login?next=%2Fdevice');
        const ip = auth.clientIp(req);
        if (!sameOrigin(req)) return redirect(res, '/device?err=csrf');

        // user_code 是可被暴力猜的：猜中并批准 = 那台机器变成批准者的远程设备。
        // 所以批准动作单独限速，且比登录更严（默认 5 分钟 10 次）。
        const gate = limiters.approve.hit(ip);
        if (!gate.ok) {
          await supa.audit({
            userId: user.uid,
            actor: 'tenant',
            action: 'security.approve_rate_limited',
            detail: { attempts_window: cfg.RL_APPROVE_MAX },
            ip,
          });
          log(`[security] 批准限速触发 ip=${ip}`);
          return sendHtml(
            res,
            429,
            deviceflow.page(
              renderApprovePage({
                user,
                focusCode: null,
                message: layout.alertBox('error', `尝试过于频繁，请 ${gate.retryAfterS} 秒后再试。`),
              }),
              { nav: consoleViews.nav(user, '/device') }
            )
          );
        }

        const body = await readAnyBody(req);
        try {
          const rec = await deviceflow.approve(body.user_code, { userId: user.uid, email: user.email, ip });
          limiters.approve.reset(ip);
          return sendHtml(
            res,
            200,
            deviceflow.page(
              renderApprovePage({
                user,
                focusCode: null,
                message: layout.alertBox(
                  'ok',
                  `已批准 <code>${esc(rec.user_code)}</code>（设备 ${esc(rec.device_name)}，
                   已绑定到你的账号）。设备会在数秒内完成接入。`
                ),
              }),
              { nav: consoleViews.nav(user, '/device') }
            )
          );
        } catch (err) {
          return sendHtml(
            res,
            err.status || 500,
            deviceflow.page(
              renderApprovePage({
                user,
                focusCode: body.user_code,
                message: layout.alertBox('error', `批准失败：${esc(err.message)}`),
              }),
              { nav: consoleViews.nav(user, '/device') }
            )
          );
        }
      }

      if (pathname === '/device/deny' && req.method === 'POST') {
        const user = auth.currentUser(req);
        if (!user) return redirect(res, '/login?next=%2Fdevice');
        if (!sameOrigin(req)) return redirect(res, '/device?err=csrf');
        const body = await readAnyBody(req);
        try {
          deviceflow.deny(body.user_code, { userId: user.uid, ip: auth.clientIp(req) });
          return redirect(res, '/device');
        } catch (err) {
          return sendHtml(
            res,
            err.status || 500,
            deviceflow.page(
              renderApprovePage({
                user,
                focusCode: body.user_code,
                message: layout.alertBox('error', `操作失败：${esc(err.message)}`),
              }),
              { nav: consoleViews.nav(user, '/device') }
            )
          );
        }
      }

      /* ---------------------------------------------------------- 运维面 */
      // 旧的 /status 现在指向控制台 —— 多租户下"列出所有设备"不该是一个公开页面。
      if (pathname === '/status' || pathname === '/status/') return redirect(res, '/console');

      if (pathname === '/healthz') {
        // 刻意**不含设备清单与租户信息**：它免鉴权，而设备名是有价值的信息。
        // 需要明细请走 /api/status（需登录）或 /api/admin/status（需管理员）。
        const cat = mcp.getCatalog();
        let dbOk = true;
        let dbError = null;
        try {
          await supa.rest.select('mcp_devices', { select: 'id', limit: '1' });
        } catch (err) {
          dbOk = false;
          dbError = err.message;
        }
        return sendJson(res, dbOk ? 200 : 503, {
          ok: dbOk,
          server: SERVER_NAME,
          version: SERVER_VERSION,
          uptime_s: Math.round(process.uptime()),
          tool_count: cat.toolCount,
          catalog_source: `${cat.source.entry} v${cat.source.version}`,
          sessions: sessions.size,
          broadcast: supa.broadcastStatsSnapshot(),
          auth: 'required',
          oauth_issuer: cfg.RELAY_PUBLIC_URL,
          db_error: dbError,
        });
      }

      if (pathname === '/api/status') {
        const user = auth.currentUser(req);
        if (!user) return sendJson(res, 401, { error: 'unauthorized' });
        const scope = supa.tenantScope(user.uid);
        let devices = [];
        let dbError = null;
        try {
          devices = await mcp.listDevices(scope);
        } catch (err) {
          dbError = err.message;
        }
        return sendJson(res, 200, {
          ok: true,
          user: { id: user.uid, email: user.email },
          devices: devices.map((d) => ({
            id: d.id,
            name: d.device_name,
            status: d.status,
            last_seen: d.last_seen,
            online: mcp.isFresh(d),
            broadcast_capable: mcp.isBroadcastCapable(d),
          })),
          auth: 'required',
          oauth_issuer: cfg.RELAY_PUBLIC_URL,
          db_error: dbError,
        });
      }

      if (pathname === '/admin' || pathname === '/admin/') {
        if (!cfg.ADMIN_TOKEN) return sendJson(res, 404, { error: 'not_found' });
        if (!auth.isAdmin(req)) return auth.adminChallenge(res);
        const view = await buildAdminView();
        return sendHtml(res, 200, adminViews.adminPage(view));
      }

      if (pathname === '/api/admin/status') {
        if (!cfg.ADMIN_TOKEN) return sendJson(res, 404, { error: 'not_found' });
        if (!auth.isAdmin(req)) return auth.adminChallenge(res);
        return sendJson(res, 200, await buildAdminView());
      }

      /* ------------------------------------------------------------ 根路径 */
      if (pathname === '/') {
        return redirect(res, auth.currentUser(req) ? '/console' : '/login');
      }

      return sendJson(res, 404, { error: 'not_found', path: pathname });
    } catch (err) {
      log(`未处理异常 ${req.method} ${pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) {
        sendJson(res, err.status || 500, { error: 'internal_error', message: err.message });
      } else {
        res.end();
      }
    }
  });
}

/* ---------------------------------------------------------------------- 启动 */

function main() {
  const problems = cfg.validate();
  if (problems.length) {
    console.error('❌ 配置不完整：');
    for (const p of problems) console.error(`   - ${p}`);
    console.error(
      '\n提示：SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY / RELAY_ADMIN_TOKEN 三处任一即可 ——\n' +
        '   ① 环境变量本身；② `<同名>_FILE=/run/secrets/xxx`（容器部署走这条，不进 docker inspect）；\n' +
        '   ③ 源码目录里的 relay/.env 或 ../supabase/selfhosted/.env（仅本机开发）。'
    );
    process.exit(1);
  }

  mcp.loadCatalog();
  session.loadSecret();

  const server = createServer();
  server.listen(cfg.PORT, cfg.HOST, () => {
    const mcpEndpoint = `${cfg.RELAY_PUBLIC_URL}${cfg.MCP_PATH_TOKEN ? `/t/${cfg.MCP_PATH_TOKEN}` : ''}/mcp`;
    log(`✅ ${SERVER_NAME} v${SERVER_VERSION} 监听 http://${cfg.HOST}:${cfg.PORT}`);
    log(`   MCP 端点        ${mcpEndpoint}     鉴权：必需（Bearer 令牌，OAuth 或人工签发）`);
    log(`   OAuth 授权服务器 ${cfg.RELAY_PUBLIC_URL}/oauth/authorize  → issuer=${cfg.RELAY_PUBLIC_URL}`);
    log(`   控制台          ${cfg.RELAY_PUBLIC_URL}/console`);
    log(`   登录/注册       ${cfg.RELAY_PUBLIC_URL}/login` + (cfg.ALLOW_SIGNUP ? '（自助注册已开启）' : '（自助注册已关闭）'));
    log(`   mcp-info        ${cfg.RELAY_PUBLIC_URL}/api/mcp-info  → supabaseUrl=${cfg.PUBLIC_SUPABASE_URL}`);
    log(`   管理员面        ${cfg.ADMIN_TOKEN ? `${cfg.RELAY_PUBLIC_URL}/admin（HTTP Basic）` : '未启用（RELAY_ADMIN_TOKEN 为空）'}`);
    log(`   路由策略        ${cfg.ROUTE_POLICY}` + (cfg.ROUTE_POLICY === 'auto-single' ? '（单台自动 / 多台需显式 device_id）' : ''));
    log(`   自动批准        ${cfg.AUTO_APPROVE ? '⚠ 开启（仅本地联调）' : '关闭，需人工在浏览器批准'}`);

    const warns = cfg.securityWarnings();
    if (warns.length) {
      log('');
      log('   ── 安全体检 ──────────────────────────────────────────');
      for (const w of warns) log(`   ⚠ ${w}`);
      log('   ──────────────────────────────────────────────────────');
    }
    log('');

    // 启动体检：库里一个账号都没有 + 自助注册已关闭 = 没人能登录控制台，
    // 而登录控制台是 OAuth 授权流程的必经一步（ChatGPT 首次调用工具 →
    // 浏览器打开授权页 → 登录 → 同意）。此时部署是死锁的，但现象只是
    // "登录不进去"，看不出是"账号根本不存在"。
    //
    // 只在启动时检测、不自动建号：RELAY_OWNER_PASSWORD 有公开默认值，
    // 自动建等于用一个人人皆知的密码开管理员入口。给指令，不替他决定。
    //
    // 不 await，不阻塞 listen；失败静默 —— 表还没建时 healthz 已经会报 db_error。
    void (async () => {
      try {
        if (await supa.auth.hasAnyUser()) return;
        if (cfg.ALLOW_SIGNUP) {
          log('   账号           库里为空 —— 自助注册已开启，可去 /signup 注册');
          return;
        }
        log('   ──────────────────────────────────────────────────────');
        log('   ⚠ 库里没有任何账号，且自助注册已关闭（RELAY_ALLOW_SIGNUP=false）。');
        log('     没有人能登录控制台，而登录是 OAuth 授权流程的必经一步 ——');
        log('     ChatGPT 走到授权页会卡住，且看起来像"密码错"。');
        log('     建一个账号：');
        log('       docker compose exec -T relay node tools/create-account.js');
        log('   ──────────────────────────────────────────────────────');
        log('');
      } catch {
        /* 表还没建 / 网络不通：不打扰启动。healthz 会如实报 db_error */
      }
    })();
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log(`${sig} —— 关闭中`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

if (require.main === module) main();

module.exports = { createServer };
