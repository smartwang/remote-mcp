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

module.exports = {
  SupabaseError,
  stripNul,
  rest,
  auth,
  broadcast,
  broadcastStatsSnapshot,
  request,
  serviceHeaders,
  anonHeaders,
  randomId: () => crypto.randomUUID(),
};
