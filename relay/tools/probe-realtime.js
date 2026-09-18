#!/usr/bin/env node
'use strict';
/**
 * 探针：验证「中继用 service_role 经 REST 广播 → 私有频道订阅者收得到」。
 *
 * 为什么单独验这一条：整个派发机制完全押在它上面。device 侧只认 Realtime
 * 广播来的 new_call 门铃（remote-channel.ts 里没有任何轮询兜底），所以
 * 如果这条路不通，tools/call 会直接卡满 5 分钟超时。这是全链路里唯一
 * "要么通要么全废"的环节，必须在接设备之前先证明它成立。
 *
 * 验证方式（不需要 device 参与）：
 *   1. 用 anon key 建/查 owner 账号，password grant 拿一个真实 JWT
 *   2. 以 WebSocket 客户端身份 join 私有频道 user:<uid>
 *   3. 用 service_role 走 REST broadcast 发 new_call
 *   4. 断言 WS 客户端收到了它
 *
 * 同时顺带体检 PostgREST / GoTrue / Realtime 三个上游。
 *
 * 用法：node tools/probe-realtime.js
 */

const cfg = require('../src/config');
const supa = require('../src/supa');

// Node 20+ 自带全局 WebSocket（undici 实现），不需要 ws 包。
if (typeof globalThis.WebSocket !== 'function') {
  console.error('❌ 需要 Node 20+ 的全局 WebSocket。当前 Node：' + process.version);
  process.exit(1);
}
const WebSocket = globalThis.WebSocket;

const TIMEOUT_MS = 20000;

function line(ok, label, detail) {
  const mark = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO';
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
  return ok === true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    }),
  ]);
}

async function main() {
  console.log('=== remote-mcp 中继 · 上游体检 ===\n');
  console.log(`Supabase        ${cfg.SUPABASE_URL}`);
  console.log(`ANON_KEY        ${cfg.ANON_KEY?.slice(0, 24)}… (${cfg.ANON_KEY?.length} 字符)`);
  console.log(`SERVICE_ROLE    ${cfg.SERVICE_ROLE_KEY?.slice(0, 24)}… (${cfg.SERVICE_ROLE_KEY?.length} 字符)\n`);

  const results = {};

  // ---- 1. PostgREST ----
  console.log('1. PostgREST');
  try {
    const rows = await withTimeout(
      supa.rest.select('mcp_devices', { select: 'id', limit: '1' }),
      TIMEOUT_MS,
      'PostgREST'
    );
    results.postgrest = true;
    line(true, 'mcp_devices 可读', `${Array.isArray(rows) ? rows.length : '?'} 行`);
  } catch (err) {
    results.postgrest = false;
    line(false, 'mcp_devices 不可读', err.message);
    console.log('\n  → schema.sql 可能还没应用。先执行：');
    console.log(`     docker exec -i supabase-db psql -U postgres -d postgres < ../supabase/schema.sql\n`);
    process.exit(1);
  }

  // ---- 2. GoTrue ----
  console.log('\n2. GoTrue（device flow 的命门）');
  let user = null;
  let session = null;
  try {
    user = await withTimeout(supa.auth.ensureUser(cfg.OWNER_EMAIL, cfg.OWNER_PASSWORD), TIMEOUT_MS, 'ensureUser');
    results.gotrue_user = !!user?.id;
    line(!!user?.id, 'owner 账号可用', `${cfg.OWNER_EMAIL} → ${user?.id}`);

    try {
      session = await supa.auth.signInWithPassword(cfg.OWNER_EMAIL, cfg.OWNER_PASSWORD);
    } catch (err) {
      line(false, 'password grant 首试失败，重置密码后重试', err.message);
      await supa.auth.setPassword(user.id, cfg.OWNER_PASSWORD);
      session = await supa.auth.signInWithPassword(cfg.OWNER_EMAIL, cfg.OWNER_PASSWORD);
    }
    results.gotrue_session = !!session?.access_token;
    line(!!session?.access_token, 'password grant 拿到 session',
      `access_token ${session.access_token.length}B, refresh_token ${session.refresh_token ? session.refresh_token.length + 'B' : '缺失'}`);

    if (!session?.refresh_token) {
      line(false, 'refresh_token 缺失', 'device 侧之后无法自行续期');
    } else {
      // device 侧要靠 refresh_token 长期续期，这条路径必须通
      const refreshed = await withTimeout(supa.auth.refresh(session.refresh_token), TIMEOUT_MS, 'refresh');
      results.gotrue_refresh = !!refreshed?.access_token;
      line(!!refreshed?.access_token, 'refresh_token 可续期');
    }

    const payload = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url').toString('utf8'));
    line(true, 'JWT payload', JSON.stringify(payload));
  } catch (err) {
    results.gotrue_user = false;
    line(false, 'GoTrue 体检失败', err.message);
  }

  // ---- 3. Realtime：REST 广播 → 私有频道 WS 订阅者 ----
  console.log('\n3. Realtime 门铃链路（REST broadcast → 私有频道订阅者）');

  const wsUrl = cfg.SUPABASE_URL.replace(/^http/, 'ws') + `/realtime/v1/websocket?apikey=${cfg.ANON_KEY}&vsn=1.0.0`;
  const topic = `user:${user.id}`;
  const received = [];
  let joined = false;
  let wsError = null;

  const ws = await withTimeout(
    new Promise((resolve, reject) => {
      const sock = new WebSocket(wsUrl);
      sock.onopen = () => resolve(sock);
      sock.onerror = (e) => reject(new Error(`WebSocket 连接失败：${e?.message || 'unknown'}`));
      setTimeout(() => reject(new Error('WebSocket 连接超时')), TIMEOUT_MS);
    }),
    TIMEOUT_MS + 1000,
    'WS connect'
  ).catch((err) => {
    wsError = err;
    return null;
  });

  if (!ws) {
    line(false, 'WebSocket 连不上 Realtime', wsError?.message);
    results.ws = false;
    results.broadcast = false;
  } else {
    results.ws = true;
    line(true, 'WebSocket 已连上', wsUrl.replace(cfg.ANON_KEY, '<anon>'));

    const joinRef = '1';
    let joinSettled = null;
    const joinPromise = new Promise((resolve) => {
      joinSettled = resolve;
    });

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.event === 'phx_reply' && msg.ref === joinRef) {
        joinSettled({ ok: msg.payload?.status === 'ok', payload: msg.payload });
        return;
      }
      if (msg.event === 'broadcast') {
        received.push(msg.payload);
      }
    };
    ws.onerror = (e) => console.log(`     [ws error] ${e?.message || 'unknown'}`);

    ws.send(JSON.stringify({
      topic: `realtime:${topic}`,
      event: 'phx_join',
      payload: {
        config: {
          broadcast: { self: false, ack: false },
          presence: { key: 'relay-probe' },
          private: true,
        },
        access_token: session.access_token,
      },
      ref: joinRef,
    }));

    const joinResult = await withTimeout(joinPromise, TIMEOUT_MS, 'phx_join').catch((err) => ({
      ok: false,
      payload: { reason: err.message },
    }));
    joined = joinResult.ok;
    results.join = joined;
    line(joined, `join 私有频道 ${topic}`, joined ? 'status=ok' : JSON.stringify(joinResult.payload));

    // 清掉早于广播的残留，避免误判
    received.length = 0;

    const probeId = supa.randomId();
    try {
      await withTimeout(
        supa.broadcast(topic, 'new_call', { call_id: probeId, device_id: supa.randomId() }),
        TIMEOUT_MS,
        'broadcast'
      );
      results.broadcast = true;
      line(true, 'REST broadcast 调用成功', '/realtime/v1/api/broadcast');
    } catch (err) {
      results.broadcast = false;
      line(false, 'REST broadcast 失败', `status=${err.status} ${err.message}`);
    }

    if (results.broadcast) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && received.length === 0) await sleep(200);
      const got = received.some((p) => p?.payload?.call_id === probeId || p?.event === 'new_call');
      results.delivered = got;
      line(got, '订阅者收到门铃', got ? JSON.stringify(received[0]).slice(0, 200) : '8 秒内没有收到');
    }

    ws.close();
  }

  console.log('\n=== 结论 ===');
  const critical = [
    ['PostgREST 可读', results.postgrest],
    ['GoTrue 可发 session', results.gotrue_session],
    ['GoTrue 可续期', results.gotrue_refresh],
    ['Realtime WS 可连', results.ws],
    ['私有频道可 join', results.join],
    ['REST broadcast 可发', results.broadcast],
    ['门铃可送达', results.delivered],
  ];
  let allPass = true;
  for (const [label, ok] of critical) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) allPass = false;
  }
  console.log(allPass ? '\n✅ 全绿 —— 可以接 device 了\n' : '\n❌ 有失败项 —— 先修，别急着接 device\n');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('\n探针自身异常：', err.stack || err.message);
  process.exit(1);
});
