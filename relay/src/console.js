'use strict';
/**
 * 浏览器页面：登录 / 注册 / 租户控制台。
 *
 * 三条设计约束：
 *
 * 1) 服务端渲染 + 原生表单 POST。不引入前端框架 —— 这些页面上的每一个动作
 *    （批准设备、创建令牌、吊销令牌）都是安全敏感操作，服务端渲染的 POST
 *    配合同源校验是最容易被审清楚的实现。
 *
 * 2) 令牌明文只在创建的那一次响应里出现，之后库里只有哈希、页面上只有前缀。
 *    所以创建令牌走"POST 后直接渲染"而不是"POST 后重定向"：重定向得把令牌
 *    放进 URL 或 flash，两者都会留痕（浏览器历史、日志、Referer）。
 *
 * 3) 待批准的授权请求**没有归属人**（device flow 的请求方还没登录），所以
 *    列表是全局可见的。直接显示别人的机器名是一种泄露，因此默认打码，
 *    只有用户是带着那个 user_code 进来的（设备自动打开浏览器的那条正常路径）
 *    才显示完整信息。别的租户的待批准项里唯一能被看到的只有"有个请求在等"。
 */

const layout = require('./layout');
const { esc, agoText, iso, table, alertBox } = layout;

/* ------------------------------------------------------------------ 导航 */

function nav(user, active = '') {
  const items = [
    ['/console', '控制台'],
    ['/device', '授权设备'],
  ];
  const links = items
    .map(([href, label]) =>
      href === active ? `<b>${esc(label)}</b>` : `<a href="${href}">${esc(label)}</a>`
    )
    .join('');
  const who = user
    ? `<span class="who">${esc(user.email || user.uid.slice(0, 8))} · ` +
      `<a href="/logout">退出</a></span>`
    : '';
  return `<nav>${links}${who}</nav>`;
}

/* ------------------------------------------------------------------ 登录 */

function loginPage({ next = '/console', error = null, email = '', info = null } = {}) {
  const body = `
<h1>登录</h1>
<p>中继控制台。登录后可批准设备、签发访问令牌、查看自己的设备与调用记录。</p>
${error ? alertBox('error', esc(error)) : ''}
${info ? alertBox('warn', esc(info)) : ''}
<form method="post" action="/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <label><span>邮箱</span><input type="email" name="email" value="${esc(email)}" autocomplete="username" required autofocus></label>
  <label><span>密码</span><input type="password" name="password" autocomplete="current-password" required></label>
  <button type="submit">登录</button>
</form>
<p style="margin-top:20px">还没有账号？<a href="/signup?next=${encodeURIComponent(next)}">注册</a></p>`;
  return layout.page(body, { title: '登录 · Remote MCP Relay' });
}

function signupPage({ next = '/console', error = null, email = '' } = {}) {
  const body = `
<h1>注册</h1>
<p>每个账号是一个独立租户：只能看到并操作自己授权的设备。</p>
${error ? alertBox('error', esc(error)) : ''}
<form method="post" action="/signup">
  <input type="hidden" name="next" value="${esc(next)}">
  <label><span>邮箱</span><input type="email" name="email" value="${esc(email)}" autocomplete="username" required autofocus></label>
  <label><span>密码（至少 8 位）</span><input type="password" name="password" autocomplete="new-password" required></label>
  <button type="submit">注册并登录</button>
</form>
<p style="margin-top:20px">已有账号？<a href="/login?next=${encodeURIComponent(next)}">去登录</a></p>`;
  return layout.page(body, { title: '注册 · Remote MCP Relay' });
}

/* ------------------------------------------------------------ 待批准授权 */

/** 打码：保留前 3 个字符，其余用 * 替代。 */
function maskName(name) {
  const s = String(name || '');
  if (!s) return '(未命名)';
  if (s.length <= 3) return '*'.repeat(s.length);
  return s.slice(0, 3) + '*'.repeat(Math.min(s.length - 3, 12));
}

/**
 * 待批准的授权表格。
 *
 * focusCode 非空时，只有 user_code 与之相符的那一条显示完整设备名 —— 这是
 * "用户在设备上发起、设备自动打开浏览器"的正常路径。其余条目一律打码，
 * 因为无法判定它属于哪个租户（尚未批准 = 还没有归属）。
 */
function pendingTable(pending, focusCode = null) {
  if (!pending.length) return '<p>当前没有待批准的授权请求。</p>';
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const focus = focusCode ? norm(focusCode) : '';

  const rows = pending.map((r) => {
    const isFocus = focus && norm(r.user_code) === focus;
    const name = isFocus
      ? esc(r.device_name || '(未命名)')
      : `<span class="dim" title="不是带你进来的那个验证码，故打码">${esc(maskName(r.device_name))}</span>`;
    const state =
      r.status === 'approved'
        ? '<span class="tag on">已批准</span>'
        : r.status === 'denied'
          ? '<span class="tag bad">已拒绝</span>'
          : '<span class="tag warn">待批准</span>';
    const action =
      r.status === 'pending'
        ? `<form method="post" action="/device/approve" style="display:inline">
             <input type="hidden" name="user_code" value="${esc(r.user_code)}">
             <button type="submit">批准</button>
             <button class="deny" type="submit" formaction="/device/deny">拒绝</button>
           </form>`
        : '';
    return `<tr><td><code>${esc(r.user_code)}</code></td><td>${name}</td><td>${r.expires_in_s}s</td><td>${state}</td><td>${action}</td></tr>`;
  });
  return table(['验证码', '设备', '剩余', '状态', '操作'], rows);
}

/* -------------------------------------------------------------- 授权同意页 */

/** scope 的人话解释。用户看到的不该是 "mcp:tools" 这种机器码。 */
const SCOPE_TEXT = {
  'mcp:tools':
    '读取你账号下的设备清单，并在这些设备上执行 DesktopCommander 提供的工具' +
    '（读写文件、执行命令、查看进程等）。',
};

/**
 * OAuth 同意页 —— **用户身份映射就是在这里建立的**。
 *
 * 用户在设备/客户端那边点"连接"之后会被带到这里；页面上显示的账号，
 * 就是他这次浏览器会话登录的那个账号。他点下"批准"的那一刻，
 * 「这个 AI 客户端 = 这个账号」这条映射就被写进 mcp_oauth_grants。
 *
 * 几个刻意的设计：
 *   · 明确写出**客户端名字**（而不是只说"某应用"）—— 用户要能分辨自己在批谁。
 *   · 明确写出**绑定到哪个账号**。这是整个页面最重要的一句话：用户需要知道
 *     "批准之后，这个 AI 能操作的是**谁的**设备"。
 *   · 原始授权参数全部以隐藏字段带回 POST —— 同一次授权请求必须原样重放，
 *     否则签发的授权码会与请求时的 redirect_uri / PKCE 上下文不一致。
 *   · 「拒绝」也是一个正常的 POST 而不是直接关闭页面 —— 客户端需要收到
 *     access_denied 才能正确地显示"用户拒绝了"，而不是一直转圈等回调。
 */
function consentPage({ user, client, scope, params = {} }) {
  const carry = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'resource', 'state']
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .map((k) => `<input type="hidden" name="${k}" value="${esc(String(params[k]))}">`)
    .join('\n  ');

  const scopeLines = String(scope || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => `<li><code>${esc(s)}</code> —— ${esc(SCOPE_TEXT[s] || '（未说明的权限）')}</li>`)
    .join('');

  const body = `
<h1>允许接入？</h1>
<p><b>${esc(client.client_name || '（未命名客户端）')}</b> 请求接入你的账号。</p>
${alertBox(
  'warn',
  `批准后，<b>${esc(user.email || user.uid)}</b> 名下的设备将可以由这个客户端操作。<br>` +
    '它不会看到别的账号的任何东西 —— 每个账号的设备是彼此隔离的。'
)}
<h2>它请求的权限</h2>
<ul>${scopeLines || '<li>（未声明）</li>'}</ul>

<h2>客户端信息</h2>
${table(
  ['项', '值'],
  [
    `<tr><th>名称</th><td>${esc(client.client_name || '(未命名)')}</td></tr>`,
    `<tr><th>client_id</th><td><code>${esc(client.client_id)}</code></td></tr>`,
    `<tr><th>回调地址</th><td class="mono dim">${esc(params.redirect_uri || '')}</td></tr>`,
  ]
)}

<form method="post" action="/oauth/authorize">
  ${carry}
  <div class="row" style="margin-top:18px">
    <button type="submit" name="decision" value="approve">批准</button>
    <button class="deny" type="submit" name="decision" value="deny">拒绝</button>
  </div>
</form>

<p class="dim" style="margin-top:22px">
  随时可以在 <a href="/console">控制台</a> 的「已授权的 AI 客户端」里撤销这次授权 ——
  撤销会同时吊销它已拿到的令牌，立即生效。
</p>`;

  return layout.page(body, { title: '授权请求 · Remote MCP Relay' });
}

/* ------------------------------------------------------------------ 控制台 */

function deviceRows(devices) {
  if (!devices.length) return [];
  const ONLINE_MS = 15 * 60 * 1000;
  return devices.map((d) => {
    const ts = d.last_seen ? Date.parse(d.last_seen) : NaN;
    const live = Number.isFinite(ts) && Date.now() - ts <= ONLINE_MS;
    const caps = d.capabilities || {};
    const bcast = caps.transport_broadcast_v1 === true || caps.transport_broadcast_v1 === 'true';
    const mismatch = (d.status === 'online') !== live;
    return (
      `<tr><td>${esc(d.device_name || '(未命名)')}</td>` +
      `<td><code>${esc(String(d.id).slice(0, 8))}</code></td>` +
      `<td>${live ? '<span class="tag on">在线</span>' : '<span class="tag off">离线</span>'}` +
      (mismatch ? ` <span class="dim">设备上报：${esc(d.status || '(空)')}</span>` : '') +
      `</td>` +
      `<td>${esc(agoText(d.last_seen))}</td>` +
      `<td>${bcast ? '<span class="tag on">可用</span>' : '<span class="tag bad">不可用</span>'}</td>` +
      `<td class="mono dim">${esc(String(d.id))}</td></tr>`
    );
  });
}

function tokenRows(tokens) {
  if (!tokens.length) return [];
  return tokens.map((t) => {
    const revoked = !!t.revoked_at;
    const expired = !revoked && t.expires_at && Date.parse(t.expires_at) <= Date.now();
    const state = revoked
      ? '<span class="tag bad">已吊销</span>'
      : expired
        ? '<span class="tag warn">已过期</span>'
        : '<span class="tag on">有效</span>';
    const action = revoked
      ? ''
      : `<form method="post" action="/console/tokens/revoke" style="display:inline">
           <input type="hidden" name="token_id" value="${esc(t.id)}">
           <button class="danger" type="submit">吊销</button>
         </form>`;
    return (
      `<tr><td>${esc(t.label || '(无标签)')}</td>` +
      `<td><code>${esc(t.prefix)}…</code></td>` +
      `<td>${
        t.kind === 'oauth'
          ? '<span class="tag on">OAuth</span>'
          : '<span class="dim">手动</span>'
      }</td>` +
      `<td>${state}</td>` +
      `<td>${esc(iso(t.created_at))}</td>` +
      `<td>${esc(t.last_used_at ? agoText(t.last_used_at) : '从未使用')}</td>` +
      `<td>${t.expires_at ? esc(iso(t.expires_at)) : '<span class="dim">不过期</span>'}</td>` +
      `<td>${action}</td></tr>`
    );
  });
}

/**
 * 「已授权的 AI 客户端」表格行。
 *
 * 这张表是"我的账号被哪些外部应用接入了"的唯一视图，也是用户自助断开的入口。
 * 「撤销」必须同时吊销令牌 —— 只置 grant 的话，已签发的 access token 在过期前
 * （最长 1 小时）还能继续用，用户会以为撤销坏了。
 */
function grantRows(grants) {
  if (!grants.length) return [];
  return grants.map((g) => {
    const revoked = !!g.revoked_at;
    const live = (g.tokens || []).filter((t) => !t.revoked_at);
    const usedAt = live
      .map((t) => t.last_used_at)
      .filter(Boolean)
      .sort()
      .pop();
    const state = revoked
      ? '<span class="tag bad">已撤销</span>'
      : '<span class="tag on">已授权</span>';
    const action = revoked
      ? ''
      : `<form method="post" action="/console/grants/revoke" style="display:inline">
           <input type="hidden" name="client_id" value="${esc(g.client_id)}">
           <button class="danger" type="submit">撤销</button>
         </form>`;
    return (
      `<tr><td>${esc(g.client_name || '(未命名)')}</td>` +
      `<td><code class="dim">${esc(String(g.client_id).slice(0, 14))}…</code></td>` +
      `<td><code>${esc(g.scope || '')}</code></td>` +
      `<td>${state}</td>` +
      `<td>${esc(iso(g.created_at))}</td>` +
      `<td>${usedAt ? esc(agoText(usedAt)) : '<span class="dim">从未使用</span>'}</td>` +
      `<td>${action}</td></tr>`
    );
  });
}

function callRows(calls, deviceNameById) {
  if (!calls.length) return [];
  return calls.map((c) => {
    const st = c.status;
    const tag =
      st === 'completed'
        ? '<span class="tag on">完成</span>'
        : st === 'failed'
          ? '<span class="tag bad">失败</span>'
          : st === 'timeout'
            ? '<span class="tag warn">超时</span>'
            : '<span class="tag warn">进行中</span>';
    const name = deviceNameById[c.device_id] || String(c.device_id).slice(0, 8);
    const args = JSON.stringify(c.tool_args || {});
    const detail =
      `<details><summary class="dim" style="cursor:pointer">参数</summary>` +
      `<pre>${esc(args.length > 600 ? args.slice(0, 600) + '…' : args)}</pre></details>`;
    const errTail = c.error_message ? `<div class="dim">${esc(String(c.error_message).slice(0, 160))}</div>` : '';
    return (
      `<tr><td class="mono">${esc(c.tool_name)}</td><td>${esc(name)}</td><td>${tag}${errTail}</td>` +
      `<td>${esc(iso(c.created_at))}</td><td>${detail}</td></tr>`
    );
  });
}

/**
 * 控制台主页面。
 *
 * newToken 只在创建令牌的那一次响应里传入 —— 明文出现且仅出现这一次。
 */
function consolePage({
  user,
  devices = [],
  pending = [],
  tokens: tokenList = [],
  grants = [],
  calls = [],
  newToken = null,
  flash = null,
  focusCode = null,
  stats = {},
} = {}) {
  const deviceNameById = {};
  for (const d of devices) deviceNameById[d.id] = d.device_name;

  const body = `
<h1>控制台</h1>
<p>账号 <code>${esc(user.email || user.uid)}</code> 下的一切都在这里。别的账号的设备与令牌对本页不可见。</p>

${flash ? flash : ''}

${
  newToken
    ? alertBox(
        'ok',
          '<b>令牌已创建，请立刻复制保存 —— 它只显示这一次。</b>' +
          `<pre style="background:#fff;border:1px solid #185FA5">${esc(newToken)}</pre>` +
          '<b>什么时候需要手动令牌：</b>不支持 OAuth 的客户端 —— CLI、脚本、自测。<br>' +
          '<b>什么时候不需要：</b>ChatGPT / Claude / Codex 这类支持 OAuth 的客户端。' +
          '连接时它们会自动把你带到授权页，用你登录的账号换取令牌：每人一枚、互不影响。' +
          '手动令牌只有一份，填进 ChatGPT 就等于把这个账号的身份借给了所有用它的人。'
      )
    : ''
}

<h2>我的设备（${devices.length}）</h2>
${table(
  ['设备', 'ID', '状态', '最后心跳', '广播通道', '完整 device_id'],
  deviceRows(devices),
  { empty: '还没有设备。在目标机器上运行 desktop-commander remote（MCP_SERVER_URL 指向本中继），完成浏览器授权后会出现在这里。' }
)}

<h2>待批准的授权（${pending.filter((p) => p.status === 'pending').length}）</h2>
<p class="dim">设备发起接入后会在其本机自动打开浏览器到本页。若不是从设备那台机器点过来的，
设备名会被打码 —— 因为待批准请求此时还没有归属账号，别人不该看到你的机器名。</p>
${pendingTable(pending, focusCode)}

<h2>已授权的 AI 客户端（${grants.filter((g) => !g.revoked_at).length} 有效 / 共 ${grants.length}）</h2>
<p class="dim">你在 AI 客户端里点「连接」并批准之后，这里会出现一条记录。
<b>每一条都绑定到你当前这个账号</b> —— 那个客户端只能操作你名下的设备。
撤销会立刻吊销它已拿到的令牌，不需要等令牌过期。</p>
${table(
  ['客户端', 'client_id', '权限', '状态', '授权于', '最后使用', '操作'],
  grantRows(grants),
  { empty: '还没有 AI 客户端接入。在 ChatGPT / Claude / Codex 里添加本 MCP 端点后，会自动跳转到授权页。' }
)}

<h2>我的访问令牌（${tokenList.filter((t) => !t.revoked_at).length} 有效 / 共 ${tokenList.length}）</h2>
<p class="dim">这里只放<b>手动创建</b>的令牌，用于不支持 OAuth 的客户端（CLI、脚本）。
上面那些 AI 客户端拿到的令牌不在这里显示 —— 它们由 OAuth 流程自动签发，
通过上表的「撤销」统一管理。</p>
<form method="post" action="/console/tokens">
  <div class="row">
    <label class="grow" style="margin:0"><span>标签（便于区分用途，例如 "自测脚本"）</span>
      <input type="text" name="label" maxlength="120" placeholder="自测脚本"></label>
    <label style="margin:0"><span>有效期</span>
      <select name="expires_in_days">
        <option value="">不过期</option>
        <option value="30">30 天</option>
        <option value="90">90 天</option>
        <option value="365">1 年</option>
      </select></label>
    <button type="submit">创建令牌</button>
  </div>
</form>
${table(
  ['标签', '前缀', '来源', '状态', '创建于', '最后使用', '过期', '操作'],
  tokenRows(tokenList),
  { empty: '还没有手动令牌。只有不支持 OAuth 的客户端才需要它。' }
)}

<h2>最近调用（${calls.length}）</h2>
${table(['工具', '设备', '结果', '时间', '参数'], callRows(calls, deviceNameById), { empty: '还没有调用记录。' })}

<h3>接入信息</h3>
${table(
  ['项', '值'],
  [
    `<tr><th>MCP 端点</th><td><code>${esc(stats.mcpEndpoint || '')}</code></td></tr>`,
    `<tr><th>鉴权</th><td><span class="tag on">必需</span> —— 每个请求都必须带有效令牌，没有匿名通路</td></tr>`,
    `<tr><th>OAuth 授权服务器</th><td><code>${esc(stats.oauthIssuer || '')}</code><br><span class="dim">支持 OAuth 的客户端（ChatGPT / Claude / Codex）会自行发现它，为每个用户各自发起一次授权</span></td></tr>`,
    `<tr><th>设备路由</th><td><code>${esc(stats.routePolicy || '')}</code>${stats.routePolicy === 'auto-single' ? ' —— 只有一台设备在线时自动选中；<b>多台在线时必须显式指定 device_id</b>，中继不会替你猜' : ''}</td></tr>`,
  ]
)}

<p class="dim" style="margin-top:28px">中继 ${esc(stats.server || '')} v${esc(stats.version || '')}
${stats.deviceCodeTtlS ? ` · 授权码有效期 ${esc(String(stats.deviceCodeTtlS))}s` : ''}</p>`;

  return layout.page(body, { title: '控制台 · Remote MCP Relay', nav: nav(user, '/console'), wide: true });
}

module.exports = { loginPage, signupPage, consentPage, consolePage, nav, pendingTable, maskName, grantRows };
