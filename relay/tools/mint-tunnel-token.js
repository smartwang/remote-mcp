#!/usr/bin/env node
/**
 * 给隧道（tunnel-client）签发一枚调用令牌，并写成 MCP_EXTRA_HEADERS 能直接引用的文件。
 *
 * 为什么需要这个工具：
 *
 * ChatGPT connector 的「身份验证」下拉里**没有 API key 这一档**，只有
 * OAuth / 无身份验证 / 混合。静态凭据的设计位置不在 connector UI，而在
 * tunnel-client 的 `mcp.extra-headers` —— 由 tunnel-client 在
 * 「它 → MCP server」这最后一跳注入，官方文档明确它**不经过 OpenAI 控制面**
 * （`tunnel-client-v0.0.14-all/docs/architecture.md` 的 auth/data flow 矩阵）。
 *
 * 于是接入形态是：
 *   1. connector 的身份验证选「无身份验证」（否则 connector 转发来的头会
 *      按“后应用者胜”覆盖掉这个静态头）；
 *   2. tunnel-client 用 MCP_EXTRA_HEADERS 注入固定的 `Authorization: Bearer rmcp_…`；
 *   3. 中继照常按令牌解析租户。
 *
 * 用法：
 *   node tools/mint-tunnel-token.js                          # 给 OWNER_EMAIL 签一枚，写默认路径
 *   node tools/mint-tunnel-token.js --email a@b.c --label x
 *   node tools/mint-tunnel-token.js --expires-days 90
 *   node tools/mint-tunnel-token.js --out /tmp/tok.txt
 *
 * 输出文件的内容是**完整的头值**（`Bearer rmcp_…`），因为
 * `file:` 引用是整值匹配 —— 写 `Authorization: Bearer file:/path` 会被当成
 * 字面量，必须让文件自己带上前缀。内容末尾可以有且仅有一个换行，
 * tunnel-client 会裁掉一个行尾（`trimOneTrailingLineEnding`）。
 *
 * ⚠️ 明文只在本次运行出现。文件已由 .gitignore 覆盖（docker/secrets/*）。
 */

const fs = require('node:fs');
const path = require('node:path');

const cfg = require('../src/config');
const supa = require('../src/supa');
const tokens = require('../src/tokens');

function parseArgs(argv) {
  const out = {
    email: cfg.OWNER_EMAIL,
    label: 'chatgpt-tunnel',
    expiresDays: null,
    out: path.resolve(__dirname, '..', '..', 'docker', 'secrets', 'relay-mcp-token.txt'),
    print: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} 需要一个值`);
      i += 1;
      return v;
    };
    if (a === '--email') out.email = next();
    else if (a === '--label') out.label = next();
    else if (a === '--expires-days') out.expiresDays = Number(next());
    else if (a === '--out') out.out = path.resolve(next());
    else if (a === '--print') out.print = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`未知参数 ${a}`);
  }
  return out;
}

function usage() {
  console.log(
    [
      '用法：node tools/mint-tunnel-token.js [选项]',
      '',
      '  --email <邮箱>        令牌归属账号（默认 RELAY_OWNER_EMAIL）',
      '  --label <标签>        令牌标签，便于在控制台辨认（默认 chatgpt-tunnel）',
      '  --expires-days <n>    过期天数（默认不过期）',
      '  --out <路径>          输出文件（默认 ../../docker/secrets/relay-mcp-token.txt）',
      '  --print               把明文也打到 stdout（默认只写文件，避免进日志）',
      '',
      '输出文件内容是完整头值 `Bearer rmcp_<prefix>_<secret>`，供',
      'MCP_EXTRA_HEADERS="Authorization: file:/run/secrets/relay_mcp_token" 引用。',
    ].join('\n')
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  const user = await supa.auth.findByEmail(args.email);
  if (!user?.id) {
    console.error(`✗ 找不到账号 ${args.email}。先用 /console 注册，或改用 --email 指定已存在的账号。`);
    process.exitCode = 1;
    return;
  }

  const { token, row } = await tokens.create(user.id, {
    label: args.label,
    expiresInDays: args.expiresDays,
    ip: 'mint-tunnel-token',
  });

  // 自检：写下去的值必须能被中继自己解析回同一枚令牌。
  // 历史上踩过“凭据生成后约一半概率解析失败”的坑，这里当场断言。
  const parsed = tokens.parse(token);
  if (!parsed || parsed.prefix !== row.prefix) {
    console.error('✗ 生成自检失败：令牌无法被 parse() 还原，未写入文件。');
    process.exitCode = 1;
    return;
  }

  const headerValue = `Bearer ${token}`;
  let wrote = false;
  try {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${headerValue}\n`, { mode: 0o600 });
    wrote = true;
  } catch (err) {
    console.error(`⚠️ 写入 ${args.out} 失败：${err.message}`);
  }

  console.log('✓ 令牌已签发');
  console.log(`  归属账号   ${args.email}`);
  console.log(`  租户       ${user.id}`);
  console.log(`  前缀       ${row.prefix}   ← 控制台里靠这个辨认/吊销`);
  console.log(`  标签       ${args.label}`);
  console.log(`  过期       ${row.expires_at || '不过期'}`);
  if (wrote) {
    console.log(`  明文已写入 ${args.out}`);
    console.log('');
    console.log('  ⚠️ 明文只此一次。需要再拿一份就重新签发，不要试图从库里读。');
    console.log('  接下来：docker/.env 里设');
    console.log('      MCP_EXTRA_HEADERS=Authorization: file:/run/secrets/relay_mcp_token');
    console.log('  然后 docker compose up -d 重建容器。');
  } else {
    console.log('  明文（仅本次显示，请立刻保存到安全位置）：');
    console.log(`      ${headerValue}`);
  }
  if (args.print || !wrote) console.log(`\n  明文：${headerValue}`);
}

main().catch((err) => {
  console.error('✗ 出错：', err.message);
  process.exitCode = 1;
});
