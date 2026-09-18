#!/usr/bin/env node
/*
 * selftest.js —— 最小 MCP 客户端，用来验证"MCP server 这一半"是活的
 *
 * 支持两种传输：
 *   stdio : node selftest.js [--call <tool> [json]] -- <command> [args...]
 *   HTTP  : node selftest.js --http http://127.0.0.1:PORT/mcp [--call <tool> [json]]
 *
 * 断言链：initialize（含协议协商）→ notifications/initialized → tools/list
 *        → ping → tools/call
 *
 * 退出码 0 = 全通过，1 = 有失败，2 = 用法错误。零依赖，不需要网络（HTTP 模式除外）。
 */

'use strict';

const { spawn } = require('node:child_process');

const argv = process.argv.slice(2);
const httpIdx = argv.indexOf('--http');
const callIdx = argv.indexOf('--call');
const dashIdx = argv.indexOf('--');

const mode = httpIdx >= 0 ? 'http' : 'stdio';
const url = mode === 'http' ? argv[httpIdx + 1] : null;
const callTool = callIdx >= 0 ? argv[callIdx + 1] : null;
const callArgs = callIdx >= 0 && argv[callIdx + 2] && argv[callIdx + 2].startsWith('{') ? JSON.parse(argv[callIdx + 2]) : {};

let cmdArgs = [];
if (mode === 'stdio') {
  cmdArgs = dashIdx >= 0 ? argv.slice(dashIdx + 1) : argv.filter((_, i) => i !== callIdx && i !== callIdx + 1 && i !== callIdx + 2);
  if (cmdArgs.length === 0) {
    console.error('用法: node selftest.js [--call <tool> [json]] -- <command> [args...]');
    process.exit(2);
  }
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

console.log(mode === 'http' ? `目标(HTTP): ${url}\n` : `目标(stdio): ${cmdArgs.join(' ')}\n`);

/* ------------------------------------------------------------- transports */

function makeStdioTransport([cmd, ...args]) {
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  let noisyStdout = false;

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // 目标在 stdout 上打了横幅 —— 对 stdio 传输来说这是协议违规，记下来
        noisyStdout = true;
        console.log(`      [目标 stdout 非协议输出] ${line.slice(0, 100)}`);
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  return {
    noisyStdout: () => noisyStdout,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} 超时（20s）`));
        }, 20000);
        pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    close() { try { child.kill(); } catch {} },
  };
}

function makeHttpTransport(endpoint) {
  let nextId = 1;
  let sessionId = null;

  async function post(method, params, isNotification) {
    const id = isNotification ? undefined : nextId++;
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const body = JSON.stringify(isNotification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params });

    const res = await fetch(endpoint, { method: 'POST', headers, body });
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
      throw new Error(`SSE 响应里没找到 id=${id} 的消息（status=${res.status}）`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  return {
    noisyStdout: () => false,
    request: (method, params) => post(method, params, false),
    notify: (method, params) => post(method, params, true),
    close() {},
  };
}

/* ------------------------------------------------------------------- run */

const transport = mode === 'http' ? makeHttpTransport(url) : makeStdioTransport(cmdArgs);

(async () => {
  try {
    const init = await transport.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'selftest', version: '0.1.0' },
    });
    const info = init.result || {};
    record('initialize 有响应', !!init.result, `protocolVersion=${info.protocolVersion}`);
    if (info.error) record('initialize 无错误', false, JSON.stringify(info.error));
    record('serverInfo 可读', !!(info.serverInfo && info.serverInfo.name), info.serverInfo && info.serverInfo.name);
    record('声明了 tools 能力', !!(info.capabilities && info.capabilities.tools), info.capabilities ? Object.keys(info.capabilities).join(',') : '无');

    await transport.notify('notifications/initialized', {});

    const list = await transport.request('tools/list', {});
    const tools = (list.result && list.result.tools) || [];
    record('tools/list 返回工具', tools.length > 0, `${tools.length} 个: ${tools.map((t) => t.name).join(', ')}`);
    if (tools.length) record('每个工具都有 inputSchema', tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));

    const ping = await transport.request('ping', {});
    record('ping 有响应', !!ping.result);

    const target = callTool || (tools.find((t) => t.name === 'get_system_info') ? 'get_system_info' : tools[0] && tools[0].name);
    if (target) {
      // 没显式给参数时，按 inputSchema.required 合成一份最小合法入参，
      // 否则像 mcp-stub 的 echo 这种必填 input 的工具会直接判失败。
      let args = callArgs;
      if (Object.keys(args).length === 0) {
        const def = tools.find((t) => t.name === target) || {};
        const required = (def.inputSchema && def.inputSchema.required) || [];
        const props = (def.inputSchema && def.inputSchema.properties) || {};
        for (const key of required) {
          const t = (props[key] && props[key].type) || 'string';
          args[key] = t === 'number' || t === 'integer' ? 1 : t === 'boolean' ? true : t === 'array' ? [] : t === 'object' ? {} : 'selftest';
        }
      }
      const res = await transport.request('tools/call', { name: target, arguments: args });
      const out = res.result || {};
      const text = (out.content || []).map((c) => c.text || JSON.stringify(c)).join('\n');
      record(`tools/call ${target}`, !out.isError && !!text, text ? text.split('\n')[0].slice(0, 120) : '无返回内容');
      if (text) console.log(`\n--- ${target} 返回 ---\n${text}\n----------------------\n`);
    }

    if (mode === 'stdio' && transport.noisyStdout()) {
      record('stdout 干净（无协议外输出）', false, '目标往 stdout 打了非 JSON 内容 —— 换成 tunnel 挂载会污染协议流');
    }
  } catch (err) {
    record('整体流程', false, err.message);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  transport.close();
  process.exit(failed.length === 0 ? 0 : 1);
})();

process.on('uncaughtException', (e) => {
  console.error('自检异常:', e.message);
  transport.close();
  process.exit(1);
});
