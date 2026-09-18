'use strict';
/**
 * 账号：注册与登录。
 *
 * 中继在这里的角色很窄 —— 它只是把凭据透传给 GoTrue 校验，然后签发**自己的**
 * cookie 会话（见 session.js）。它不存密码、不存 token、不存 session。
 *
 * 关于邮箱确认：自建部署通常没配 SMTP，走标准 signup 会卡在"等确认邮件"。
 * 所以注册走 GoTrue 的**管理接口**并直接置 email_confirm=true —— 这也让
 * "注册后立刻能用"这件事不依赖 RELAY 之外的任何配置。
 * 代价是没有邮箱真实性验证：能填任意邮箱注册。内网/自用可接受，
 * 上公网前应关闭自助注册（RELAY_ALLOW_SIGNUP=false）或接入真实 SMTP。
 */

const supa = require('./supa');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 200;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateCredentials(email, password) {
  if (!email) return '请填写邮箱';
  if (!EMAIL_RE.test(email)) return '邮箱格式不正确';
  if (email.length > 200) return '邮箱过长';
  if (!password) return '请填写密码';
  if (String(password).length < MIN_PASSWORD_LEN) return `密码至少 ${MIN_PASSWORD_LEN} 位`;
  if (String(password).length > MAX_PASSWORD_LEN) return '密码过长';
  return null;
}

/**
 * 注册。返回 { ok, userId?, email?, error? }。
 *
 * 刻意不给"邮箱已注册"之外的任何细节，避免把注册接口变成邮箱枚举器 ——
 * 不过"邮箱已注册"本身就已经是一次枚举了。要做到不枚举就得改成"发确认邮件、
 * 无论是否存在都提示已发送"，那需要 SMTP。这里如实暴露，并在 README 里写明。
 */
async function signup(rawEmail, password, { ip = null } = {}) {
  const email = normalizeEmail(rawEmail);
  const invalid = validateCredentials(email, password);
  if (invalid) return { ok: false, error: invalid };

  let user;
  try {
    user = await supa.auth.createUser(email, password);
  } catch (err) {
    await supa.audit({ actor: 'anonymous', action: 'account.signup_error', target: email, detail: { message: err.message }, ip });
    return { ok: false, error: `创建账号失败：${err.message}` };
  }

  if (!user?.id) {
    await supa.audit({ actor: 'anonymous', action: 'account.signup_conflict', target: email, ip });
    return { ok: false, error: '该邮箱已注册，直接登录即可。' };
  }

  await supa.audit({ userId: user.id, actor: 'anonymous', action: 'account.signup', target: email, ip });
  return { ok: true, userId: user.id, email };
}

/** 登录。密码交给 GoTrue 校验，中继只拿回 userId。 */
async function login(rawEmail, password, { ip = null } = {}) {
  const email = normalizeEmail(rawEmail);
  if (!email || !password) return { ok: false, error: '请填写邮箱和密码' };

  let session;
  try {
    session = await supa.auth.signInWithPassword(email, password);
  } catch (err) {
    // GoTrue 对"用户不存在"和"密码错误"返回的都是 400 invalid_grant，
    // 这里保持同一个对外文案 —— 区分开就等于送了一个账号存在性接口。
    const bad =
      err.status === 400 || err.status === 401 || /invalid_grant|invalid_credentials/i.test(err.message);
    await supa.audit({
      actor: 'anonymous',
      action: bad ? 'account.login_failed' : 'account.login_error',
      target: email,
      detail: { status: err.status },
      ip,
    });
    return { ok: false, error: bad ? '邮箱或密码不正确。' : `登录失败：${err.message}` };
  }

  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false, error: 'GoTrue 没有返回用户信息' };
  }

  await supa.audit({ userId, actor: 'tenant', action: 'account.login', target: email, ip });
  return { ok: true, userId, email: session.user.email || email };
}

/** 按 id 取用户，用于会话续期/展示。 */
async function getUser(userId) {
  return supa.auth.getById(userId);
}

module.exports = { signup, login, getUser, normalizeEmail, MIN_PASSWORD_LEN };
