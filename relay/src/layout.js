'use strict';
/**
 * 页面布局与 HTML 片段工具。
 *
 * 抽出来的原因：授权页、登录页、控制台、管理员页要用同一套视觉与同一套转义。
 * 之前授权页和状态页各自拼 CSS，已经开始漂移（一个 640px、一个 820px，
 * 同一批颜色字面量写了两遍）—— 再多两个页面就会彻底失控。
 */

/** HTML 转义。所有插入页面的动态字符串都必须过这里。 */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/** 相对时间（服务端渲染用，不依赖 JS）。 */
function agoText(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return esc(iso);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return `${Math.round(s)} 秒前`;
  if (s < 5400) return `${Math.round(s / 60)} 分钟前`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

function iso(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const BASE_CSS = `
:root{color-scheme:light}
body{font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#2C2C2A}
h1{font-size:18px;font-weight:500;margin:0 0 4px}
h2{font-size:14px;font-weight:500;margin:26px 0 2px;color:#2C2C2A}
h3{font-size:13px;font-weight:500;margin:16px 0 4px;color:#5F5E5A}
p{color:#5F5E5A;margin:6px 0}
a{color:#185FA5}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#F1EFE8;padding:2px 6px;border-radius:4px;font-size:12.5px}
pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#F1EFE8;padding:10px 12px;border-radius:8px;overflow:auto;font-size:12.5px;margin:10px 0}
table{border-collapse:collapse;width:100%;margin:16px 0}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #D3D1C7;font-size:13px;vertical-align:top}
th{font-weight:500;color:#5F5E5A}
tbody th{width:150px}
input[type=text],input[type=email],input[type=password],input[type=number],select{font:inherit;padding:8px 10px;border:1px solid #B4B2A9;border-radius:8px;width:100%;box-sizing:border-box}
input.code{width:180px;letter-spacing:2px;text-transform:uppercase}
button{font:inherit;padding:8px 16px;border:1px solid #185FA5;background:#E6F1FB;color:#0C447C;border-radius:8px;cursor:pointer}
button.deny{border-color:#BA7517;background:#FAEEDA;color:#633806}
button.subtle{border-color:#B4B2A9;background:#FFFFFF;color:#5F5E5A;padding:4px 10px;font-size:12.5px}
button.danger{border-color:#A32D2D;background:#FCEBEB;color:#791F1F;padding:4px 10px;font-size:12.5px}
.ok{border:1px solid #185FA5;background:#E6F1FB;color:#0C447C;padding:10px 12px;border-radius:8px;margin:16px 0}
.err{border:1px solid #A32D2D;background:#FCEBEB;color:#791F1F;padding:10px 12px;border-radius:8px;margin:16px 0}
.warn{border:1px solid #BA7517;background:#FAEEDA;color:#633806;padding:10px 12px;border-radius:8px;margin:16px 0}
.dim{color:#888780}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:12px;white-space:nowrap}
.tag.on{background:#E6F1FB;color:#0C447C}
.tag.off{background:#F1EFE8;color:#5F5E5A}
.tag.warn{background:#FAEEDA;color:#633806}
.tag.bad{background:#FCEBEB;color:#791F1F}
nav{margin:0 0 20px;padding-bottom:10px;border-bottom:1px solid #D3D1C7;font-size:13px}
nav a{margin-right:14px}
nav .who{float:right;color:#888780}
label{display:block;margin:12px 0}
label span{display:block;color:#5F5E5A;font-size:12.5px;margin-bottom:4px}
.row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.row > *{flex:0 0 auto}
.grow{flex:1 1 200px !important}
`;

/**
 * 渲染完整页面。
 *   opts.title  浏览器标题
 *   opts.nav    顶部导航 HTML（已转义或由调用方构造）
 *   opts.wide   宽版（控制台/管理员页）
 *   opts.extraCss 追加样式
 */
function page(htmlBody, opts = {}) {
  const title = opts.title || 'Remote MCP Relay';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${BASE_CSS}${opts.wide ? 'body{max-width:960px}' : ''}
${opts.extraCss || ''}</style></head><body>${opts.nav || ''}${htmlBody}</body></html>`;
}

/** 一个表格；rows 为已构造好的 `<tr>` 字符串数组。 */
function table(headers, rows, { empty = '（空）' } = {}) {
  if (!rows.length) return `<p>${esc(empty)}</p>`;
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function alertBox(kind, html) {
  const cls = kind === 'error' ? 'err' : kind === 'warn' ? 'warn' : 'ok';
  return `<div class="${cls}">${html}</div>`;
}

module.exports = { esc, agoText, iso, page, table, alertBox, BASE_CSS };
