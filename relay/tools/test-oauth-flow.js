#!/usr/bin/env node
'use strict';
/**
 * OAuth 2.1 端到端验收 —— 模拟一个真实 MCP 客户端（ChatGPT 扮演的那个角色）。
 *
 * 这个脚本存在的理由：OAuth 的失败模式几乎全部发生在**状态与顺序**上
 * （授权码重放、PKCE 不匹配、refresh 不轮换、撤销不即时生效），
 * 而这些都不是"看一眼代码就能确认对"的东西。必须真跑一遍。
 *
 * 它按 MCP 规范里客户端的实际行为走完整条链路：
 *
 *   ① 无令牌打 /mcp          → 期望 401 + WWW-Authenticate(resource_metadata, scope)
 *   ② 读 PRM                 → 期望 authorization_servers 指向本服务
 *   ③ 读 AS metadata         → 期望 authorization/token/registration 三个端点
 *   ④ DCR 注册               → 期望拿到 client_id
 *   ⑤ 授权页（未登录→登录）   → 期望 302 到 /login 且 next 保留原始查询串
 *   ⑥ 批准                   → 期望 302 回 redirect_uri?code&state&iss
 *   ⑦ 换令牌                 → 期望 access_token + refresh_token
 *   ⑧ 带令牌调 tools/call    → 期望真实执行到设备
 *   ⑨ 跨租户隔离             → 期望 B 的令牌碰不到 A 的设备
 *   ⑩ refresh 轮换           → 期望旧 refresh 失效、旧 access 失效
 *   ⑪ 撤销授权               → 期望立刻 401（不等过期）
 *
 * 用法：
 *   node relay/tools/test-oauth-flow.js                     # 打 18087（本地测试实例）
 *   RELAY_TEST_BASE=http://127.0.0.1:18086 node ...          # 打线上实例
 *
 * 注意它会**真的创建账号并授权设备**，只应在测试实例上跑。
 * 跑完会清理临时账号；owner 账号上的测试授权也会撤销。
 */

const crypto = require('node:crypto');
const cfg = require('../src/config');
const supa = require('../src/supa');

const BASE = (process.env.RELAY_TEST_BASE || 'http://127.0.0.1:18087').replace(/\/+$/, '');
const MCP_URL = `${BASE}/mcp`;
/**
 * 期望的 issuer。
 *
 * 默认就是 BASE —— 因为被测实例必须以自己对外可见的地址作为 issuer，
 * 否则 PRM 里的 authorization_servers 会指向另一个地址，客户端会走错门。
 * 用独立环境变量留一个覆盖口子，用于反代场景（外部域名 ≠ 内部地址）。
 */
const EXPECTED_ISSUER = (process.env.RELAY_EXPECTED_ISSUER || BASE).replace(/\/+$/, '');
const TENANT_B_EMAIL = 'oauth-tenant-b@relay.test';
const TENANT_B_PASSWORD = 'oauth-test-b-4471';

const OWNER_EMAIL = cfg.OWNER_EMAIL;
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || cfg.OWNER_PASSWORD;

let passed = 0;
let failed = 0;
const failures = [];

function check(ok, label, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? `\n      ← ${detail}` : ''}`);
  }
}

function phase(title) {
  console.log(`\n${title}`);
}

function note(text) {
  console.log(`    · ${text}`);
}

/* ------------------------------------------------------------- HTTP 客户端 */

/** 带 cookie jar 的会话 —— 模拟一个浏览器。 */
function makeSession() {
  const jar = new Map();

  async function req(path, { method = 'GET', json, form, token, headers = {}, redirect = 'manual' } = {}) {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    if (token) h.authorization = `Bearer ${token}`;

    const res = await fetch(new URL(path, BASE), {
      method,
      headers: h,
      body,
      redirect,
      signal: AbortSignal.timeout(30000),
    });

    // 收集 Set-Cookie（Node 18.14+ 提供 getSetCookie）
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }

    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 非 JSON 就留 null */
    }
    return {
      status: res.status,
      headers: res.headers,
      text,
      json: parsed,
      location: res.headers.get('location'),
    };
  }

  return { req, jar };
}

/* ------------------------------------------------------------------ PKCE */

function makePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/* ---------------------------------------------------------------- MCP 调用 */

function parseSse(text) {
  const m = /^data:\s*(.+)$/m.exec(text);
  try {
    return JSON.parse(m ? m[1] : text);
  } catch {
    return null;
  }
}

async function mcpPost(body, { token, sid } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (sid) headers['mcp-session-id'] = sid;

  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  return {
    status: res.status,
    sid: res.headers.get('mcp-session-id'),
    wwwAuth: res.headers.get('www-authenticate'),
    json: parseSse(text),
    text,
  };
}

/** 用一枚令牌跑一遍 initialize + tools/list，返回是否成功。 */
async function probeMcp(token) {
  const init = await mcpPost(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'oauth-flow-test', version: '1' } } },
    { token }
  );
  if (init.status !== 200) return { ok: false, status: init.status, wwwAuth: init.wwwAuth };

  await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, { token, sid: init.sid });
  const list = await mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { token, sid: init.sid });
  const tools = list.json?.result?.tools || [];
  return { ok: true, status: 200, sid: init.sid, toolCount: tools.length };
}

/* ------------------------------------------------------------- 账号准备 */

async function deleteUserByEmail(email) {
  const u = await supa.auth.findByEmail(email).catch(() => null);
  if (!u) return false;
  await supa.request(`${cfg.SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
    method: 'DELETE',
    headers: supa.secretKeyHeaders(),
    timeoutMs: 20000,
  }).catch(() => {});
  return true;
}

/* ------------------------------------------------------------------- 主流程 */

(async () => {
  console.log(`OAuth 2.1 端到端验收 —— 目标 ${BASE}`);
  console.log(`issuer 期望值：${EXPECTED_ISSUER}`);
  console.log(`owner 账号：${OWNER_EMAIL}`);

  // 清理上次残留（上一次跑到一半中断会留下）
  await deleteUserByEmail(TENANT_B_EMAIL);

  const browser = makeSession(); // 模拟"用户自己的浏览器"
  let clientId = null;

  try {
    /* ============================================================ ① 发现 */
    phase('① 未授权时 /mcp 的行为');

    const anon = await mcpPost({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'anon', version: '1' } },
    });
    check(anon.status === 401, '无令牌打 /mcp 得到 401', `实际 HTTP ${anon.status}`);
    check(!!anon.wwwAuth, '响应带 WWW-Authenticate 头', `头值：${anon.wwwAuth}`);
    check(
      !!anon.wwwAuth && /resource_metadata="/.test(anon.wwwAuth),
      'WWW-Authenticate 含 resource_metadata（客户端据此发现授权服务器）',
      `头值：${anon.wwwAuth}`
    );
    check(
      !!anon.wwwAuth && /scope="/.test(anon.wwwAuth),
      'WWW-Authenticate 含 scope（告诉客户端要申请什么权限）',
      `头值：${anon.wwwAuth}`
    );
    check(
      anon.status === 401 && !/#|stack|Error:/i.test(anon.text.slice(0, 400)),
      '错误响应体不泄露内部细节（不区分"不存在/已吊销/已过期"）'
    );

    phase('② 资源服务器元数据 (RFC 9728)');
    const prm = await browser.req('/.well-known/oauth-protected-resource');
    check(prm.status === 200, 'GET /.well-known/oauth-protected-resource → 200', `实际 HTTP ${prm.status}`);
    const asList = prm.json?.authorization_servers || [];
    check(asList.length > 0, '已经声明 authorization_servers（不再是空数组放弃 OAuth）', JSON.stringify(prm.json));
    check(
      asList.includes(EXPECTED_ISSUER),
      `authorization_servers 指向本服务 ${EXPECTED_ISSUER}`,
      JSON.stringify(asList)
    );
    check(
      prm.json?.resource === `${EXPECTED_ISSUER}/mcp`,
      'resource 与本服务的 MCP 端点一致',
      `实际：${prm.json?.resource}`
    );

    const prmPath = await browser.req('/.well-known/oauth-protected-resource/mcp');
    check(prmPath.status === 200, '带路径的 RFC 9728 形式也能取到（隧道两种都会探）', `实际 HTTP ${prmPath.status}`);

    phase('③ 授权服务器元数据 (RFC 8414)');
    const asm = await browser.req('/.well-known/oauth-authorization-server');
    check(asm.status === 200, 'GET /.well-known/oauth-authorization-server → 200', `实际 HTTP ${asm.status}`);
    check(asm.json?.issuer === EXPECTED_ISSUER, 'issuer 与 RELAY_PUBLIC_URL 一致', `实际：${asm.json?.issuer}`);
    check(!!asm.json?.authorization_endpoint, '声明了 authorization_endpoint');
    check(!!asm.json?.token_endpoint, '声明了 token_endpoint');
    check(!!asm.json?.registration_endpoint, '声明了 registration_endpoint（支持 DCR）');
    check(
      Array.isArray(asm.json?.code_challenge_methods_supported) && asm.json.code_challenge_methods_supported.includes('S256'),
      '声明支持 PKCE S256'
    );

    /* ============================================================== ④ DCR */
    phase('④ 动态客户端注册 (RFC 7591)');

    const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const reg = await browser.req('/oauth/register', {
      method: 'POST',
      json: { client_name: 'ChatGPT (验收)', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' },
    });
    check(reg.status === 201, '注册合法客户端 → 201', `实际 HTTP ${reg.status} ${reg.text.slice(0, 200)}`);
    clientId = reg.json?.client_id;
    check(!!clientId && clientId.startsWith('mcp_'), '拿到 client_id', `实际：${clientId}`);
    check(reg.json?.redirect_uris?.includes(redirectUri), '注册响应回显 redirect_uris');

    const badScheme = await browser.req('/oauth/register', {
      method: 'POST',
      json: { client_name: '坏客户端', redirect_uris: ['http://evil.example.com/cb'] },
    });
    check(badScheme.status === 400, '拒绝 http 非回环的 redirect_uri（防明文劫持）', `实际 HTTP ${badScheme.status}`);

    const noUri = await browser.req('/oauth/register', {
      method: 'POST',
      json: { client_name: '空回调', redirect_uris: [] },
    });
    check(noUri.status === 400, '拒绝空 redirect_uris', `实际 HTTP ${noUri.status}`);

    /* ============================================================ ⑤⑥ 授权 */
    phase('⑤ 授权页：未登录 → 登录');

    const pkce = makePkce();
    const authQuery = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      scope: 'mcp:tools',
      resource: `${EXPECTED_ISSUER}/mcp`,
      state: 'state-' + crypto.randomBytes(8).toString('hex'),
    });

    const notLogged = await browser.req(`/oauth/authorize?${authQuery}`);
    check(notLogged.status === 302, '未登录时 GET /oauth/authorize → 302 到登录页', `实际 HTTP ${notLogged.status}`);
    check(
      !!notLogged.location && notLogged.location.startsWith('/login') && notLogged.location.includes('next='),
      '重定向到 /login 且带 next（登录后要能重放同一个授权请求）',
      `Location: ${notLogged.location}`
    );
    const decodedNext = decodeURIComponent(notLogged.location || '');
    check(
      decodedNext.includes('code_challenge') && decodedNext.includes('client_id'),
      'next 里保留了完整授权参数（否则登录回来就丢了 PKCE 上下文）',
      decodedNext.slice(0, 160)
    );

    // 用 owner 账号登录 —— 它名下有真实在线的设备，才能验证"带令牌真的能调工具"
    const login = await browser.req('/login', {
      method: 'POST',
      form: { email: OWNER_EMAIL, password: OWNER_PASSWORD, next: '/console' },
      headers: { origin: BASE },
    });
    const loggedIn = login.status === 302 && !String(login.location || '').includes('/login?');
    check(loggedIn, `owner 账号 (${OWNER_EMAIL}) 登录成功`, `HTTP ${login.status} → ${login.location}`);
    if (!loggedIn) {
      console.log('\n  ⚠ 无法登录 owner 账号，后续需要登录态的用例会失败。');
      console.log('    可设 OWNER_PASSWORD 环境变量覆盖。');
    }

    const consent = await browser.req(`/oauth/authorize?${authQuery}`);
    check(consent.status === 200, '已登录时 GET /oauth/authorize → 200 同意页', `实际 HTTP ${consent.status}`);
    check(consent.text.includes('ChatGPT (验收)'), '同意页显示客户端名字（用户要能分辨自己在批谁）');
    check(consent.text.includes(OWNER_EMAIL), '同意页显示将绑定到哪个账号（这是最关键的一句话）');
    check(consent.text.includes('mcp:tools'), '同意页列出请求的 scope');

    const wrongRedirect = await browser.req(
      `/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(authQuery), redirect_uri: 'https://evil.example.com/cb' })}`
    );
    check(
      wrongRedirect.status === 400 && !wrongRedirect.location,
      '未注册的 redirect_uri 被硬拒绝且**不重定向**（否则等于开放反射点）',
      `HTTP ${wrongRedirect.status} location=${wrongRedirect.location}`
    );

    // 授权端点回 401 是个陷阱：会做 OAuth 发现的客户端（ChatGPT 就是）把 401 理解成
    // "去重新发现一次"，于是 PRM → AS metadata → authorize → 又 401，用户卡在循环里。
    // 规范上这个端点的错误码也应当是 invalid_request（400），不是 invalid_client（令牌端点用）。
    const unknownClient = await browser.req(
      `/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(authQuery), client_id: 'mcp_不存在的客户端' })}`
    );
    check(
      unknownClient.status === 400,
      '未注册的 client_id → 400（**不是 401**，否则客户端会陷入重新发现的循环）',
      `HTTP ${unknownClient.status}`
    );

    // 规范把授权端点的错误分两层：redirect_uri 与 client 都验证通过之后，
    // 后续错误必须**重定向回客户端**（带 error/state/iss），让客户端能正常收到失败通知；
    // 在这之前的错误（client 不存在、redirect_uri 不匹配）只能硬拒绝 ——
    // 重定向会把错误送到一个未经验证的地址上，那是个开放的反射点。
    const noPkce = await browser.req(
      `/oauth/authorize?${new URLSearchParams(
        Object.fromEntries(Object.entries(Object.fromEntries(authQuery)).filter(([k]) => k !== 'code_challenge'))
      )}`
    );
    check(
      noPkce.status === 302 &&
        String(noPkce.location || '').startsWith(redirectUri) &&
        String(noPkce.location || '').includes('error=invalid_request'),
      '缺少 code_challenge → 302 回客户端并带 error=invalid_request（本服务强制 PKCE）',
      `HTTP ${noPkce.status} Location: ${String(noPkce.location || '').slice(0, 140)}`
    );
    check(
      String(noPkce.location || '').includes('state=' + authQuery.get('state')) &&
        String(noPkce.location || '').includes('iss='),
      '错误响应里带回了 state 与 iss（客户端才能确认这是它那次请求、且来自本 issuer）',
      String(noPkce.location || '').slice(0, 140)
    );

    const badScope = await browser.req(
      `/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(authQuery), scope: 'mcp:tools admin:everything' })}`
    );
    check(
      badScope.status === 302 && String(badScope.location || '').includes('error=invalid_scope'),
      '请求不支持的 scope → 302 回客户端并带 error=invalid_scope（不假装支持）',
      `HTTP ${badScope.status} Location: ${String(badScope.location || '').slice(0, 140)}`
    );

    phase('⑥ 批准 → 授权码');

    const approve = await browser.req('/oauth/authorize', {
      method: 'POST',
      form: { ...Object.fromEntries(authQuery), decision: 'approve' },
      headers: { origin: BASE },
    });
    check(approve.status === 302, '批准 → 302 回客户端', `实际 HTTP ${approve.status}`);
    const back = approve.location ? new URL(approve.location) : null;
    check(back?.origin + back?.pathname === 'https://chatgpt.com/connector_platform_oauth_redirect', '重定向到注册时的 redirect_uri', `Location: ${approve.location}`);
    const code = back?.searchParams.get('code');
    check(!!code, '回跳里带 authorization code');
    check(back?.searchParams.get('state') === authQuery.get('state'), 'state 原样回传（防 CSRF 的关键）', `实际：${back?.searchParams.get('state')}`);
    check(back?.searchParams.get('iss') === EXPECTED_ISSUER, '带 iss 参数（客户端可确认响应确实来自本 issuer）', `实际：${back?.searchParams.get('iss')}`);

    /* ========================================================== ⑦ 换令牌 */
    phase('⑦ 令牌端点');

    const badVerifier = await browser.req('/oauth/token', {
      method: 'POST',
      form: { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: 'wrong-verifier' },
    });
    check(badVerifier.status === 400 && badVerifier.json?.error === 'invalid_grant', '错误的 code_verifier 被拒（PKCE 真的在生效）', JSON.stringify(badVerifier.json));

    // 上面那次失败不能消费掉授权码 —— 只有完全通过校验才会标记 consumed。
    const tokenRes = await browser.req('/oauth/token', {
      method: 'POST',
      form: { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: pkce.verifier },
    });
    check(tokenRes.status === 200, '正确的 code + verifier 换到令牌', `实际 HTTP ${tokenRes.status} ${tokenRes.text.slice(0, 200)}`);
    const access1 = tokenRes.json?.access_token;
    const refresh1 = tokenRes.json?.refresh_token;
    check(!!access1 && access1.startsWith('rmcp_'), 'access_token 形态正确', `实际：${String(access1).slice(0, 20)}…`);
    check(!!refresh1, '签发了 refresh_token（客户端可自动续期）');
    check(tokenRes.json?.token_type === 'Bearer', 'token_type = Bearer');
    check(Number(tokenRes.json?.expires_in) > 0, '声明了 expires_in', `实际：${tokenRes.json?.expires_in}`);

    const replay = await browser.req('/oauth/token', {
      method: 'POST',
      form: { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: pkce.verifier },
    });
    check(replay.status === 400 && replay.json?.error === 'invalid_grant', '授权码**不可重放**（第二次兑换被拒）', JSON.stringify(replay.json));

    /* ==================================================== ⑧ 带令牌调工具 */
    phase('⑧ 用 OAuth 令牌真实调用工具');

    const probe = await probeMcp(access1);
    check(probe.ok, '带 access_token 的 initialize + tools/list 成功', `HTTP ${probe.status}`);
    check(probe.toolCount === 26, `工具清单返回 26 个工具`, `实际：${probe.toolCount}`);

    if (probe.ok) {
      const call = await mcpPost(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'list_directory', arguments: { path: 'C:\\Users\\longyuan\\workspace\\remote-mcp' } },
        },
        { token: access1, sid: probe.sid }
      );
      const txt = call.json?.result?.content?.[0]?.text || call.json?.error?.message || '';
      check(
        call.status === 200 && !!txt && !call.json?.error,
        'tools/call 真实执行到设备（不是只过了鉴权）',
        `HTTP ${call.status}：${String(txt).slice(0, 200)}`
      );
      note(`设备返回前 80 字：${String(txt).replace(/\n/g, ' ').slice(0, 80)}`);
    }

    /* ======================================================== ⑨ 跨租户隔离 */
    phase('⑨ 跨租户隔离：另一个账号的令牌');

    const bUser = await supa.auth.createUser(TENANT_B_EMAIL, TENANT_B_PASSWORD);
    check(!!bUser?.id, `创建测试租户 B（${TENANT_B_EMAIL}）`);
    if (bUser?.id) {
      // 让 B 也走一遍完整 OAuth —— 用 B 的浏览器会话
      const browserB = makeSession();
      await browserB.req('/login', {
        method: 'POST',
        form: { email: TENANT_B_EMAIL, password: TENANT_B_PASSWORD, next: '/console' },
        headers: { origin: BASE },
      });
      const pkceB = makePkce();
      const approveB = await browserB.req('/oauth/authorize', {
        method: 'POST',
        form: {
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          code_challenge: pkceB.challenge,
          code_challenge_method: 'S256',
          scope: 'mcp:tools',
          resource: `${EXPECTED_ISSUER}/mcp`,
          state: 'state-b',
          decision: 'approve',
        },
        headers: { origin: BASE },
      });
      const codeB = approveB.location ? new URL(approveB.location).searchParams.get('code') : null;
      const tokenB = codeB
        ? await browserB.req('/oauth/token', {
            method: 'POST',
            form: { grant_type: 'authorization_code', code: codeB, client_id: clientId, redirect_uri: redirectUri, code_verifier: pkceB.verifier },
          })
        : null;
      const accessB = tokenB?.json?.access_token;
      check(!!accessB, '租户 B 独立走完 OAuth 并拿到自己的令牌');

      if (accessB) {
        check(accessB !== access1, '两个用户拿到的是**不同**的令牌（这正是多租户的前提）');
        const probeB = await probeMcp(accessB);
        check(probeB.ok, 'B 的令牌能通过鉴权（是有效身份）');

        // B 名下没有设备 —— 调用必须报"没有设备"，而绝不能落到 A 的设备上
        const callB = await mcpPost(
          {
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: { name: 'list_directory', arguments: { path: 'C:\\' } },
          },
          { token: accessB, sid: probeB.sid }
        );
        const msgB = callB.json?.error?.message || '';
        check(
          !callB.json?.result,
          'B 的调用**没有**被派发到 A 的设备上（隔离生效）',
          `返回：${JSON.stringify(callB.json).slice(0, 240)}`
        );
        check(
          /没有|设备/i.test(msgB),
          'B 得到的是"没有可用设备"这类合理错误（而不是 A 的设备数据）',
          `错误：${String(msgB).slice(0, 200)}`
        );

        // 数据库层面反证：B 名下确实没有任何设备
        const bDevices = await supa.rest.select('mcp_devices', { user_id: `eq.${bUser.id}`, select: 'id' });
        check(
          Array.isArray(bDevices) && bDevices.length === 0,
          'B 账号下的设备数为 0（数据库层反证）',
          `实际：${JSON.stringify(bDevices)}`
        );
      }
    }

    /* ======================================================== ⑩ refresh 轮换 */
    phase('⑩ refresh token 轮换');

    const refreshed = await browser.req('/oauth/token', {
      method: 'POST',
      form: { grant_type: 'refresh_token', refresh_token: refresh1, client_id: clientId },
    });
    check(refreshed.status === 200, '用 refresh_token 换到新令牌', `实际 HTTP ${refreshed.status} ${refreshed.text.slice(0, 160)}`);
    const access2 = refreshed.json?.access_token;
    const refresh2 = refreshed.json?.refresh_token;
    check(!!access2 && !!refresh2, '同时返回了新的 access 与 refresh');
    check(refresh2 !== refresh1, 'refresh_token 已轮换（不是原样返回）');

    const recycled = await browser.req('/oauth/token', {
      method: 'POST',
      form: { grant_type: 'refresh_token', refresh_token: refresh1, client_id: clientId },
    });
    check(
      recycled.status === 400 && recycled.json?.error === 'invalid_grant',
      '**旧** refresh_token 立刻失效（一次性语义）',
      JSON.stringify(recycled.json)
    );

    const oldAccess = await probeMcp(access1);
    check(oldAccess.ok === false, '**旧** access_token 在轮换后失效（缓存也被清干净了）', `HTTP ${oldAccess.status}`);
    const newAccess = await probeMcp(access2);
    check(newAccess.ok, '新的 access_token 可用', `HTTP ${newAccess.status}`);

    /* ========================================================= ⑪ 撤销授权 */
    phase('⑪ 撤销授权（用户自助断开）');

    const consolePage = await browser.req('/console');
    check(consolePage.status === 200 && consolePage.text.includes('ChatGPT (验收)'), '控制台「已授权的 AI 客户端」里能看到这次授权');

    const revoke = await browser.req('/console/grants/revoke', {
      method: 'POST',
      form: { client_id: clientId },
      headers: { origin: BASE },
    });
    check(revoke.status === 302 && String(revoke.location).includes('ok=grant_revoked'), '撤销成功', `HTTP ${revoke.status} → ${revoke.location}`);

    const afterRevoke = await probeMcp(access2);
    check(afterRevoke.ok === false && afterRevoke.status === 401, '撤销后 access_token **立刻** 401（不等过期）', `HTTP ${afterRevoke.status}`);

    const refreshAfter = await browser.req('/oauth/token', {
      method: 'POST',
      form: { grant_type: 'refresh_token', refresh_token: refresh2, client_id: clientId },
    });
    check(
      refreshAfter.status === 400 && refreshAfter.json?.error === 'invalid_grant',
      '撤销后 refresh 也失效（不会靠续期绕开撤销）',
      JSON.stringify(refreshAfter.json)
    );

    const consoleAfter = await browser.req('/console');
    check(consoleAfter.text.includes('已撤销'), '控制台显示该授权已撤销');

    const row = await supa.rest.select('mcp_oauth_grants', {
      client_id: `eq.${clientId}`,
      select: 'user_id,revoked_at',
      limit: '1',
    });
    check(Array.isArray(row) && row[0]?.revoked_at, '数据库里 grant.revoked_at 已置位（库层反证）', JSON.stringify(row));

    /* ---------------------------------------------------------- 汇总 */
    console.log(`\n${'─'.repeat(66)}`);
    console.log(`结果：${passed} 通过 / ${failed} 失败`);
    if (failed) {
      console.log('\n失败项：');
      for (const f of failures) console.log(`  · ${f}`);
    }
    console.log(`${'─'.repeat(66)}`);
  } catch (err) {
    console.error(`\n脚本异常中止：${err.message}`);
    console.error(err.stack);
    failed += 1;
  } finally {
    // 清理：删测试租户 B（级联删掉它的设备/令牌/授权），删本次注册的客户端
    const removedB = await deleteUserByEmail(TENANT_B_EMAIL);
    if (removedB) note('已清理测试租户 B');
    if (clientId) {
      await supa.rest.del('mcp_oauth_clients', { client_id: `eq.${clientId}` }).catch(() => {});
      note('已清理本次注册的 OAuth 客户端');
    }
  }

  process.exit(failed ? 1 : 0);
})();
