#!/usr/bin/env node
/**
 * relay-device —— 本机副本准备器（零下载）
 * =====================================================================
 * 为什么需要「副本」这件事：
 *
 * 1. 官方那台 device（npx @wonderwhy-er/desktop-commander@latest remote）不能动。
 *    它把 `<npx-cache>/.../dist` 当 cwd 用（desktop-commander-integration.js:127
 *    用 process.execPath spawn 同包的 dist/index.js，cwd=dist），于是那个目录被
 *    锁住 —— 这正是 npx 升级时报 EBUSY 的原因（rename 目录失败）。
 *
 * 2. `dist/remote-device/device.js` 里状态文件路径是**硬编码**的
 *    （getRemoteDeviceConfigPath() → `~/.desktop-commander-device/device.json`），
 *    全 dist 仅此一处，没有任何环境变量可覆盖。而这个文件只存
 *    {deviceId, session}，**不记 server URL** —— 所以两台 device 必然争抢它：
 *    后启动的覆写身份，官方那台下次重启就废了。
 *
 * 所以必须：独立副本 + 改掉那一行状态路径。官方那份一个字节不碰。
 *
 * 本脚本做四件事，全部幂等：
 *   a. 从本机 npx 缓存里找到现有的 node_modules（**本地复制，绝不联网下载**）
 *   b. 复制到 <root>/node_modules
 *   c. 把副本里 device.js 的状态路径改成可被 DCD_DEVICE_STATE_DIR 覆盖，
 *      且**默认值也不再与官方撞车**
 *   d. 静态校验补丁真的生效（不 import 那个模块 —— 它经 capture.js 牵进 server.js，
 *      顶部有副作用，不适合拿来做检查）
 *
 * 用法：
 *   node prepare.mjs [--root <dir>] [--state-dir <dir>] [--source <node_modules>]
 *                    [--force] [--check-only] [--quiet]
 * 环境变量兜底：DCD_DEVICE_ROOT / DCD_DEVICE_STATE_DIR / DCD_SOURCE_NODE_MODULES
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PKG_SUB = ['@wonderwhy-er', 'desktop-commander'];
const ENTRY_IN_PKG = ['dist', 'remote-device', 'device.js'];
const MARKER = '.prepared.json';

/**
 * 官方那一行的精确形态（device.js:21 / src 的 device.ts:28）：
 *     return path.join(os.homedir(), '.desktop-commander-device', 'device.json');
 * 只按「这一行」替换，缩进用捕获组保留，避免碰坏别的代码。
 */
const OLD_RE = /^([ \t]*)return path\.join\(os\.homedir\(\), '\.desktop-commander-device', 'device\.json'\);$/m;
const patchedBody = (indent) =>
  `${indent}const dir = process.env.DCD_DEVICE_STATE_DIR || path.join(os.homedir(), '.desktop-commander-device-relay');\n` +
  `${indent}return path.join(dir, 'device.json');`;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const QUIET = flag('--quiet');
const log = (...a) => { if (!QUIET) console.log(...a); };
const die = (msg) => { console.error(`\n[prepare] ✗ ${msg}\n`); process.exit(1); };

/* ------------------------------------------------------------------ 路径 */

const ROOT = path.resolve(
  opt('--root') || process.env.DCD_DEVICE_ROOT || path.join(HERE, '_device')
);
const STATE_DIR = path.resolve(
  opt('--state-dir') || process.env.DCD_DEVICE_STATE_DIR || path.join(ROOT, 'state')
);
const DEST_NM = path.join(ROOT, 'node_modules');
const DEST_ENTRY = path.join(DEST_NM, ...PKG_SUB, ...ENTRY_IN_PKG);
const DEST_DEVICE_JS = path.join(DEST_NM, ...PKG_SUB, 'dist', 'remote-device', 'device.js');
const MARKER_FILE = path.join(ROOT, MARKER);

/* ------------------------------------------------------- 找本机现成的副本 */

function readVersion(nmDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(nmDir, ...PKG_SUB, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

const hasPayload = (nmDir) => fs.existsSync(path.join(nmDir, ...PKG_SUB, ...ENTRY_IN_PKG));

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/** 只在**本机**找：显式指定 > npx 缓存里所有 _npx\<hash>\node_modules。 */
function findSource() {
  const explicit = opt('--source') || process.env.DCD_SOURCE_NODE_MODULES;
  if (explicit) {
    const p = path.resolve(explicit);
    if (!hasPayload(p)) die(`--source 指向的目录里没有 dist/remote-device/device.js：\n  ${p}`);
    return { dir: p, version: readVersion(p) || 'unknown', origin: '显式指定' };
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const npxRoot = path.join(localAppData, 'npm-cache', '_npx');
  if (!fs.existsSync(npxRoot)) {
    die(
      '找不到本机 npx 缓存，也没有给 --source。\n' +
      `  期望位置：${npxRoot}\n` +
      '  如果你从没在这台机器上跑过官方 device，请先手动装一份，或用 --source 指向任一\n' +
      '  含 node_modules 的 @wonderwhy-er/desktop-commander 安装点。\n' +
      '  注意：本脚本**不会**替你联网下载。'
    );
  }

  const found = [];
  for (const hash of fs.readdirSync(npxRoot)) {
    const nm = path.join(npxRoot, hash, 'node_modules');
    if (hasPayload(nm)) found.push({ dir: nm, version: readVersion(nm) || 'unknown', origin: `npx 缓存 ${hash}` });
  }
  if (!found.length) die(`${npxRoot} 下没有任何可用的 @wonderwhy-er/desktop-commander 安装点。`);

  found.sort((a, b) => cmpVersion(b.version, a.version));
  return found[0];
}

/* -------------------------------------------------------------------- 复制 */

let copiedFiles = 0;
let copiedBytes = 0;
let lastTick = Date.now();

async function copyTree(src, dest) {
  const entries = await fsp.readdir(src, { withFileTypes: true });
  await fsp.mkdir(dest, { recursive: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isSymbolicLink()) {
      const target = await fsp.readlink(s).catch(() => null);
      if (target) await fsp.symlink(target, d).catch(() => {});
      continue;
    }
    if (e.isDirectory()) {
      await copyTree(s, d);
      continue;
    }
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fsp.copyFile(s, d);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    if (lastErr) {
      die(
        `复制失败：${s}\n  ${lastErr.message}\n` +
        '  如果报 EBUSY/EPERM，通常是杀软或某个进程正占用它 —— 本脚本只读源目录，\n' +
        '  不会动官方那台。稍后重跑即可（已复制的文件会被覆盖，幂等）。'
      );
    }
    copiedFiles++;
    try { copiedBytes += (await fsp.stat(d)).size; } catch {}
    if (!QUIET && Date.now() - lastTick > 250) {
      lastTick = Date.now();
      process.stdout.write(`\r  … 已复制 ${copiedFiles} 个文件 / ${(copiedBytes / 1048576).toFixed(0)} MB`);
    }
  }
}

/* ------------------------------------------------------------------ 打补丁 */

async function patchDeviceJs() {
  let src;
  try {
    src = await fsp.readFile(DEST_DEVICE_JS, 'utf8');
  } catch (err) {
    die(`读不到副本里的 device.js：${DEST_DEVICE_JS}\n  ${err.message}`);
  }

  if (src.includes('DCD_DEVICE_STATE_DIR')) return { alreadyPatched: true };

  const matches = src.match(new RegExp(OLD_RE.source, 'gm'));
  if (!matches) {
    die(
      '副本里找不到预期的那行状态路径，无法安全打补丁。\n' +
      `  文件：${DEST_DEVICE_JS}\n` +
      "  期望：return path.join(os.homedir(), '.desktop-commander-device', 'device.json');\n" +
      '  → 上游版本可能改了实现。别硬改，先人工看一眼这个文件。'
    );
  }
  if (matches.length !== 1) {
    die(`那行状态路径出现了 ${matches.length} 次（预期 1 次），停手以免改错地方。`);
  }

  const indent = matches[0].match(/^([ \t]*)/)[1];
  await fsp.writeFile(DEST_DEVICE_JS, src.replace(OLD_RE, patchedBody(indent)), 'utf8');
  return { alreadyPatched: false };
}

/* -------------------------------------------------------------- 静态校验 */

/**
 * 把补丁后的 getRemoteDeviceConfigPath() 函数体抽出来，用桩 process 求值。
 * 不 import 模块本身 —— device.js 经 capture.js 牵进 server.js，顶部有副作用。
 */
function evaluateConfigPath(fileSrc) {
  const m = fileSrc.match(/export function getRemoteDeviceConfigPath\(\)\s*\{([\s\S]*?)\n\}/);
  if (!m) die('补丁后仍无法从 device.js 里解析出 getRemoteDeviceConfigPath()。');
  const factory = new Function('path', 'os', 'process', m[1]);
  return factory;
}

function verify(deviceSrc) {
  const factory = evaluateConfigPath(deviceSrc);
  const realPath = path;

  // 情形 1：没有任何环境变量 → 必须落在 relay 专用目录，绝不能是官方那个
  const bare = factory(realPath, os, { env: {} });
  const expectBare = realPath.join(os.homedir(), '.desktop-commander-device-relay', 'device.json');
  if (bare !== expectBare) {
    die(`默认状态路径不对。\n  实际：${bare}\n  期望：${expectBare}`);
  }
  if (realPath.dirname(bare) === realPath.join(os.homedir(), '.desktop-commander-device')) {
    die('默认状态路径仍指向官方目录 —— 补丁无效。');
  }

  // 情形 2：给了 DCD_DEVICE_STATE_DIR → 必须听它
  const withEnv = factory(realPath, os, { env: { DCD_DEVICE_STATE_DIR: STATE_DIR } });
  const expectEnv = realPath.join(STATE_DIR, 'device.json');
  if (withEnv !== expectEnv) {
    die(`DCD_DEVICE_STATE_DIR 覆盖失效。\n  实际：${withEnv}\n  期望：${expectEnv}`);
  }

  return { fallback: bare, active: withEnv };
}

/* -------------------------------------------------------------------- main */

// check-only 只看已有副本，不需要源：这样在 npx 缓存被清掉的机器上也能自检。
if (flag('--check-only')) {
  log('');
  log('  relay-device · 副本自检');
  log('  ────────────────────────────────────────────────');
  log(`  目标    : ${ROOT}`);
  if (!hasPayload(DEST_NM)) {
    die(`副本还没准备：\n  ${DEST_NM}\n  → 去掉 --check-only 跑一次，或直接运行 start-device.cmd。`);
  }
  const { fallback, active } = verify(fs.readFileSync(DEST_DEVICE_JS, 'utf8'));
  let m = null;
  try { m = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8')); } catch {}
  log('');
  log('  ✓ 校验通过');
  log(`    版本   : v${m ? m.version : '(无记录)'}`);
  log(`    入口   : ${DEST_ENTRY}`);
  log(`    默认   : ${fallback}`);
  log(`    实际用 : ${active}`);
  log('');
  process.exit(0);
}

const src = findSource();
const srcVersion = src.version;

log('');
log('  relay-device · 本机副本准备');
log('  ────────────────────────────────────────────────');
log(`  源      : ${src.dir}`);
log(`            v${srcVersion}  (${src.origin})`);
log(`  目标    : ${ROOT}`);
log(`  状态文件: ${path.join(STATE_DIR, 'device.json')}`);
log('');

let marker = null;
try { marker = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8')); } catch {}

const ready =
  !flag('--force') &&
  hasPayload(DEST_NM) &&
  marker &&
  marker.version === srcVersion &&
  marker.source === src.dir;

if (ready) {
  const { fallback, active } = verify(fs.readFileSync(DEST_DEVICE_JS, 'utf8'));
  log(`  ✓ 副本已就绪（v${srcVersion}），跳过复制`);
  log(`    默认   : ${fallback}`);
  log(`    实际用 : ${active}`);
  log('');
  process.exit(0);
}

if (flag('--force') || (hasPayload(DEST_NM) && marker && marker.version !== srcVersion)) {
  // 只删我们自己管的那个 node_modules 目录，删前确认它确实在 ROOT 里面
  const guard = path.relative(ROOT, DEST_NM);
  if (guard.startsWith('..') || path.isAbsolute(guard)) die(`拒绝删除 ${DEST_NM}：它不在 ${ROOT} 之内。`);
  log(`  重新准备：清理旧副本 ${DEST_NM}`);
  await fsp.rm(DEST_NM, { recursive: true, force: true });
}

const t0 = Date.now();
log(`  复制 node_modules（本地复制，不联网）…`);
await copyTree(src.dir, DEST_NM);
if (!QUIET && copiedFiles) process.stdout.write('\r' + ' '.repeat(60) + '\r');
log(`  复制完成：${copiedFiles} 个文件 / ${(copiedBytes / 1048576).toFixed(1)} MB / ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const { alreadyPatched } = await patchDeviceJs();
log(alreadyPatched ? '  补丁：已存在，跳过' : '  补丁：已写入 DCD_DEVICE_STATE_DIR 覆盖点');

await fsp.mkdir(STATE_DIR, { recursive: true });
const { fallback, active } = verify(fs.readFileSync(DEST_DEVICE_JS, 'utf8'));

await fsp.writeFile(
  MARKER_FILE,
  JSON.stringify(
    { version: srcVersion, source: src.dir, preparedAt: new Date().toISOString(), entry: DEST_ENTRY },
    null,
    2
  ) + '\n',
  'utf8'
);

log('');
log('  ✓ 校验通过');
log(`    入口   : ${DEST_ENTRY}`);
log(`    默认   : ${fallback}`);
log(`    实际用 : ${active}`);
log('');
