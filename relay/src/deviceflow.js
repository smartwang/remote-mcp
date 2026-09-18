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
    // 本地联调：不阻塞请求，后台异步批准（approve 里会打 GoTrue）
    approve(userCode).catch((err) => {
      console.error(`[device] AUTO_APPROVE 失败：${err.message}`);
    });
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

async function approve(userCodeInput, { deviceNameOverride } = {}) {
  const userCode = normalizeUserCode(userCodeInput);
  const rec = [...pending.values()].find((r) => normalizeUserCode(r.user_code) === userCode);
  if (!rec) throw Object.assign(new Error(`找不到待批准的验证码 ${userCodeInput}`), { status: 404 });
  if (rec.status === 'approved') return rec;
  if (rec.expires_at < Date.now()) throw Object.assign(new Error('验证码已过期'), { status: 410 });

  const key = userCode;
  if (approveLocks.has(key)) return approveLocks.get(key);
  const job = (async () => {
    // 1) 账号
    const user = await supa.auth.ensureUser(cfg.OWNER_EMAIL, cfg.OWNER_PASSWORD);
    if (!user?.id) throw new Error('GoTrue 没有返回用户 id');

    // 2) 设备行。优先复用 device 带上来的 id（真正的"重连"场景），
    //    否则新建一台。
    let device = null;
    if (rec.requested_device_id) {
      const found = await supa.rest.select('mcp_devices', {
        id: `eq.${rec.requested_device_id}`,
        user_id: `eq.${user.id}`,
        select: 'id,device_name',
      });
      if (Array.isArray(found) && found.length) device = found[0];
    }
    if (!device) {
      const inserted = await supa.rest.insert('mcp_devices', {
        user_id: user.id,
        device_name: deviceNameOverride || rec.device_name || 'unknown-device',
        status: 'offline',
      });
      device = Array.isArray(inserted) ? inserted[0] : inserted;
    }
    if (!device?.id) throw new Error('创建设备行失败');

    // 3) 真的去 GoTrue 换 session。先确保密码是我们知道的那个 ——
    //    账号可能是上一次以别的密码建的。
    let session;
    try {
      session = await supa.auth.signInWithPassword(cfg.OWNER_EMAIL, cfg.OWNER_PASSWORD);
    } catch (err) {
      if (err.status === 400 || err.status === 401) {
        await supa.auth.setPassword(user.id, cfg.OWNER_PASSWORD);
        session = await supa.auth.signInWithPassword(cfg.OWNER_EMAIL, cfg.OWNER_PASSWORD);
      } else {
        throw err;
      }
    }

    rec.status = 'approved';
    rec.session = {
      access_token: session.access_token,
      refresh_token: session.refresh_token || null,
      token_type: session.token_type || 'bearer',
      expires_in: session.expires_in || 3600,
    };
    rec.assigned_device_id = device.id;
    rec.user_id = user.id;
    console.log(`[device] approved user_code=${rec.user_code} device_id=${device.id} user=${user.id}`);
    return rec;
  })().finally(() => approveLocks.delete(key));

  approveLocks.set(key, job);
  return job;
}

/* ------------------------------------------------------------------- /device/poll */

function deny(userCodeInput) {
  const userCode = normalizeUserCode(userCodeInput);
  const rec = [...pending.values()].find((r) => normalizeUserCode(r.user_code) === userCode);
  if (!rec) throw Object.assign(new Error('找不到该验证码'), { status: 404 });
  rec.status = 'denied';
  return rec;
}

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
 * 页面骨架。opts.title 换标题，opts.extraCss 追加页面专属样式 ——
 * 让运维状态页与授权页共用同一套基础 CSS，避免两份样式各自漂移。
 */
function page(htmlBody, opts = {}) {
  const title = opts.title || '授权设备接入远程 MCP';
  const extraCss = opts.extraCss || '';
  const wide = opts.wide ? 'body{max-width:820px}' : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light}
body{font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#2C2C2A}
h1{font-size:18px;font-weight:500;margin:0 0 4px}
h2{font-size:14px;font-weight:500;margin:26px 0 2px;color:#2C2C2A}
p{color:#5F5E5A;margin:6px 0}
a{color:#185FA5}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#F1EFE8;padding:2px 6px;border-radius:4px}
table{border-collapse:collapse;width:100%;margin:16px 0}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #D3D1C7;font-size:13px}
th{font-weight:500;color:#5F5E5A}
tbody th{width:150px}
input[type=text]{font:inherit;padding:8px 10px;border:1px solid #B4B2A9;border-radius:8px;width:180px;letter-spacing:2px;text-transform:uppercase}
button{font:inherit;padding:8px 16px;border:1px solid #185FA5;background:#E6F1FB;color:#0C447C;border-radius:8px;cursor:pointer}
button.deny{border-color:#BA7517;background:#FAEEDA;color:#633806;margin-left:8px}
.ok{border:1px solid #185FA5;background:#E6F1FB;color:#0C447C;padding:10px 12px;border-radius:8px;margin:16px 0}
.err{border:1px solid #A32D2D;background:#FCEBEB;color:#791F1F;padding:10px 12px;border-radius:8px;margin:16px 0}
.dim{color:#888780}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:12px}
.tag.on{background:#E6F1FB;color:#0C447C}
.tag.off{background:#F1EFE8;color:#5F5E5A}
${wide}
${extraCss}
</style></head><body>${htmlBody}</body></html>`;
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
