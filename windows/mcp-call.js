#!/usr/bin/env node
/*
 * mcp-call.js —— 手动调用任意 streamable-HTTP MCP 端点的一个工具
 *
 * 用途：不经过 ChatGPT 就能验证链路。调试时比翻隧道日志快得多。
 *
 * 用法：
 *   node mcp-call.js <url> <tool> '<json 参数>'
 *   node mcp-call.js <url> <tool> @args.json        # 参数复杂时走文件，避开 shell 引号地狱
 *   node mcp-call.js <url> --list                   # 只列工具
 *
 * 例：
 *   node mcp-call.js http://127.0.0.1:18090/t/xxx/mcp get_windows_info
 *   node mcp-call.js http://127.0.0.1:18090/t/xxx/mcp run_powershell @ps.json
 *
 * 退出码 0 = 调用成功且 isError 非真。
 */

'use strict';

const fs = require('node:fs');

const [url, tool, argsRaw] = process.argv.slice(2);

if (!url || (!tool && !process.argv.includes('--list'))) {
  console.error('用法: node mcp-call.js <url> <tool|--list> [\'<json>\' | @file.json]');
  process.exit(2);
}

let sessionId = null;
let nextId = 1;

async function rpc(method, params, isNotification) {
  const id = isNotification ? undefined : nextId++;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const payload = isNotification
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id, method, params };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  if (isNotification) return null;

  const text = await res.text();
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      try {
        const m = JSON.parse(t.slice(5).trim());
        if (m.id === id) return m;
      } catch { /* 跳过非 JSON 的 SSE 行 */ }
    }
    throw new Error(`SSE 响应里没找到 id=${id}（status=${res.status}）`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

(async () => {
  try {
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-call', version: '1.0.0' },
    });
    await rpc('notifications/initialized', {});

    const list = await rpc('tools/list', {});
    const tools = (list.result && list.result.tools) || [];

    if (tool === '--list' || !tool) {
      console.log(`${tools.length} 个工具：`);
      for (const t of tools) console.log(`  ${t.name.padEnd(20)} ${(t.description || '').split('\n')[0].slice(0, 90)}`);
      process.exit(0);
    }

    let args = {};
    if (argsRaw) {
      if (argsRaw.startsWith('@')) args = JSON.parse(fs.readFileSync(argsRaw.slice(1), 'utf8'));
      else args = JSON.parse(argsRaw);
    }

    const res = await rpc('tools/call', { name: tool, arguments: args });
    const out = res.result || {};
    if (res.error) {
      console.error('JSON-RPC 错误:', JSON.stringify(res.error));
      process.exit(1);
    }
    const text = (out.content || []).map((c) => c.text || JSON.stringify(c)).join('\n');
    console.log(text);
    process.exit(out.isError ? 1 : 0);
  } catch (err) {
    console.error('调用失败:', err.message);
    process.exit(1);
  }
})();
