'use strict';
/**
 * 多租户隔离的对抗性验收。
 *
 * 这个脚本的目的不是"跑一遍正常流程"，而是**主动尝试越权并确认失败**。
 * 每条断言都对应一个具体的攻击面：
 *
 *   · A 的令牌指定 B 的 device_id       → 必须被拒，且不透露 B 的设备是否存在
 *   · A 的令牌自动路由                  → 必须落到 A 自己的设备上
 *   · A 的令牌读 B 的控制台             → 必须看不到 B 的任何设备/令牌/调用
 *   · 无效/已吊销令牌                    → 必须 401，且不区分失败原因
 *   · 会话 ID 跨租户复用                 → 必须拒绝（会话 ID 不是身份凭据）
 *   · 未鉴权的 /healthz                 → 不得含设备名（信息泄露）
 *   · /admin 无凭据                      → 必须 401
 *
 * 另外还验证"无令牌即 401"：RELAY_REQUIRE_AUTH 开关与匿名 owner 回落路径
 * 已随 OAuth 2.1 的引入一并删除（见 relay/src/oauth.js），所以这条现在
 * 是**无条件**成立的断言，不再随配置变化。
 *
 * 用法：
 *   node tools/test-tenant-isolation.js
 *   RELAY=http://127.0.0.1:18086 node tools/test-tenant-isolation.js
 *
 * 副作用：会创建两个测试账号、各一条设备行与令牌。设备行在结束时删除；
 * 账号保留（删账号会连带删设备与调用记录，重复跑没问题，因为邮箱固定）。
 */

const path = require('node:path');

const RELAY = (process.env.RELAY || 'http://127.0.0.1:18086').replace(/\/+$/, '');
const ORIGIN = RELAY;

// 直接复用中继自己的模块：测试要能建"对方租户的设备行"，而这条路径在
// HTTP 面上故意不开放（客户端不该能伪造设备）。
process.chdir(path.resolve(__dirname, '..'));
const supa = require('../src/supa');
const tokens = require('../src/tokens');
const cfg = require('../src/config');

const A_EMAIL = process.env.TEST_TENANT_A || cfg.OWNER_EMAIL;
const A_PASSWORD = process.env.TEST_TENANT_A_PASSWORD || cfg.OWNER_PASSWORD;
const B_EMAIL = process.env.TEST_TENANT_B || 'tenant-b@relay.test';
const PASSWORD = 'relay-test-password-9182';
const FAKE_DEVICE_NAME = '__isolation_probe_B__';

const results = [];
let currentPhase = '';

function phase(name) {
  currentPhase = name;
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 56 - name.length))}`);
}

function check(ok, label, extra = '') {
  results.push({ ok, label, phase: currentPhase, extra });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `\n          ${extra}` : ''}`);
  return ok;
}

/**
 * 看门狗：某个 await 永远不返回时，静默等待是最糟的失败模式 —— 分不清"慢"和"死"。
 *
 * 这个是被真实事故逼出来的：一条 `{ abortMs }` 因为中间函数签名没跟上而被丢弃，
 * 于是本应 4 秒掐断的请求变成了等满 300 秒设备超时，跑一次要 5 分钟，
 * 而且没有任何输出说明卡在哪。
 *
 * 正常路径 `finish()` 会 process.exit()，所以它不会误触发。
 * 阈值可用 TEST_WATCHDOG_MS 覆盖（比如针对慢机器调大）。
 */
const WATCHDOG_MS = Number(process.env.TEST_WATCHDOG_MS || 120000);
setTimeout(() => {
  console.error(
    `\n⏰ 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完，卡在阶段「${currentPhase}」。\n` +
      '   惯例是某个 await 永远不返回。先确认最近的改动没让超时/中断参数在传递链上被丢掉' +
      '（函数签名、默认值、对象展开都是常见的丢参数现场）。'
  );
  process.exit(3);
}, WATCHDOG_MS);

/* ------------------------------------------------------------------ HTTP 小工具 */

function cookieJar() {
  const jar = new Map();
  return {
    absorb(res) {
      const list =
        typeof res.headers.getSetCookie === 'function'
          ? res.headers.getSetCookie()
          : [res.headers.get('set-cookie')].filter(Boolean);
      for (const raw of list) {
        const [pair] = String(raw).split(';');
        const eq = pair.indexOf('=');
        if (eq < 1) continue;
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (v === '') jar.delete(k);
        else jar.set(k, v);
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
  };
}

async function form(urlPath, body, { jar, follow = false } = {}) {
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    origin: ORIGIN,
  };
  if (jar) headers.cookie = jar.header();
  const res = await fetch(`${RELAY}${urlPath}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString(),
    redirect: follow ? 'follow' : 'manual',
  });
  if (jar) jar.absorb(res);
  return res;
}

async function get(urlPath, { jar, headers = {} } = {}) {
  const h = { ...headers };
  if (jar) h.cookie = jar.header();
  return fetch(`${RELAY}${urlPath}`, { headers: h, redirect: 'manual' });
}

/**
 * 发一个 JSON-RPC 请求到 /mcp。
 *
 * abortMs：到这个时间就掐掉连接。用于"只想看派发结果、不想等设备超时"的场景 ——
 * 中继在插入派发行之后才会等结果，所以掐掉连接不影响我们查库取证。
 */
let rpcId = 0;
async function mcp(method, params, { token = null, sessionId = null, abortMs = 0 } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (sessionId) headers['mcp-session-id'] = sessionId;
  try {
    const res = await fetch(`${RELAY}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal: abortMs ? AbortSignal.timeout(abortMs) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 保留原文 */
    }
    return { status: res.status, json, text, headers: res.headers, aborted: false };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { status: 0, json: null, text: `(已按 ${abortMs}ms 主动断开)`, headers: null, aborted: true };
    }
    throw err;
  }
}

/**
 * 完整的 MCP 会话：initialize → tools/list → (tools/call)。
 *
 * ⚠️ initialize 必须**同样带上令牌**。这不是可选的：中继在 initialize 时就把会话
 * 绑定到解析出的租户，后续请求的身份不一致即拒（`session_tenant_mismatch`）。
 * 真实客户端（隧道转发的 ChatGPT connector）每个 POST 都会带 Authorization 头，
 * 测试必须照做。
 *
 * 曾经这里漏传令牌，灰度期下 initialize 匿名回落到遗留 owner 账号，于是：
 *   · 租户 A 恰好就是 owner → 看不出问题；
 *   · 租户 B 的会话被绑到 A → 随后的 tools/list 被判为跨租户复用 → 401。
 * 症状极具迷惑性（"A 全对、B 全错"），所以这条注释留在这里。
 */
async function mcpSession(token) {
  const init = await mcp(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'isolation-test', version: '1.0' },
    },
    { token }
  );
  if (init.status !== 200 || !init.json?.result) {
    return { init, sid: null, tools: null, instructions: null, listStatus: null, listRaw: init.text };
  }
  const sid = init.headers.get('mcp-session-id');
  const tl = await mcp('tools/list', {}, { token, sessionId: sid });
  return {
    init,
    sid,
    tools: tl.json?.result?.tools || null,
    instructions: init.json.result.instructions || '',
    listStatus: tl.status,
    listRaw: tl.text.slice(0, 240),
  };
}

async function callTool(token, sid, name, args, opts = {}) {
  return mcp('tools/call', { name, arguments: args }, { token, sessionId: sid, ...opts });
}

/* ------------------------------------------------------------------ 账号准备 */

/**
 * 建/取租户。viaHttp=true 时优先走中继真实的 /signup 路由（顺带验证注册链路）。
 *
 * 自助注册在上公网前应当被关闭（RELAY_ALLOW_SIGNUP=false），那时 /signup 会
 * 直接拒绝 —— 这**不是**被测行为失败，只是脚本的准备步骤需要换一条路：
 * 退回 GoTrue admin API 建账号。两条路都走不通才算失败。
 *
 * 已存在时强制对齐密码：上次可能用别的密码建的，不对齐的话后面 /login 会失败。
 */
async function ensureTenant(email, { viaHttp = true, password = PASSWORD } = {}) {
  let user = await supa.auth.findByEmail(email);
  if (user) {
    await supa.auth.setPassword(user.id, password).catch(() => {});
    return user;
  }

  if (viaHttp) {
    const res = await form('/signup', { email, password, next: '/console' });
    if (res.status === 302 || res.status === 200) {
      user = await supa.auth.findByEmail(email);
    } else {
      const body = await res.text();
      console.log(
        `  · 自助注册不可用（HTTP ${res.status}），改用 admin API 建账号` +
          (res.status === 403 ? '（RELAY_ALLOW_SIGNUP=false，这是正确的生产姿态）' : '')
      );
      void body;
    }
  }

  if (!user) {
    user = await supa.auth.createUser(email, password);
  }
  if (!user?.id) throw new Error(`无法建立租户 ${email}`);
  // 保证密码确实是我们知道的那个（createUser 若因并发返回 null 时也能兜住）
  await supa.auth.setPassword(user.id, password).catch(() => {});
  return user;
}

/** 通过真实的控制台 HTTP 路径登录并创建令牌（顺带验证控制台本身）。 */
async function issueTokenViaConsole(email, password) {
  const jar = cookieJar();
  const res = await form('/login', { email, password, next: '/console' }, { jar });
  if (res.status !== 302) {
    const body = await res.text();
    return { ok: false, error: `登录 HTTP ${res.status}：${body.slice(0, 200)}` };
  }
  const page = await form(
    '/console/tokens',
    { label: 'isolation-test', expires_in_days: '' },
    { jar }
  );
  const html = await page.text();
  const m = html.match(/rmcp_[a-z0-9]{10}_[A-Za-z0-9_-]{43}/);
  if (!m) return { ok: false, error: '控制台响应里没有找到新令牌明文' };
  return { ok: true, token: m[0], html, jar };
}

async function syncFakeDevice(userId, { fresh = true } = {}) {
  const scope = supa.tenantScope(userId);
  const existing = await scope.select('mcp_devices', {
    select: 'id',
    device_name: `eq.${FAKE_DEVICE_NAME}`,
  });
  const rows = Array.isArray(existing) ? existing : [];
  const payload = {
    device_name: FAKE_DEVICE_NAME,
    status: fresh ? 'online' : 'offline',
    last_seen: new Date(fresh ? Date.now() : Date.now() - 3600_000).toISOString(),
    capabilities: { app_version: 'probe', transport_broadcast_v1: true },
  };
  if (rows.length) {
    await scope.update('mcp_devices', { id: `eq.${rows[0].id}` }, payload);
    return rows[0].id;
  }
  const inserted = await scope.insert('mcp_devices', payload);
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  return row.id;
}

/**
 * 清理测试产物。
 *
 * 背景：中继在客户端断开后**不会**把还没结算的派发行改写成 timeout（它只在
 * 自己的内存里放弃等待）。这对线上是正确语义 —— 设备稍后仍可能来抢占并执行，
 * 返回文案里也写明了"这是不知道结果，不是没有执行"。代价是每跑一次测试都会
 * 留下一条永远 pending 的孤儿行。
 *
 * 这里显式删派发行是**保险**：`mcp_remote_calls.device_id` 上有
 * `references mcp_devices(id) on delete cascade`，删设备本来就会连带删掉它们。
 * 但显式写出来不依赖该约束 —— schema 若哪天改成 `on delete set null`，
 * 这段仍然是对的。
 */
async function removeFakeDevice(userId) {
  const scope = supa.tenantScope(userId);
  const rows = await scope.select('mcp_devices', {
    select: 'id',
    device_name: `eq.${FAKE_DEVICE_NAME}`,
  });
  for (const r of Array.isArray(rows) ? rows : []) {
    await supa.rest.del('mcp_remote_calls', { device_id: `eq.${r.id}`, user_id: `eq.${userId}` });
    await scope.update('mcp_devices', { id: `eq.${r.id}` }, { status: 'offline' });
    await supa.rest.del('mcp_devices', { id: `eq.${r.id}`, user_id: `eq.${userId}` });
  }
}

/** 清掉上次运行留下的测试令牌，避免表无限增长、也避免断言被旧数据干扰。 */
async function purgeTestTokens(userId) {
  const scope = supa.tenantScope(userId);
  const rows = await scope.select('mcp_api_tokens', { select: 'id', label: 'eq.isolation-test' });
  for (const r of Array.isArray(rows) ? rows : []) {
    await supa.rest.del('mcp_api_tokens', { id: `eq.${r.id}`, user_id: `eq.${userId}` });
  }
}

/**
 * 删掉一个测试租户（账号 + 令牌）。
 *
 * **只能对脚本自己建的账号用。** 租户 A 用的是 `cfg.OWNER_EMAIL` ——
 * 那是部署本人的管理员账号，删掉等于把控制台锁死，所以这里显式挡一道。
 *
 * 为什么必须连账号一起删：测试账号的密码是**硬编码在本文件里**的
 * （`relay-test-password-9182`）。只清令牌的话，这个账号仍然能登录
 * `/console`，而登录之后**可以自己再签发一枚 `/mcp` 令牌** —— 等于库里
 * 一直留着一把钥匙。清令牌是"收走钥匙"，删账号才是"拆掉门"。
 */
async function removeTestTenant(userId, email, { purgeTokens = true } = {}) {
  if (!userId) return;
  const owner = (cfg.OWNER_EMAIL || '').toLowerCase();
  if (email && owner && email.toLowerCase() === owner) {
    console.log(`  ⚠ 跳过删除 ${email} —— 它是 owner 账号，不是测试产物`);
    return;
  }
  if (purgeTokens) await purgeTestTokens(userId);
  await supa.auth.deleteUser(userId).catch((err) => {
    console.log(`  ⚠ 删除测试账号 ${email} 失败（需手工清理）：${err.message}`);
  });
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  console.log(`中继：${RELAY}`);
  console.log(`鉴权：必需（Bearer 令牌，无匿名通路）· 路由策略：${cfg.ROUTE_POLICY}`);

  /* ---------------------------------------------------- 0. 前置 */
  phase('0. 前置检查');
  const hz = await fetch(`${RELAY}/healthz`);
  const hzBody = await hz.json();
  check(hz.status === 200 && hzBody.ok === true, `/healthz 存活（HTTP ${hz.status}）`);
  check(hzBody.tool_count === 26, `工具目录 26 个（实测 ${hzBody.tool_count}）`);

  // 令牌格式自检：穷举生成并逐个 parse。
  // 这条断言来自一次真实事故 —— secret 是 base64url（含下划线），而解析用了
  // split('_')，导致约一半的令牌被切碎后校验失败，且"换一个就好"极难定位。
  {
    const bad = [];
    for (let i = 0; i < 500; i++) {
      const g = tokens.generate();
      const p = tokens.parse(g.token);
      if (!p || p.prefix !== g.prefix || p.secret !== g.secret) bad.push(g.token);
    }
    check(bad.length === 0, `令牌格式往返自检 500 次（失败 ${bad.length} 次）`,
      bad.length ? `首个失败样例：${bad[0]}` : '');
  }

  // 租户 A 用持有真实设备的那个账号（遗留 owner）。它的设备是唯一真正在线的，
  // 所以"A 的调用能成功"同时证明了端到端链路。
  //
  // **必须显式传 password**：ensureTenant 会把密码对齐成传入值，传默认值
  // （PASSWORD）会把 owner 账号的密码改掉，后面用 A_PASSWORD 登录就会 401。
  const tenantA = await ensureTenant(A_EMAIL, { viaHttp: false, password: A_PASSWORD });
  const tenantB = await ensureTenant(B_EMAIL);
  check(!!tenantA.id && !!tenantB.id, '两个租户就绪');
  check(tenantA.id !== tenantB.id, '两个租户是不同账号');

  const aDevices = await supa.tenantScope(tenantA.id).select('mcp_devices', {
    select: 'id,device_name,last_seen,capabilities',
    order: 'last_seen.desc',
  });
  const aReal = (Array.isArray(aDevices) ? aDevices : []).filter(
    (d) => d.device_name !== FAKE_DEVICE_NAME
  );
  check(
    aReal.length >= 1,
    `租户 A 有真实设备（${aReal.map((d) => d.device_name).join(', ') || '无'}）`,
    aReal.length ? '' : `账号 ${A_EMAIL} 下没有设备 —— 先在该机器上跑一次 desktop-commander remote 并批准`
  );
  if (!aReal.length) {
    console.log('\n❌ 租户 A 没有可用设备，无法验证路由与链路。先接入一台设备再跑本脚本。');
    await removeFakeDevice(tenantB.id);
    return finish();
  }

  // 先清掉上次运行的残留（被中途打断时会留下设备行与孤儿派发行）。
  await removeFakeDevice(tenantB.id);
  const bDeviceId = await syncFakeDevice(tenantB.id, { fresh: true });
  check(!!bDeviceId, `租户 B 已放置一条"在线"设备行（${bDeviceId.slice(0, 8)}）`);
  const aDeviceIds = new Set(aReal.map((d) => d.id));
  check(!aDeviceIds.has(bDeviceId), 'B 的设备 id 不在 A 的设备集合里（数据层已隔离）');

  /* ---------------------------------------------------- 1. 令牌签发 */
  phase('1. 通过控制台签发令牌（走真实 HTTP 路径）');
  await purgeTestTokens(tenantA.id);
  await purgeTestTokens(tenantB.id);
  const issuedA = await issueTokenViaConsole(A_EMAIL, A_PASSWORD);
  check(issuedA.ok, '租户 A 登录并在控制台创建令牌', issuedA.error || '');
  const issuedB = await issueTokenViaConsole(B_EMAIL, PASSWORD);
  check(issuedB.ok, '租户 B 登录并在控制台创建令牌', issuedB.error || '');
  if (!issuedA.ok || !issuedB.ok) {
    console.log('\n❌ 令牌签发失败，后续断言无法进行');
    return finish();
  }
  const tokA = issuedA.token;
  const tokB = issuedB.token;
  check(tokA !== tokB, '两个租户拿到不同令牌');
  check(
    !issuedA.html.includes(FAKE_DEVICE_NAME) && !issuedA.html.includes(B_EMAIL),
    'A 的控制台页面不含 B 的设备名与邮箱'
  );

  /* ---------------------------------------------------- 2. 正常路径 */
  phase('2. A 的令牌正常工作（链路未被改坏）');
  const sessA = await mcpSession(tokA);
  check(sessA.tools !== null && sessA.tools.length === 26, `A 拿到 26 个工具（实测 ${sessA.tools?.length}）`);
  check(
    sessA.instructions.includes('本账号的设备'),
    'initialize 的 instructions 带上了本账号设备清单'
  );
  check(
    sessA.instructions.includes(aReal[0].device_name),
    `instructions 里出现 A 自己的设备名 ${aReal[0].device_name}`
  );
  check(
    !sessA.instructions.includes(FAKE_DEVICE_NAME),
    'instructions 里**不**出现 B 的设备名（隔离成立）'
  );

  const callA = await callTool(tokA, sessA.sid, 'read_file', {
    path: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
  });
  const textA = callA.json?.result?.content?.[0]?.text || '';
  check(
    callA.status === 200 && /localhost|127\.0\.0\.1/i.test(textA),
    'A 真的读到了 Windows 的 hosts 文件（端到端链路通）',
    textA ? `返回前 60 字：${textA.slice(0, 60).replace(/\n/g, ' ')}` : `响应：${callA.text.slice(0, 200)}`
  );

  /* ---------------------------------------------------- 3. 跨租户越权 */
  phase('3. 跨租户越权尝试（全部必须失败）');
  const crossExplicit = await callTool(tokA, sessA.sid, 'list_directory', {
    path: 'C:\\',
    device_id: bDeviceId,
  });
  const crossText = crossExplicit.json?.error?.message || crossExplicit.json?.result?.content?.[0]?.text || '';
  check(
    crossExplicit.json?.error?.code === -32602,
    'A 指定 B 的 device_id → 被拒（code -32602）',
    `实际：${JSON.stringify(crossExplicit.json?.error || crossExplicit.json?.result || {}).slice(0, 200)}`
  );
  check(
    !crossText.includes(FAKE_DEVICE_NAME),
    '拒绝信息里不含 B 的设备名（不泄漏存在性）'
  );
  check(
    /不属于当前账号|找不到设备/.test(crossText),
    '拒绝信息明确说"找不到设备"（不与"存在但无权限"区分）',
    crossText ? `实际：${crossText.slice(0, 120)}` : ''
  );

  /* ---------------------------------------------------- 4. B 侧视角 */
  phase('4. 租户 B 看不到 A 的任何东西');
  const sessB = await mcpSession(tokB);
  check(
    sessB.tools !== null && sessB.tools.length === 26,
    'B 也能看到 26 个工具（工具表是全局目录，这是设计）',
    `tools/list HTTP ${sessB.listStatus} · ${sessB.listRaw}`
  );
  check(
    sessB.instructions.includes(FAKE_DEVICE_NAME),
    'B 的 instructions 里是 B 自己的设备'
  );
  check(
    !aReal.some((d) => sessB.instructions.includes(d.device_name)),
    'B 的 instructions 里**不**出现 A 的设备名'
  );

  // B 的调用必须派发到 **B 自己**那条设备行上，绝不能落到 A 的真实设备。
  //
  // 这里刻意不等那 300s 的设备超时（假设备永远不会结算），而是直接查派发行 ——
  // 行里的 device_id **就是**路由结果，比"读超时文案"直接得多，也快 5 分钟。
  // 请求用 4 秒 AbortSignal 掐掉；中继会在自己的内存里继续等到超时为止。
  const callB = await callTool(tokB, sessB.sid, 'list_directory', { path: 'C:\\' }, { abortMs: 4000 });
  const bCalls = await supa.tenantScope(tenantB.id).select('mcp_remote_calls', {
    select: 'id,device_id,status,user_id',
    order: 'created_at.desc',
    limit: '1',
  });
  const bCall = (Array.isArray(bCalls) ? bCalls : [])[0];
  check(
    !!bCall && bCall.device_id === bDeviceId,
    'B 的调用被派发到 B 自己的设备行上',
    bCall
      ? `派发行 device_id=${String(bCall.device_id).slice(0, 8)} status=${bCall.status}` +
        `（期望 ${bDeviceId.slice(0, 8)}）`
      : `未查到派发行。响应：${callB.text.slice(0, 160)}`
  );

  // 反向取证：从"别人的设备"那一侧看，有没有不该存在的调用行。
  // 这比只看 B 的派发行更强 —— 它排除了"B 的调用同时被扇出到 A 的设备"这种情形。
  const foreignCalls = await supa.rest.select('mcp_remote_calls', {
    select: 'id,user_id',
    device_id: `eq.${aReal[0].id}`,
    user_id: `neq.${tenantA.id}`,
    limit: '5',
  });
  check(
    (Array.isArray(foreignCalls) ? foreignCalls : []).length === 0,
    `A 的设备（${aReal[0].device_name}）上没有任何来自其他租户的调用行`
  );

  const statusA = await get('/api/status', { jar: issuedA.jar });
  const statusABody = await statusA.json();
  const statusB = await get('/api/status', { jar: issuedB.jar });
  const statusBBody = await statusB.json();
  const aNames = (statusABody.devices || []).map((d) => d.name);
  const bNames = (statusBBody.devices || []).map((d) => d.name);
  check(
    !aNames.includes(FAKE_DEVICE_NAME),
    `/api/status：A 看不到 B 的设备（A 看到：${aNames.join(', ') || '无'}）`
  );
  check(
    bNames.includes(FAKE_DEVICE_NAME) && !aReal.some((d) => bNames.includes(d.device_name)),
    `/api/status：B 只看到自己的设备（B 看到：${bNames.join(', ') || '无'}）`
  );

  /* ---------------------------------------------------- 5. 控制台隔离 */
  phase('5. 控制台页面的租户隔离');
  const cA = await (await get('/console', { jar: issuedA.jar })).text();
  const cB = await (await get('/console', { jar: issuedB.jar })).text();
  check(!cA.includes(FAKE_DEVICE_NAME), 'A 的控制台不含 B 的设备名');
  check(!cA.includes(B_EMAIL), 'A 的控制台不含 B 的邮箱');
  check(!cB.includes(FAKE_DEVICE_NAME) === false, 'B 的控制台含自己的设备名');
  check(!aReal.some((d) => cB.includes(d.device_name)), 'B 的控制台不含 A 的设备名');
  check(
    cA.includes(aReal[0].device_name),
    'A 的控制台含自己的设备名'
  );

  /* ---------------------------------------------------- 6. 令牌校验反例 */
  phase('6. 无效令牌与吊销');
  const noToken = await mcp('tools/list', {}, {});
  check(
    noToken.status === 401,
    '未带令牌 → 401（鉴权已是强制的，没有匿名通路）',
    `HTTP ${noToken.status}`
  );

  const badToken = await mcp('tools/list', {}, { token: 'rmcp_aaaaaaaaaa_not-a-real-secret-at-all-xxxxx' });
  check(badToken.status === 401, '格式合法但不存在的令牌 → 401', `HTTP ${badToken.status}`);
  check(
    !/unknown|不存在|已吊销|已过期|mismatch/.test(badToken.text),
    '401 响应体不区分失败原因（不当作 prefix 存在性探测器）',
    `响应：${badToken.text.slice(0, 160)}`
  );

  const malformed = await mcp('tools/list', {}, { token: 'not-a-token' });
  check(malformed.status === 401, '格式非法的令牌 → 401', `HTTP ${malformed.status}`);

  // 吊销 A 的令牌：走真实 HTTP 路径
  const tokenIdA = (await tokens.list(tenantA.id)).find((t) => t.prefix === tokA.split('_')[1])?.id;
  check(!!tokenIdA, '能在库里定位到 A 的令牌行');
  if (tokenIdA) {
    const rev = await form('/console/tokens/revoke', { token_id: tokenIdA }, { jar: issuedA.jar });
    check(rev.status === 302, '吊销请求被接受（302 重定向）', `HTTP ${rev.status}`);
    const afterRevoke = await mcp('tools/list', {}, { token: tokA });
    check(afterRevoke.status === 401, '已吊销的令牌**立刻**失效（同进程缓存已清除）', `HTTP ${afterRevoke.status}`);
  }

  /* ---------------------------------------------------- 7. 会话 ID 不可跨租户 */
  phase('7. MCP 会话 ID 不是身份凭据');
  const sessForMix = await mcpSession(tokB);
  const mixed = await mcp('tools/list', {}, { token: tokA, sessionId: sessForMix.sid });
  check(
    mixed.status === 401,
    '持有 A 的令牌 + B 的会话 ID → 被拒（会话已绑租户）',
    `HTTP ${mixed.status} ${mixed.text.slice(0, 120)}`
  );
  void tokB;

  /* ---------------------------------------------------- 8. 运维面 */
  phase('8. 运维面的信息收敛');
  check(!('devices' in hzBody), '/healthz 不含设备清单字段');
  check(
    !JSON.stringify(hzBody).includes(aReal[0].device_name),
    `/healthz 响应里不含任何设备名（含 ${aReal[0].device_name}）`
  );
  check(!('public_supabase_url' in hzBody), '/healthz 不再回显 Supabase 地址');

  const adminNoAuth = await get('/admin');
  check(adminNoAuth.status === 401, '/admin 无凭据 → 401', `HTTP ${adminNoAuth.status}`);
  if (cfg.ADMIN_TOKEN) {
    const basic = Buffer.from(`admin:${cfg.ADMIN_TOKEN}`).toString('base64');
    const adminOk = await get('/admin', { headers: { authorization: `Basic ${basic}` } });
    const adminHtml = await adminOk.text();
    check(adminOk.status === 200, '/admin 带管理员凭据 → 200', `HTTP ${adminOk.status}`);
    check(
      adminHtml.includes(A_EMAIL) && adminHtml.includes(B_EMAIL),
      '管理员面能看到全部租户（含 A 与 B）'
    );
    check(adminHtml.includes(FAKE_DEVICE_NAME), '管理员面能看到 B 的伪造设备');
    const adminBad = await get('/admin', { headers: { authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') } });
    check(adminBad.status === 401, '/admin 错误凭据 → 401', `HTTP ${adminBad.status}`);
  } else {
    console.log('  （未配置 RELAY_ADMIN_TOKEN，跳过管理员面断言）');
  }

  await removeFakeDevice(tenantB.id);

  // 收尾也要清令牌，不能只靠下一轮开头的 purge 兜着：跑到这里时 B 的令牌
  // 依然是一枚**有效凭据**，能在库里躺到下次有人跑测试为止 —— 等于存着一把
  // 无人认领、却能直接 POST /mcp 的钥匙。开头的 purge 只保证"下次跑之前干净"，
  // 不保证"这次跑完之后干净"，两件事不一样。
  // A 只清令牌：`A_EMAIL` 就是 `cfg.OWNER_EMAIL`（部署本人的管理员账号），
  // 删账号会把控制台锁死。这里**不要**为了对称去删它。
  await purgeTestTokens(tenantA.id);
  // B 是脚本自己建的（tenant-b@relay.test），账号连令牌一起删 ——
  // 它的密码硬编码在本文件里，留着等于留一把能登录控制台、再自签令牌的钥匙。
  await removeTestTenant(tenantB.id, tenantB.email);

  return finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`结论：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  ✗ [${f.phase}] ${f.label}${f.extra ? `\n      ${f.extra}` : ''}`);
  } else {
    console.log('✅ 全部通过 —— 跨租户隔离成立');
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\n💥 测试脚本自身出错：', err.stack || err.message);
  process.exit(2);
});
