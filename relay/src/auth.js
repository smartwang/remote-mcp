'use strict';
/**
 * 请求身份解析 —— 一个入口，三种身份。
 *
 *   1. 租户（AI 客户端）  Authorization: Bearer rmcp_...   → /mcp
 *   2. 租户（人类浏览器）  Cookie: rmcp_session=...        → /console /device
 *   3. 管理员            HTTP Basic 或 Bearer <ADMIN_TOKEN> → /admin
 *
 * 解析结果只有"是谁"，不含任何授权判断 —— 授权由调用点决定，这样"哪条路由
 * 需要哪种身份"在读 index.js 的路由表时是一目了然的，不用去翻解析逻辑。
 */

const crypto = require('node:crypto');
const cfg = require('./config');
const tokens = require('./tokens');
const session = require('./session');

/* ---------------------------------------------------------------------- IP */

/**
 * 取客户端 IP，用于限速与审计。
 *
 * 经隧道过来的请求，X-Forwarded-For 里是 OpenAI 侧的 IP；经反向代理过来的是
 * 真实客户端 IP。两者都不是"直连中继的那个 socket 地址"，所以优先用 XFF。
 */
function clientIp(req) {
  if (cfg.TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return first;
    }
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
  }
  return (req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
}

/* ------------------------------------------------------------------- 令牌 */

/** 从 Authorization 头取 Bearer 值。 */
function bearer(req) {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : null;
}

/** 常数时间字符串比较（管理员令牌比对用）。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ----------------------------------------------------- /mcp 的租户身份 */

/**
 * 解析 /mcp 调用的租户身份。
 *
 * 身份**只有一种来源**：Authorization 头里的有效令牌。没有令牌就是 401。
 *
 * 这里曾经有一条"匿名回落到遗留 owner 账号"的分支（配合 RELAY_REQUIRE_AUTH
 * 开关）。它已被删除，见 config.js 中关于该开关的说明 —— 简言之：
 * OAuth 的凭据是协商式取得的（401 → 客户端自己去授权），不需要灰度；
 * 而匿名回落会让"忘了打开开关"变成一种静默的、人人可调用的状态。
 *
 * 顺带一提，返回的 reason 区分了"没带令牌 / 格式错 / 不存在 / 已吊销 /
 * 已过期"，但它**只进日志与审计**，绝不写进响应体 —— 区分这些会让 401
 * 变成一个 prefix 存在性探测器。
 */
async function resolveMcpIdentity(req) {
  const ip = clientIp(req);
  const token = bearer(req);

  if (!token) return { ok: false, via: 'none', reason: 'missing_token', ip };

  const res = await tokens.verify(token, { ip });
  if (res.ok) {
    return { ok: true, userId: res.userId, via: 'token', prefix: res.prefix, label: res.label, ip };
  }
  return { ok: false, via: 'token', reason: res.reason, prefix: res.prefix || null, ip };
}

/* ---------------------------------------------------------------- 管理员 */

/**
 * 管理员鉴权。支持两种带法：
 *   Authorization: Basic base64(任意用户名:管理员令牌)   ← 浏览器原生弹窗，运维页用
 *   Authorization: Bearer <管理员令牌>                  ← curl / 脚本用
 *
 * 未配置 RELAY_ADMIN_TOKEN 时一律返回 false —— 也就是管理员面完全关闭。
 * 这比"留空即放行"安全得多（后者是最常见的配置事故）。
 */
function isAdmin(req) {
  if (!cfg.ADMIN_TOKEN) return false;
  const h = String(req.headers.authorization || '').trim();

  const basic = /^Basic\s+(.+)$/i.exec(h);
  if (basic) {
    let decoded = '';
    try {
      decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    } catch {
      return false;
    }
    const idx = decoded.indexOf(':');
    const pass = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    return safeEqual(pass, cfg.ADMIN_TOKEN);
  }

  const b = bearer(req);
  return b ? safeEqual(b, cfg.ADMIN_TOKEN) : false;
}

function adminChallenge(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="remote-mcp-relay admin", charset="UTF-8"',
    'content-type': 'text/plain; charset=utf-8',
  });
  res.end('需要管理员凭据。\n');
}

/* ------------------------------------------------------------ 浏览器会话 */

/** 从 cookie 解出已登录用户。返回 { uid, email } | null。 */
function currentUser(req) {
  const payload = session.readSession(req);
  return payload ? { uid: payload.uid, email: payload.email } : null;
}

module.exports = {
  clientIp,
  bearer,
  safeEqual,
  resolveMcpIdentity,
  isAdmin,
  adminChallenge,
  currentUser,
};
