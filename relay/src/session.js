'use strict';
/**
 * 浏览器会话：HMAC 签名的无状态 cookie。
 *
 * 为什么不用 GoTrue 的 access_token 直接当 cookie：
 *   它 1 小时就过期，而且刷新要点 GoTrue。中继想要的是"登录一次，控制台能连着用一周"。
 *   所以中继自己签发一个签名 cookie，把 GoTrue 只当作"密码校验器"用 ——
 *   中继**从不接触也不存储用户密码**，密码只在登录那一刻透传给 GoTrue。
 *
 * 为什么是无状态（签名 payload 而不是随机 session id + 服务端存储）：
 *   中继重启不该让所有用户掉线，也不该为此引入一张会话表。代价是"主动登出所有
 *   设备"这种能力暂时没有 —— 需要时把签名密钥换掉即可（换密钥 = 全部失效），
 *   这是可接受的取舍，且操作很明确。
 *
 * 签名密钥：RELAY_SESSION_SECRET 环境变量优先；没有就首次启动生成一次、
 * 写进 relay/.session-secret（已 gitignore）。自动落盘是为了让"重启中继"
 * 这个高频动作不会把所有人踢下线。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const cfg = require('./config');

let cachedSecret = null;

function loadSecret() {
  if (cachedSecret) return cachedSecret;

  if (cfg.SESSION_SECRET) {
    cachedSecret = cfg.SESSION_SECRET;
    return cachedSecret;
  }
  try {
    const fromFile = fs.readFileSync(cfg.SESSION_SECRET_FILE, 'utf8').trim();
    if (fromFile.length >= 32) {
      cachedSecret = fromFile;
      return cachedSecret;
    }
  } catch {
    /* 文件不存在或不可读 —— 下面生成一个新的 */
  }

  const fresh = crypto.randomBytes(48).toString('base64url');
  try {
    fs.writeFileSync(cfg.SESSION_SECRET_FILE, fresh, { mode: 0o600 });
    console.log(`[session] 已生成会话签名密钥 → ${cfg.SESSION_SECRET_FILE}（已 gitignore，请勿提交）`);
  } catch (err) {
    console.warn(
      `[session] ⚠ 无法写入 ${cfg.SESSION_SECRET_FILE}（${err.message}）。` +
        '密钥只存在于内存中 —— 中继一旦重启，所有登录都会失效。'
    );
  }
  cachedSecret = fresh;
  return cachedSecret;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function hmac(data) {
  return crypto.createHmac('sha256', loadSecret()).update(data).digest();
}

/** 把 payload 签成一个 cookie 值。 */
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(hmac(body))}`;
}

/** 校验并解出 payload。签名不对、格式不对、已过期都返回 null。 */
function unsign(value) {
  if (typeof value !== 'string' || !value.includes('.')) return null;
  const idx = value.lastIndexOf('.');
  const body = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  let expected;
  try {
    expected = b64u(hmac(body));
  } catch {
    return null;
  }
  if (expected.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (!payload.uid || !payload.exp) return null;
  if (payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

/* --------------------------------------------------------------- cookie 读写 */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function readSession(req) {
  const raw = parseCookies(req.headers.cookie)[cfg.COOKIE_NAME];
  if (!raw) return null;
  return unsign(raw);
}

function cookieAttrs(maxAgeS) {
  const parts = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  // Lax 而非 None：Lax 下跨站的 POST 不带 cookie，这本身就是一层 CSRF 防护。
  // 中继没有任何需要跨站携带会话的场景，所以不需要 None。
  if (cfg.COOKIE_SECURE) parts.push('Secure');
  parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeS))}`);
  return parts.join('; ');
}

function setSession(res, { userId, email }) {
  const payload = {
    uid: userId,
    email,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + cfg.SESSION_TTL_S,
  };
  const value = sign(payload);
  res.setHeader('Set-Cookie', `${cfg.COOKIE_NAME}=${encodeURIComponent(value)}; ${cookieAttrs(cfg.SESSION_TTL_S)}`);
  return payload;
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${cfg.COOKIE_NAME}=; ${cookieAttrs(0)}`);
}

module.exports = {
  sign,
  unsign,
  readSession,
  setSession,
  clearSession,
  parseCookies,
  loadSecret,
};
