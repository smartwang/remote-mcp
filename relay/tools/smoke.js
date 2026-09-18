#!/usr/bin/env node
'use strict';
/**
 * 中继自检：不接真实设备，把 device 进程会走的每一步原样走一遍。
 *
 * 覆盖 device-authenticator + device 启动阶段的全部外部调用，顺序都一样：
 *   /api/mcp-info → /device/start → （批准）→ /device/poll
 *   → 用拿到的 JWT 走 PostgREST 读自己的设备行
 *
 * 这一步过了，说明"红框"对 device 而言是可用的；剩下的不确定性只有
 * Realtime 门铃（由 tools/probe-realtime.js 单独覆盖）和真实设备进程本身。
 *
 * 用法：
 *   node tools/smoke.js                       # 打本机默认中继
 *   RELAY=http://127.0.0.1:18086 node tools/smoke.js
 */

const crypto = require('node:crypto');

const RELAY = (process.env.RELAY || 'http://127.0.0.1:18086').replace(/\/+$/, '');

const results = [];
let smokeDeviceId = null;
function check(ok, label, detail) {
  results.push({ ok, label, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, headers: res.headers, body };
}

async function main() {
  console.log('=== remote-mcp 中继自检 ===\n');
  console.log(`中继 ${RELAY}\n`);

  // ---- 1. 健康 ----
  console.log('1. 健康检查');
  const health = await jsonFetch(`${RELAY}/healthz`);
  if (!check(health.status === 200, 'GET /healthz', `HTTP ${health.status} ok=${health.body?.ok}`)) {
    console.log(`\n  响应：${JSON.stringify(health.body).slice(0, 400)}`);
    process.exit(1);
  }
  check(Array.isArray(health.body.devices), '设备列表可读', `${health.body.devices?.length ?? 0} 台`);
  console.log(`        工具数 ${health.body.tool_count}，目录来源 ${health.body.catalog_source}`);
  console.log(`        MCP 端点 ${health.body.mcp_endpoint}`);
  if (health.body.db_error) check(false, '数据库连通', health.body.db_error);

  // ---- 2. /api/mcp-info ----
  console.log('\n2. /api/mcp-info（device.ts:313 的免鉴权端点）');
  const info = await jsonFetch(`${RELAY}/api/mcp-info`);
  check(info.status === 200, 'HTTP 200');
  const supabaseUrl = info.body?.supabaseUrl;
  const anonKey = info.body?.supabasePublishableKey;
  check(!!supabaseUrl, 'supabaseUrl 非空', supabaseUrl);
  check(!!anonKey && anonKey.split('.').length === 3, 'supabasePublishableKey 是 JWT', `${anonKey?.length} 字符`);

  if (supabaseUrl && anonKey) {
    const probe = await jsonFetch(`${supabaseUrl}/rest/v1/mcp_devices?select=id&limit=1`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    check(probe.status === 200, 'device 能用该地址+key 打通 PostgREST', `HTTP ${probe.status}`);
    if (probe.status !== 200) {
      console.log(`        响应：${JSON.stringify(probe.body).slice(0, 300)}`);
      console.log('        提示：device 在别的机器上时，PUBLIC_SUPABASE_URL 必须是它能访问到的地址。');
    }
  }

  // ---- 3. device flow ----
  console.log('\n3. device flow（device-authenticator.ts 的完整路径）');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const start = await jsonFetch(`${RELAY}/device/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: 'mcp-device',
      scope: 'mcp:tools',
      device_name: `${require('node:os').hostname()}-smoke`,
      device_type: 'mcp',
      device_id: null,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }),
  });
  check(start.status === 200, 'POST /device/start', `HTTP ${start.status}`);
  const { device_code, user_code, verification_uri, expires_in, interval } = start.body || {};
  check(!!device_code && !!user_code, '拿到 device_code / user_code', `${user_code}（${expires_in}s，interval ${interval}s）`);
  check(typeof verification_uri === 'string' && verification_uri.length > 0, 'verification_uri 非空', verification_uri);

  // 首轮 poll 必须是 pending（device 侧靠它判断"还没批准"）
  const poll1 = await jsonFetch(`${RELAY}/device/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code, client_id: 'mcp-device', code_verifier: verifier }),
  });
  check(poll1.body?.error === 'authorization_pending', '未批准时返回 authorization_pending', `HTTP ${poll1.status} error=${poll1.body?.error}`);

  // 批准（走和中继内部同一个函数，AUTO_APPROVE 开着时已经批过了）
  console.log('   → 批准 …');
  const approveBody = new URLSearchParams({ user_code });
  const approve = await fetch(`${RELAY}/device/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: approveBody.toString(),
    redirect: 'manual',
  });
  check(approve.status === 200, 'POST /device/approve', `HTTP ${approve.status}`);

  // 等过 slow_down 窗口
  await new Promise((r) => setTimeout(r, ((interval || 2) + 1) * 1000));

  const poll2 = await jsonFetch(`${RELAY}/device/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code, client_id: 'mcp-device', code_verifier: verifier }),
  });
  const session = poll2.body || {};
  check(
    poll2.status === 200 && !!session.access_token && !!session.refresh_token && !!session.device_id,
    '批准后拿到完整 session',
    `HTTP ${poll2.status} access_token=${session.access_token?.length}B refresh_token=${session.refresh_token?.length}B device_id=${session.device_id}`
  );
  if (!session.access_token) {
    console.log(`        响应：${JSON.stringify(session).slice(0, 300)}`);
  }
  if (session.device_id) smokeDeviceId = session.device_id;

  // PKCE 反例：错的 verifier 必须被拒
  const badPoll = await jsonFetch(`${RELAY}/device/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code, client_id: 'mcp-device', code_verifier: 'wrong-verifier' }),
  });
  check(badPoll.body?.error === 'invalid_grant', 'PKCE 错 verifier 被拒', `error=${badPoll.body?.error}`);

  // ---- 4. 用拿到的身份读自己的设备行（device 启动时要做的就是这件事）----
  console.log('\n4. 用 session 走 PostgREST（device.ts registerDevice 的同款调用）');
  if (session.access_token && session.device_id && supabaseUrl && anonKey) {
    const asUser = await jsonFetch(
      `${supabaseUrl}/rest/v1/mcp_devices?id=eq.${session.device_id}&select=id,device_name,status,capabilities`,
      { headers: { apikey: anonKey, Authorization: `Bearer ${session.access_token}` } }
    );
    const row = Array.isArray(asUser.body) ? asUser.body[0] : null;
    check(asUser.status === 200 && !!row, '能读到自己的设备行（RLS 放行）', `HTTP ${asUser.status} id=${row?.id ?? '(无)'} status=${row?.status ?? '-'}`);
    if (!row) console.log(`        响应：${JSON.stringify(asUser.body).slice(0, 300)}`);

    // 反向断言：anon（未登录）必须读不到东西，否则 RLS 没生效
    const asAnon = await jsonFetch(
      `${supabaseUrl}/rest/v1/mcp_devices?select=id&limit=5`,
      { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } }
    );
    const anonRows = Array.isArray(asAnon.body) ? asAnon.body : [];
    check(anonRows.length === 0, 'anon 身份读不到任何设备（RLS 生效）', `${anonRows.length} 行`);

    // 伪造防护：schema.sql 刻意不给 insert 策略。自托管 Supabase 的默认权限
    // 比托管版宽（anon/authenticated 对 public 新表默认拿到 ALL），所以
    // 「拦得住」这件事必须实测，不能靠 GRANT 推断。
    const forgeCall = await jsonFetch(`${supabaseUrl}/rest/v1/mcp_remote_calls`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${session.access_token}`,
        'content-type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        device_id: session.device_id,
        user_id: '00000000-0000-0000-0000-000000000000',
        tool_name: 'read_file',
        tool_args: { path: 'C:/Windows/win.ini' },
      }),
    });
    check(
      forgeCall.status === 401 || forgeCall.status === 403,
      'authenticated 无法伪造调用行（无 insert 策略）',
      `HTTP ${forgeCall.status}`
    );

    const forgeDevice = await jsonFetch(`${supabaseUrl}/rest/v1/mcp_devices`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${session.access_token}`,
        'content-type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ user_id: '00000000-0000-0000-0000-000000000000', device_name: 'forged' }),
    });
    check(
      forgeDevice.status === 401 || forgeDevice.status === 403,
      'authenticated 无法自建设备行',
      `HTTP ${forgeDevice.status}`
    );

    // 设备状态更新（device.ts updateDevice 的同款调用）
    const patch = await jsonFetch(
      `${supabaseUrl}/rest/v1/mcp_devices?id=eq.${session.device_id}`,
      {
        method: 'PATCH',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${session.access_token}`,
          'content-type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ status: 'online', capabilities: { app_version: 'smoke', transport_broadcast_v1: true } }),
      }
    );
    const patched = Array.isArray(patch.body) ? patch.body[0] : null;
    check(patch.status === 200 && patched?.status === 'online', '能更新自己的设备行', `status=${patched?.status}`);
  }

  // ---- 5. MCP 端点 ----
  console.log('\n5. MCP 端点（ChatGPT 会走的形状）');
  const mcpUrl = health.body.mcp_endpoint;
  const init = await jsonFetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } },
    }),
  });
  const sid = init.headers.get('mcp-session-id');
  check(init.status === 200 && !!init.body?.result, 'initialize 成功', `HTTP ${init.status} session=${sid ? sid.slice(0, 8) + '…' : '(无)'}`);
  check(!!sid, '返回 mcp-session-id 头');

  const list = await jsonFetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const tools = list.body?.result?.tools || [];
  check(tools.length === health.body.tool_count, `tools/list 返回 ${tools.length} 个（期望 ${health.body.tool_count}）`);
  check(tools.every((t) => t.name && t.inputSchema), '每个工具都有 name 与 inputSchema');

  console.log('\n=== 结论 ===');
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}`);
  console.log(failed.length === 0 ? '\n✅ 全绿\n' : `\n❌ ${failed.length} 项失败\n`);

  await cleanup(smokeDeviceId);
  process.exit(failed.length === 0 ? 0 : 1);
}

/**
 * 删掉自检期间造的设备行。
 *
 * 这一步不能省：自检过的设备行带着 transport_broadcast_v1=true 和刚刷新的
 * last_seen，会被 tools/call 的选设备逻辑当成一台"在线且支持广播"的设备，
 * 于是真实调用被路由到一个不存在的设备上、白等 5 分钟。
 */
async function cleanup(deviceId) {
  if (!deviceId) return;
  try {
    const cfg = require('../src/config');
    const supa = require('../src/supa');
    // 走 supa 的 header 构造，别手写 `Authorization: Bearer <key>` ——
    // 新格式密钥（sb_secret_…）不是 JWT，塞进 Bearer 会被判 Invalid JWT。
    await fetch(`${cfg.SUPABASE_URL}/rest/v1/mcp_devices?id=eq.${deviceId}`, {
      method: 'DELETE',
      headers: supa.secretKeyHeaders({ Prefer: 'return=representation' }),
    });
    console.log(`  (已清理自检设备行 ${deviceId})`);
  } catch (err) {
    console.log(`  ⚠ 清理自检设备行失败：${err.message}`);
    console.log(`    手动清：delete from mcp_devices where device_name like '%smoke%';`);
  }
}

main().catch((err) => {
  console.error('\n自检异常：', err.stack || err.message);
  process.exit(1);
});
