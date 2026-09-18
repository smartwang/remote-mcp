#!/usr/bin/env node
/**
 * 探针：把 DesktopCommander 当 stdio 子进程跑起来，问清它到底声明了哪些能力、
 * 有没有 resources / prompts / UI 组件。
 *
 * 为什么需要：中继在 tools/list 里原样透传了上游工具的 `_meta`，而 `_meta` 里
 * 带的是 `ui://desktop-commander/*` 这类 UI 组件资源声明。如果中继同时**不**声明
 * `resources` 能力、又不实现 `resources/read`，就会出现自相矛盾：
 *   客户端看到工具广告了 UI 模板 → 去读那个资源 → 中继报 -32601。
 * 本探针用来确定上游真实支持面，避免中继凭空撒谎或凭空丢弃。
 *
 * 用法：
 *   node tools/probe-capabilities.js
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const TIMEOUT_MS = 60_000;
const CLIENT_INFO = { name: 'desktop-commander-client', version: '1.0.0' };

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

function resolveEntry() {
  if (process.env.DC_ENTRY) {
    if (!fs.existsSync(process.env.DC_ENTRY)) fail(`DC_ENTRY 不存在：${process.env.DC_ENTRY}`);
    return process.env.DC_ENTRY;
  }
  const candidates = [];
  candidates.push(path.resolve(__dirname, '..', '..', '..', 'DesktopCommanderMCP', 'dist', 'index.js'));
  const npxRoot = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  if (fs.existsSync(npxRoot)) {
    for (const dir of fs.readdirSync(npxRoot)) {
      candidates.push(path.join(npxRoot, dir, 'node_modules', '@wonderwhy-er', 'desktop-commander', 'dist', 'index.js'));
    }
  }
  candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@wherewhy-er'.replace('wherewhy', 'wonderwhy'), 'desktop-commander', 'dist', 'index.js'));
  const found = candidates.filter((p) => fs.existsSync(p));
  if (!found.length) fail('找不到 DesktopCommander 的 dist/index.js');
  const withVersion = found.map((p) => {
    try {
      return { p, version: JSON.parse(fs.readFileSync(path.join(p, '..', '..', 'package.json'), 'utf8')).version || '0.0.0' };
    } catch {
      return { p, version: '0.0.0' };
    }
  });
  withVersion.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return withVersion[0].p;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms); }),
  ]);
}

async function main() {
  const entry = resolveEntry();
  console.log(`DesktopCommander: ${entry}\n`);

  const child = spawn(process.execPath, [entry], {
    cwd: path.dirname(entry),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, DC_REMOTE_DEVICE: 'true' },
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    for (const l of String(c).split(/\r?\n/)) if (l.trim()) console.log(`   [stderr] ${l.trim()}`);
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

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let msg;
    try { msg = JSON.parse(t); } catch { console.log(`   [stdout·非JSON] ${t.slice(0, 160)}`); return; }
    if (msg.id === undefined || msg.id === null) return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)));
    else slot.resolve(msg.result);
  });

  // 逐个问，任何一个失败都不阻断后面的
  const ask = async (method, params) => {
    try {
      return { ok: true, result: await withTimeout(send(method, params), TIMEOUT_MS, method) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  };

  try {
    console.log('=== initialize (2025-06-18) ===');
    const init = await withTimeout(
      send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: CLIENT_INFO }),
      TIMEOUT_MS, 'initialize'
    );
    console.log(`serverInfo      : ${init.serverInfo?.name} ${init.serverInfo?.version}`);
    console.log(`protocolVersion : ${init.protocolVersion}`);
    console.log('capabilities    :');
    console.log(JSON.stringify(init.capabilities, null, 2).split('\n').map((l) => '   ' + l).join('\n'));
    if (init.instructions) console.log(`instructions    : ${String(init.instructions).slice(0, 200)}`);

    notify('notifications/initialized', {});

    console.log('\n=== tools/list ===');
    const listed = await withTimeout(send('tools/list', {}), TIMEOUT_MS, 'tools/list');
    const tools = listed.tools || [];
    console.log(`工具数: ${tools.length}`);
    if (listed.nextCursor) console.log(`nextCursor: ${listed.nextCursor}`);

    // _meta 聚合
    const metaKeys = {};
    const uiUris = new Set();
    const withMeta = tools.filter((t) => t._meta);
    for (const t of withMeta) {
      for (const k of Object.keys(t._meta)) metaKeys[k] = (metaKeys[k] || 0) + 1;
      const uri = t._meta['ui/resourceUri'] || t._meta?.ui?.resourceUri || t._meta['openai/outputTemplate'];
      if (uri) uiUris.add(uri);
    }
    console.log(`带 _meta 的工具: ${withMeta.length}/${tools.length}`);
    console.log('_meta 键分布  :');
    for (const [k, n] of Object.entries(metaKeys)) console.log(`   ${k.padEnd(28)} x${n}`);
    console.log(`UI 资源 URI   : ${uiUris.size} 个`);
    for (const u of uiUris) console.log(`   - ${u}`);

    console.log('\n=== resources/templates/list ===');
    const tpl = await ask('resources/templates/list', {});
    console.log(tpl.ok ? JSON.stringify(tpl.result).slice(0, 1200) : `ERR ${tpl.error}`);

    console.log('\n=== resources/list ===');
    const rl2 = await ask('resources/list', {});
    console.log(rl2.ok ? JSON.stringify(rl2.result).slice(0, 1200) : `ERR ${rl2.error}`);

    if (uiUris.size) {
      const sample = [...uiUris][0];
      console.log(`\n=== resources/read  ${sample} ===`);
      const rd = await ask('resources/read', { uri: sample });
      if (rd.ok) {
        const j = JSON.stringify(rd.result);
        console.log(`OK，返回 ${j.length} 字符`);
        console.log(`   mimeType: ${rd.result?.contents?.[0]?.mimeType}`);
        console.log(`   预览: ${String(rd.result?.contents?.[0]?.text || '').slice(0, 200)}`);
      } else {
        console.log(`ERR ${rd.error}`);
      }
    }

    console.log('\n=== prompts/list ===');
    const pr = await ask('prompts/list', {});
    console.log(pr.ok ? JSON.stringify(pr.result).slice(0, 800) : `ERR ${pr.error}`);

    child.stdin.end();
    setTimeout(() => child.kill(), 500).unref();
  } catch (err) {
    child.kill();
    fail(String(err && err.message ? err.message : err));
  }
}

main();
