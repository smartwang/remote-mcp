#!/usr/bin/env node
/*
 * check-official-stub.js —— 用官方 stub 验证自检脚本的 HTTP 通路
 *
 * 做的事：拉起 `tunnel-client dev mcp-stub`（它以 HTTP 方式暴露 MCP），
 * 从它 stdout 里解析出 MCP URL，再让 selftest.js 以 HTTP 模式打一遍。
 * 全程父子进程都在本进程内，不产生游离进程。
 *
 * 用法：node check-official-stub.js <tunnel-client 可执行文件路径> <selftest.js 路径>
 */

'use strict';

const { spawn } = require('node:child_process');

const [tcBin, selftestPath] = process.argv.slice(2);
if (!tcBin || !selftestPath) {
  console.error('用法: node check-official-stub.js <tunnel-client> <selftest.js>');
  process.exit(2);
}

const stub = spawn(tcBin, ['dev', 'mcp-stub'], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
let done = false;

const timer = setTimeout(() => {
  if (done) return;
  console.error('等 stub 启动超时（20s）。已收到的输出：\n' + out);
  stub.kill();
  process.exit(1);
}, 20000);

function finish(code) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  stub.kill();
  process.exit(code);
}

stub.stderr.on('data', (d) => { out += d.toString(); });

stub.stdout.on('data', (chunk) => {
  out += chunk.toString();
  const m = out.match(/MCP URL:\s*(\S+)/);
  if (!m) return;
  const url = m[1].trim();
  console.log(`发现 stub MCP URL: ${url}\n`);
  const t = spawn(process.execPath, [selftestPath, '--http', url], { stdio: 'inherit' });
  t.on('close', (code) => finish(code === null ? 1 : code));
});

stub.on('close', (code) => {
  if (!done) {
    console.error(`stub 提前退出，code=${code}\n输出：\n${out}`);
    finish(1);
  }
});
