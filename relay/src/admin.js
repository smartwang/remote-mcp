'use strict';
/**
 * 管理员页面。
 *
 * 与租户控制台的区别：管理员看得到**所有**租户的设备、令牌（仅前缀）、
 * 调用记录与审计流水。这是运维视角，不是产品视角 —— 它不应该出现在普通
 * 用户能到达的地方，所以：
 *   · 未配置 RELAY_ADMIN_TOKEN 时整个面（包括这个文件渲染出来的页面）不可达
 *   · 鉴权走 HTTP Basic（浏览器原生弹窗，不引入会话概念，不写 cookie）
 *
 * 为什么用 Basic 而不是复用浏览器会话：管理员身份与租户身份是两回事，
 * 混用会带来"某个租户账号不小心获得管理员视图"这类事故。Basic 的好处是
 * 凭据不在服务端留状态、关掉弹窗即失效，且 curl 友好。
 */

const layout = require('./layout');
const { esc, agoText, iso, table, alertBox } = layout;

function deviceRows(devices) {
  if (!devices.length) return [];
  const ONLINE_MS = 15 * 60 * 1000;
  return devices.map((d) => {
    const ts = d.last_seen ? Date.parse(d.last_seen) : NaN;
    const live = Number.isFinite(ts) && Date.now() - ts <= ONLINE_MS;
    const caps = d.capabilities || {};
    const bcast = caps.transport_broadcast_v1 === true;
    return (
      `<tr><td>${esc(d.device_name || '(未命名)')}</td>` +
      `<td class="mono">${esc(String(d.user_id).slice(0, 8))}</td>` +
      `<td>${live ? '<span class="tag on">在线</span>' : '<span class="tag off">离线</span>'}</td>` +
      `<td>${esc(agoText(d.last_seen))}</td>` +
      `<td>${bcast ? '<span class="tag on">可用</span>' : '<span class="tag bad">不可用</span>'}</td>` +
      `<td class="mono dim">${esc(String(d.id))}</td></tr>`
    );
  });
}

function tenantRows(users, devicesByUser, tokensByUser, grantsByUser, oauthTokenCounts = {}) {
  if (!users.length) return [];
  return users.map((u) => {
    const devs = devicesByUser[u.id] || [];
    const toks = tokensByUser[u.id] || 0;
    const grs = grantsByUser[u.id] || [];
    const liveGrants = grs.filter((g) => !g.revoked_at);
    const online = devs.filter((d) => {
      const ts = d.last_seen ? Date.parse(d.last_seen) : NaN;
      return Number.isFinite(ts) && Date.now() - ts <= 15 * 60 * 1000;
    }).length;
    return (
      `<tr><td>${esc(u.email || '(无邮箱)')}</td>` +
      `<td class="mono">${esc(u.id.slice(0, 8))}</td>` +
      `<td>${devs.length}${devs.length ? `（在线 ${online}）` : ''}</td>` +
      `<td>${liveGrants.length}${liveGrants.length ? ` <span class="dim">/ 共 ${grs.length}</span>` : ''}</td>` +
      `<td>${toks}${oauthTokenCounts[u.id] ? ` <span class="dim">（OAuth ${oauthTokenCounts[u.id]}）</span>` : ''}</td>` +
      `<td>${esc(iso(u.created_at))}</td>` +
      `<td>${u.last_sign_in_at ? esc(agoText(u.last_sign_in_at)) : '<span class="dim">从未登录</span>'}</td></tr>`
    );
  });
}

/**
 * 跨租户的 AI 客户端授权表。
 *
 * 这是"谁把账号借给了哪个应用"的全景视图 —— 管理员面独有。
 * 租户自己只能在控制台看到**自己**那几条，看不出"某个客户端正在大量接入账号"
 * 这种异常模式，而那恰恰是最该被发现的信号。
 */
function grantAdminRows(grants, emailById, clientNameById) {
  if (!grants.length) return [];
  return grants.map((g) => {
    const revoked = !!g.revoked_at;
    return (
      `<tr><td>${esc(emailById[g.user_id] || String(g.user_id).slice(0, 8))}</td>` +
      `<td>${esc(clientNameById[g.client_id] || '(未知客户端)')}</td>` +
      `<td class="mono dim">${esc(String(g.client_id).slice(0, 14))}…</td>` +
      `<td><code>${esc(g.scope || '')}</code></td>` +
      `<td>${revoked ? '<span class="tag bad">已撤销</span>' : '<span class="tag on">有效</span>'}</td>` +
      `<td>${esc(iso(g.created_at))}</td>` +
      `<td>${esc(g.last_authorized_at ? agoText(g.last_authorized_at) : '—')}</td></tr>`
    );
  });
}

/** 已注册的 OAuth 客户端（DCR 自助注册进来的）。 */
function clientRows(clients) {
  if (!clients.length) return [];
  return clients.map(
    (c) =>
      `<tr><td>${esc(c.client_name || '(未命名)')}</td>` +
      `<td class="mono dim">${esc(String(c.client_id).slice(0, 18))}…</td>` +
      `<td class="mono">${esc((c.redirect_uris || []).join('<br>'))}</td>` +
      `<td>${esc(iso(c.created_at))}</td>` +
      `<td>${esc(c.last_used_at ? agoText(c.last_used_at) : '<span class="dim">未使用</span>')}</td></tr>`
  );
}

function auditRows(entries) {
  if (!entries.length) return [];
  return entries.map((a) => {
    const bad = /denied|cross_tenant|failed|error|conflict/.test(a.action);
    const tag = bad ? '<span class="tag bad">' : '<span class="tag off">';
    return (
      `<tr><td>${esc(iso(a.created_at))}</td>` +
      `<td>${tag}${esc(a.action)}</span></td>` +
      `<td>${esc(a.actor)}</td>` +
      `<td class="mono">${esc(a.user_id ? String(a.user_id).slice(0, 8) : '—')}</td>` +
      `<td class="mono">${esc(a.target || '—')}</td>` +
      `<td class="mono dim">${esc(String(a.ip || '—'))}</td></tr>`
    );
  });
}

function adminPage({
  users = [],
  devices = [],
  tokenCounts = {},
  oauthTokenCounts = {},
  grants = [],
  clients = [],
  audit = [],
  pending = [],
  stats = {},
} = {}) {
  const devicesByUser = {};
  for (const d of devices) (devicesByUser[d.user_id] = devicesByUser[d.user_id] || []).push(d);

  const grantsByUser = {};
  for (const g of grants) (grantsByUser[g.user_id] = grantsByUser[g.user_id] || []).push(g);

  const emailById = {};
  for (const u of users) emailById[u.id] = u.email;
  const clientNameById = {};
  for (const c of clients) clientNameById[c.client_id] = c.client_name;

  const b = stats.broadcast || { ok: 0, failed: 0 };

  const body = `
<meta http-equiv="refresh" content="20">
<h1>管理员视图</h1>
<p>全部租户的设备、令牌、AI 客户端授权与审计。页面每 20 秒自动刷新。</p>

${stats.securityWarnings && stats.securityWarnings.length
  ? alertBox('warn', '<b>安全体检告警：</b><ul>' + stats.securityWarnings.map((w) => `<li>${esc(w)}</li>`).join('') + '</ul>')
  : ''}

<h2>概览</h2>
${table(
  ['项', '值'],
  [
    `<tr><th>服务</th><td>${esc(stats.server || '')} v${esc(stats.version || '')} · 运行 ${esc(String(stats.uptimeS || 0))}s</td></tr>`,
    `<tr><th>工具目录</th><td>${esc(String(stats.toolCount || 0))} 个工具，来自 <code>${esc(stats.catalogSource || '')}</code></td></tr>`,
    `<tr><th>租户数</th><td>${users.length}${stats.userListTruncated ? '（⚠ 已达单页上限，可能还有更多）' : ''}</td></tr>`,
    `<tr><th>设备数</th><td>${devices.length}</td></tr>`,
    `<tr><th>AI 客户端授权</th><td>${grants.filter((g) => !g.revoked_at).length} 有效 / 共 ${grants.length}${clients.length ? ` · ${clients.length} 个客户端已注册` : ''}</td></tr>`,
    `<tr><th>广播投递</th><td>成功 ${esc(String(b.ok))} / 失败 ${esc(String(b.failed))}${b.lastError ? ` · 最近错误：${esc(b.lastError.message || '')}` : ''}</td></tr>`,
    `<tr><th>活跃 MCP 会话</th><td>${esc(String(stats.sessions || 0))}</td></tr>`,
    `<tr><th>令牌校验缓存</th><td>${esc(String(stats.tokenCache?.entries ?? 0))} 条 · TTL ${esc(String(stats.tokenCache?.ttl_ms ?? 0))}ms</td></tr>`,
    `<tr><th>限速器</th><td class="mono">${
      Object.entries(stats.rateLimiters || {})
        .map(([k, v]) => `${esc(k)}: ${esc(String(v.hits))}/${esc(String(v.max))}（${esc(String(v.window_ms / 1000))}s 窗）`)
        .join('<br>') || '—'
    }</td></tr>`,
    `<tr><th>鉴权</th><td><span class="tag on">必需</span> —— <code>/mcp</code> 不接受任何匿名请求</td></tr>`,
    `<tr><th>OAuth 授权服务器</th><td><code>${esc(stats.oauthIssuer || '')}</code></td></tr>`,
    `<tr><th>MCP 端点</th><td><code>${esc(stats.mcpEndpoint || '')}</code></td></tr>`,
    `<tr><th>Supabase</th><td><code>${esc(stats.supabaseUrl || '')}</code></td></tr>`,
  ]
)}

<h2>租户（${users.length}）</h2>
${table(
  ['邮箱', 'ID', '设备', 'AI 客户端授权', '有效令牌', '注册于', '最后登录'],
  tenantRows(users, devicesByUser, tokenCounts, grantsByUser, oauthTokenCounts),
  { empty: '还没有任何账号。' }
)}

<h2>AI 客户端授权（${grants.length}）</h2>
<p class="dim">每一行是"某个账号把自己的设备借给了某个 AI 客户端"。
这是跨租户的全景 —— 单个租户在控制台里只看得到自己那几条，
而"某个客户端正在大量接入账号"这类异常模式只有在这里才看得出来。</p>
${table(
  ['账号', '客户端', 'client_id', '权限', '状态', '授权于', '最近授权'],
  grantAdminRows(grants, emailById, clientNameById),
  { empty: '还没有任何 AI 客户端接入。用户在客户端里点「连接」后会出现在这里。' }
)}

<h2>已注册的 OAuth 客户端（${clients.length}）</h2>
<p class="dim">客户端通过 <code>/oauth/register</code> 自助注册（RFC 7591），无需预置。
回调地址是授权码的唯一出口，一旦被篡改即可劫持授权码，因此这里要能一眼看到。</p>
${table(['名称', 'client_id', '回调地址', '注册于', '最后使用'], clientRows(clients), {
  empty: '还没有客户端注册。',
})}

<h2>全部设备（${devices.length}）</h2>
${table(['设备', '归属租户', '状态', '最后心跳', '广播通道', 'device_id'], deviceRows(devices), {
  empty: '还没有设备接入。',
})}

<h2>待批准授权（${pending.filter((p) => p.status === 'pending').length}）</h2>
${table(
  ['验证码', '设备', '剩余', '状态'],
  pending.map(
    (r) =>
      `<tr><td><code>${esc(r.user_code)}</code></td><td>${esc(r.device_name)}</td><td>${esc(String(r.expires_in_s))}s</td><td>${esc(r.status)}</td></tr>`
  ),
  { empty: '当前没有待批准请求。' }
)}

<h2>审计流水（最近 ${audit.length} 条）</h2>
${table(['时间', '动作', '主体', '租户', '目标', 'IP'], auditRows(audit), {
  empty: '还没有审计记录。',
})}

<p class="dim" style="margin-top:24px">渲染于 ${esc(new Date().toLocaleString())} ·
数据来自 Supabase 与进程内存（页面本身不缓存任何东西）</p>`;

  return layout.page(body, { title: '管理员 · Remote MCP Relay', wide: true });
}

module.exports = { adminPage };
