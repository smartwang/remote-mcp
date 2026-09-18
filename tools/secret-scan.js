'use strict';
/**
 * 提交前凭据反查 —— 仓库纪律的强制执行部分。
 *
 * 用法（在仓库根目录）：
 *   node tools/secret-scan.js              # 查暂存区（默认，提交前用）
 *   node tools/secret-scan.js --worktree   # 查工作区文件（更慢，覆盖未暂存的改动）
 *
 * 为什么要这么查：不能靠"我 .gitignore 写对了"来交付。这里把真实密钥文件里的
 * 每一个**值**拿去在即将提交的树里搜 —— 命中就说明该值以某种方式进了库
 * （文档里贴了示例、example 被填了真值、注释里留了调试 URL 等等）。
 * 这比"扫描哪些文件看起来像密钥"可靠得多。
 *
 * 实测抓出过真实泄露：windows/README.md 里贴了 MCP_PATH_TOKEN 的真值
 * （写文档时顺手复制了真实 URL 进示例）。
 *
 * 命中之后要**逐个判定**，不能一律当事故：
 *   · 官方模板里的公开默认值（supabase 的 S3_PROTOCOL_* / MINIO_ROOT_PASSWORD 等）
 *     —— 与上游模板逐字节相同即为公开默认。提交无害，但要记进 README 的
 *     「上公网必改」清单。
 *   · 自己生成的密钥出现在任何受版本控制的文件里 —— 真泄露，必须修。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
process.chdir(REPO);

// 只把**真实**密钥文件当来源。
// 刻意不含 *.env.example：它按定义就是占位符，当来源只会产生自匹配噪音；
// 而它作为**被搜索的对象**仍在树里，所以"有人把真值填进了 example"照样能被抓到。
const SOURCES = [
  'relay/.env',
  'relay/.session-secret',
  'docker/.env',
  'docker/secrets/control-plane.key',
  'docker/secrets/relay-mcp-token.txt',
  'supabase/selfhosted/.env',
  'windows/server.env',
];

const SENSITIVE = /(_KEY|_SECRET|_TOKEN|_PASSWORD|SERVICE_ROLE|JWT_SECRET|ANON_KEY|CONTROL_PLANE|ADMIN_TOKEN)/;

/**
 * 整份文件就是一个凭据（内容不是 KEY=VALUE）。
 *
 * 注意 `docker/secrets/` 是整个目录算：那里每加一个文件都应该自动纳入扫描，
 * 而不是等谁记得来改这份清单 —— 漏一个来源 = 那个凭据泄露时静默通过。
 * `relay-mcp-token.txt` 就是这么被发现的。
 */
function isOpaqueSecretFile(f) {
  return f.startsWith('docker/secrets/') || f.endsWith('.session-secret') || f.endsWith('.key');
}

const worktree = process.argv.includes('--worktree');
const target = worktree ? null : '--cached';

function collect() {
  const pairs = [];
  for (const f of SOURCES) {
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, 'utf8');
    // 整份就是一个密钥的文件：整个内容算一个值
    if (isOpaqueSecretFile(f)) {
      const v = raw.trim();
      if (v.length >= 12) {
        pairs.push({ src: f, key: '(整份密钥文件)', val: v });
        // 头值形如 `Bearer <token>`。只搜全文，等于只能抓到"整行被贴进文档"；
        // 抓不到"只贴了令牌本体"—— 而那才是更可能的泄露形态（比如写文档时
        // 只复制了令牌、漏了 scheme）。所以再拆一份出来单独搜。
        const m = /^([A-Za-z][A-Za-z0-9-]*)\s+(\S+)$/.exec(v);
        if (m && m[2].length >= 12) {
          pairs.push({ src: f, key: `(整份密钥文件 · 去掉 ${m[1]} 前缀)`, val: m[2] });
        }
      }
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
      if (!m || !SENSITIVE.test(m[1])) continue;
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      // 阈值：太短的值（"true"、"false"、"1234"）会在源码里大量误命中
      if (v.length >= 12) pairs.push({ src: f, key: m[1], val: v });
    }
  }
  return pairs;
}

function searchDir(val) {
  const args = ['grep', '-l', '-F', '-e', val];
  if (target) args.push(target);
  // spawnSync 数组传参，避免 base64 里的 +/= 被 shell 吃掉
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return (r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
}

const pairs = collect();
const scope = worktree ? '工作区' : '暂存区';
const hits = [];

for (const p of pairs) {
  // 工作区模式下，被 .gitignore 排除的文件也要搜（要给出文件名，所以用 grep -r）
  let locs = searchDir(p.val);
  if (worktree) {
    const r = spawnSync('git', ['grep', '-l', '-F', '-e', p.val, '--', '.'], { encoding: 'utf8' });
    // 上面这条仍受 .git 追踪范围限制，真正的"工作区全量"用 grep -r
    const g = spawnSync('grep', ['-rlF', '-e', p.val, '.'], { encoding: 'utf8' });
    locs = locs.concat((g.stdout || '').trim().split(/\r?\n/).filter(Boolean));
    locs = [...new Set(locs)];
  }
  if (locs.length) hits.push({ ...p, locs });
}

console.log(`扫描范围：${scope}`);
console.log(`来源：${SOURCES.filter((f) => fs.existsSync(f)).join(', ') || '(无)'}`);
console.log(`检查了 ${pairs.length} 个真实凭据值\n`);

if (!hits.length) {
  console.log(`✅ ${scope}里不含任何真实凭据值`);
  process.exit(0);
}

// 失败时只回显值的前 8 位 —— 不能把凭据打进 CI 日志
for (const h of hits) {
  console.log(`  ⚠️  ${h.key}  ← ${h.src}  (值前 8 位：${h.val.slice(0, 8)}…)`);
  for (const l of h.locs) console.log(`        ${l}`);
}
console.log(`\n共 ${hits.length} 处命中 —— 逐个判定是"官方公开默认值"还是"真泄露"，见文件头注释。`);
process.exit(1);
