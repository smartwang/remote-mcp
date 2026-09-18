#!/usr/bin/env node
/*
 * minimal-mcp-server —— 零依赖的 stdio MCP server（容器版）
 *
 * 用途：验证 "ChatGPT → OpenAI tunnel → 容器内 MCP server" 这条链路。
 *       也是后续自建中继时的最小 MCP server 模板。
 *
 * 定位说明（别误解）：
 *   · 它是"探针 + 模板"，不是 DesktopCommander 的替代品。工具只有 5 个，
 *     能力刻意做窄，目的是让链路问题一眼可辨。
 *   · 它是**全权限**执行体 —— run_command 能跑执行环境里的任意命令，
 *     文件工具能读写执行环境里可达的任意路径。靠环境隔离兜底，不靠进程内护栏。
 *
 * 执行边界（重要，别搞混）：
 *   server 在容器里跑时，run_command 执行的是**容器内**的 shell，不是宿主的。
 *   要碰宿主文件只能靠 volume 挂载（compose 默认挂到 /host/workspace、
 *   /host/wsl-home）。这是容器化的代价，也是它换来隔离的地方。
 *
 * 传输：stdio，newline-delimited JSON-RPC 2.0。
 *   stdout 只写协议消息；所有日志走 stderr —— 这条不遵守整条链路就废了。
 *
 * 环境变量：
 *   MCP_SHELL     执行 run_command 的 shell（默认 /bin/bash，Windows 下 bash.exe）
 *   MCP_MAX_CHARS 单次工具返回的字符上限（默认 20000，超出截断）
 *   MCP_SCOPE     执行环境自述标签，仅用于展示（容器部署时设为 container）
 */

'use strict';

const readline = require('node:readline');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SERVER_NAME = 'minimal-mcp-server';
const SERVER_VERSION = '0.2.0-container';
const LATEST_PROTOCOL = '2025-06-18';
const KNOWN_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

const SHELL_BIN = process.env.MCP_SHELL || (process.platform === 'win32' ? 'bash.exe' : '/bin/bash');
const MAX_CHARS = Number(process.env.MCP_MAX_CHARS || 20000);
const CALL_TIMEOUT_MS = 120000;

function log(...args) {
  process.stderr.write(`[${SERVER_NAME}] ${args.join(' ')}\n`);
}

function truncate(text) {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n…[截断，原始长度 ${text.length} 字符，上限 ${MAX_CHARS}]`;
}

/* ------------------------------------------------------------- 环境探测 */

function inContainer() {
  if (fs.existsSync('/.dockerenv')) return true;
  try {
    const cg = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return /docker|containerd|kubepods|podman/.test(cg);
  } catch {
    return false;
  }
}

function inWsl() {
  return (
    fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') ||
    String(process.env.WSL_DISTRO_NAME || '') !== ''
  );
}

// runtime 描述的是"命令实际在哪执行"，这是使用者最该知道的一件事
const RUNTIME = inContainer() ? 'container' : inWsl() ? 'wsl' : 'host';
const SCOPE_LABEL = process.env.MCP_SCOPE || RUNTIME;

// 找出挂进来的宿主路径，写进工具描述里 —— 让调用方能自己判断能碰哪些目录
function mountedHostPaths() {
  const roots = ['/host'];
  const out = [];
  for (const r of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(r, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const p = path.join(r, e.name);
      let note = '';
      try {
        const n = fs.readdirSync(p).length;
        note = `（${n} 项）`;
      } catch {
        note = '（不可读）';
      }
      out.push(`${p}${note}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ tools */

const SCOPE_DESC =
  RUNTIME === 'container'
    ? '在容器内执行'
    : RUNTIME === 'wsl'
      ? '在 WSL 里执行'
      : '在本机执行';

const HOST_MOUNTS = mountedHostPaths();
const MOUNT_DESC = HOST_MOUNTS.length
  ? ` 宿主目录已挂载到：${HOST_MOUNTS.join('、')}。`
  : ' 当前没有挂载宿主目录，只能访问容器内的路径。';

const TOOLS = [
  {
    name: 'run_command',
    description: `${SCOPE_DESC}一条 shell 命令，返回 stdout/stderr 与退出码。用于查看系统状态、跑构建、调用 CLI。注意执行环境是${RUNTIME}，不是宿主机。`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令，会在 shell 里按原样运行' },
        cwd: { type: 'string', description: '工作目录，默认家目录' },
        timeout_ms: { type: 'number', description: `超时毫秒数，默认 ${CALL_TIMEOUT_MS}` },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: `读取一个文本文件的内容，可按行偏移与行数限制分块读取。${MOUNT_DESC}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径或 ~ 开头路径' },
        offset: { type: 'number', description: '起始行号（从 1 开始），默认 1' },
        limit: { type: 'number', description: '最多读取行数，默认 500' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: `写入文本文件，父目录不存在会自动创建。整文件覆盖。${MOUNT_DESC}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径或 ~ 开头路径' },
        content: { type: 'string', description: '文件内容（覆盖写入）' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: `列出一个目录下的条目，含类型与大小。${MOUNT_DESC}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，默认当前工作目录' },
      },
    },
  },
  {
    name: 'get_system_info',
    description:
      '返回运行本 server 的机器信息：主机名、用户、平台、内核、Node 版本、当前目录、以及命令实际执行的环境（container / wsl / host）。用来确认请求落到了哪一层。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function runCommand({ command, cwd, timeout_ms }) {
  return new Promise((resolve) => {
    const workdir = expandHome(cwd) || os.homedir();
    const child = spawn(SHELL_BIN, ['-lc', command], { cwd: workdir, env: process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve(`命令超时（${timeout_ms || CALL_TIMEOUT_MS} ms），已终止。\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
    }, timeout_ms || CALL_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(`无法启动 shell（${SHELL_BIN}）：${err.message}`);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(`exit code: ${code}\n\n--- stdout ---\n${stdout || '(空)'}\n--- stderr ---\n${stderr || '(空)'}`);
    });
  });
}

function textResult(text) {
  return { content: [{ type: 'text', text: truncate(String(text)) }] };
}

async function callTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'run_command': {
      if (!a.command) throw new Error('缺少参数 command');
      return textResult(await runCommand(a));
    }
    case 'read_file': {
      const p = expandHome(a.path);
      if (!p) throw new Error('缺少参数 path');
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      const offset = Math.max(1, a.offset || 1);
      const limit = a.limit || 500;
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}\t${l}`).join('\n');
      return textResult(`${p}  共 ${lines.length} 行，显示第 ${offset}–${offset + slice.length - 1} 行\n${numbered}`);
    }
    case 'write_file': {
      const p = expandHome(a.path);
      if (!p) throw new Error('缺少参数 path');
      if (typeof a.content !== 'string') throw new Error('缺少参数 content');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, a.content, 'utf8');
      return textResult(`已写入 ${p}，${Buffer.byteLength(a.content, 'utf8')} 字节`);
    }
    case 'list_directory': {
      const p = expandHome(a.path) || process.cwd();
      const entries = fs.readdirSync(p, { withFileTypes: true });
      const rows = entries
        .map((e) => {
          if (e.isDirectory()) return `DIR   ${e.name}/`;
          try {
            return `FILE  ${e.name}  ${fs.statSync(path.join(p, e.name)).size}B`;
          } catch {
            return `FILE  ${e.name}`;
          }
        })
        .join('\n');
      return textResult(`${p}  共 ${entries.length} 项\n${rows || '(空目录)'}`);
    }
    case 'get_system_info': {
      const mounts = mountedHostPaths();
      return textResult(
        [
          `hostname      : ${os.hostname()}`,
          `user          : ${os.userInfo().username} (uid=${process.getuid ? process.getuid() : 'n/a'})`,
          `platform      : ${os.platform()} ${os.release()} (${os.arch()})`,
          `node          : ${process.version}`,
          `cwd           : ${process.cwd()}`,
          `homedir       : ${os.homedir()}`,
          `shell         : ${SHELL_BIN}`,
          `runtime       : ${RUNTIME}          <- run_command 实际执行的地方`,
          `scope_label   : ${SCOPE_LABEL}`,
          `is_container  : ${inContainer()}`,
          `is_wsl        : ${inWsl()}`,
          `host_mounts   : ${mounts.length ? mounts.join(' | ') : '(无)'}`,
        ].join('\n')
      );
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
}

/* --------------------------------------------------------------- dispatch */

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      const negotiated = KNOWN_PROTOCOLS.has(requested) ? requested : LATEST_PROTOCOL;
      log(`initialize: client=${(params && params.clientInfo && params.clientInfo.name) || '?'} protocol=${requested} -> ${negotiated}`);
      return {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
    }
    case 'notifications/initialized':
    case 'initialized':
      log('client initialized');
      return undefined;
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const name = params && params.name;
      log(`tools/call ${name}`);
      try {
        return await callTool(name, params && params.arguments);
      } catch (err) {
        return { content: [{ type: 'text', text: `工具执行失败：${err.message}` }], isError: true };
      }
    }
    case 'resources/list':
      return { resources: [] };
    case 'prompts/list':
      return { prompts: [] };
    default:
      if (isNotification) return undefined;
      throw Object.assign(new Error(`未实现的方法：${method}`), { code: -32601 });
  }
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    log(`无法解析的输入行：${err.message}`);
    return;
  }
  Promise.resolve()
    .then(() => handle(msg))
    .then((result) => {
      if (msg.id === undefined || msg.id === null) return;
      if (result === undefined) {
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
        return;
      }
      send({ jsonrpc: '2.0', id: msg.id, result });
    })
    .catch((err) => {
      if (msg.id === undefined || msg.id === null) return;
      send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32603, message: err.message } });
    });
});

rl.on('close', () => {
  log('stdin 关闭，退出');
  process.exit(0);
});

log(`已就绪 | runtime=${RUNTIME} | shell=${SHELL_BIN} | max_chars=${MAX_CHARS} | pid=${process.pid}`);
if (HOST_MOUNTS.length) log(`挂载的宿主目录：${HOST_MOUNTS.join('、')}`);
