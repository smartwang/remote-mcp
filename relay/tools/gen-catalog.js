#!/usr/bin/env node
/**
 * 生成 DesktopCommander 的 MCP 工具目录 catalog.json。
 *
 * 为什么需要它：DesktopCommander 的 device 进程**不上报工具表**给中继服务 ——
 * remote-channel.ts 的 registerDevice() 把传入的 capabilities 参数整个丢弃，
 * 写成只含 app_version 的 payload（见 remote-mcp/docs/ 的架构记录）。
 * 所以自建中继必须自己持有工具目录，只把「执行」路由到设备。
 *
 * 做法：真的把 DesktopCommander 当 stdio 子进程跑起来，调 initialize + tools/list，
 * 把返回的 tools 数组原样落盘。不要从源码里抄 —— 描述文案和 inputSchema 都由
 * zod 在运行时生成，抄不准。
 *
 * 用法：
 *   node tools/gen-catalog.js                       # 自动探测桌面端安装位置
 *   DC_ENTRY=/path/to/dist/index.js node tools/gen-catalog.js
 *   node tools/gen-catalog.js --out ../catalog.json
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const INIT_TIMEOUT_MS = 90_000;
const TOOLS_TIMEOUT_MS = 60_000;

// 客户端名必须用 'desktop-commander-client'：server.ts 的 isRemoteClientContext()
// 认这个名字（以及 DC_REMOTE_DEVICE=true）。用别的名字虽然也能拿到工具表，
// 但会走进"新手欢迎页"分支，可能弹浏览器。
const CLIENT_INFO = { name: 'desktop-commander-client', version: '1.0.0' };

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

/** 按优先级探测 DesktopCommander 的 dist/index.js。 */
function resolveEntry() {
  if (process.env.DC_ENTRY) {
    if (!fs.existsSync(process.env.DC_ENTRY)) fail(`DC_ENTRY 指向的文件不存在：${process.env.DC_ENTRY}`);
    return process.env.DC_ENTRY;
  }

  const candidates = [];

  // 1) 本仓库构建产物（DesktopCommanderMCP/dist/index.js）
  const repoGuess = path.resolve(__dirname, '..', '..', '..', 'DesktopCommanderMCP', 'dist', 'index.js');
  candidates.push(repoGuess);

  // 2) npx 缓存里最新的一份
  const npxRoot = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  if (fs.existsSync(npxRoot)) {
    for (const dir of fs.readdirSync(npxRoot)) {
      candidates.push(path.join(
        npxRoot, dir, 'node_modules', '@wonderwhy-er', 'desktop-commander', 'dist', 'index.js'
      ));
    }
  }

  // 3) 全局安装
  const globalRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules');
  candidates.push(path.join(globalRoot, '@wonderwhy-er', 'desktop-commander', 'dist', 'index.js'));

  const found = candidates.filter((p) => fs.existsSync(p));
  if (found.length === 0) {
    fail(
      '找不到 DesktopCommander 的 dist/index.js。\n' +
      '   先装一个：npx -y @wonderwhy-er/desktop-commander@latest --help\n' +
      '   或用 DC_ENTRY=<绝对路径> 指定。'
    );
  }

  // 多份时取版本号最高的，避免拿到过期的 npx 缓存
  const withVersion = found.map((p) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(p, '..', '..', 'package.json'), 'utf8'));
      return { p, version: pkg.version || '0.0.0' };
    } catch {
      return { p, version: '0.0.0' };
    }
  });
  withVersion.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  if (withVersion.length > 1) {
    console.log(`   探测到 ${withVersion.length} 份安装，取版本最高的：`);
    for (const { p, version } of withVersion) console.log(`     - ${version}  ${p}`);
  }
  return withVersion[0].p;
}

function parseArgs(argv) {
  const out = { out: path.resolve(__dirname, '..', 'catalog.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) out.out = path.resolve(process.cwd(), argv[++i]);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const entry = resolveEntry();
  const entryDir = path.dirname(entry);

  let version = 'unknown';
  try {
    version = JSON.parse(fs.readFileSync(path.join(entryDir, '..', 'package.json'), 'utf8')).version;
  } catch { /* 版本号只是元数据，拿不到不影响 */ }

  console.log(`DesktopCommander: ${entry}`);
  console.log(`版本:             ${version}`);
  console.log('');

  const child = spawn(process.execPath, [entry], {
    cwd: entryDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, DC_REMOTE_DEVICE: 'true' },
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) console.log(`   [stderr] ${line}`);
    }
  });

  const pending = new Map();
  let nextId = 1;
  const send = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  const notify = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };

  // stdout 是纯换行分隔的 JSON-RPC。非 JSON 的行（如启动横幅）只记录不报错。
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      console.log(`   [stdout·非JSON] ${trimmed.slice(0, 200)}`);
      return;
    }
    if (msg.id === undefined || msg.id === null) return; // 通知，忽略
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)));
    else slot.resolve(msg.result);
  });

  const bail = setTimeout(() => {
    fail(`超时（${INIT_TIMEOUT_MS}ms）：DesktopCommander 没有在预期时间内应答。`);
  }, INIT_TIMEOUT_MS);

  try {
    console.log('→ initialize ...');
    const init = await withTimeout(
      send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: CLIENT_INFO,
      }),
      INIT_TIMEOUT_MS,
      'initialize'
    );
    console.log(`   serverInfo: ${init.serverInfo?.name} ${init.serverInfo?.version}`);
    console.log(`   protocolVersion: ${init.protocolVersion}`);

    notify('notifications/initialized', {});

    console.log('→ tools/list ...');
    const listed = await withTimeout(send('tools/list', {}), TOOLS_TIMEOUT_MS, 'tools/list');
    const tools = listed.tools || [];
    if (tools.length === 0) fail('tools/list 返回空数组 —— 这不对，DesktopCommander 应该有几十个工具。');

    const missingSchema = tools.filter((t) => !t.name || !t.inputSchema);
    if (missingSchema.length) {
      fail(`有 ${missingSchema.length} 个工具缺 name 或 inputSchema：${missingSchema.map((t) => t.name).join(', ')}`);
    }

    const catalog = {
      generatedAt: new Date().toISOString(),
      source: { entry, version, serverInfo: init.serverInfo, protocolVersion: init.protocolVersion },
      toolCount: tools.length,
      tools,
    };

    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

    console.log('');
    console.log(`✅ ${tools.length} 个工具 → ${args.out}`);
    for (const t of tools) {
      const size = JSON.stringify(t.inputSchema).length;
      console.log(`   - ${t.name.padEnd(38)} schema ${String(size).padStart(5)} B`);
    }
    clearTimeout(bail);
    child.stdin.end();
    setTimeout(() => child.kill(), 500).unref();
  } catch (err) {
    clearTimeout(bail);
    child.kill();
    fail(String(err && err.message ? err.message : err));
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    }),
  ]);
}

main();
