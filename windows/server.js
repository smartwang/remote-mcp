#!/usr/bin/env node
/*
 * windows-mcp-server —— 跑在 **Windows 宿主**上的 MCP server（零依赖）
 *
 * 为什么需要它：
 *   容器里跑不了 Windows 程序。实测 docker-desktop VM 没有 binfmt/WSLInterop，
 *   Windows 的 PE 可执行文件在 Linux 容器里无法 exec。所以"操作 Windows 本机"
 *   这件事必须由一个 Windows 原生进程来做。
 *
 * 它在这套架构里的位置：
 *   ChatGPT → OpenAI 隧道 → 容器内 tunnel-client → host.docker.internal
 *          → 【本进程】 → PowerShell / cmd.exe → 真实的 Windows
 *
 *   tunnel-client 是"管道"（凭据在容器里，隔离），本进程是"手"（真实机器权限）。
 *
 * 传输：
 *   http   （默认）streamable HTTP MCP，路径 /mcp —— 给 tunnel-client 的 MCP_SERVER_URL 用
 *   stdio  （--stdio 或 MCP_TRANSPORT=stdio）—— 给本机 MCP 客户端/tunnel 的 MCP_COMMAND 用
 *
 * 环境变量：
 *   MCP_TRANSPORT     http | stdio          默认 http
 *   MCP_BIND          监听地址              默认 ::（双栈，IPv4/IPv6 都收）。
 *                                           容器要经 host.docker.internal 连进来，绑 127.0.0.1 连不通；
 *                                           而 Docker 的 host-gateway 会解析到 IPv6，所以默认双栈最稳。
 *   MCP_PORT          监听端口              默认 18090
 *   MCP_PATH_TOKEN    路径内共享密钥。设了就只接受 /t/<token>/mcp
 *                     —— 因为 tunnel-client 没法给 MCP server 发自定义请求头，
 *                        而绑 0.0.0.0 意味着同网段可达，这个 token 就是那道门。
 *   MCP_BEARER        可选。设了就要求 Authorization: Bearer <值>
 *   MCP_ALLOWED_ROOTS 可选。分号分隔的目录白名单，限制文件工具可达范围。不设=不限制。
 *   MCP_MAX_CHARS     单次返回字符上限，默认 20000
 *   MCP_DEFAULT_SHELL powershell | cmd       默认 powershell
 *
 * 安全定位（和 DesktopCommander 一个口径）：
 *   这是**本机全权限执行体**，不是沙箱。run_powershell 能跑当前用户能跑的任意命令。
 *   隔离靠"谁能连到它"（容器网络 + path token + 可选 bearer），不靠进程内护栏。
 */

'use strict';

const http = require('node:http');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const argv = process.argv.slice(2);

// 支持同目录的 server.env（KEY=VALUE，一行一条，# 开头为注释）。
// 目的是让启动器能只是一句 `node server.js`，不用把 token 塞进命令行
// （命令行参数在 Windows 上对同机其他用户是可见的）。
// 真实环境变量优先级更高，便于临时覆盖。
(function loadEnvFile() {
  const p = path.join(__dirname, 'server.env');
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
})();

const SERVER_NAME = 'windows-mcp-server';
const SERVER_VERSION = '1.0.0';
const LATEST_PROTOCOL = '2025-06-18';
const KNOWN_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

const TRANSPORT = argv.includes('--stdio')
  ? 'stdio'
  : (process.env.MCP_TRANSPORT || 'http').toLowerCase();
const BIND = process.env.MCP_BIND || '::';
const PORT = Number(process.env.MCP_PORT || 18090);
const PATH_TOKEN = process.env.MCP_PATH_TOKEN || '';
const BEARER = process.env.MCP_BEARER || '';
const MAX_CHARS = Number(process.env.MCP_MAX_CHARS || 20000);
const ALLOWED_ROOTS = (process.env.MCP_ALLOWED_ROOTS || '')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 9 * 60 * 1000; // 留出余量：隧道的 MCP 连接上限默认 10 分钟

const PS_EXE =
  process.env.MCP_POWERSHELL ||
  path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
const CMD_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');

// HTTP 模式下 stdout 不是协议通道，日志写 stdout 方便前台直接看；
// stdio 模式下 stdout 只能放协议帧，日志一律走 stderr。
function log(...args) {
  const line = `[${SERVER_NAME}] ${args.join(' ')}\n`;
  if (TRANSPORT === 'stdio') process.stderr.write(line);
  else process.stdout.write(line);
}

function truncate(text) {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n…[截断，原始长度 ${text.length} 字符，上限 ${MAX_CHARS}]`;
}

// 中文 Windows 上的编码是两头堵：
//   · cmd.exe 的内置字符串（如 ver 的 "[版本 10.0...]"）走 OEM 代码页 GBK，
//     即使前面加了 chcp 65001 也照样是 GBK 字节；
//   · PowerShell 侧我们已经在脚本里把输出编码钉成 UTF-8。
// 所以这里做一次判定：能严格往返 UTF-8 的就当 UTF-8，否则按 GBK 解。
// （实测 GBK 字节序列 B0 E6 开头就是非法 UTF-8 起始字节，判别是可靠的。）
function decodeBytes(buf) {
  const asUtf8 = buf.toString('utf8');
  if (Buffer.compare(Buffer.from(asUtf8, 'utf8'), buf) === 0) return asUtf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return asUtf8;
  }
}

/* ------------------------------------------------------------- 路径与限制 */

function guardPath(p) {
  if (!ALLOWED_ROOTS.length) return p;
  const resolved = path.resolve(p);
  const ok = ALLOWED_ROOTS.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.toLowerCase().startsWith(r.toLowerCase() + path.sep);
  });
  if (!ok) {
    throw new Error(`路径不在 MCP_ALLOWED_ROOTS 白名单内：${resolved}`);
  }
  return resolved;
}

/* ------------------------------------------------------------- 环境自述 */

const RUNTIME = process.platform === 'win32' ? 'windows-host' : process.platform;

function hostSummary() {
  const drives = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    try {
      if (fs.existsSync(root)) drives.push(root);
    } catch {
      /* 未就绪的驱动器会抛错，忽略 */
    }
  }
  return drives;
}

/* --------------------------------------------------------------- 执行内核 */

// PowerShell 的引号规则能把人逼疯，用 -EncodedCommand（UTF-16LE base64）彻底绕开。
// 顺带在里面把输出编码钉成 UTF-8，否则 Node 按 UTF-8 解码会看到乱码。
function runPowershell({ command, cwd, timeout_ms }) {
  // 两个实测出来的必要处理：
  //   1) ProgressPreference=SilentlyContinue —— 否则首次加载模块时 PowerShell 会往
  //      stderr 吐 "正在准备首次使用模块" 的 progress 记录。
  //   2) 用 & { ... } *>&1 | Out-String 把错误/警告流并进 stdout —— PowerShell 在
  //      stderr 被重定向时会序列化成 CLIXML（一大坨 XML + _x000D_ 转义），
  //      又难读又费 token。合并后是纯文本，代价是丢了 stdout/stderr 的区分。
  //     （注意：外部程序自己写 stderr 的不受此影响，那些仍是纯文本。）
  const preamble = [
    "$ErrorActionPreference = 'Continue'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    'try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
  ].join('; ');
  const full = `${preamble}; & { ${command} } *>&1 | Out-String -Width 200`;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  return runChild(PS_EXE, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], cwd, timeout_ms, 'powershell');
}

function runCmd({ command, cwd, timeout_ms }) {
  // chcp 65001 把 cmd 的输出切到 UTF-8，否则中文是 GBK，Node 解出来是乱码
  const full = `chcp 65001>nul && ${command}`;
  return runChild(CMD_EXE, ['/d', '/s', '/c', full], cwd, timeout_ms, 'cmd');
}

function runChild(exe, args, cwd, timeout_ms, label) {
  return new Promise((resolve) => {
    let workdir = cwd ? guardPath(cwd) : os.homedir();
    try {
      if (!fs.statSync(workdir).isDirectory()) workdir = os.homedir();
    } catch {
      workdir = os.homedir();
    }
    const budget = Math.min(Number(timeout_ms) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    let child;
    try {
      child = spawn(exe, args, { cwd: workdir, windowsHide: true });
    } catch (err) {
      resolve(`无法启动 ${label}（${exe}）：${err.message}`);
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      resolve(
        `命令超时（${budget} ms），已终止。\n\n--- stdout ---\n${decodeBytes(stdout) || '(空)'}\n--- stderr ---\n${decodeBytes(stderr) || '(空)'}`
      );
    }, budget);

    child.stdout.on('data', (d) => { stdout = Buffer.concat([stdout, d]); });
    child.stderr.on('data', (d) => { stderr = Buffer.concat([stderr, d]); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(`无法启动 ${label}（${exe}）：${err.message}`);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = decodeBytes(stdout);
      const err = decodeBytes(stderr);
      resolve(`[${label}] exit code: ${code}  cwd: ${workdir}\n\n--- stdout ---\n${out || '(空)'}\n--- stderr ---\n${err || '(空)'}`);
    });
  });
}

/* ------------------------------------------------------------------ tools */

const DRIVES = hostSummary();
const SCOPE_DESC = '在 Windows 宿主机上执行（不是容器、不是 WSL）';
const ROOT_DESC = ALLOWED_ROOTS.length
  ? `文件工具被限制在这些根目录内：${ALLOWED_ROOTS.join('、')}。`
  : '文件工具当前未限制范围，可访问当前用户有权限的任意路径。';

const TOOLS = [
  {
    name: 'run_powershell',
    description: `${SCOPE_DESC}一条 PowerShell 命令，返回 stdout/stderr 与退出码。这是操作 Windows 的主力工具：进程、服务、注册表、网络、文件、事件日志都能碰。可用管道与 cmdlet。`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell 命令，按原样执行（单行；多行用分号或换行）' },
        cwd: { type: 'string', description: '工作目录，如 C:\\Users\\longyuan\\workspace，默认用户主目录' },
        timeout_ms: { type: 'number', description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}` },
      },
      required: ['command'],
    },
  },
  {
    name: 'run_cmd',
    description: `${SCOPE_DESC}一条 cmd.exe 命令，返回 stdout/stderr 与退出码。少数只认 cmd 的老工具（如部分安装器、\`where\`、\`dir\` 的批处理场景）用这个。`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'cmd 命令，按原样执行' },
        cwd: { type: 'string', description: '工作目录，默认用户主目录' },
        timeout_ms: { type: 'number', description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}` },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: `读取 Windows 上的一个文本文件，可按行偏移与行数分块。路径用 Windows 形式（C:\\...）。${ROOT_DESC}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径，如 C:\\Users\\longyuan\\Desktop\\a.txt' },
        offset: { type: 'number', description: '起始行号（从 1 开始），默认 1' },
        limit: { type: 'number', description: '最多读取行数，默认 500' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: `写入 Windows 上的文本文件，父目录不存在会自动创建。整文件覆盖。${ROOT_DESC}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径（Windows 形式）' },
        content: { type: 'string', description: '文件内容（覆盖写入）' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: `列出 Windows 上一个目录的条目，含类型与大小。默认列出已发现的盘根目录。${ROOT_DESC}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，如 C:\\Users\\longyuan\\workspace' },
      },
    },
  },
  {
    name: 'list_processes',
    description: `${SCOPE_DESC}列出当前进程，按内存占用降序。可用来查某个程序是否在跑、占了多少内存。`,
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '可选，按进程名做不区分大小写的包含匹配，如 chrome' },
        limit: { type: 'number', description: '返回条数，默认 20' },
      },
    },
  },
  {
    name: 'get_windows_info',
    description:
      '返回本机 Windows 的身份信息：主机名、当前用户、OS 版本、架构、启动时长、磁盘、以及命令实际执行的环境标签。用来确认请求到底落到了哪台机器上。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function textResult(text) {
  return { content: [{ type: 'text', text: truncate(String(text)) }] };
}

async function callTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'run_powershell': {
      if (!a.command) throw new Error('缺少参数 command');
      return textResult(await runPowershell(a));
    }
    case 'run_cmd': {
      if (!a.command) throw new Error('缺少参数 command');
      return textResult(await runCmd(a));
    }
    case 'read_file': {
      if (!a.path) throw new Error('缺少参数 path');
      const p = guardPath(expandHome(a.path));
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      const offset = Math.max(1, a.offset || 1);
      const limit = a.limit || 500;
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}\t${l}`).join('\n');
      return textResult(`${p}  共 ${lines.length} 行，显示第 ${offset}–${offset + slice.length - 1} 行\n${numbered}`);
    }
    case 'write_file': {
      if (!a.path) throw new Error('缺少参数 path');
      if (typeof a.content !== 'string') throw new Error('缺少参数 content');
      const p = guardPath(expandHome(a.path));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, a.content, 'utf8');
      return textResult(`已写入 ${p}，${Buffer.byteLength(a.content, 'utf8')} 字节`);
    }
    case 'list_directory': {
      const raw = expandHome(a.path);
      const p = raw ? guardPath(raw) : DRIVES[0] || os.homedir();
      const entries = fs.readdirSync(p, { withFileTypes: true });
      const rows = entries
        .map((e) => {
          if (e.isDirectory()) return `DIR   ${e.name}\\`;
          try {
            return `FILE  ${e.name}  ${fs.statSync(path.join(p, e.name)).size}B`;
          } catch {
            return `FILE  ${e.name}`;
          }
        })
        .join('\n');
      return textResult(`${p}  共 ${entries.length} 项\n${rows || '(空目录)'}`);
    }
    case 'list_processes': {
      const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 200);
      const filter = a.filter ? String(a.filter).replace(/'/g, "''") : '';
      const cmd = [
        'Get-Process',
        filter ? `| Where-Object { $_.ProcessName -like '*${filter}*' }` : '',
        '| Sort-Object -Descending WorkingSet64',
        `| Select-Object -First ${limit} ProcessName, Id, @{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB,1)}}, @{n='CPUs';e={[math]::Round($_.CPU,1)}}`,
        '| Format-Table -AutoSize | Out-String -Width 200',
      ].filter(Boolean).join(' ');
      return textResult(await runPowershell({ command: cmd, timeout_ms: 60000 }));
    }
    case 'get_windows_info': {
      const osLine = await runPowershell({
        command:
          "$o = Get-CimInstance Win32_OperatingSystem; " +
          "'{0}|{1}|{2}' -f $o.Caption, $o.Version, $o.OSArchitecture",
        timeout_ms: 30000,
      });
      const parity = osLine.split('\n').map((s) => s.trim()).filter(Boolean);
      const caption = parity.find((s) => s.includes('|')) || '(未知)';
      const [osCaption, osVersion, osArch] = caption.split('|');
      const disks = await runPowershell({
        command:
          "Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | " +
          "ForEach-Object { '{0} {1}GB free / {2}GB' -f $_.DeviceID, " +
          "[math]::Round($_.FreeSpace/1GB,1), [math]::Round($_.Size/1GB,1) }",
        timeout_ms: 30000,
      });
      const diskLines = disks.split('\n').map((s) => s.trim()).filter((s) => /^[A-Z]:/.test(s));
      return textResult(
        [
          `hostname      : ${os.hostname()}`,
          `user          : ${os.userInfo().username}`,
          `os            : ${osCaption || '?'} ${osVersion || ''} (${osArch || os.arch()})`,
          `platform      : ${process.platform} ${os.release()} (${os.arch()})`,
          `node          : ${process.version}`,
          `cwd           : ${process.cwd()}`,
          `homedir       : ${os.homedir()}`,
          `uptime        : ${(os.uptime() / 3600).toFixed(1)} h`,
          `drives        : ${DRIVES.join(', ') || '(无)'}`,
          `disk_free     : ${diskLines.join(' | ') || '(未知)'}`,
          `runtime       : ${RUNTIME}          <- 命令实际执行的地方`,
          `is_container  : false`,
          `is_wsl        : false`,
          `powershell    : ${PS_EXE}`,
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

/* ------------------------------------------------------------- stdio 传输 */

function startStdio() {
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
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? {} : result })}\n`);
      })
      .catch((err) => {
        if (msg.id === undefined || msg.id === null) return;
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32603, message: err.message } })}\n`);
      });
  });
  rl.on('close', () => {
    log('stdin 关闭，退出');
    process.exit(0);
  });
  log(`已就绪(stdio) | runtime=${RUNTIME} | pid=${process.pid}`);
}

/* -------------------------------------------------------------- HTTP 传输 */

// streamable HTTP：请求走 POST，响应直接给单个 JSON（规范允许）。
// 没有 server-initiated 流，所以 GET 返回 405；DELETE 收掉会话。
const sessions = new Map();

function mcpPathMatches(urlPath) {
  const clean = urlPath.split('?')[0].replace(/\/+$/, '') || '/';
  if (PATH_TOKEN) return clean === `/t/${PATH_TOKEN}/mcp`;
  return clean === '/mcp';
}

function sendJson(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error('请求体超过 8MB'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!BEARER) return true;
  const h = req.headers['authorization'] || '';
  return h === `Bearer ${BEARER}`;
}

async function processRpc(msg, sessionId) {
  // 批量（数组）也支持：过滤掉通知后，如果还有请求就逐个处理
  if (Array.isArray(msg)) {
    const out = [];
    for (const one of msg) {
      const r = await processRpc(one, sessionId);
      if (r) out.push(r);
    }
    return out.length ? out : null;
  }
  if (msg.id === undefined || msg.id === null) {
    try {
      await handle(msg);
    } catch (err) {
      log(`通知处理出错：${err.message}`);
    }
    return null;
  }
  try {
    const result = await handle(msg);
    return { jsonrpc: '2.0', id: msg.id, result: result === undefined ? {} : result };
  } catch (err) {
    return { jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32603, message: err.message } };
  }
}

function startHttp() {
  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    // tunnel-client 挂 HTTP MCP 目标时会做一次 RFC 9728 的 protected-resource
    // metadata 探测。我们这里没有 OAuth，正确做法是回一份**合法的**元数据、
    // 且不含 authorization_servers —— 它据此就能判定"不需要鉴权"。
    // 不这么做的话它会拿根路径的响应去当元数据解析，日志里留一条
    // "OAuth discovery failed" 警告（无害，但很容易被误读成链路有问题）。
    if (urlPath === '/.well-known/oauth-protected-resource') {
      const host = req.headers.host || `${BIND}:${PORT}`;
      const mcpPath = PATH_TOKEN ? `/t/${PATH_TOKEN}/mcp` : '/mcp';
      sendJson(res, 200, {
        resource: `http://${host}${mcpPath}`,
        bearer_methods_supported: BEARER ? ['header'] : [],
      });
      return;
    }

    // 只认 /healthz。/ 刻意不返回 JSON —— 理由同上。
    if (urlPath === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        server: SERVER_NAME,
        version: SERVER_VERSION,
        runtime: RUNTIME,
        transport: 'http',
        tools: TOOLS.length,
        sessions: sessions.size,
        uptime_s: Math.round(process.uptime()),
        hostname: os.hostname(),
      });
      return;
    }

    if (!mcpPathMatches(urlPath)) {
      // 纯文本 404，且首字符不用 n/t/f —— 否则会被当成 JSON 字面量去解析，
      // 报出 "invalid character 'o' in literal null" 这种莫名其妙的错。
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`# no such endpoint here; MCP endpoint is ${PATH_TOKEN ? `/t/${PATH_TOKEN}/mcp` : '/mcp'}\n`);
      return;
    }

    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'GET') {
      // 不提供 server-initiated SSE 流
      res.writeHead(405, { allow: 'POST, DELETE', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed', hint: '本 server 只在 POST 上响应' }));
      return;
    }

    if (req.method === 'DELETE') {
      const sid = req.headers['mcp-session-id'];
      if (sid) sessions.delete(sid);
      res.writeHead(204).end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST, DELETE', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      sendJson(res, 413, { error: 'payload_too_large', message: err.message });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `JSON 解析失败：${err.message}` } });
      return;
    }

    const incomingSid = req.headers['mcp-session-id'];
    let sid = incomingSid;
    const isInitialize = !Array.isArray(msg) && msg.method === 'initialize';

    if (isInitialize) {
      sid = crypto.randomUUID();
      sessions.set(sid, { createdAt: Date.now() });
      // 清理太老的会话，避免长时间运行后内存里攒一堆
      if (sessions.size > 64) {
        for (const [k, v] of sessions) {
          if (Date.now() - v.createdAt > 6 * 3600 * 1000) sessions.delete(k);
        }
      }
    }
    if (sid) {
      const known = sessions.get(sid);
      if (known) known.lastSeen = Date.now();
    }

    const reply = await processRpc(msg, sid);

    const headers = {};
    if (isInitialize && sid) headers['mcp-session-id'] = sid;
    // 客户端可能声明了它偏好的协议版本，回显一下有助于排错
    if (req.headers['mcp-protocol-version']) {
      headers['mcp-protocol-version'] = req.headers['mcp-protocol-version'];
    }

    if (reply === null) {
      // 只有通知：规范要求 202 + 空体
      res.writeHead(202, headers).end();
      return;
    }
    sendJson(res, 200, reply, headers);
  });

  server.on('clientError', (err, socket) => {
    try { socket.destroy(); } catch {}
  });

  server.listen(PORT, BIND, () => {
    log(`已就绪(http) | 监听 ${BIND}:${PORT} | runtime=${RUNTIME} | pid=${process.pid}`);
    const shown = BIND === '0.0.0.0' || BIND === '::' ? '<本机IP>' : BIND;
    log(`MCP 端点: http://${shown}:${PORT}${PATH_TOKEN ? `/t/${PATH_TOKEN}/mcp` : '/mcp'}`);
    log(`健康检查: http://127.0.0.1:${PORT}/healthz`);
    log(`工具(${TOOLS.length}): ${TOOLS.map((t) => t.name).join(', ')}`);
    if (PATH_TOKEN) log('路径 token 已启用');
    if (BEARER) log('bearer 鉴权已启用');
    if (ALLOWED_ROOTS.length) log(`文件访问白名单: ${ALLOWED_ROOTS.join('; ')}`);
  });
}

/* -------------------------------------------------------------------- 启动 */

log(`runtime=${RUNTIME} platform=${process.platform} node=${process.version} homedir=${os.homedir()}`);
if (TRANSPORT === 'stdio') startStdio();
else startHttp();
