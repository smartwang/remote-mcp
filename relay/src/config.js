'use strict';
/**
 * 中继服务配置。
 *
 * 密钥来源优先级：process.env > relay/.env > ../supabase/selfhosted/.env
 * 直接从 Supabase 的 .env 兜底读取，是为了避免"两处各存一份 ANON_KEY
 * 然后悄悄不一致"——那类问题排查起来非常费劲。
 */

const fs = require('node:fs');
const path = require('node:path');

const RELAY_ROOT = path.resolve(__dirname, '..');
const SUPA_ENV = path.resolve(RELAY_ROOT, '..', 'supabase', 'selfhosted', '.env');

/** 极简 dotenv 解析：只支持 KEY=VALUE 与 # 注释，不处理多行。 */
function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const relayEnv = parseEnvFile(path.join(RELAY_ROOT, '.env'));
const supaEnv = parseEnvFile(SUPA_ENV);

function pick(key) {
  const fromProcess = process.env[key];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  const fromRelay = relayEnv[key];
  if (fromRelay !== undefined && fromRelay !== '') return fromRelay;
  const fromSupa = supaEnv[key];
  if (fromSupa !== undefined && fromSupa !== '') return fromSupa;
  return undefined;
}

// 18080（tunnel 健康/UI）、18090（windows MCP server）已占；
// 8787 也不行 —— 实测被 com.docker.backend.exe（Docker Desktop 的端口转发器）占着。
const PORT = Number(pick('RELAY_PORT') || 18086);
const HOST = pick('RELAY_HOST') || '127.0.0.1';

// 中继自己访问 Supabase 用这个地址（容器里跑就是 supabase-envoy:8000）。
const SUPABASE_URL = (pick('SUPABASE_URL') || 'http://127.0.0.1:8000').replace(/\/+$/, '');

// 下发给 device 的地址。device 在别的机器上时，这个值必须是 device 能访问到的 URL，
// 所以允许和 SUPABASE_URL 分开配。
const PUBLIC_SUPABASE_URL = (pick('PUBLIC_SUPABASE_URL') || SUPABASE_URL).replace(/\/+$/, '');

// 中继自己对外暴露的地址，用于拼 device flow 的验证链接。
const RELAY_PUBLIC_URL = (pick('RELAY_PUBLIC_URL') || `http://${HOST}:${PORT}`).replace(/\/+$/, '');

const ANON_KEY = pick('ANON_KEY');
const SERVICE_ROLE_KEY = pick('SERVICE_ROLE_KEY');

// 单租户阶段：device flow 建立/复用的那个账号。多租户要用真实的用户体系替换。
const OWNER_EMAIL = pick('RELAY_OWNER_EMAIL') || 'device@remote-mcp.local';
const OWNER_PASSWORD = pick('RELAY_OWNER_PASSWORD') || 'remote-mcp-device-owner';

// 本地联调用：跳过浏览器点"批准"，/device/start 直接置为已批准。
// 生产必须为 false。
const AUTO_APPROVE = (pick('DEVICE_FLOW_AUTO_APPROVE') || 'false') === 'true';

// 对齐 device 侧的调用超时（remote-channel.ts 注释里写明服务端契约是 5 分钟）。
const CALL_TIMEOUT_MS = Number(pick('CALL_TIMEOUT_MS') || 300000);
const CALL_POLL_INTERVAL_MS = Number(pick('CALL_POLL_INTERVAL_MS') || 400);

// device flow 参数
const DEVICE_CODE_TTL_S = Number(pick('DEVICE_CODE_TTL_S') || 300);
const DEVICE_POLL_INTERVAL_S = Number(pick('DEVICE_POLL_INTERVAL_S') || 2);

// 设备视为"fresh"的窗口，用于挑目标设备。与 schema 里的判定口径保持一致：
// 具备广播能力的设备心跳间隔是 5 分钟，窗口必须明显大于它。
const DEVICE_FRESH_MS = Number(pick('DEVICE_FRESH_MS') || 15 * 60 * 1000);

const CATALOG_PATH = pick('CATALOG_PATH') || path.join(RELAY_ROOT, 'catalog.json');

// 可选：给 /mcp 端点加一条路径令牌（放 URL 路径里，因为 ChatGPT 侧的
// Authorization 头不一定可控）。留空则不校验。
const MCP_PATH_TOKEN = pick('MCP_PATH_TOKEN') || '';

function validate() {
  const problems = [];
  if (!ANON_KEY) problems.push('ANON_KEY 缺失（relay/.env 或 supabase/selfhosted/.env）');
  if (!SERVICE_ROLE_KEY) problems.push('SERVICE_ROLE_KEY 缺失');
  if (!fs.existsSync(CATALOG_PATH)) {
    problems.push(`工具目录不存在：${CATALOG_PATH}（先跑 node tools/gen-catalog.js）`);
  }
  return problems;
}

module.exports = {
  RELAY_ROOT,
  SUPA_ENV,
  PORT,
  HOST,
  SUPABASE_URL,
  PUBLIC_SUPABASE_URL,
  RELAY_PUBLIC_URL,
  ANON_KEY,
  SERVICE_ROLE_KEY,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  AUTO_APPROVE,
  CALL_TIMEOUT_MS,
  CALL_POLL_INTERVAL_MS,
  DEVICE_CODE_TTL_S,
  DEVICE_POLL_INTERVAL_S,
  DEVICE_FRESH_MS,
  CATALOG_PATH,
  MCP_PATH_TOKEN,
  validate,
};
