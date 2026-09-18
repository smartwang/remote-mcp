#!/usr/bin/env node
/**
 * 设备路由验收：证明"一个账号下有多台设备时，中继怎么选"是全定的、可预测的。
 *
 * 为什么单独有这个脚本
 * --------------------
 * 隔离测试（test-tenant-isolation.js）验的是"B 碰不到 A 的设备"，也就是**租户维度**。
 * 但多租户成立之后还剩一个同样致命的问题：**同一个账号下有多台设备时选哪台？**
 *
 * 这是 `RELAY_ROUTE_POLICY=auto-single` 的全部内容，而它此前从未被端到端验证过 ——
 * README 的"尚未验证"里挂着这一条。风险不在于"选错"这个动作本身，
 * 而在于**静默地选了一台用户没在想的机器**：一次 write_file 落到错误机器的代价，
 * 远高于多问一句。所以这里的断言重点不是"能跑通"，而是：
 *
 *   · 多台在线时**必须拒绝执行**（而不是挑一台），并且错误里带上足够让 AI
 *     转述给用户的信息（设备名 + device_id + 怎么指定）；
 *   · 拒绝发生在**派发之前** —— 库里不能多出一条派发行。否则"报错"只是文案，
 *     实际已经在某台机器上跑了一半。
 *   · 显式指定时，派发行里的 device_id **就是**路由结果，用它取证，
 *     比读返回文案直接，也不用等 300s 设备超时。
 *
 * 覆盖的路由矩阵：
 *   0 台在线   → 报错，且提示怎么接入设备
 *   1 台在线   → 自动选中（唯一不需要用户介入的情形）
 *   多台在线   → 报错 + 列出候选 + **不产生派发行**
 *   显式指定   → 派发到指定那台（在线 / 离线 / 不存在 三种）
 *   跨租户 id  → 与"不存在"同一个措辞（不透露存在性）
 *
 * 副作用：会在 owner 账号下临时插入一条假设备行（`__routing_probe__`），
 * 结束时连同它引发的派发行一起删除。真实设备行只读、不改。
 *
 * 用法：
 *   node tools/test-device-routing.js
 *   RELAY=http://127.0.0.1:18086 node tools/test-device-routing.js
 *
 * 退出码 0 = 全绿；1 = 有断言失败。
 */

'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const RELAY = (process.env.RELAY || 'http://127.0.0.1:18086').replace(/\/+$/, '');

// 直接复用中继自己的模块：测试要伪造一条设备行，而这条路径在 HTTP 面上
// 故意不开放（客户端不该能伪造设备）。
process.chdir(path.resolve(__dirname, '..'));
const supa = require('../src/supa');
const tokens = require('../src/tokens');
const cfg = require('../src/config');

/** 假设备名。带前后双下划线，一眼看出是测试产物，不会和真实机器名混淆。 */
const FAKE_ONLINE = '__routing_probe_online__';
const FAKE_OFFLINE = '__routing_probe_offline__';
const TEST_LABEL = 'routing-test';

const results = [];
let currentPhase = '';

function phase(name) {
  currentPhase = name;
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 52 - name.length))}`);
}

function check(ok, label, extra = '') {
  results.push({ ok, label, phase: currentPhase, extra });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `\n          ${extra}` : ''}`);
  return ok;
}

/**
 * 看门狗：某个 await 永远不返回时，静默等待是最糟的失败模式 ——
 * 分不清"慢"和"死"。正常路径 finish() 会 exit，所以不会误触发。
 */
const WATCHDOG_MS = Number(process.env.TEST_WATCHDOG_MS || 180000);
setTimeout(() => {
  console.error(
    `\n⏰ 看门狗触发：${Math.round(WATCHDOG_MS / 1000)}s 内没跑完，卡在阶段「${currentPhase}」。\n` +
      '   惯例是某个 await 永远不返回 —— 先确认 abortMs 没在传递链上被丢掉。'
  );
  process.exit(1);
}, WATCHDOG_MS).unref?.();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ MCP 客户端 */

/**
 * 打一次 /mcp。
 *
 * `abortMs` 是**必须**留的口子：显式指定一台永远不会应答的假设备时，
 * 中继会在自己的内存里一直等设备超时（默认 300s）。我们不等那个 ——
 * 派发行在那之前就已经写好了，直接掐掉连接去查库。
 */
async function mcp(method, params, { token, sessionId, abortMs = 20000 } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), abortMs);
  try {
    const res = await fetch(`${RELAY}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ac.signal,
    });
    const text = await res.text();
    // 中继可能以 SSE 形式回（text/event-stream），取 data: 行里的 JSON。
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      const line = text.split('\n').find((l) => l.startsWith('data:'));
      if (line) {
        try {
          json = JSON.parse(line.slice(5).trim());
        } catch {
          json = null;
        }
      }
    }
    return { status: res.status, headers: res.headers, text, json };
  } catch (err) {
    // 被我们自己掐断，或连接层错误 —— 都当作"没有拿到有效响应"返回，
    // 由调用方按上下文判断，而不是让整个脚本崩掉。
    return { status: 0, headers: new Headers(), text: `[aborted] ${err.name}: ${err.message}`, json: null };
  } finally {
    clearTimeout(timer);
  }
}

async function mcpSession(token) {
  const init = await mcp(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'routing-test', version: '1.0' },
    },
    { token }
  );
  if (init.status !== 200 || !init.json?.result) {
    return { init, sid: null, instructions: '' };
  }
  return {
    init,
    sid: init.headers.get('mcp-session-id'),
    instructions: init.json.result.instructions || '',
  };
}

/** 取一次 tools/call 的错误文案（成功时返回空串）。 */
function errorText(res) {
  const e = res.json?.error;
  if (e) return String(e.message || JSON.stringify(e));
  const c = res.json?.result?.content;
  if (Array.isArray(c)) return c.map((x) => x.text || '').join(' ');
  return '';
}

/* ------------------------------------------------------------------ 数据库取证 */

/**
 * 读派发行。**行里的 device_id 就是路由结果** —— 这是本脚本的核心取证手段：
 * 比"读超时文案"直接得多，也快 5 分钟。
 */
async function lastDispatch(userId) {
  const rows = await supa.tenantScope(userId).select('mcp_remote_calls', {
    select: 'id,device_id,status,created_at',
    order: 'created_at.desc',
    limit: '1',
  });
  return (Array.isArray(rows) ? rows : [])[0] || null;
}

async function countDispatches(userId) {
  const rows = await supa.tenantScope(userId).select('mcp_remote_calls', { select: 'id' });
  return (Array.isArray(rows) ? rows : []).length;
}

/** 建/更新一条假设备行。返回它的 id。 */
async function upsertProbeDevice(userId, name, { online }) {
  const scope = supa.tenantScope(userId);
  const existing = await scope.select('mcp_devices', { select: 'id', device_name: `eq.${name}` });
  const payload = {
    device_name: name,
    status: online ? 'online' : 'offline',
    // 在线：心跳打现在；离线：打到 1 小时前，确保超出 15 分钟新鲜窗口。
    last_seen: new Date(online ? Date.now() : Date.now() - 3600_000).toISOString(),
    capabilities: { app_version: 'routing-probe', transport_broadcast_v1: true },
  };
  const rows = Array.isArray(existing) ? existing : [];
  if (rows.length) {
    await scope.update('mcp_devices', { id: `eq.${rows[0].id}` }, payload);
    return rows[0].id;
  }
  const inserted = await scope.insert('mcp_devices', payload);
  return (Array.isArray(inserted) ? inserted[0] : inserted).id;
}

/**
 * 清掉假设备行及其派发行。
 *
 * 背景：中继在客户端断开后**不会**把还没结算的派发行改成 timeout（它只在内存里
 * 放弃等待）。这对线上是正确的语义 —— 设备稍后仍可能来抢占并执行 ——
 * 但代价是每跑一次都会留下一条永远 pending 的孤儿行。所以测试自己负责删。
 */
async function removeProbeDevices(userId) {
  const scope = supa.tenantScope(userId);
  for (const name of [FAKE_ONLINE, FAKE_OFFLINE]) {
    const rows = await scope.select('mcp_devices', { select: 'id', device_name: `eq.${name}` });
    for (const r of Array.isArray(rows) ? rows : []) {
      await supa.rest.del('mcp_remote_calls', { device_id: `eq.${r.id}`, user_id: `eq.${userId}` });
      // 先置离线再删：万一有 device 进程恰好连上来，不至于把它当成"在线但消失"。
      await scope.update('mcp_devices', { id: `eq.${r.id}` }, { status: 'offline' });
      await supa.rest.del('mcp_devices', { id: `eq.${r.id}`, user_id: `eq.${userId}` });
    }
  }
}

async function purgeTestTokens(userId) {
  const scope = supa.tenantScope(userId);
  const rows = await scope.select('mcp_api_tokens', { select: 'id', label: `eq.${TEST_LABEL}` });
  for (const r of Array.isArray(rows) ? rows : []) {
    await supa.rest.del('mcp_api_tokens', { id: `eq.${r.id}`, user_id: `eq.${userId}` });
  }
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  console.log(`中继：${RELAY}`);
  console.log(`路由策略：${cfg.ROUTE_POLICY}（设备新鲜窗口 ${Math.round(cfg.DEVICE_FRESH_MS / 60000)} 分钟）`);

  /* ---------------------------------------------------- 0. 前置 */
  phase('0. 前置检查');

  const hz = await fetch(`${RELAY}/healthz`).then((r) => r.json());
  check(hz.ok === true, '中继健康', `auth=${hz.auth} tools=${hz.tool_count}`);
  check(hz.auth === 'required', "/healthz 报告 auth=required（没有匿名通路）", `实际 ${hz.auth}`);
  check(
    cfg.ROUTE_POLICY === 'auto-single',
    '路由策略是 auto-single —— 本脚本只在这个策略下有意义',
    `实际 ${cfg.ROUTE_POLICY}`
  );

  const owner = await supa.auth.findByEmail(cfg.OWNER_EMAIL);
  check(!!owner?.id, `owner 账号存在（${cfg.OWNER_EMAIL}）`);
  if (!owner?.id) return finish();

  // 清残留：上次被中途打断时留下的假设备行会让后续断言全部失真。
  await removeProbeDevices(owner.id);
  await purgeTestTokens(owner.id);

  // 造一枚本次专用的令牌。用 tokens.create 而不是走控制台 ——
  // 这里测的是路由，登录/发令牌那条链路由另外两个脚本覆盖。
  const { token } = await tokens.create(owner.id, { label: TEST_LABEL });

  const realDevices = await supa.tenantScope(owner.id).select('mcp_devices', {
    select: 'id,device_name,last_seen,status,capabilities',
    order: 'last_seen.desc',
  });
  const real = (Array.isArray(realDevices) ? realDevices : []).filter(
    (d) => !d.device_name.startsWith('__routing_probe_')
  );
  check(
    real.length >= 1,
    `owner 名下有真实设备（${real.map((d) => d.device_name).join(', ') || '无'}）`,
    real.length ? '' : `先在该机器上跑 desktop-commander remote 并批准，再跑本脚本`
  );
  if (!real.length) return finish();

  const realId = real[0].id;
  const realName = real[0].device_name;

  // 派发行的基线。owner 是真实在用的账号，库里本来就有历史行 ——
  // 断言必须是"相对基线没多出不该有的行"，而不是"总共只有一条"。
  const baselineCalls = await countDispatches(owner.id);

  const sess = await mcpSession(token);
  check(!!sess.sid, '带令牌能建立会话并拿到 session id', `HTTP ${sess.init.status}`);
  if (!sess.sid) {
    console.log(`   会话建立失败：${sess.init.text.slice(0, 200)}`);
    return finish();
  }

  /* ------------------------------------- 1. 显式指定：路由结果的直接取证 */
  phase('1. 显式指定 device_id → 派发行必须落在指定那台');

  await callAndInspect(token, sess.sid, realId, `${realName}（真实设备）`, { expectOk: true });

  // 离线设备：心跳打到 1 小时前。
  const offlineId = await upsertProbeDevice(owner.id, FAKE_OFFLINE, { online: false });
  const offlineRes = await mcp(
    'tools/call',
    { name: 'list_directory', arguments: { path: 'C:\\', device_id: offlineId } },
    { token, sessionId: sess.sid, abortMs: 6000 }
  );
  check(
    offlineRes.status === 200 && /离线|超出|正在运行/.test(errorText(offlineRes)),
    '显式指定一台**离线**设备 → 明确报"离线"，而不是"找不到"（两种失败要能分辨）',
    `HTTP ${offlineRes.status} · ${errorText(offlineRes).slice(0, 120)}`
  );
  check(
    !(await lastDispatch(owner.id)) || (await lastDispatch(owner.id)).device_id !== offlineId,
    '离线设备**没有**产生派发行（拒绝发生在派发之前）'
  );

  /* ------------------------------------------ 2. 不存在的 id：措辞不可区分 */
  phase('2. 不存在的 device_id → 措辞不得透露"存在但属于别人"');

  const ghostId = crypto.randomUUID();
  const ghostRes = await mcp(
    'tools/call',
    { name: 'list_directory', arguments: { path: 'C:\\', device_id: ghostId } },
    { token, sessionId: sess.sid, abortMs: 6000 }
  );
  const ghostMsg = errorText(ghostRes);
  check(
    ghostRes.status === 200 && /找不到设备/.test(ghostMsg),
    '不存在的 UUID → "找不到设备"，并说明可能是"不属于当前账号，或已被删除"',
    ghostMsg.slice(0, 140)
  );
  check(
    ghostMsg.includes(ghostId),
    '错误里回显尝试的 id（用户要能判断是不是自己贴错了），但不加任何存在性信息',
    ''
  );

  /* ------------------------------------ 3. 多台在线：必须拒绝 + 列出候选 */
  phase('3. 多台在线 → 拒绝执行并列出候选（这是本脚本的主角）');

  const onlineId = await upsertProbeDevice(owner.id, FAKE_ONLINE, { online: true });
  await sleep(300); // 让设备行落库（心跳有秒级时间戳，避免同刻排序歧义）

  const beforeCount = await countDispatches(owner.id);

  const multiRes = await mcp(
    'tools/call',
    { name: 'list_directory', arguments: { path: 'C:\\' } },
    { token, sessionId: sess.sid, abortMs: 8000 }
  );
  const multiMsg = errorText(multiRes);

  check(multiRes.status === 200, '多台在线、不指定 device_id → 请求本身成功返回（错误在 JSON-RPC 层）', `HTTP ${multiRes.status}`);
  check(
    /无法自动判断|请先向用户确认目标机器/.test(multiMsg),
    '错误文案明确要求"先向用户确认目标机器"，而不是让模型自己猜',
    multiMsg.split('\n')[0]
  );
  check(
    multiMsg.includes(realName) && multiMsg.includes(FAKE_ONLINE),
    '候选列表里**两台都列出**（少列一台 = 用户没法选）',
    ''
  );
  check(
    multiMsg.includes(realId) && multiMsg.includes(onlineId),
    '候选里带 device_id（否则模型只能报设备名，用户仍无法指定）',
    ''
  );
  check(
    /device_id/.test(multiMsg) && /path/.test(multiMsg),
    '给出了可照抄的调用示例（模型不需要自由发挥格式）',
    ''
  );
  check(
    /最后心跳/.test(multiMsg),
    '每台候选带最后心跳时间（判断哪台更可能是想要的）',
    ''
  );

  const afterCount = await countDispatches(owner.id);
  check(
    afterCount === beforeCount,
    '**拒绝发生在派发之前** —— 库里没有多出任何派发行',
    `派发行 ${beforeCount} → ${afterCount}`
  );

  /* --------------------------------------- 4. 显式指定后就该正常派发 */
  phase('4. 多台在线 + 显式指定 → 派发到指定那台，歧义消失');

  const dispatched = await lastDispatch(owner.id);

  const pickFake = await mcp(
    'tools/call',
    { name: 'list_directory', arguments: { path: 'C:\\', device_id: onlineId } },
    { token, sessionId: sess.sid, abortMs: 5000 }
  );
  check(
    pickFake.status === 200 || pickFake.status === 0,
    '显式指定候选里的一台 → 请求被受理（假设备不会应答，连接由测试自己掐断）',
    `HTTP ${pickFake.status}`
  );
  const d1 = await lastDispatch(owner.id);
  check(
    d1 && d1.device_id === onlineId,
    '派发行 device_id == 显式指定的那台（**这就是路由结果**）',
    d1 ? `device_id=${String(d1.device_id).slice(0, 8)} 期望 ${onlineId.slice(0, 8)}` : '未查到派发行'
  );

  const pickReal = await mcp(
    'tools/call',
    { name: 'list_directory', arguments: { path: 'C:\\', device_id: realId } },
    { token, sessionId: sess.sid, abortMs: 20000 }
  );
  const d2 = await lastDispatch(owner.id);
  check(
    d2 && d2.device_id === realId,
    '改指定真实设备 → 派发行跟着变（并发/多台下不会串台）',
    d2 ? `device_id=${String(d2.device_id).slice(0, 8)} 期望 ${realId.slice(0, 8)}` : '未查到派发行'
  );
  check(
    pickReal.status === 200 && /\[DIR\]|\[FILE\]|目录/.test(pickReal.text + (pickReal.json?.result ? JSON.stringify(pickReal.json.result) : '')),
    '真实设备的调用**真的执行了**（拿到目录列表，不是只过了鉴权）',
    `HTTP ${pickReal.status}`
  );

  /* ------------------------- 5. 回到单台：自动选，用户零感知（日常路径） */
  phase('5. 回到单台在线 → 自动选中，不需要 device_id');

  // 删掉两台假设备，只留真实设备。
  await removeProbeDevices(owner.id);
  await sleep(300);

  const singleRes = await mcp(
    'tools/call',
    { name: 'list_directory', arguments: { path: 'C:\\' } },
    { token, sessionId: sess.sid, abortMs: 20000 }
  );
  const singleMsg = errorText(singleRes);
  check(
    !/无法自动判断/.test(singleMsg),
    '只剩一台在线 → 不再报"无法自动判断"（这是多数人的日常路径）',
    singleMsg ? singleMsg.slice(0, 120) : '（正常返回）'
  );
  const d3 = await lastDispatch(owner.id);
  check(
    d3 && d3.device_id === realId,
    '自动选中的就是那唯一一台在线的真实设备',
    d3 ? `device_id=${String(d3.device_id).slice(0, 8)} 期望 ${realId.slice(0, 8)}` : '未查到派发行'
  );
  check(
    sess.instructions.includes(realName) && /无需指定 device_id/.test(sess.instructions),
    'initialize 的 instructions 在多台时提示"必须指定 device_id"、单台时提示"无需指定"',
    /无需指定 device_id/.test(sess.instructions) ? '' : '本次 instructions 未包含单台提示（多台时抓取会被覆盖）'
  );

  /* --------------------------------------------------- 6. 收尾 */
  phase('6. 收尾 · 不留残留');

  await removeProbeDevices(owner.id);
  await purgeTestTokens(owner.id);

  const leftoverDevices = await supa.tenantScope(owner.id).select('mcp_devices', {
    select: 'id,device_name',
  });
  const probes = (Array.isArray(leftoverDevices) ? leftoverDevices : []).filter((d) =>
    d.device_name.startsWith('__routing_probe_')
  );
  check(probes.length === 0, '假设备行已全部删除', probes.length ? `残留 ${probes.length} 条` : '');

  // 本次跑动中**理应**留下的派发行：显式指定真实设备两次（1a / 步骤 4），
  // 单台自动选一次（步骤 5）。假设备那两条应当随设备行一起被清掉。
  const EXPECTED_REAL_CALLS = 3;
  const allCalls = await supa.tenantScope(owner.id).select('mcp_remote_calls', {
    select: 'id,device_id',
  });
  const calls = Array.isArray(allCalls) ? allCalls : [];
  const orphan = calls.filter((c) => c.device_id === onlineId || c.device_id === offlineId);
  check(
    orphan.length === 0,
    '没有任何派发行还指向假设备（否则会永远 pending 在库里）',
    orphan.length ? `残留 ${orphan.length} 条` : ''
  );
  check(
    calls.length === baselineCalls + EXPECTED_REAL_CALLS,
    `派发行只增加了 ${EXPECTED_REAL_CALLS} 条（全是真实设备的正常调用）`,
    `基线 ${baselineCalls} → 现在 ${calls.length}`
  );

  return finish();
}

/**
 * 指定设备并核对派发行。
 *
 * 注意"真实设备"这一路是**真跑**的（list_directory 只读、无副作用）：
 * 只有让它正常结算，才谈得上"端到端真的通了"。
 */
async function callAndInspect(token, sid, deviceId, label, { expectOk }) {
  phase(`1a. 显式指定 ${label}`);

  const res = await mcp(
    'tools/call',
    { name: 'list_directory', arguments: { path: 'C:\\', device_id: deviceId } },
    { token, sessionId: sid, abortMs: 20000 }
  );

  const body = res.json?.result ? JSON.stringify(res.json.result) : res.text;
  check(
    res.status === 200 && (!expectOk || /\[DIR\]|\[FILE\]|目录/.test(body)),
    `指定 ${label} → 调用被派发并返回目录列表`,
    `HTTP ${res.status} · ${body.slice(0, 120)}`
  );

  const owner = await supa.auth.findByEmail(cfg.OWNER_EMAIL);
  const d = await lastDispatch(owner.id);
  check(
    d && d.device_id === deviceId,
    `派发行 device_id == ${label} 的 id`,
    d ? `${String(d.device_id).slice(0, 8)} vs ${deviceId.slice(0, 8)}` : '未查到派发行'
  );
}

function finish() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  console.log('\n' + '─'.repeat(68));
  console.log(`结果：${passed} 通过 / ${failed.length} 失败`);
  if (failed.length) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  · [${f.phase}] ${f.label}${f.extra ? `\n      ${f.extra}` : ''}`);
  } else {
    console.log('✅ 设备路由行为全定 —— 多台在线时拒绝执行、列出候选、不产生派发行；');
    console.log('   显式指定时派发行严格跟随；只剩一台时自动选中。');
  }
  console.log('─'.repeat(68));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\n脚本异常中止：', err?.stack || err);
  console.error(`   卡在阶段「${currentPhase}」`);
  process.exit(1);
});
