'use strict';
/**
 * remote-mcp relay —— 自建版的「云端·闭源」那一层。
 *
 * 对外三组面：
 *   1. /api/mcp-info            给 device 进程拿 Supabase 连接信息
 *   2. /device/*                给 device 进程走 OAuth Device Flow 拿 session
 *   3. /mcp                     给 ChatGPT / Claude 的 HTTP MCP 端点
 *   4. /status                  人看的只读运维页（设备在线状态、广播投递、待批准授权）
 *
 * 中继自己不做数据库 —— 数据和实时广播都交给自托管 Supabase。
 * 它只负责「协议转译 + 门铃派发」，这样后面换成别的后端时不用动协议面。
 */

const http = require('node:http');
const { URL } = require('node:url');

const cfg = require('./config');
const supa = require('./supa');
const deviceflow = require('./deviceflow');
const mcp = require('./mcp');

const SERVER_NAME = 'remote-mcp-relay';
const SERVER_VERSION = require('../package.json').version;

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
  });
  res.end(body);
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
    const s = { id, createdAt: Date.now(), lastSeen: Date.now(), clientInfo: null };
    sessions.set(id, s);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest) sessions.delete(oldest.id);
    }
    return { id, session: s, isNew: true };
  }
  const id = supa.randomId();
  const s = { id, createdAt: Date.now(), lastSeen: Date.now(), clientInfo: null };
  sessions.set(id, s);
  return { id, session: s, isNew: true };
}

/* --------------------------------------------------------------- MCP 端点 */

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

  let msg;
  try {
    msg = await readJson(req);
  } catch (err) {
    sendJson(res, err.status || 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: err.message } });
    return;
  }

  const isInitialize = !Array.isArray(msg) && msg.method === 'initialize';
  const incomingSid = req.headers['mcp-session-id'];
  const { id: sid, session } = ensureSession(req, res, isInitialize);
  if (isInitialize && msg.params?.clientInfo) {
    session.clientInfo = msg.params.clientInfo;
  }

  const extraHeaders = { 'mcp-session-id': sid };

  async function one(m) {
    const label = m.method || '(无 method)';
    const who = `${m.id === undefined || m.id === null ? 'notif' : 'id=' + m.id}`;
    if (m.id === undefined || m.id === null) {
      try {
        await mcp.handle(m, session);
        log(`[mcp] ← 通知 ${label}（${who}）`);
      } catch (err) {
        // -32601 = 不认识的方法。通知（无 id）本来就不需要响应，未知通知是协议上
        // 合法的噪音，不该按错误记 —— 实测 tunnel-client 启动探测会发一条无 method
        // 的消息，按错误打会在每次隧道重连时刷一条假告警。
        if (err.code === -32601) {
          if (m.method) log(`[mcp] ← 通知 ${label}（${who}）·忽略未知方法`);
        } else {
          log(`[mcp] ← 通知 ${label}（${who}）·处理出错：${err.message}`);
        }
      }
      return null;
    }
    try {
      const result = await mcp.handle(m, session);
      const detail =
        label === 'tools/list'
          ? `·${result.tools.length} 个工具`
          : label === 'initialize'
            ? `·client=${session.clientInfo?.name || '?'} proto=${result.protocolVersion}`
            : '';
      log(
        `[mcp] ← ${label}（${who}，session ${incomingSid ? '沿用' : '新建'}=${sid.slice(0, 8)}）${detail}`
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

/* ----------------------------------------------------------------- 验证页面 */

function renderPage(userCode, message) {
  const pending = deviceflow.listPending();
  const rows = pending.length
    ? `<table><thead><tr><th>验证码</th><th>设备</th><th>剩余</th><th>状态</th></tr></thead><tbody>${
        pending
          .map(
            (r) =>
              `<tr><td><code>${r.user_code}</code></td><td>${escapeHtml(r.device_name)}</td>` +
              `<td>${r.expires_in_s}s</td><td>${r.status}</td></tr>`
          )
          .join('')
      }</tbody></table>`
    : '<p>当前没有待批准的授权请求。</p>';

  return `
<h1>授权设备接入远程 MCP</h1>
<p>设备上运行的 <code>desktop-commander remote</code> 请求接入本中继。
批准后，该设备将以你的账号身份接收工具调用。</p>
${message || ''}
<form method="post" action="/device/approve">
  <p><label>验证码<br><input type="text" name="user_code" value="${escapeHtml(userCode || '')}" placeholder="XXXX-XXXX" required></label></p>
  <button type="submit">批准</button>
  <button class="deny" type="submit" formaction="/device/deny">拒绝</button>
</form>
<h1 style="margin-top:28px">待处理的授权</h1>
${rows}
<p style="margin-top:24px;color:#888780">中继 ${SERVER_NAME} v${SERVER_VERSION} ·
Supabase ${escapeHtml(cfg.SUPABASE_URL)} ·
自动批准 ${cfg.AUTO_APPROVE ? '<b>已开启</b>（仅本地联调）' : '未开启'}</p>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------- 运维状态页面 */

/**
 * 只读运维页。数据全部来自 /healthz，页面自己每 5 秒拉一次重绘 ——
 * 所以这个 HTML 是静态骨架，不含任何服务端注入的数据。
 *
 * 在线判定用 15 分钟窗口，与 supabase/schema.sql 里 mcp_device_presence
 * 视图的口径保持一致（device 心跳比这密得多，15 分钟只用来过滤"死进程"）。
 */
function renderStatusPage() {
  return `
<h1>remote-mcp-relay</h1>
<p>中继实时状态，每 5 秒自动刷新。设备授权入口在 <a href="/device">/device</a>。</p>
<div id="root" class="dim">加载中…</div>
<script>
var ONLINE_WINDOW_S = 15 * 60;
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function dur(s) {
  if (s == null || isNaN(s)) return '—';
  if (s < 90) return Math.round(s) + ' 秒';
  if (s < 5400) return Math.round(s / 60) + ' 分钟';
  if (s < 172800) return (s / 3600).toFixed(1) + ' 小时';
  return Math.round(s / 86400) + ' 天';
}
function ago(iso) {
  if (!iso) return '—';
  var t = new Date(iso).getTime();
  if (isNaN(t)) return esc(iso);
  var s = Math.max(0, (Date.now() - t) / 1000);
  return dur(s) + '前';
}
function kv(label, value, mono) {
  return '<tr><th>' + esc(label) + '</th><td>' + (mono ? '<code>' + esc(value) + '</code>' : esc(value)) + '</td></tr>';
}
function render(j) {
  var devs = j.devices || [];
  var h = '';

  h += '<h2>概览</h2><table>';
  h += kv('服务', j.server + ' v' + j.version);
  h += kv('运行时长', dur(j.uptime_s));
  h += kv('工具数', j.tool_count + ' 个');
  h += kv('工具目录来源', j.catalog_source, true);
  h += kv('活跃 MCP 会话', j.sessions + ' 个');
  h += kv('广播投递', '成功 ' + j.broadcast.ok + ' / 失败 ' + j.broadcast.failed
    + (j.broadcast.lastError ? '（最近错误：' + j.broadcast.lastError + '）' : ''), true);
  h += kv('自动批准授权', j.auto_approve ? '已开启（仅本地联调，勿上公网）' : '未开启');
  h += kv('MCP 端点', j.mcp_endpoint, true);
  h += kv('Supabase', j.public_supabase_url, true);
  h += '</table>';

  h += '<h2>已接入设备（' + devs.length + '）</h2>';
  if (!devs.length) {
    h += '<p>还没有设备接入。在设备上执行 <code>desktop-commander remote</code> 并完成授权后会出现在这里。</p>';
  } else {
    h += '<table><thead><tr><th>设备</th><th>ID</th><th>状态</th><th>最后心跳</th><th>广播通道</th></tr></thead><tbody>';
    devs.forEach(function (d) {
      var age = d.last_seen ? (Date.now() - new Date(d.last_seen).getTime()) / 1000 : Infinity;
      var live = age <= ONLINE_WINDOW_S;
      // status 是 device 自己上报的，心跳是它实际留下的痕迹 —— 两者正常时一致，
      // 不一致本身就是诊断信号（例如进程已死但还没来得及改状态），才值得显示。
      var mismatch = (d.status === 'online') !== live;
      h += '<tr>';
      h += '<td>' + esc(d.name || '(未命名)') + '</td>';
      h += '<td><code>' + esc(String(d.id || '').slice(0, 8)) + '</code></td>';
      h += '<td>' + (live
        ? '<span class="tag on">在线</span>'
        : '<span class="tag off">离线</span>')
        + (mismatch ? ' <span class="dim">设备上报：' + esc(d.status || '(空)') + '</span>' : '')
        + '</td>';
      h += '<td>' + ago(d.last_seen) + '</td>';
      h += '<td>' + (d.broadcast_capable
        ? '<span class="tag on">可用</span>'
        : '<span class="tag off">不可用</span>') + '</td>';
      h += '</tr>';
    });
    h += '</tbody></table>';
    h += '<p class="dim">心跳是 device 进程直连 Supabase 上报的；超过 15 分钟无心跳即视为离线。'
      + '「广播通道」为否的设备收不到中继的门铃事件，调用会失败。</p>';
  }

  var pend = j.pending_device_authorizations || [];
  h += '<h2>待批准的授权（' + pend.length + '）</h2>';
  if (!pend.length) {
    h += '<p>当前没有待批准的授权请求。</p>';
  } else {
    h += '<table><thead><tr><th>验证码</th><th>设备</th><th>剩余</th><th>状态</th></tr></thead><tbody>';
    pend.forEach(function (r) {
      h += '<tr><td><code>' + esc(r.user_code) + '</code></td><td>' + esc(r.device_name)
        + '</td><td>' + esc(r.expires_in_s) + 's</td><td>' + esc(r.status) + '</td></tr>';
    });
    h += '</tbody></table>';
    h += '<p><a href="/device">前往授权页批准 →</a></p>';
  }

  if (j.db_error) h += '<div class="err">Supabase 查询失败：' + esc(j.db_error) + '</div>';
  if (!j.ok) h += '<div class="err">中继自检未通过（数据库不可达），上方数据可能不完整。</div>';
  h += '<p class="dim" style="margin-top:24px">刷新于 ' + esc(new Date().toLocaleTimeString()) + '</p>';

  document.getElementById('root').innerHTML = h;
}
function tick() {
  fetch('/healthz', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function (e) {
      document.getElementById('root').innerHTML =
        '<div class="err">无法连接中继：' + esc(e.message) + '</div>';
    });
}
tick();
setInterval(tick, 5000);
</script>`;
}

/* ---------------------------------------------------------------------- 路由 */

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      if (mcpPathMatches(pathname)) return await handleMcp(req, res, pathname);

      // RFC 9728 允许两种形式：资源在 / 用根路径，资源带路径时用「路径插入」形式
      // （/.well-known/oauth-protected-resource/mcp）。隧道两种都会探，只实现根路径
      // 会让带路径那种拿到 404。两边都答，内容相同。
      if (
        pathname === '/.well-known/oauth-protected-resource' ||
        pathname.startsWith('/.well-known/oauth-protected-resource/')
      ) {
        const host = req.headers.host || `${cfg.HOST}:${cfg.PORT}`;
        const mcpPath = cfg.MCP_PATH_TOKEN ? `/t/${cfg.MCP_PATH_TOKEN}/mcp` : '/mcp';
        return sendJson(res, 200, { resource: `http://${host}${mcpPath}`, bearer_methods_supported: [] });
      }

      if (pathname === '/api/mcp-info') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
        // 免鉴权公开端点 —— 与官方契约一致（device.ts:313 不带任何 Authorization）。
        // 安全性由 Supabase 侧的 RLS 兜底，不靠这里藏密钥。
        return sendJson(res, 200, {
          supabaseUrl: cfg.PUBLIC_SUPABASE_URL,
          supabasePublishableKey: cfg.ANON_KEY,
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

      if (pathname === '/device' && req.method === 'GET') {
        return sendHtml(res, 200, deviceflow.page(renderPage(url.searchParams.get('user_code'), null)));
      }

      if (pathname === '/device/approve' && req.method === 'POST') {
        const body = await readAnyBody(req);
        try {
          const rec = await deviceflow.approve(body.user_code);
          return sendHtml(
            res,
            200,
            deviceflow.page(
              renderPage(
                null,
                `<div class="ok">已批准 <code>${escapeHtml(rec.user_code)}</code>（设备 ${escapeHtml(rec.device_name)}，device_id <code>${escapeHtml(rec.assigned_device_id)}</code>）。设备会在数秒内完成接入。</div>`
              )
            )
          );
        } catch (err) {
          return sendHtml(res, err.status || 500, deviceflow.page(renderPage(null, `<div class="err">批准失败：${escapeHtml(err.message)}</div>`)));
        }
      }

      if (pathname === '/device/deny' && req.method === 'POST') {
        const body = await readAnyBody(req);
        try {
          deviceflow.deny(body.user_code);
          return sendHtml(res, 200, deviceflow.page(renderPage(null, '<div class="ok">已拒绝该请求。</div>')));
        } catch (err) {
          return sendHtml(res, err.status || 500, deviceflow.page(renderPage(null, `<div class="err">操作失败：${escapeHtml(err.message)}</div>`)));
        }
      }

      if (pathname === '/healthz') {
        const cat = mcp.getCatalog();
        let devices = [];
        let dbOk = true;
        let dbError = null;
        try {
          const rows = await supa.rest.select('mcp_devices', {
            select: 'id,device_name,status,last_seen,capabilities',
            order: 'last_seen.desc',
            limit: '20',
          });
          devices = (Array.isArray(rows) ? rows : []).map((r) => ({
            id: r.id,
            name: r.device_name,
            status: r.status,
            last_seen: r.last_seen,
            broadcast_capable: r.capabilities?.transport_broadcast_v1 === true,
          }));
        } catch (err) {
          dbOk = false;
          dbError = err.message;
        }
        return sendJson(res, dbOk ? 200 : 503, {
          ok: dbOk,
          server: SERVER_NAME,
          version: SERVER_VERSION,
          uptime_s: Math.round(process.uptime()),
          supabase_url: cfg.SUPABASE_URL,
          public_supabase_url: cfg.PUBLIC_SUPABASE_URL,
          relay_public_url: cfg.RELAY_PUBLIC_URL,
          auto_approve: cfg.AUTO_APPROVE,
          tool_count: cat.toolCount,
          catalog_source: `${cat.source.entry} v${cat.source.version}`,
          mcp_endpoint: `${cfg.RELAY_PUBLIC_URL}${cfg.MCP_PATH_TOKEN ? `/t/${cfg.MCP_PATH_TOKEN}` : ''}/mcp`,
          sessions: sessions.size,
          broadcast: supa.broadcastStatsSnapshot(),
          pending_device_authorizations: deviceflow.listPending(),
          devices,
          db_error: dbError,
        });
      }

      // 运维状态页（只读）
      if ((pathname === '/status' || pathname === '/status/') && req.method === 'GET') {
        return sendHtml(
          res,
          200,
          deviceflow.page(renderStatusPage(), { title: '中继状态 · remote-mcp-relay', wide: true })
        );
      }

      if (pathname === '/' && req.method === 'GET') {
        return sendHtml(res, 200, deviceflow.page(renderPage(null, null)));
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
    console.error('\n提示：中继会从 ../supabase/selfhosted/.env 自动读取 ANON_KEY / SERVICE_ROLE_KEY。');
    process.exit(1);
  }

  mcp.loadCatalog();

  const server = createServer();
  server.listen(cfg.PORT, cfg.HOST, () => {
    log(`✅ ${SERVER_NAME} v${SERVER_VERSION} 监听 http://${cfg.HOST}:${cfg.PORT}`);
    log(`   MCP 端点        ${cfg.RELAY_PUBLIC_URL}${cfg.MCP_PATH_TOKEN ? `/t/${cfg.MCP_PATH_TOKEN}` : ''}/mcp`);
    log(`   mcp-info        ${cfg.RELAY_PUBLIC_URL}/api/mcp-info  → supabaseUrl=${cfg.PUBLIC_SUPABASE_URL}`);
    log(`   授权页          ${cfg.RELAY_PUBLIC_URL}/device`);
    log(`   状态页          ${cfg.RELAY_PUBLIC_URL}/status`);
    log(`   自动批准        ${cfg.AUTO_APPROVE ? '开启（仅本地联调）' : '关闭'}`);
    log(`   调用超时        ${cfg.CALL_TIMEOUT_MS}ms`);
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
