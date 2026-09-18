#!/usr/bin/env node
/**
 * create-account.js —— 建 / 改一个控制台账号。
 *
 * 为什么需要它
 * ------------
 * `RELAY_ALLOW_SIGNUP=false`（生产默认）时，服务端**没有任何**建号路径：
 *
 *   · `/signup` 直接 403；
 *   · `supa.auth.ensureUser()` 唯一的调用点在 `deviceflow.js` 的 AUTO_APPROVE
 *     分支里，而那个开关只该在本地联调打开。
 *
 * 而登录控制台是 OAuth 授权流程的**必经一步**（ChatGPT 首次调用工具 → 浏览器
 * 打开授权页 → 登录 → 同意）。于是"全新部署 + 关闭注册"会死锁：没有任何账号
 * 可以登录，而登录又是除建号外唯一的入口。
 *
 * 现象具有误导性 —— 浏览器停在登录页，看起来像"密码错了"，其实是"账号不存在"。
 * 所以这里给出一条明确的出路，而不是让运维去猜。
 *
 * 为什么不干脆在启动时自动建
 * --------------------------
 * 因为 `RELAY_OWNER_PASSWORD` 有默认值（`remote-mcp-device-owner`）。启动即自动
 * 建号 = 用一个人人皆知的密码开出一个管理员入口。宁可多一步手工操作。
 * （启动时只做**检测**并打印提示，见 `src/index.js` 的 `main()`。）
 *
 * 用法
 * ----
 *   # 建号（幂等：已存在则**不改密码**，只回报 ok）
 *   node tools/create-account.js
 *   node tools/create-account.js --email me@x.io --password '...'
 *
 *   # 改已存在账号的密码（ensureUser 不会动密码，要改必须显式说）
 *   node tools/create-account.js --email me@x.io --set-password --password '...'
 *
 *   # 口令从标准输入读，不进 shell 历史 / 不进 ps
 *   printf '%s' 'my-password' | node tools/create-account.js --email me@x.io --password-stdin
 *
 *   # 容器里跑（推荐 —— 密钥、config 都是现成的）
 *   docker compose exec -T relay node tools/create-account.js --set-password --password-stdin < pwd.txt
 *
 * 不传 --email / --password 时，用 RELAY_OWNER_EMAIL / RELAY_OWNER_PASSWORD。
 */

const cfg = require('../src/config');
const supa = require('../src/supa');

const DEFAULT_PW = 'remote-mcp-device-owner';

function parseArgs(argv) {
  const out = { email: null, password: null, passwordStdin: false, setPassword: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--email') out.email = argv[++i];
    else if (a === '--password') out.password = argv[++i];
    else if (a === '--password-stdin') out.passwordStdin = true;
    else if (a === '--set-password') out.setPassword = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`未知参数：${a}（--help 看用法）`);
      process.exit(2);
    }
  }
  return out;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')));
    process.stdin.on('error', reject);
  });
}

const HELP = `建 / 改一个控制台账号。

  node tools/create-account.js [--email <邮箱>] [--password <口令>]
  node tools/create-account.js --email <邮箱> --set-password --password <新口令>
  node tools/create-account.js --email <邮箱> --set-password --password-stdin
  node tools/create-account.js --password-stdin     # 口令从标准输入读，不进 shell 历史

不传 --email/--password 时用 RELAY_OWNER_EMAIL / RELAY_OWNER_PASSWORD。
后者的默认值是公开的 ${DEFAULT_PW} —— 真部署请务必换掉。

建号是幂等的：账号已存在时**不会**改密码，只回报 ok。要改密码必须显式
加 --set-password。这样"重跑一次脚本"不会意外把正在用的口令换掉。

账号建好后：浏览器登录 <RELAY_PUBLIC_URL>/console，再去 /device 批准设备。
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const email = args.email || cfg.OWNER_EMAIL;
  let password = args.password;
  if (args.passwordStdin) password = await readStdin();
  if (!password) password = cfg.OWNER_PASSWORD;

  if (!email) {
    console.error('❌ 没有邮箱：传 --email，或设置 RELAY_OWNER_EMAIL。');
    process.exit(2);
  }
  if (!password) {
    console.error('❌ 没有口令：传 --password / --password-stdin，或设置 RELAY_OWNER_PASSWORD。');
    process.exit(2);
  }
  if (password === DEFAULT_PW) {
    console.warn(`⚠ 口令是公开的默认值（${DEFAULT_PW}）。`);
    console.warn('   这个账号能登录控制台、自己签发 /mcp 令牌、批准设备接入。');
    console.warn('   生产环境请换掉：--set-password --password <高熵口令>');
  }

  console.log(`Supabase   ${cfg.SUPABASE_URL}`);
  console.log(`邮箱       ${email}`);

  // 先查是否已存在 —— 决定这次是"建"还是"改"，也决定要不要拦下"重跑改密"。
  let existing = null;
  try {
    existing = await supa.auth.findByEmail(email);
  } catch (err) {
    console.error(`\n❌ 查询账号失败：${err.message}`);
    if (err.status === 401 || err.status === 403) {
      console.error('   401/403 表示 SUPABASE_SECRET_KEY 不对（要用 sb_secret_… / service_role）。');
    } else if (err.status === 404 || /could not find the table|PGRST/i.test(err.message)) {
      console.error('   看起来表还没建 —— 先跑 ./migrate.sh。');
    }
    process.exit(1);
  }

  let user;
  let action;
  try {
    if (existing && args.setPassword) {
      action = '已存在 → 按 --set-password 更新口令';
      user = await supa.auth.setPassword(existing.id, password);
    } else if (existing) {
      action = '已存在 → 未改动（要改口令加 --set-password）';
      user = existing;
    } else {
      action = '不存在 → 新建';
      user = await supa.auth.ensureUser(email, password);
    }
  } catch (err) {
    console.error(`\n❌ 操作失败：${err.message}`);
    process.exit(1);
  }

  if (!user?.id) {
    console.error('❌ GoTrue 返回里没有 user.id，无法确认结果。');
    process.exit(1);
  }

  const confirmed = Boolean(user.email_confirmed_at || user.confirmed_at);
  console.log(`结果       ${action}`);
  console.log(`\n✅ 账号可用  id=${user.id}`);
  console.log(`   邮箱已确认：${confirmed ? '是' : '否'}`);
  if (!confirmed) {
    console.warn('   ⚠ 未确认的邮箱可能无法登录 —— 用 --set-password 重跑一次（它会带 email_confirm:true）。');
  }

  console.log('\n下一步：');
  console.log(`   1. 浏览器登录   ${cfg.RELAY_PUBLIC_URL}/console`);
  console.log(`   2. 自检口令是否就是这个（可选）：`);
  console.log(`      docker compose exec -T relay node -e "require('./src/supa').auth.signInWithPassword('${email}', '<口令>').then(s=>console.log('登录 OK', s.access_token.length)).catch(e=>console.log('FAIL', e.message))"`);
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
