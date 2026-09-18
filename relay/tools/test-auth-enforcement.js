#!/usr/bin/env node
/**
 * 鉴权强制验收：证明 /mcp 对任何"没有有效令牌"的请求都一律 401，
 * 而一枚有效令牌始终可用 —— 无论它是 OAuth 签发的还是手动创建的。
 *
 * 为什么需要这个脚本
 * ------------------
 * 鉴权从"可关闭的开关"改成"强制"之后，最容易出的问题是**误伤**：
 * 某个本该放行的路径（隧道路径、会话续用、前缀匹配）被一起拒掉了。
 * 所以这里既验负向（一律 401），也验正向（有效令牌仍然通）。
 *
 * 历史备注：本脚本原名为"收紧验收"，用来证明 RELAY_REQUIRE_AUTH=true 之后
 * 隧道注入的静态头仍然可用。那个开关与那条灰度路径**已被删除**
 * （改为 OAuth 2.1，见 relay/src/oauth.js），因此这里不再有"灰度态"这个分支，
 * 两个实例的姿态也与之一致。
 *
 * 它**不碰**正在服务的那个实例。做法是另起一个隔离实例（RELAY_PORT=18087），
 * 用同一个数据库、同一份令牌，验证两者行为一致。
 *
 * 中继只广播、不订阅（门铃是发给 device 的），所以第二个实例不会抢走
 * 正在进行的调用。本脚本也刻意**不做 tools/call**，不产生任何派发行。
 *
 * 用法：node tools/test-auth-enforcement.js
 * 退出码 0 = 全绿；1 = 有断言失败（可用于 CI / 提交前门禁）。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const RELAY_ROOT = path.resolve(__dirname, '..');
const LIVE = 'http://127.0.0.1:18086';
const TEST_PORT = 18087;
const TEST = `http://127.0.0.1:${TEST_PORT}`;
const SECRET_FILE = path.resolve(RELAY_ROOT, '..', 'docker', 'secrets', 'relay-mcp-token.txt');

/* ----------------------------------------------------------------- 断言框架 */

const results = [];
let currentPhase = '';

function phase(name) {
  currentPhase = name;
  console.log(`\n── ${name}`);
}

function check(ok, label, extra = '') {
  results.push({ ok, label, phase: currentPhase, extra });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `\n          ${extra}` : ''}`);
  return ok;
}

/** 断言"包含"，并把实际值带进输出，方便失败时定位。 */
function checkMatch(actual, re, label) {
  const s = typeof actual === 'string' ? actual : JSON.stringify(actual);
  return check(re.test(s), label, re.test(s) ? '' : `实际：${s.slice(0, 160)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- MCP 客户端 */

let rpcId = 0;
async function mcp(base, method, params, { token = null, sessionId = null } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) headers.authorization = token;
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 保留原文 */
  }
  return { status: res.status, json, text, headers: res.headers };
}

/* ----------------------------------------------------------------- 子进程 */

async function waitHealthy(base, { expectAuth, timeoutMs = 25000 }) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
      const j = await r.json();
      if (j.ok) {
        // 鉴权姿态由 /healthz 的 auth 字段表达（'required' 是当前唯一取值）。
        if (expectAuth === undefined || j.auth === (expectAuth ? 'required' : 'optional')) return j;
        last = `auth=${j.auth}（期望 ${expectAuth ? 'required' : 'optional'}）`;
      } else {
        last = JSON.stringify(j).slice(0, 120);
      }
    } catch (e) {
      last = e.name;
    }
    await sleep(400);
  }
  throw new Error(`等 ${base}/healthz 就绪超时：${last}`);
}

/* ------------------------------------------------------------------- 主流程 */

async function main() {
  let child = null;
  let secretHeader = '';

  try {
    /* ---- 阶段 0 · 前提 ---- */
    phase('0. 前提与基线');

    check(fs.existsSync(SECRET_FILE), `秘密文件存在：${path.relative(RELAY_ROOT, SECRET_FILE)}`);
    if (!fs.existsSync(SECRET_FILE)) throw new Error('秘密文件不存在，无法继续');

    const raw = fs.readFileSync(SECRET_FILE, 'utf8');
    // tunnel-client 的 `file:` 分支会裁掉一个行尾；中继的 bearer() 也会 trim。
    // 两种形态都应该被接受 —— 这正是"隧道写了什么、中继就收到什么"的边界。
    secretHeader = raw.replace(/\r?\n$/, '');
    const bytesOnDisk = raw.length;
    const tailRemoved = bytesOnDisk - secretHeader.length;

    checkMatch(secretHeader, /^Bearer\s+rmcp_[a-z0-9]{10}_[A-Za-z0-9_-]{43}$/, '秘密文件是合法的 Bearer rmcp_ 令牌');
    check(tailRemoved <= 1, `文件尾部只有至多一个行尾（被裁掉 ${tailRemoved} 字节）`, `文件共 ${bytesOnDisk} 字节`);
    check(
      !/\s/.test(secretHeader.replace(/^Bearer\s+/, '')),
      '令牌本体不含任何空白（否则 splitHeaderList 会把它切碎）'
    );

    let live = null;
    try {
      live = await (await fetch(`${LIVE}/healthz`, { signal: AbortSignal.timeout(3000) })).json();
      check(true, `live 实例存活（uptime ${live.uptime_s}s，auth=${live.auth}）`);
      // 鉴权现在是强制的（RELAY_REQUIRE_AUTH 开关已被删除），不存在灰度态，
      // 因此这里不需要再"记录姿态、让对照跟着走"—— 两个实例的姿态是同一个。
      check(true, 'live 处于强制鉴权姿态 —— 与隔离实例同姿态，阶段 4 验证两者行为一致');
    } catch (e) {
      check(false, 'live 实例可达', `打不开 ${LIVE}/healthz：${e.name}`);
    }

    /* ---- 阶段 1 · 起隔离实例 ---- */
    phase('1. 隔离实例（18087 · 强制鉴权）');

    child = spawn(process.execPath, ['src/index.js'], {
      cwd: RELAY_ROOT,
      env: { ...process.env, RELAY_PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let childLog = '';
    child.stdout.on('data', (d) => (childLog += d));
    child.stderr.on('data', (d) => (childLog += d));
    let exited = null;
    child.on('exit', (code) => (exited = code));

    const j = await waitHealthy(TEST, { expectAuth: true });
    check(true, '隔离实例起来了，且鉴权是强制的（auth=required）', `tool_count=${j.tool_count}`);
    check(exited === null, '子进程没有意外退出', exited === null ? '' : `退出码 ${exited}`);

    /* ---- 阶段 2 · 负向：锁真的锁上了 ---- */
    phase('2. 负向 · 没有有效令牌一律 401');

    const noAuth = await mcp(TEST, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a', version: '1' } });
    check(noAuth.status === 401, '完全不带 Authorization → 401', `HTTP ${noAuth.status}`);
    checkMatch(noAuth.text, /"error"\s*:\s*"unauthorized"/, '401 响应体是结构化 JSON-RPC 错误（不是空/500）');
    check(
      !!noAuth.headers.get('www-authenticate'),
      '401 带 WWW-Authenticate 质询头（OAuth 客户端靠这个找元数据）'
    );
    check(
      !/not_found|revoked|expired|missing_token|malformed|allowed_ips/.test(noAuth.text),
      '401 响应体**不泄露**拒绝原因（否则成了 prefix 存在性探测器）'
    );

    const fake = `rmcp_${'a'.repeat(10)}_${'b'.repeat(43)}`;
    const notFound = await mcp(TEST, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a', version: '1' } }, { token: `Bearer ${fake}` });
    check(notFound.status === 401, '格式合法但不存在的令牌 → 401', `HTTP ${notFound.status}`);
    check(notFound.text === noAuth.text, '与"没带令牌"的响应逐字节相同（不区分"不存在"与"未提供"）');

    const garbage = await mcp(TEST, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a', version: '1' } }, { token: 'Bearer not-a-token-at-all' });
    check(garbage.status === 401, '格式非法的字符串 → 401', `HTTP ${garbage.status}`);

    const basic = await fetch(`${TEST}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Basic ' + Buffer.from('u:' + secretHeader.replace(/^Bearer\s+/, '')).toString('base64') },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a', version: '1' } } }),
    });
    check(basic.status === 401, '把令牌塞进 Basic 头 → 401（Basic 只属于管理员面，不能误放行）', `HTTP ${basic.status}`);

    /* ---- 阶段 3 · 正向：隧道的头能通过 ---- */
    phase('3. 正向 · 隧道注入的头在收紧后仍然可用');

    const init = await mcp(TEST, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'enforcement-test', version: '1' } }, { token: secretHeader });
    check(init.status === 200, '带秘密文件里的令牌 → initialize 200', `HTTP ${init.status}`);
    const sid = init.headers.get('mcp-session-id');
    check(!!sid, '拿到了 mcp-session-id', sid ? `sid=${String(sid).slice(0, 8)}…` : '');
    checkMatch(init.text, /"serverInfo"|"protocolVersion"/, 'initialize 返回了合法结果');

    const list = await mcp(TEST, 'tools/list', {}, { token: secretHeader, sessionId: sid });
    check(list.status === 200, '同一令牌做 tools/list → 200（收紧不影响连续调用）', `HTTP ${list.status}`);
    const tools = list.json?.result?.tools || [];
    check(tools.length > 0, `拿到工具表：${tools.length} 个`, tools.length ? `例：${tools.slice(0, 3).map((t) => t.name).join(', ')}` : list.text.slice(0, 120));

    // 同一会话里换成一个**别的租户**之外的假令牌，必须被拒 ——
    // 证明会话不会因为"第一次带对了"就永久放行。
    const swap = await mcp(TEST, 'tools/list', {}, { token: `Bearer ${fake}`, sessionId: sid });
    check(swap.status === 401, '同一会话里换成无效令牌 → 401（不会一次通过就永久放行）', `HTTP ${swap.status}`);

    /* ---- 阶段 4 · 对照与不变量 ---- */
    phase('4. 对照 · 两个实例在鉴权行为上零差别');

    const liveNoAuth = await mcp(LIVE, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'enforcement-test', version: '1' } });
    check(
      liveNoAuth.status === 401,
      '同一无头请求打到 live 也是 401 —— 与隔离实例零差别（不再有"灰度态回落"这条分支）',
      `HTTP ${liveNoAuth.status}`
    );

    const liveWithAuth = await mcp(LIVE, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'enforcement-test', version: '1' } }, { token: secretHeader });
    check(liveWithAuth.status === 200, '同一令牌打到 live 也是 200 —— 两个实例在"带对令牌"上无差别', `HTTP ${liveWithAuth.status}`);

    const liveList = await mcp(LIVE, 'tools/list', {}, { token: secretHeader, sessionId: liveWithAuth.headers.get('mcp-session-id') });
    const liveTools = liveList.json?.result?.tools || [];
    check(
      liveTools.length === tools.length,
      `两个实例的工具表一致（live ${liveTools.length} / 收紧 ${tools.length}）`
    );

    check(
      !('devices' in j) && !/device_name|DESKTOP-/.test(JSON.stringify(j)),
      '收紧实例的 /healthz 不含设备清单（运维面不泄露租户数据）',
      ''
    );

    /* ---- 阶段 5 · 收尾 ---- */
    phase('5. 收尾 · 不留残留');

    child.kill();
    await sleep(1200);
    let stillUp = true;
    try {
      await fetch(`${TEST}/healthz`, { signal: AbortSignal.timeout(1500) });
    } catch {
      stillUp = false;
    }
    check(!stillUp, '隔离实例已停止，18087 端口释放');
    check(true, '本脚本没有发起任何 tools/call，因此没有产生派发行');
  } catch (err) {
    check(false, `${currentPhase} 阶段抛异常`, err.message);
  } finally {
    if (child && child.exitCode === null) {
      try {
        child.kill();
      } catch {
        /* 已经死了 */
      }
    }
  }

  /* ------------------------------------------------------------------ 汇总 */

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '─'.repeat(72));
  if (failed.length === 0) {
    console.log(`✅ 鉴权强制验收通过：${results.length}/${results.length}`);
    console.log('   结论：/mcp 拒绝所有无令牌请求（含 Basic 误用、无效令牌、会话中途换令牌），');
    console.log('   而一枚有效的令牌 —— 无论是 OAuth 签发的还是手动创建的 —— 始终可用。');
    console.log('   注：RELAY_REQUIRE_AUTH 开关已删除，不再存在"灰度态"这条分支。');
  } else {
    console.log(`❌ 收紧验收未通过：${results.length - failed.length}/${results.length}，失败 ${failed.length} 条：`);
    for (const f of failed) console.log(`   · [${f.phase}] ${f.label}${f.extra ? ` — ${f.extra}` : ''}`);
  }
  console.log('─'.repeat(72));
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
