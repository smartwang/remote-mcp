'use strict';
/**
 * OAuth 2.1 授权服务器 + 资源服务器元数据。
 *
 * ── 为什么需要它（这是在解决什么问题）────────────────────────────────────────
 * 个人访问令牌（PAT）能回答"这是不是一个有效的凭据"，但回答不了
 * "**现在是谁在用**"：ChatGPT 的隧道型 connector 只有一个静态凭据位，
 * 整条隧道注入同一个头。多个终端用户共用一个凭据 ⇒ 中继只看到一种身份 ⇒
 * 多租户在入口处就退化掉了。
 *
 * OAuth 的作用不是"更安全地传令牌"，而是**让每个终端用户各自拿到一枚绑定到
 * 自己账号的令牌**。身份的建立发生在 /oauth/authorize —— 用户在自己浏览器里
 * 登录的是谁，那枚 token 就代表谁。这是唯一可靠的用户身份来源：
 * ChatGPT **不会**把它的用户标识传给 MCP 服务器，它只"代表用户"发起 OAuth。
 *
 * ── 本文件实现的端点 ────────────────────────────────────────────────────────
 *   GET  /.well-known/oauth-protected-resource      资源服务器元数据 (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server    授权服务器元数据 (RFC 8414)
 *   POST /oauth/register                            动态客户端注册   (RFC 7591)
 *   GET/POST /oauth/authorize                       授权端点（登录 + 同意）
 *   POST /oauth/token                               令牌端点（code / refresh）
 *
 * ── 几个刻意的取舍 ──────────────────────────────────────────────────────────
 * · access token 复用 mcp_api_tokens 表与 tokens.js 校验路径，而不是改用 JWT。
 *   JWT 无状态、验得快，但"签出去就撤不回来"—— 用户点"撤销授权"时必须立刻
 *   生效，这一条比省一次查库重要得多。（tokens.js 里已有 prefix 定位 + 内存
 *   缓存，实际开销接近零。）
 * · 授权码落库而不是放内存：中继重启不该让正在进行的授权失败。它只有 60 秒
 *   寿命，不值得为它引入共享缓存。
 * · 不支持 client_secret 之外的回调认证，不实现 implicit / password 模式。
 *   MCP 规范要求的就是授权码 + PKCE，多实现一种模式只是多一个出错面。
 */

const crypto = require('node:crypto');
const cfg = require('./config');
const supa = require('./supa');
const tokens = require('./tokens');

/* ------------------------------------------------------------------ 常量 */

/** 目前只定义一个 scope。细粒度 scope（按工具/按设备）是后续按需项。 */
const SCOPE_DEFAULT = 'mcp:tools';
const SUPPORTED_SCOPES = [SCOPE_DEFAULT];

/** access token 默认 1 小时。客户端会拿 refresh_token 自动续期。 */
const ACCESS_TTL_S = 3600;
/** refresh token 30 天。超期要重新走一次浏览器授权。 */
const REFRESH_TTL_S = 30 * 86400;
/** 授权码 60 秒。它只是"立刻兑换"的凭据，不需要长命。 */
const CODE_TTL_S = 60;

/* ------------------------------------------------------------------ 工具 */

function sha256hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** PKCE S256：base64url(SHA256(verifier))。 */
function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** 授权码的存储键。 */
const codeKey = (code) => sha256hex(code);

/* ------------------------------------------------------- 元数据文档 */

/**
 * 本服务的 MCP 资源标识（RFC 8707 的 resource）。
 *
 * 三个地方必须**用同一个值**，任何一处不一致都会让令牌被拒：
 *   · PRM 里的 resource             —— 客户端据此知道令牌是给谁的
 *   · authorize 请求的 resource 参数 —— 客户端原样回传
 *   · 401 challenge 与校验时的期望值
 * 所以只在这里算一次，别处一律引用它。
 */
function mcpResourceUrl() {
  const path = cfg.MCP_PATH_TOKEN ? `/t/${cfg.MCP_PATH_TOKEN}/mcp` : '/mcp';
  return `${cfg.RELAY_PUBLIC_URL}${path}`;
}

/**
 * 资源服务器元数据（RFC 9728）。
 *
 * 这个文档是**整条链路的第一跳**：ChatGPT 收到 401 的 WWW-Authenticate 后
 * 来这里拿 authorization_servers，才知道该把用户送去哪里登录。
 *
 * 历史备注：本函数此前返回 `bearer_methods_supported: []`，注释写着
 * "告诉客户端别走 OAuth，本服务只接受静态令牌"。那个决策是错的 ——
 * 静态令牌无法区分终端用户，直接把多租户压成了单租户。现在改为
 * 正式声明授权服务器，客户端会为**每个用户**各自走一次授权。
 */
function protectedResourceMetadata(req) {
  const issuer = cfg.RELAY_PUBLIC_URL;
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [issuer],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Remote MCP Relay',
  };
}

/**
 * 授权服务器元数据（RFC 8414）。
 *
 * 客户端按这个文档决定：把用户送去哪个 authorize、去哪里换 token、
 * 以及**用哪种方式取得 client_id**。
 *
 * 客户端的注册方式优先级（MCP 规范明确定义）：
 *   ① 预注册  ② CIMD  ③ DCR
 * 选择依据是元数据里的两个字段：
 *   · `client_id_metadata_document_supported: true` → 可以用 CIMD
 *   · `registration_endpoint` 存在                  → 可以用 DCR
 *
 * **我们只实现了 DCR，所以刻意不声明 CIMD 支持。** 不声明，规范客户端
 * 就按优先级回落到 DCR。这里曾经写着"两个都支持最省事" —— 那是假的：
 * `loadClient()` 只会拿 client_id 去 mcp_oauth_clients 做行查询，
 * 遇到 CIMD 的 URL 形式 client_id 会直接判为未注册。
 * 要真支持 CIMD，得做三件事：抓取 https 元数据文档（含 SSRF 防护）、
 * 校验文档内 client_id 与 URL 逐字相等、用文档里的 redirect_uris 做白名单。
 */
function authorizationServerMetadata(req) {
  const issuer = cfg.RELAY_PUBLIC_URL;
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    scopes_supported: SUPPORTED_SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    // 我们会在授权响应里回带 iss，客户端可据此确认"响应确实来自本 issuer"。
    authorization_response_iss_parameter_supported: true,
  };
}

/* --------------------------------------------------------- 动态注册 */

class OAuthError extends Error {
  constructor(error, description, status = 400) {
    super(description || error);
    this.name = 'OAuthError';
    this.oauthError = error;
    this.status = status;
  }

  /** RFC 6749 §5.2 的错误响应体。 */
  body() {
    return { error: this.oauthError, error_description: this.message };
  }
}

/**
 * 校验一个 redirect_uri。
 *
 * 规则严格到近乎偏执，因为 redirect_uri 是授权码流程的**唯一出口**：
 * 一旦能被篡改，攻击者就能把别人的授权码收进自己口袋。
 *
 *   1. 必须 https（localhost / 127.0.0.1 / ::1 例外，方便本地开发）
 *   2. 不允许 fragment（规范明令禁止）
 *   3. 注册与授权时**精确字符串比对**，不做前缀匹配、不做通配符
 */
function validateRedirectUri(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return '不是合法的 URL';
  }
  if (u.hash) return '不允许带 fragment（#）';
  const host = u.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback)) {
    return '必须是 https（本地回环地址可用 http）';
  }
  return null;
}

/**
 * 动态客户端注册（RFC 7591）。
 *
 * 不预置客户端、不做白名单：ChatGPT / Claude / Codex / Cursor 各家的回调地址
 * 会变，硬编码等于每次都要改代码重新部署。安全边界不靠"谁注册了"，
 * 而靠后面那三件必须做对的事 —— redirect_uri 精确比对、PKCE 强制、
 * 以及**授权页上那个真人的同意**。
 */
async function register(body, { ip = null } = {}) {
  const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter(Boolean) : [];
  if (!redirectUris.length) throw new OAuthError('invalid_redirect_uri', 'redirect_uris 不能为空');
  if (redirectUris.length > 10) throw new OAuthError('invalid_redirect_uri', 'redirect_uris 最多 10 个');

  for (const uri of redirectUris) {
    const bad = validateRedirectUri(uri);
    if (bad) throw new OAuthError('invalid_redirect_uri', `redirect_uri "${uri}" 不合法：${bad}`);
  }

  // 只接受我们真正实现的能力。客户端要求别的模式就明确拒绝，
  // 而不是假装支持 —— 那会让它在运行到一半时神秘失败。
  const grantTypes = Array.isArray(body?.grant_types) ? body.grant_types : ['authorization_code', 'refresh_token'];
  for (const g of grantTypes) {
    if (g !== 'authorization_code' && g !== 'refresh_token') {
      throw new OAuthError('invalid_client_metadata', `不支持的 grant_type：${g}`);
    }
  }
  const authMethod = body?.token_endpoint_auth_method || 'none';
  if (authMethod !== 'none') {
    throw new OAuthError('invalid_client_metadata', `本服务只接受公开客户端（token_endpoint_auth_method=none），收到 "${authMethod}"`);
  }

  const clientId = `mcp_${randomToken(16)}`;
  await supa.rest.insert(
    'mcp_oauth_clients',
    {
      client_id: clientId,
      client_name: String(body?.client_name || '').slice(0, 200),
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE_DEFAULT,
      client_uri: body?.client_uri ? String(body.client_uri).slice(0, 500) : null,
      logo_uri: body?.logo_uri ? String(body.logo_uri).slice(0, 500) : null,
      created_ip: ip,
    },
    { returning: false }
  );

  await supa.audit({
    actor: 'anonymous',
    action: 'oauth.client.register',
    target: clientId,
    detail: { client_name: body?.client_name || '', redirect_uris: redirectUris },
    ip,
  });

  console.log(`[oauth] 注册客户端 ${clientId} "${body?.client_name || '(无名)'}" → ${redirectUris.join(', ')}`);

  return {
    client_id: clientId,
    client_name: String(body?.client_name || ''),
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SCOPE_DEFAULT,
    // 规范要求返回注册时间，客户端会据此判断是否需要重新注册
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
}

/* ------------------------------------------------------------- 客户端 */

async function loadClient(clientId) {
  if (!clientId) throw new OAuthError('invalid_client', '缺少 client_id', 401);
  const rows = await supa.rest.select('mcp_oauth_clients', {
    client_id: `eq.${clientId}`,
    select: '*',
    limit: '1',
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) throw new OAuthError('invalid_client', 'client_id 未注册', 401);
  if (row.revoked_at) throw new OAuthError('invalid_client', 'client_id 已被吊销', 401);
  return row;
}

/* ------------------------------------------------------------- 授权码 */

/**
 * 校验一个授权请求。
 *
 * 只做"这个请求本身是否成立"的判断，**不碰用户身份** —— 登录与否由路由层
 * 决定（没登录就先把用户送去 /login，登录完再回到这里重放一次同样的参数）。
 * 这样"参数合法性"与"用户是谁"两件事各自独立，审计时也能分清是哪种拒绝。
 */
async function validateAuthorizeRequest(q) {
  // 授权端点**不能**回 invalid_client / 401。
  //
  // 两个原因：
  //   · invalid_client 是 RFC 6749 §5.2（令牌端点）的错误码；授权端点的合法错误码里
  //     没有它，规范要求的对应码是 invalid_request（§4.1.2.1）。
  //   · 更实际的一层：**401 是"去重新发现"的信号**。会做 OAuth 发现的客户端
  //     （ChatGPT 就是）看到 401 会再走一遍 PRM → AS metadata → authorize，
  //     而我们这里仍然拒它 —— 用户卡在循环里，看不到任何有意义的提示。
  //     400 + 错误页则是一次性、可读的失败。
  const client = await loadClient(q.client_id).catch((err) => {
    if (err instanceof OAuthError) {
      throw new OAuthError('invalid_request', err.message, 400);
    }
    throw err;
  });

  if (!q.redirect_uri) throw new OAuthError('invalid_request', '缺少 redirect_uri');
  if (!client.redirect_uris.includes(q.redirect_uri)) {
    // 注意：这里是**硬拒绝**，不重定向回 redirect_uri ——
    // 那等于把错误送到一个未经验证的地址上。
    throw new OAuthError('invalid_request', `redirect_uri 未在客户端注册：${q.redirect_uri}`);
  }

  // 走到这里说明 client 与 redirect_uri 都已可信。**从这里往后的任何错误
  // 都可以安全地回传到该地址**（按规范带 error / error_description / state），
  // 让客户端能正常拿到错误而不是卡在等待回调上。打上 redirectable 标记，
  // 由路由层决定是重定向还是渲染错误页。
  try {
    if (q.response_type !== 'code') {
      throw new OAuthError('unsupported_response_type', `只支持 response_type=code，收到 "${q.response_type}"`);
    }

    if (!q.code_challenge) {
      throw new OAuthError('invalid_request', '缺少 code_challenge（本服务强制 PKCE）');
    }
    const method = String(q.code_challenge_method || 'S256').toUpperCase();
    if (method !== 'S256') {
      throw new OAuthError('invalid_request', `只支持 code_challenge_method=S256，收到 "${q.code_challenge_method}"`);
    }

    // RFC 8707：客户端声明这枚令牌要给哪个资源用。只接受指向本服务的值 ——
    // 接受别的值等于同意签发一枚"打别人"的令牌，那正是它要防的事。
    const expectedResource = mcpResourceUrl();
    if (q.resource && q.resource !== expectedResource) {
      throw new OAuthError('invalid_target', `resource 必须是 ${expectedResource}`);
    }

    const requested = String(q.scope || SCOPE_DEFAULT).split(/\s+/).filter(Boolean);
    const unsupported = requested.filter((s) => !SUPPORTED_SCOPES.includes(s));
    if (unsupported.length) {
      throw new OAuthError('invalid_scope', `不支持的 scope：${unsupported.join(' ')}`);
    }

    return { client, scope: requested.join(' ') || SCOPE_DEFAULT, resource: q.resource || expectedResource };
  } catch (err) {
    if (err instanceof OAuthError) {
      err.redirectable = true;
      err.redirectUri = q.redirect_uri;
      err.state = q.state || null;
    }
    throw err;
  }
}

/**
 * 用户同意后签发授权码。
 *
 * 同时 upsert 一行 mcp_oauth_grants —— **这就是身份映射被固化的那一刻**。
 * 放在签发授权码这一步而不是等换 token 成功，是因为用户"批准了这个应用"
 * 这个事实本身就该被记下来（哪怕后面换 token 失败，控制台也该看到这次授权）。
 */
async function issueCode({ user, client, redirectUri, scope, resource, codeChallenge, ip = null }) {
  const code = randomToken(32);
  const now = Date.now();

  await supa.rest.insert('mcp_oauth_codes', {
    code_hash: codeKey(code),
    client_id: client.client_id,
    user_id: user.uid,
    redirect_uri: redirectUri,
    scope,
    resource,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    expires_at: new Date(now + CODE_TTL_S * 1000).toISOString(),
  });

  await upsertGrant({ userId: user.uid, clientId: client.client_id, scope, ip });

  return code;
}

/** 记录/刷新一条授权关系。同一 (user, client) 重复授权只更新时间戳。 */
async function upsertGrant({ userId, clientId, scope, ip = null }) {
  const existing = await supa.rest.select('mcp_oauth_grants', {
    user_id: `eq.${userId}`,
    client_id: `eq.${clientId}`,
    select: 'id,revoked_at',
    limit: '1',
  });
  const row = Array.isArray(existing) ? existing[0] : existing;
  const nowIso = new Date().toISOString();

  if (row) {
    // 重新授权 = 用户改主意了（之前撤销过）。把 revoked_at 清掉。
    await supa.rest.update(
      'mcp_oauth_grants',
      { id: `eq.${row.id}` },
      { scope, last_authorized_at: nowIso, revoked_at: null }
    );
  } else {
    await supa.rest.insert('mcp_oauth_grants', {
      user_id: userId,
      client_id: clientId,
      scope,
      last_authorized_at: nowIso,
    });
  }
}

/**
 * 兑换授权码。
 *
 * 三个必须依次通过的闸门：**存在且未用过 → 未过期 → PKCE 匹配**。
 * 顺序不能换：先判 PKCE 再判"用过没有"，会让攻击者用错误的 verifier 反复
 * 试探一个已被消费的码（虽然结果都是拒绝，但白白多了一次哈希比对）。
 *
 * consumed_at 的写入用 `where consumed_at is null` 做**条件更新**，
 * 而不是"先读后写" —— 后者在并发下存在竞态：两个请求同时读到未消费状态，
 * 双双通过检查，同一个码换出两枚 token。
 */
async function consumeCode({ code, clientId, redirectUri, codeVerifier }) {
  if (!code) throw new OAuthError('invalid_request', '缺少 code');
  const rows = await supa.rest.select('mcp_oauth_codes', {
    code_hash: `eq.${codeKey(code)}`,
    select: '*',
    limit: '1',
  });
  const rec = Array.isArray(rows) ? rows[0] : rows;
  if (!rec) throw new OAuthError('invalid_grant', '授权码不存在');
  if (rec.consumed_at) throw new OAuthError('invalid_grant', '授权码已被使用过');
  if (Date.parse(rec.expires_at) <= Date.now()) throw new OAuthError('invalid_grant', '授权码已过期');
  if (rec.client_id !== clientId) throw new OAuthError('invalid_grant', '授权码不属于该 client_id');
  if (redirectUri !== rec.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri 与授权请求不一致');

  if (!codeVerifier) throw new OAuthError('invalid_grant', '缺少 code_verifier');
  if (pkceChallenge(codeVerifier) !== rec.code_challenge) {
    throw new OAuthError('invalid_grant', 'PKCE 校验失败');
  }

  // 条件更新：只有真正把 consumed_at 从 null 改成有值时，这次兑换才算数。
  //
  // 为什么必须带 `consumed_at: 'is.null'` 这个条件而不是直接按主键更新：
  // 两个并发请求可能同时读到"未消费"状态、双双通过上面的检查。带上条件
  // 后，数据库层只让其中一个把 null 改成时间戳，另一个 affected=0 → 被拒。
  // 少了这一条，同一个授权码能换出两枚 token。
  const claimed = await supa.rest.update(
    'mcp_oauth_codes',
    { code_hash: `eq.${rec.code_hash}`, consumed_at: 'is.null' },
    { consumed_at: new Date().toISOString() }
  );
  if (!Array.isArray(claimed) || claimed.length === 0) {
    throw new OAuthError('invalid_grant', '授权码已被使用过');
  }

  return rec;
}

/* ------------------------------------------------------------- 令牌 */

/**
 * 签发一对 access/refresh token。
 *
 * access token 走 tokens.js 那套 `rmcp_<prefix>_<secret>` 形态，
 * 于是 /mcp 的校验路径**完全不用改**：拿到什么令牌都走同一个 verify()。
 * 这是刻意的 —— 两套校验逻辑必然漂移，而漂移的那一侧通常就是漏洞。
 *
 * refresh token 是一串纯随机值，库里只存 sha256。轮换时直接改写
 * refresh_token_hash，旧值随之消失，不需要额外的黑名单表。
 */
async function issueTokens({ userId, client, scope, ip = null }) {
  const gen = tokens.generate();
  const refresh = randomToken(32);
  const now = Date.now();

  await supa.rest.insert(
    'mcp_api_tokens',
    {
      user_id: userId,
      label: client.client_name || `OAuth · ${client.client_id.slice(0, 12)}`,
      prefix: gen.prefix,
      token_hash: gen.tokenHash,
      kind: 'oauth',
      client_id: client.client_id,
      refresh_token_hash: sha256hex(refresh),
      refresh_expires_at: new Date(now + REFRESH_TTL_S * 1000).toISOString(),
      created_ip: ip,
      expires_at: new Date(now + ACCESS_TTL_S * 1000).toISOString(),
    },
    { returning: false }
  );

  await supa.audit({
    userId,
    actor: 'tenant',
    action: 'oauth.token.issue',
    target: gen.prefix,
    detail: { client_id: client.client_id, client_name: client.client_name, scope },
    ip,
  });

  return {
    access_token: gen.token,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope,
  };
}

/**
 * 用 refresh_token 换新的一对令牌（轮换）。
 *
 * 这里有一次**无租户条件的数据库查询**（按 refresh_token_hash 查）——
 * 与 tokens.js 的 loadByPrefix 同理：身份还没建立起来，正是要靠这次查询
 * 才知道查的是哪个租户。查的是哈希，返回的是行，泄露面为零。
 *
 * refresh token 一次性：换成功即轮换，旧值立刻失效。这样即使 refresh
 * token 被截获，攻击者用它换一次之后，真正用户的续期就会失败并暴露异常。
 */
async function refreshTokens({ refreshToken, clientId, scope: requestedScope, ip = null }) {
  if (!refreshToken) throw new OAuthError('invalid_request', '缺少 refresh_token');
  const client = await loadClient(clientId);

  const rows = await supa.rest.select('mcp_api_tokens', {
    refresh_token_hash: `eq.${sha256hex(refreshToken)}`,
    select: 'id,user_id,prefix,client_id,revoked_at,refresh_expires_at,refresh_token_hash',
    limit: '1',
  });
  const rec = Array.isArray(rows) ? rows[0] : rows;
  if (!rec) throw new OAuthError('invalid_grant', 'refresh_token 无效');
  if (rec.revoked_at) throw new OAuthError('invalid_grant', '该授权已被吊销');
  if (rec.client_id !== client.client_id) throw new OAuthError('invalid_grant', 'refresh_token 不属于该客户端');
  if (!rec.refresh_expires_at || Date.parse(rec.refresh_expires_at) <= Date.now()) {
    throw new OAuthError('invalid_grant', 'refresh_token 已过期，请重新授权');
  }

  // 授权被撤销后不该还能续期 —— grants 是"用户是否还同意"的真源。
  const grant = await supa.rest.select('mcp_oauth_grants', {
    user_id: `eq.${rec.user_id}`,
    client_id: `eq.${client.client_id}`,
    select: 'revoked_at',
    limit: '1',
  });
  const g = Array.isArray(grant) ? grant[0] : grant;
  if (!g || g.revoked_at) throw new OAuthError('invalid_grant', '授权已被撤销，请重新授权');

  const scope = requestedScope || SCOPE_DEFAULT;

  // 轮换：新 access + 新 refresh，写进同一行。
  // 旧的 refresh_token_hash 被覆盖 ⇒ 旧 refresh 立即失效（一次性语义）。
  const gen = tokens.generate();
  const newRefresh = randomToken(32);
  const now = Date.now();

  await supa.rest.update(
    'mcp_api_tokens',
    { id: `eq.${rec.id}` },
    {
      prefix: gen.prefix,
      token_hash: gen.tokenHash,
      refresh_token_hash: sha256hex(newRefresh),
      refresh_expires_at: new Date(now + REFRESH_TTL_S * 1000).toISOString(),
      refresh_rotated_at: new Date().toISOString(),
      expires_at: new Date(now + ACCESS_TTL_S * 1000).toISOString(),
      revoked_at: null,
    }
  );

  // 旧 access token 的缓存必须清掉：它的 prefix 已经换了，
  // 但缓存里可能还留着旧 prefix → 旧行的映射（不清会继续放行旧令牌）。
  tokens.evict(rec.prefix);

  await supa.audit({
    userId: rec.user_id,
    actor: 'tenant',
    action: 'oauth.token.refresh',
    target: gen.prefix,
    detail: { client_id: client.client_id, previous_prefix: rec.prefix },
    ip,
  });

  return {
    access_token: gen.token,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: newRefresh,
    scope,
  };
}

/* --------------------------------------------------------- 令牌端点总入口 */

/**
 * POST /oauth/token 的分发。
 *
 * 所有失败都返回 OAuthError，由路由层转成规范要求的 JSON 错误体
 * （而不是 HTTP 层面的 500）—— 客户端要靠 error 字段决定是重试还是重新授权。
 */
async function token(body, { ip = null } = {}) {
  const grantType = body?.grant_type;
  if (grantType === 'authorization_code') {
    const rec = await consumeCode({
      code: body.code,
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
      codeVerifier: body.code_verifier,
    });
    const client = await loadClient(body.client_id);
    return issueTokens({ userId: rec.user_id, client, scope: rec.scope || SCOPE_DEFAULT, ip });
  }

  if (grantType === 'refresh_token') {
    return refreshTokens({
      refreshToken: body.refresh_token,
      clientId: body.client_id,
      scope: body.scope,
      ip,
    });
  }

  throw new OAuthError('unsupported_grant_type', `不支持的 grant_type：${grantType || '(空)'}`);
}

/* ------------------------------------------------------- 授权关系管理 */

/** 某个用户已授权的客户端（控制台「已授权的 AI 客户端」列表）。 */
async function listGrants(userId) {
  const rows = await supa.rest.select('mcp_oauth_grants', {
    user_id: `eq.${userId}`,
    select: 'id,client_id,scope,created_at,last_authorized_at,revoked_at',
    order: 'created_at.desc',
  });
  const grants = Array.isArray(rows) ? rows : [];
  if (!grants.length) return [];

  // 补客户端名与令牌数（客户端表在 OAuth 客户端之间是共享的，
  // 但 grant 行本身已经限定了 user_id，所以这里不构成跨租户读取）。
  const ids = [...new Set(grants.map((g) => g.client_id))];
  const clients = await supa.rest.select('mcp_oauth_clients', {
    client_id: `in.(${ids.join(',')})`,
    select: 'client_id,client_name',
  });
  const nameById = {};
  for (const c of Array.isArray(clients) ? clients : []) nameById[c.client_id] = c.client_name;

  const tokenRows = await supa.rest.select('mcp_api_tokens', {
    user_id: `eq.${userId}`,
    kind: 'eq.oauth',
    select: 'id,client_id,prefix,revoked_at,last_used_at,expires_at',
  });
  const tokensByClient = {};
  for (const t of Array.isArray(tokenRows) ? tokenRows : []) {
    (tokensByClient[t.client_id] ||= []).push(t);
  }

  return grants.map((g) => ({
    ...g,
    client_name: nameById[g.client_id] || '(未知客户端)',
    tokens: tokensByClient[g.client_id] || [],
  }));
}

/**
 * 撤销一条授权：置 grant.revoked_at **并吊销该客户端下所有 OAuth 令牌**。
 *
 * 两件事必须一起做。只置 grant 而不吊销令牌的话，那枚 access token 在
 * 它过期前（最长 1 小时）依然能通过 /mcp 的校验 —— 用户点了"撤销"却发现
 * 还能用，这是最容易被当成"撤销功能坏了"的那种 bug。
 *
 * 反向也成立：refreshTokens 每次都会回查 grant，所以撤销后连续期也一并断掉。
 */
async function revokeGrant(userId, clientId, { ip = null } = {}) {
  const rows = await supa.rest.select('mcp_oauth_grants', {
    user_id: `eq.${userId}`,
    client_id: `eq.${clientId}`,
    select: 'id,revoked_at',
    limit: '1',
  });
  const grant = Array.isArray(rows) ? rows[0] : rows;
  if (!grant) return { ok: false, reason: 'not_found' };

  const nowIso = new Date().toISOString();
  await supa.rest.update('mcp_oauth_grants', { id: `eq.${grant.id}` }, { revoked_at: nowIso });

  const live = await supa.rest.select('mcp_api_tokens', {
    user_id: `eq.${userId}`,
    client_id: `eq.${clientId}`,
    kind: 'eq.oauth',
    revoked_at: 'is.null',
    select: 'id,prefix',
  });
  const list = Array.isArray(live) ? live : [];
  for (const t of list) {
    await supa.rest.update('mcp_api_tokens', { id: `eq.${t.id}` }, { revoked_at: nowIso });
    tokens.evict(t.prefix); // 立刻让缓存失效，否则 TTL 内仍会放行
  }

  await supa.audit({
    userId,
    actor: 'tenant',
    action: 'oauth.grant.revoke',
    target: clientId,
    detail: { revoked_tokens: list.length },
    ip,
  });

  return { ok: true, revokedTokens: list.length };
}

/** 是否存在有效的授权关系（撤销后 refresh 要据此拒绝）。 */
async function hasActiveGrant(userId, clientId) {
  const rows = await supa.rest.select('mcp_oauth_grants', {
    user_id: `eq.${userId}`,
    client_id: `eq.${clientId}`,
    select: 'revoked_at',
    limit: '1',
  });
  const g = Array.isArray(rows) ? rows[0] : rows;
  return !!g && !g.revoked_at;
}

module.exports = {
  SCOPE_DEFAULT,
  SUPPORTED_SCOPES,
  ACCESS_TTL_S,
  REFRESH_TTL_S,
  CODE_TTL_S,
  OAuthError,
  pkceChallenge,
  mcpResourceUrl,
  validateRedirectUri,
  protectedResourceMetadata,
  authorizationServerMetadata,
  register,
  loadClient,
  validateAuthorizeRequest,
  issueCode,
  upsertGrant,
  consumeCode,
  issueTokens,
  refreshTokens,
  token,
  listGrants,
  revokeGrant,
  hasActiveGrant,
};
