'use strict';
/**
 * Supabase 访问层（零依赖，全部走 fetch）。
 *
 * 只用三块能力：
 *   · PostgREST  → 读写 mcp_devices / mcp_remote_calls（service_role，绕过 RLS）
 *   · GoTrue     → 建账号 + 用 password grant 换取真实 session
 *   · Realtime   → 往私有频道广播 new_call 门铃
 *
 * 为什么用 password grant 而不是 generate_link + verify：前者是版本最稳定的
 * 一条路径，且直接返回 refresh_token —— device 侧之后要靠它自己续期。
 */

const crypto = require('node:crypto');
const cfg = require('./config');

class SupabaseError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
    this.body = body;
  }
}

/** 剥离 NUL(U+0000)。Postgres 的 jsonb/text 都拒绝它（22P05）。 */
function stripNul(value) {
  if (typeof value === 'string') return value.includes('\u0000') ? value.replace(/\u0000/g, '') : value;
  if (Array.isArray(value)) return value.map(stripNul);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k.replace(/\u0000/g, '')] = stripNul(v);
    return out;
  }
  return value;
}

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let text;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new SupabaseError(`${method} ${url} 超时（${timeoutMs}ms）`, 0, null);
    throw new SupabaseError(`${method} ${url} 网络错误：${err.message}`, 0, null);
  }
  clearTimeout(timer);

  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const detail = typeof parsed === 'string' ? parsed.slice(0, 400) : JSON.stringify(parsed)?.slice(0, 400);
    throw new SupabaseError(`${method} ${url} → HTTP ${res.status}: ${detail}`, res.status, parsed);
  }
  return { status: res.status, headers: res.headers, data: parsed };
}

function serviceHeaders(extra = {}) {
  return {
    apikey: cfg.SERVICE_ROLE_KEY,
    Authorization: `Bearer ${cfg.SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function anonHeaders(extra = {}) {
  return {
    apikey: cfg.ANON_KEY,
    Authorization: `Bearer ${cfg.ANON_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/* ------------------------------------------------------------------ PostgREST */

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) u.append(k, v);
  return u.toString();
}

const rest = {
  async select(table, params = {}, { single = false } = {}) {
    const headers = serviceHeaders(single ? { Accept: 'application/vnd.pgrst.object+json' } : {});
    const { data } = await request(`${cfg.SUPABASE_URL}/rest/v1/${table}?${qs(params)}`, { headers });
    return data;
  },
  async insert(table, rows, { returning = true } = {}) {
    const headers = serviceHeaders(returning ? { Prefer: 'return=representation' } : {});
    const { data } = await request(`${cfg.SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers,
      body: stripNul(rows),
    });
    return data;
  },
  async update(table, params, patch) {
    const headers = serviceHeaders({ Prefer: 'return=representation' });
    const { data } = await request(`${cfg.SUPABASE_URL}/rest/v1/${table}?${qs(params)}`, {
      method: 'PATCH',
      headers,
      body: stripNul(patch),
    });
    return data;
  },
  async del(table, params) {
    const headers = serviceHeaders({ Prefer: 'return=representation' });
    const { data } = await request(`${cfg.SUPABASE_URL}/rest/v1/${table}?${qs(params)}`, {
      method: 'DELETE',
      headers,
    });
    return data;
  },
};

/* --------------------------------------------------------------------- GoTrue */

const auth = {
  /** 找用户或建用户。返回 GoTrue 的 user 对象。 */
  async ensureUser(email, password, { timeoutMs = 20000 } = {}) {
    const listUrl = `${cfg.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=200`;
    const { data: listing } = await request(listUrl, { headers: serviceHeaders(), timeoutMs });
    const users = listing?.users || (Array.isArray(listing) ? listing : []);
    const existing = users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
    if (existing) return existing;

    try {
      const { data } = await request(`${cfg.SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: serviceHeaders(),
        body: { email, password, email_confirm: true },
        timeoutMs,
      });
      return data;
    } catch (err) {
      // 并发下可能被判重，再查一次
      if (err.status === 422 || err.status === 409) {
        const { data: retry } = await request(listUrl, { headers: serviceHeaders(), timeoutMs });
        const again = (retry?.users || []).find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
        if (again) return again;
      }
      throw err;
    }
  },

  /** 确保密码是我们知道的那个（用户可能是上次以别的密码建的）。 */
  async setPassword(userId, password) {
    const { data } = await request(`${cfg.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: serviceHeaders(),
      body: { password, email_confirm: true },
    });
    return data;
  },

  /** password grant 换取完整 session（含 refresh_token）。 */
  async signInWithPassword(email, password) {
    // 注意：这个调用要用 anon key（模拟普通客户端），而不是 service_role。
    const { data } = await request(`${cfg.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: anonHeaders(),
      body: { email, password },
    });
    if (!data?.access_token) {
      throw new SupabaseError('GoTrue 返回的 session 里没有 access_token', 200, data);
    }
    return data;
  },

  /** 用 refresh_token 换新 session —— 用于自检。 */
  async refresh(refreshToken) {
    const { data } = await request(`${cfg.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: anonHeaders(),
      body: { refresh_token: refreshToken },
    });
    return data;
  },

  /** 按 id 取用户。 */
  async getById(id) {
    if (!id) return null;
    try {
      const { data } = await request(`${cfg.SUPABASE_URL}/auth/v1/admin/users/${id}`, {
        headers: serviceHeaders(),
        timeoutMs: 15000,
      });
      return data?.id ? data : data?.user || null;
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  },

  /** 按 email 查用户（不存在返回 null，不建）。 */
  async findByEmail(email) {
    if (!email) return null;
    const { data: listing } = await request(`${cfg.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=200`, {
      headers: serviceHeaders(),
      timeoutMs: 20000,
    });
    const users = listing?.users || (Array.isArray(listing) ? listing : []);
    const want = String(email).toLowerCase();
    return users.find((u) => (u.email || '').toLowerCase() === want) || null;
  },

  /** 建用户（邮箱直接标记已确认）。已存在则返回 null，由调用方决定语义。 */
  async createUser(email, password) {
    try {
      const { data } = await request(`${cfg.SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: serviceHeaders(),
        body: { email, password, email_confirm: true },
        timeoutMs: 20000,
      });
      return data;
    } catch (err) {
      // 422/409 都是"已存在"的常见表达；并发下也可能被判重
      if (err.status === 422 || err.status === 409) return null;
      throw err;
    }
  },

  /**
   * 为一个用户**免密**签发真实 session。
   *
   * 为什么需要它：多租户下"批准设备"这个动作要把一个真实 session 交给 device
   * 进程（device 靠它过 PostgREST 与 Realtime 的 RLS）。但批准设备的人此刻是
   * 通过 cookie 登录的 —— 中继手上没有、也不应该持有他的密码。
   *
   * 做法（实测确认可用，见 docs 与 tools/probe-*）：
   *   1. admin/generate_link {type:'magiclink'} → 返回 email_otp（6 位）
   *   2. POST /auth/v1/verify {type:'magiclink', token: email_otp, email} → 完整 session
   *
   * 实测要点（别照直觉改）：
   *   · verify 必须用 type='magiclink'。用 type='email' 会 403 otp_expired。
   *   · token 必须传 email_otp 那个 6 位码，传 hashed_token 同样 403。
   *   · 返回的 session 带 refresh_token，device 靠它自己续期（已实测可续）。
   */
  async mintSession(email) {
    const { data: link } = await request(`${cfg.SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: serviceHeaders(),
      body: { type: 'magiclink', email },
      timeoutMs: 20000,
    });
    const otp = link?.email_otp;
    if (!otp) {
      throw new SupabaseError('generate_link 没有返回 email_otp —— GoTrue 版本可能不兼容', 200, link);
    }
    const { data: session } = await request(`${cfg.SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: anonHeaders(),
      body: { type: 'magiclink', token: otp, email },
      timeoutMs: 20000,
    });
    if (!session?.access_token) {
      throw new SupabaseError('verify 没有返回 access_token', 200, session);
    }
    return session;
  },
};

/* ------------------------------------------------------------------- Realtime */

let broadcastStats = { ok: 0, failed: 0, lastError: null };

/**
 * 往私有频道广播一条消息（Realtime 的 REST broadcast 接口）。
 *
 * 用 service_role 走这条路会绕过 realtime.messages 的 RLS —— 这正是我们要的：
 * 门铃只能由服务端发出，客户端不该有广播权限。
 *
 * 若该接口在目标 Realtime 版本上不可用（404/405），需要退回"中继自开
 * WebSocket 当客户端"的路径。那个实现更重（Phoenix 协议 + 心跳 + 重连），
 * 所以先探测、确认必要再写 —— 见 tools/probe-realtime.js。
 */
async function broadcast(topic, event, payload, { privateTopic = true } = {}) {
  const body = { messages: [{ topic, event, payload, private: privateTopic }] };
  try {
    const { data } = await request(`${cfg.SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: serviceHeaders(),
      body,
      timeoutMs: 10000,
    });
    broadcastStats.ok += 1;
    return data;
  } catch (err) {
    broadcastStats.failed += 1;
    broadcastStats.lastError = { status: err.status, message: err.message };
    throw err;
  }
}

function broadcastStatsSnapshot() {
  return { ...broadcastStats };
}

/* --------------------------------------------------------------- 租户作用域 */

/**
 * 把数据访问绑死在一个租户上。
 *
 * 为什么必须有这一层：中继用 service_role 访问数据库，而 **service_role 绕过
 * RLS**。schema 里那些 mcp_devices / mcp_remote_calls 的 RLS 策略保护的是
 * "device 进程直连 PostgREST" 那条路，对中继自己完全无效。也就是说，
 * 如果中继某处漏写 `user_id = 本租户`，它就能读到别的租户的数据 ——
 * 数据库不会拦。
 *
 * 所以把 user_id 从"每次查询都要记得加的条件"变成"作用域对象的固有属性"：
 * 调用方拿不到一个"不带 user_id 的查询"。
 *
 * 反向检查是刻意保留的：如果调用方自己传了 user_id 且与作用域不符，
 * 直接抛错而不是静默覆盖 —— 静默覆盖会把"代码里写错了租户"这种 bug
 * 变成一个永远查不到数据的怪现象，比直接报错难查得多。
 */
function tenantScope(userId) {
  if (!userId) throw new Error('tenantScope 需要一个 userId');

  const own = `eq.${userId}`;
  const guard = (table, params) => {
    const p = { ...(params || {}) };
    if (p.user_id !== undefined && p.user_id !== own) {
      throw new Error(
        `租户作用域冲突：对 ${table} 的查询带了 user_id=${p.user_id}，但当前作用域是 ${userId}`
      );
    }
    p.user_id = own;
    return p;
  };

  return {
    userId,

    select(table, params) {
      return rest.select(table, guard(table, params));
    },

    insert(table, rows) {
      const list = Array.isArray(rows) ? rows : [rows];
      const injected = list.map((r) => {
        if (r.user_id !== undefined && r.user_id !== userId) {
          throw new Error(
            `租户作用域冲突：往 ${table} 插入的数据 user_id=${r.user_id}，但当前作用域是 ${userId}`
          );
        }
        return { ...r, user_id: userId };
      });
      return rest.insert(table, Array.isArray(rows) ? injected : injected[0]);
    },

    update(table, params, patch) {
      const p = { ...(patch || {}) };
      if (p.user_id !== undefined && p.user_id !== userId) {
        throw new Error(`租户作用域冲突：更新 ${table} 时试图改写 user_id`);
      }
      delete p.user_id; // user_id 是不可变的归属字段，不允许被 update 携带
      return rest.update(table, guard(table, params), p);
    },

    /**
     * 按主键取单行，且必须是本租户的。
     *
     * 跨租户取不到时返回 null，**不区分"不存在"与"不属于你"** ——
     * 区分开会让调用方变成一个存在性探测器（拿别人的 UUID 试一下就知道有没有）。
     */
    async find(table, id, columns = '*') {
      const rows = await rest.select(table, { id: `eq.${id}`, user_id: own, select: columns });
      const list = Array.isArray(rows) ? rows : [];
      return list.length ? list[0] : null;
    },

    /** 本租户的行数（用于"该租户一共有几台设备"这类判断）。 */
    async count(table) {
      const rows = await rest.select(table, { user_id: own, select: 'id' });
      return Array.isArray(rows) ? rows.length : 0;
    },
  };
}

/* ------------------------------------------------------------------- 审计 */

/**
 * 写一条审计记录。**永不抛错**。
 *
 * 审计是为了"事后能查清发生了什么"，它自己的失败不该让被审计的业务操作
 * 一起失败 —— 那会导致"因为记不下日志所以拒绝登录"这种荒谬结果。
 * 失败只打日志。
 */
async function audit({ userId = null, actor, action, target = null, detail = {}, ip = null }) {
  try {
    await rest.insert(
      'mcp_audit_log',
      { user_id: userId, actor, action, target, detail: stripNul(detail), ip },
      { returning: false }
    );
  } catch (err) {
    console.error(`[audit] 写入失败（不影响主流程）：action=${action} ${err.message}`);
  }
}

/** 读审计记录（管理员面用）。 */
async function auditTail({ limit = 50, userId = null } = {}) {
  const params = { select: '*', order: 'created_at.desc', limit: String(limit) };
  if (userId) params.user_id = `eq.${userId}`;
  const rows = await rest.select('mcp_audit_log', params);
  return Array.isArray(rows) ? rows : [];
}

module.exports = {
  SupabaseError,
  stripNul,
  rest,
  auth,
  broadcast,
  broadcastStatsSnapshot,
  tenantScope,
  audit,
  auditTail,
  request,
  serviceHeaders,
  anonHeaders,
  randomId: () => crypto.randomUUID(),
};
