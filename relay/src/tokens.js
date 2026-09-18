'use strict';
/**
 * 个人访问令牌（PAT）—— AI 客户端访问 /mcp 的凭据。
 *
 * 令牌形态：  rmcp_<prefix>_<secret>
 *   prefix  10 位 [a-z0-9]，明文存库、明文回显。作用只是"一句话定位到行"，
 *           避免每次校验都全表比对哈希。它不是秘密。
 *   secret  32 字节随机数的 base64url（43 字符），**只在创建时返回一次**，
 *           库里只留 sha256(secret)。
 *
 * 为什么这样切分：定位要快（每次 MCP 请求都要校验一次），而比对要慢得安全
 * （不能让库泄露直接等于令牌泄露）。前缀明文 + 密钥哈希正好同时满足。
 *
 * 为什么不用 Supabase JWT：JWT 1 小时过期，ChatGPT connector 里填的是静态值，
 * 没法自动刷新。而且 PAT 可以被单独吊销（JWT 在过期前吊销不掉）。
 *
 * 缓存：verify() 结果在内存里缓存 cfg.TOKEN_CACHE_TTL_MS。同进程内 revoke()
 * 会立刻清掉对应条目，所以"吊销后立即失效"在单进程下是精确的；跨进程部署
 * （多副本）时最坏有 TTL 那么久的延迟 —— 想做到精确就得走数据库或广播，
 * 现阶段不值当，但要知道这个边界。
 */

const crypto = require('node:crypto');
const cfg = require('./config');
const supa = require('./supa');

const SCHEME = 'rmcp';
const PREFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PREFIX_LEN = 10;
const SECRET_BYTES = 32;
/** 对外展示与统计用的字段，**刻意不含 token_hash 与 refresh_token_hash**。 */
const SAFE_COLUMNS =
  'id,user_id,label,prefix,kind,client_id,created_at,last_used_at,last_used_ip,expires_at,revoked_at';

function randomPrefix() {
  const bytes = crypto.randomBytes(PREFIX_LEN);
  let s = '';
  for (let i = 0; i < PREFIX_LEN; i++) s += PREFIX_ALPHABET[bytes[i] % PREFIX_ALPHABET.length];
  return s;
}

function sha256hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** 常数时间比对两个 hex 摘要，避免逐字节的时序差异。 */
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * 生成一条新令牌。返回的 token 只在此刻存在，库里存的是它的哈希。
 *
 * 自带往返自检：生成后立刻 parse 一遍，不匹配就抛错。
 * 加这个是因为曾经踩过一次"生成的格式与解析的正则不一致"——
 * 结果是随机一半的令牌不可用，而且换一个就好了，极难定位。
 * 一次 parse 的开销可以忽略，换来的是这类 bug 再也不可能溜过去。
 */
function generate() {
  const prefix = randomPrefix();
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const token = `${SCHEME}_${prefix}_${secret}`;
  const back = parse(token);
  if (!back || back.prefix !== prefix || back.secret !== secret) {
    throw new Error(
      `令牌格式自检失败：生成的 "${token.slice(0, 20)}…" 无法被 parse 还原。` +
      '这通常意味着 SECRET_BYTES 变了（base64url 长度随之改变）但 parse 的正则没跟着改。'
    );
  }
  return { prefix, secret, token, tokenHash: sha256hex(secret) };
}

/**
 * 解析令牌串。格式不对就返回 null —— 不去查库。
 *
 * 格式定义（位置固定，别改成 split）：
 *   rmcp_  +  prefix(10 位 [a-z0-9])  +  _  +  secret(43 位 base64url)
 *                                            ↑ 32 字节 base64url 恰好 43 字符
 */
function parse(token) {
  if (typeof token !== 'string') return null;
  // 按**固定位置**精确解析，不用 split('_')。
  //
  // 这里踩过坑：secret 是 base64url，字母表是 [A-Za-z0-9_-] —— **包含下划线**。
  // 用 split('_') 就会把 secret 里恰好出现的 '_' 也当成分隔符，于是 43 字符的
  // secret 有约 1-(63/64)^43 ≈ 49% 的概率被切碎，导致"随机一半的令牌校验失败"。
  // 这种 bug 极难复现（换一个令牌就好了），所以格式定义必须和解析方式严格对齐。
  const m = /^rmcp_([a-z0-9]{10})_([A-Za-z0-9_-]{43})$/.exec(token.trim());
  if (!m) return null;
  return { prefix: m[1], secret: m[2] };
}

/* ------------------------------------------------------------------- 校验 */

/** prefix → { row, fetchedAt } */
const cache = new Map();
/** prefix → 上次写 last_used_at 的时间戳（节流用） */
const lastTouch = new Map();

/**
 * 按 prefix 取令牌行。
 *
 * 必须按前缀全局查、**不能**带租户条件：身份还没建立起来，正是要靠这次查询
 * 才知道查的是哪个租户。查询本身用 service_role，返回的也只是哈希（不是明文），
 * 所以泄露面为零。
 *
 * 这是全仓库仅有的两处合法的"无租户条件"数据库访问之一，另一处是下面的
 * touch()（按上一次校验得到的主键 id 精确更新）。除此之外任何地方都必须走
 * supa.tenantScope()。**别在别处模仿这个写法。**
 */
async function loadByPrefix(prefix) {
  const hit = cache.get(prefix);
  if (hit && Date.now() - hit.fetchedAt < cfg.TOKEN_CACHE_TTL_MS) return hit.row;

  const rows = await supa.rest.select('mcp_api_tokens', {
    prefix: `eq.${prefix}`,
    select: `${SAFE_COLUMNS},token_hash`,
    limit: '1',
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) {
    // 否命中也缓存（存 null），否则一串随机 prefix 的探测请求会每次都打到库
    cache.set(prefix, { row: null, fetchedAt: Date.now() });
    return null;
  }
  cache.set(prefix, { row, fetchedAt: Date.now() });
  return row;
}

/**
 * 校验一个令牌。返回 { ok, userId?, reason?, prefix?, label? }。
 *
 * reason 只进日志，**不外泄给调用方**：客户端一律收到同一个 401。区分
 * "格式错/不存在/已吊销/已过期"会让攻击者能判定某个 prefix 是否存在。
 */
async function verify(token, { ip = null } = {}) {
  const parsed = parse(token);
  if (!parsed) return { ok: false, reason: 'malformed' };

  const row = await loadByPrefix(parsed.prefix);
  if (!row) return { ok: false, reason: 'unknown', prefix: parsed.prefix };
  if (row.revoked_at) return { ok: false, reason: 'revoked', prefix: parsed.prefix };
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    return { ok: false, reason: 'expired', prefix: parsed.prefix };
  }
  if (!timingSafeEqualHex(sha256hex(parsed.secret), row.token_hash)) {
    return { ok: false, reason: 'mismatch', prefix: parsed.prefix };
  }

  touch(parsed.prefix, row.id, ip);

  return { ok: true, userId: row.user_id, prefix: parsed.prefix, label: row.label, id: row.id };
}

/**
 * 节流地更新 last_used_at。
 *
 * 为什么不每次都写：一次工具调用会伴随多次 HTTP 请求，每次都写库既没必要
 * 也会给"每次调用"凭空加上一次写操作。节流窗口内的使用记录丢失是可接受的 ——
 * 这个字段的用途是"看出某个令牌是否还在被用"，不是精确计量。
 *
 * 按主键 id 更新，不带租户条件 —— 这是本文件第二处合法的无租户访问。
 * 安全性来自 id 的来源：它取自 verify() 刚刚按 prefix 校验通过的那一行，
 * 调用方无法传入任意 id。
 */
function touch(prefix, id, ip) {
  const now = Date.now();
  const prev = lastTouch.get(prefix) || 0;
  if (now - prev < cfg.TOKEN_TOUCH_INTERVAL_MS) return;
  lastTouch.set(prefix, now);
  supa.rest
    .update('mcp_api_tokens', { id: `eq.${id}` }, { last_used_at: new Date().toISOString(), last_used_ip: ip })
    .catch(() => {
      // 更新失败不影响本次调用 —— 它只是统计字段
      lastTouch.delete(prefix);
    });
}

/* ------------------------------------------------------------------- 管理 */

/** 创建一个令牌。返回 { token, row }，token 是唯一一次明文出现的地方。 */
async function create(userId, { label = '', expiresInDays = null, ip = null } = {}) {
  const scope = supa.tenantScope(userId);
  const g = generate();
  const payload = {
    label: String(label || '').slice(0, 120),
    prefix: g.prefix,
    token_hash: g.tokenHash,
    created_ip: ip,
  };
  if (expiresInDays && Number(expiresInDays) > 0) {
    payload.expires_at = new Date(Date.now() + Number(expiresInDays) * 86400_000).toISOString();
  }

  const inserted = await scope.insert('mcp_api_tokens', payload);
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  if (!row?.id) throw new Error('创建令牌失败：数据库没有返回行');

  await supa.audit({
    userId,
    actor: 'tenant',
    action: 'token.create',
    target: row.prefix,
    detail: { label: payload.label, expires_at: payload.expires_at || null },
    ip,
  });

  return { token: g.token, row };
}

/** 列出本租户的令牌（不含哈希）。 */
async function list(userId) {
  const rows = await supa.tenantScope(userId).select('mcp_api_tokens', {
    select: SAFE_COLUMNS,
    order: 'created_at.desc',
  });
  return Array.isArray(rows) ? rows : [];
}

/** 吊销一个令牌。按 id 找，作用域限定在本租户 —— 不能吊销别人的。 */
async function revoke(userId, tokenId, { ip = null } = {}) {
  const scope = supa.tenantScope(userId);
  const row = await scope.find('mcp_api_tokens', tokenId, 'id,prefix,label,revoked_at');
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revoked_at) return { ok: true, already: true, prefix: row.prefix };

  const now = new Date().toISOString();
  await scope.update('mcp_api_tokens', { id: `eq.${tokenId}` }, { revoked_at: now });

  // 立刻清缓存 —— 否则这个令牌在 TTL 内还能继续用（单进程下必须精确失效）
  cache.delete(row.prefix);
  lastTouch.delete(row.prefix);

  await supa.audit({
    userId,
    actor: 'tenant',
    action: 'token.revoke',
    target: row.prefix,
    detail: { label: row.label, token_id: tokenId },
    ip,
  });

  return { ok: true, prefix: row.prefix };
}

/** 清空缓存（测试用；也用于将来跨进程吊销后的强制刷新）。 */
function clearCache() {
  cache.clear();
  lastTouch.clear();
}

/**
 * 让某一个 prefix 的缓存条目立刻失效。
 *
 * 用于两个场景，都是"行还在但已经不该放行"的情况：
 *   · OAuth refresh 轮换：同一行的 prefix 被换掉了，缓存里还留着旧 prefix
 *     指向该行的映射，不清就会继续放行旧令牌。
 *   · 撤销一条 OAuth 授权：批量吊销该客户端下的令牌，逐个 evict。
 *
 * 与 revoke() 里那句 cache.delete 的区别：revoke 是"按令牌吊销"，
 * 这里是"按行失效"，不知道 secret 也能用 —— 因为调用方本来就持有权威结论。
 */
function evict(prefix) {
  if (!prefix) return;
  cache.delete(prefix);
  lastTouch.delete(prefix);
}

function cacheStats() {
  return { entries: cache.size, ttl_ms: cfg.TOKEN_CACHE_TTL_MS };
}

module.exports = {
  SCHEME,
  PREFIX_LEN,
  SECRET_LEN: 43,
  generate,
  parse,
  sha256hex,
  verify,
  create,
  list,
  revoke,
  evict,
  clearCache,
  cacheStats,
  _cache: cache,
};
