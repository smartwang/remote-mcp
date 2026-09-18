#!/usr/bin/env node
/**
 * 为自托管 Supabase 生成 .env。
 *
 * 复刻官方 utils/generate-keys.sh 的算法（不是自己发明的格式）：
 *   jwt_secret = openssl rand -base64 30
 *   header     = {"alg":"HS256","typ":"JWT"}
 *   payload    = {"role":"<role>","iss":"supabase","iat":<now>,"exp":<now + 5*365d>}
 *   token      = base64url(header) . base64url(payload) . base64url(HMAC-SHA256(signed, secret))
 *
 * 与官方一致的还有：不启用非对称密钥（JWT_KEYS/JWT_JWKS 留空），
 * 于是 Auth / PostgREST / Realtime 全部回落到 HS256 的 JWT_SECRET。
 * device 侧的 supabase-js 拿 ANON_KEY 当 publishable key，兼容。
 *
 * 用法：
 *   node tools/gen-env.js            # 生成 .env（已存在则拒绝覆盖，除非 --force）
 *   node tools/gen-env.js --force
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXAMPLE = path.join(ROOT, '.env.example');
const TARGET = path.join(ROOT, '.env');

const force = process.argv.includes('--force');

// ---------------------------------------------------------------------------
// 端口规划
//
// 宿主上已被占用的：8080（CDJ public-api）、18080（tunnel 健康端口/UI）、
// 18090（windows MCP server）。这里全部避开。
// ---------------------------------------------------------------------------

const PORTS = {
  API_GW_HTTP_PORT: '8000',            // Envoy 网关，device 侧的 supabaseUrl 就打这里
  POSTGRES_PORT: '5432',               // 注意：这个值同时是容器内 PGPORT，不能改
  POOLER_PROXY_PORT_TRANSACTION: '6543',
};

const b64 = (buf) => Buffer.from(buf).toString('base64');
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (n) => crypto.randomBytes(n).toString('hex');

function jwt(secret, role) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 5 * 365 * 24 * 3600; // 官方同款：5 年
  const header = JSON.stringify({ alg: 'HS256', typ: 'JWT' });
  const payload = JSON.stringify({ role, iss: 'supabase', iat, exp });
  const signed = `${b64url(header)}.${b64url(payload)}`;
  const sig = b64url(crypto.createHmac('sha256', secret).update(signed).digest());
  return `${signed}.${sig}`;
}

function main() {
  if (!fs.existsSync(EXAMPLE)) {
    console.error(`❌ 找不到 ${EXAMPLE}。先把官方 docker/.env.example 复制过来。`);
    process.exit(1);
  }
  if (fs.existsSync(TARGET) && !force) {
    console.error(`❌ ${TARGET} 已存在。要重新生成请加 --force（会作废旧数据：旧 JWT_SECRET 变了，旧 token 全失效）。`);
    process.exit(1);
  }

  const jwtSecret = b64(crypto.randomBytes(30));
  const anonKey = jwt(jwtSecret, 'anon');
  const serviceRoleKey = jwt(jwtSecret, 'service_role');

  const values = {
    // —— 密码与密钥 ——
    POSTGRES_PASSWORD: hex(24),
    JWT_SECRET: jwtSecret,
    ANON_KEY: anonKey,
    SERVICE_ROLE_KEY: serviceRoleKey,
    DASHBOARD_USERNAME: 'supabase',
    DASHBOARD_PASSWORD: hex(16),
    SECRET_KEY_BASE: b64(crypto.randomBytes(48)),
    REALTIME_DB_ENC_KEY: hex(8),
    VAULT_ENC_KEY: hex(16),
    PG_META_CRYPTO_KEY: b64(crypto.randomBytes(24)),
    LOGFLARE_PUBLIC_ACCESS_TOKEN: b64(crypto.randomBytes(24)),
    LOGFLARE_PRIVATE_ACCESS_TOKEN: b64(crypto.randomBytes(24)),
    POOLER_TENANT_ID: 'remote-mcp',
    ...PORTS,
  };

  // 显式清空：走 legacy HS256 单密钥路径，不启用非对称密钥。
  const blanks = ['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'JWT_KEYS', 'JWT_JWKS'];

  let text = fs.readFileSync(EXAMPLE, 'utf8');
  const applied = [];
  const missing = [];

  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) {
      text = text.replace(re, `${key}=${value}`);
      applied.push(key);
    } else {
      text = `${text.trimEnd()}\n${key}=${value}\n`;
      missing.push(key);
    }
  }
  for (const key of blanks) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) {
      text = text.replace(re, `${key}=`);
      applied.push(`${key}(清空)`);
    }
  }

  fs.writeFileSync(TARGET, text, { mode: 0o600 });

  console.log(`✅ 已写入 ${TARGET}`);
  console.log('');
  console.log(`   覆盖 ${applied.length} 个键：${applied.join(', ')}`);
  if (missing.length) console.log(`   ⚠ .env.example 里没找到、已追加：${missing.join(', ')}`);
  console.log('');
  console.log('   ---- 中继服务要用的两个值（从 .env 读，别硬编码）----');
  console.log(`   SUPABASE_URL       = http://127.0.0.1:${PORTS.API_GW_HTTP_PORT}`);
  console.log(`   ANON_KEY           = ${anonKey.slice(0, 32)}…  (长度 ${anonKey.length})`);
  console.log(`   SERVICE_ROLE_KEY   = ${serviceRoleKey.slice(0, 32)}…  (长度 ${serviceRoleKey.length})`);
  console.log('');
  console.log('   ---- 验签自检 ----');
  const [h, p, s] = anonKey.split('.');
  const expect = b64url(crypto.createHmac('sha256', jwtSecret).update(`${h}.${p}`).digest());
  console.log(`   anon key 签名自校验: ${expect === s ? 'PASS' : 'FAIL'}`);
  console.log(`   payload: ${Buffer.from(p, 'base64url').toString('utf8')}`);
}

main();
