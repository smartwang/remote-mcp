'use strict';
/**
 * OAuth 2.0 Device Authorization Grant（复刻 device-authenticator.ts 期望的契约）。
 *
 * device 侧只看这几个字段（device-authenticator.ts:12-29）：
 *   /device/start  → { device_code, user_code, verification_uri,
 *                      verification_uri_complete, expires_in, interval }
 *   /device/poll   → { access_token, refresh_token, token_type, expires_in, device_id }
 *                  | { error: 'authorization_pending' | 'slow_down' | ... }
 *
 * 所以这不是给人类用的 OAuth 服务器，只是让开源 device 进程能拿到一个
 * "它以为来自 Supabase GoTrue" 的真实 session —— 因此批准动作必须真的去
 * GoTrue 换 token，不能自己造一个假的 JWT（PostgREST / Realtime 都不认）。
 *
 * 存储：进程内存。device flow 的生命周期只有几分钟，中继重启导致的失败
 * 用户重跑一次即可。要跨重启就得建表，属于后续按需项。
 */

const crypto = require('node:crypto');
const cfg = require('./config');
const supa = require('./supa');
const layout = require('./layout');

/** device_code → record */
const pending = new Map();

const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789'; // 去掉易混字符

function makeUserCode() {
  let s = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function normalizeUserCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sweepExpired() {
  const now = Date.now();
  for (const [code, rec] of pending) {
    if (rec.expires_at < now) pending.delete(code);
  }
}

/** base64url(SHA256(verifier)) —— PKCE S256 的校验。 */
function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/* ------------------------------------------------------------------ /device/start */

function start(body) {
  sweepExpired();

  const deviceCode = crypto.randomBytes(32).toString('base64url');
  const userCode = makeUserCode();
  const now = Date.now();

  const rec = {
    device_code: deviceCode,
    user_code: userCode,
    client_id: body.client_id || 'mcp-device',
    scope: body.scope || 'mcp:tools',
    device_name: body.device_name || 'unknown-device',
    device_type: body.device_type || 'mcp',
    // device 会把它本地持久化的 device_id 带上来。若是官方的 ID，我们库里查不到，
    // 就按"新设备"处理；批准时会把我们自己的 device_id 回给它，
    // device.ts 会打印 "Device ID changed" 并采用新值。
    requested_device_id: body.device_id || null,
    code_challenge: body.code_challenge || null,
    code_challenge_method: body.code_challenge_method || 'S256',
    created_at: now,
    expires_at: now + cfg.DEVICE_CODE_TTL_S * 1000,
    status: 'pending',
    session: null,
    assigned_device_id: null,
    last_poll_ms: 0,
  };
  pending.set(deviceCode, rec);

  console.log(`[device] start  user_code=${userCode} device="${rec.device_name}" device_id=${rec.requested_device_id || '(none)'}`);

  if (cfg.AUTO_APPROVE) {
    // 本地联调：不阻塞请求，后台异步批准。
    // 多租户下"自动批准"必须指定一个归属账号，这里用遗留的 OWNER_EMAIL ——
    // 自动批准意味着任何设备请求都会被无条件接入，只该在本地开。
    (async () => {
      try {
        const user =
          (await supa.auth.findByEmail(cfg.OWNER_EMAIL)) ||
          (await supa.auth.ensureUser(cfg.OWNER_EMAIL, cfg.OWNER_PASSWORD));
        if (!user?.id) throw new Error('找不到用于自动批准的账号');
        await approve(userCode, { userId: user.id, email: user.email });
      } catch (err) {
        console.error(`[device] AUTO_APPROVE 失败：${err.message}`);
      }
    })();
  }

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${cfg.RELAY_PUBLIC_URL}/device`,
    verification_uri_complete: `${cfg.RELAY_PUBLIC_URL}/device?user_code=${encodeURIComponent(userCode)}`,
    expires_in: cfg.DEVICE_CODE_TTL_S,
    interval: cfg.DEVICE_POLL_INTERVAL_S,
  };
}

/* ------------------------------------------------------------------ 批准 */

const approveLocks = new Map(); // user_code → Promise，防并发重复建设备

/**
 * 批准一个待处理的授权请求，把设备绑定到**批准者**的账号上。
 *
 * 多租户下的关键变化：userId 是必传的，且不再有"默认账号"这种回落。
 * 之前这里写死 cfg.OWNER_EMAIL —— 意味着**任何人**只要打到 /device/approve
 * 就能把一台设备接进系统（而且都归到同一个账号）。现在批准者是谁，设备就属于谁，
 * 所以调用点（路由层）必须先完成登录校验。
 *
 * 另一点：不再需要用户密码。device 需要的是一个真实 session（它靠这个过
 * PostgREST 与 Realtime 的 RLS），而这个 session 用 admin 的 generate_link +
 * verify 免密就能签出来 —— 见 supa.auth.mintSession 的注释。
 */
async function approve(userCodeInput, { userId, email, deviceNameOverride, ip = null } = {}) {
  const userCode = normalizeUserCode(userCodeInput);
  const rec = [...pending.values()].find((r) => normalizeUserCode(r.user_code) === userCode);
  if (!rec) throw Object.assign(new Error(`找不到待批准的验证码 ${userCodeInput}`), { status: 404 });
  if (rec.status === 'approved') return rec;
  if (rec.expires_at < Date.now()) throw Object.assign(new Error('验证码已过期'), { status: 410 });

  if (!userId) {
    throw Object.assign(new Error('批准请求缺少登录身份'), { status: 401 });
  }

  const key = userCode;
  if (approveLocks.has(key)) return approveLocks.get(key);

  const job = (async () => {
    const scope = supa.tenantScope(userId);

    // 1) 设备行。device 会把本地持久化的 device_id 带上来，但那个 id 只有在
    //    **属于本租户**时才能复用 —— tenantScope.find 自带 user_id 条件，
    //    别人的 id 在这里等同不存在，于是走新建分支。
    let device = null;
    if (rec.requested_device_id) {
      device = await scope.find('mcp_devices', rec.requested_device_id, 'id,device_name');
    }
    if (!device) {
      const inserted = await scope.insert('mcp_devices', {
        device_name: deviceNameOverride || rec.device_name || 'unknown-device',
        status: 'offline',
      });
      device = Array.isArray(inserted) ? inserted[0] : inserted;
    }
    if (!device?.id) throw new Error('创建设备行失败');

    // 2) 免密签发一个真实 session 交给 device 进程。
    const targetEmail = email || (await supa.auth.getById(userId))?.email;
    if (!targetEmail) throw new Error('无法确定批准者邮箱，session 签发中止');
    const session = await supa.auth.mintSession(targetEmail);

    rec.status = 'approved';
    rec.session = {
      access_token: session.access_token,
      refresh_token: session.refresh_token || null,
      token_type: session.token_type || 'bearer',
      expires_in: session.expires_in || 3600,
    };
    rec.assigned_device_id = device.id;
    rec.user_id = userId;
    rec.approved_at = Date.now();

    await supa.audit({
      userId,
      actor: 'tenant',
      action: 'device.approve',
      target: device.id,
      detail: { device_name: device.device_name, user_code: rec.user_code },
      ip,
    });

    console.log(
      `[device] approved user_code=${rec.user_code} device=${device.id.slice(0, 8)} ` +
        `"${device.device_name}" → tenant ${userId.slice(0, 8)}`
    );
    return rec;
  })().finally(() => approveLocks.delete(key));

  approveLocks.set(key, job);
  return job;
}

/** 拒绝一个待处理请求。同样要求登录身份（路由层保证）。 */
function deny(userCodeInput, { userId = null, ip = null } = {}) {
  const userCode = normalizeUserCode(userCodeInput);
  const rec = [...pending.values()].find((r) => normalizeUserCode(r.user_code) === userCode);
  if (!rec) throw Object.assign(new Error('找不到该验证码'), { status: 404 });
  rec.status = 'denied';
  supa
    .audit({
      userId,
      actor: 'tenant',
      action: 'device.deny',
      target: rec.device_name,
      detail: { user_code: rec.user_code },
      ip,
    })
    .catch(() => {});
  return rec;
}

/* ------------------------------------------------------------------- /device/poll */

function poll(body) {
  sweepExpired();
  const { device_code: deviceCode, client_id: clientId, code_verifier: codeVerifier } = body || {};

  if (!deviceCode) return { httpStatus: 400, body: { error: 'invalid_request', error_description: '缺少 device_code' } };
  const rec = pending.get(deviceCode);
  if (!rec) {
    return { httpStatus: 400, body: { error: 'expired_token', error_description: 'device_code 不存在或已过期' } };
  }
  if (clientId && rec.client_id && clientId !== rec.client_id) {
    return { httpStatus: 400, body: { error: 'invalid_client', error_description: 'client_id 不匹配' } };
  }
  if (rec.expires_at < Date.now()) {
    pending.delete(deviceCode);
    return { httpStatus: 400, body: { error: 'expired_token', error_description: 'device_code 已过期' } };
  }

  // PKCE：device 侧一定会带 code_verifier（device-authenticator.ts:130）
  if (rec.code_challenge) {
    if (!codeVerifier) {
      return { httpStatus: 400, body: { error: 'invalid_grant', error_description: '缺少 code_verifier' } };
    }
    const method = (rec.code_challenge_method || 'S256').toUpperCase();
    const actual = method === 'S256' ? pkceChallenge(codeVerifier) : codeVerifier;
    if (actual !== rec.code_challenge) {
      console.warn(`[device] PKCE 校验失败 user_code=${rec.user_code}`);
      return { httpStatus: 400, body: { error: 'invalid_grant', error_description: 'PKCE 校验失败' } };
    }
  }

  const now = Date.now();
  if (rec.last_poll_ms && now - rec.last_poll_ms < cfg.DEVICE_POLL_INTERVAL_S * 1000) {
    return { httpStatus: 400, body: { error: 'slow_down', error_description: `轮询过快，间隔应不小于 ${cfg.DEVICE_POLL_INTERVAL_S}s` } };
  }
  rec.last_poll_ms = now;

  if (rec.status === 'denied') {
    pending.delete(deviceCode);
    return { httpStatus: 400, body: { error: 'access_denied', error_description: '用户拒绝了本次授权' } };
  }
  if (rec.status !== 'approved' || !rec.session) {
    return { httpStatus: 400, body: { error: 'authorization_pending', error_description: '等待用户批准' } };
  }

  // 批准过了：交出 session。刻意不删除记录 —— device 侧在拿不到 device_id 时
  // 会重新走一遍流程，保留记录能让它重复拉取而不是重新验证。
  return {
    httpStatus: 200,
    body: {
      access_token: rec.session.access_token,
      refresh_token: rec.session.refresh_token,
      token_type: rec.session.token_type,
      expires_in: rec.session.expires_in,
      device_id: rec.assigned_device_id,
    },
  };
}

/* ------------------------------------------------------------------- 验证页 */

function listPending() {
  sweepExpired();
  return [...pending.values()].map((r) => ({
    user_code: r.user_code,
    device_name: r.device_name,
    created_at: r.created_at,
    expires_in_s: Math.max(0, Math.round((r.expires_at - Date.now()) / 1000)),
    status: r.status,
    device_id: r.assigned_device_id,
  }));
}

/**
 * 页面骨架 —— 转发到共享布局（layout.js）。
 *
 * 保留这个转发是为了不打断既有调用点（index.js 的 renderPage/renderStatusPage）。
 * 真正的样式与转义在 layout.js，所有页面共用一套，避免各页 CSS 各自漂移。
 */
function page(htmlBody, opts = {}) {
  return layout.page(htmlBody, opts);
}

module.exports = {
  start,
  poll,
  approve,
  deny,
  listPending,
  page,
  pkceChallenge,
  _pending: pending,
};
