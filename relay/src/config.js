'use strict';
/**
 * 中继服务配置。
 *
 * 取值优先级：`<KEY>_FILE` > process.env > relay/.env > ../supabase/selfhosted/.env
 * 最后一级直接从 Supabase 的 .env 兜底读取，是为了避免"两处各存一份 ANON_KEY
 * 然后悄悄不一致"——那类问题排查起来非常费劲。**那一级只在源码目录里成立**，
 * 容器部署中考的是前两级（见下）。
 *
 * `<KEY>_FILE` 是 Docker 惯例（同 `POSTGRES_PASSWORD_FILE`）：值从文件读，
 * **不经过环境变量**，因此不会出现在 `docker inspect` 的明文里。容器部署走这条。
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

/** `<变量名>_FILE` 读取失败的记录，交给 validate() 统一报出，而不是在这里抛。 */
const fileReadErrors = [];

/**
 * 从文件读一个值。trim 是必要的：`printf '%s\n'` 与 docker secret 都会带尾换行，
 * 而 Bearer 令牌/nonce 里多一个 \n 会变成一个极难定位的鉴权失败。
 */
function readSecretFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    fileReadErrors.push(`<变量名>_FILE 指向的 ${file} 读取失败：${err.message}`);
    return undefined;
  }
}

/**
 * 允许走 `<KEY>_FILE` 读取的键。
 *
 * **刻意用白名单，而不是对每个键都拼 `_FILE`。** 泛化实现会撞车：
 * `RELAY_SESSION_SECRET` 本身是一个键，而 `RELAY_SESSION_SECRET_FILE` 是另一个
 * 语义完全不同的键 —— 后者是会话密钥的**读写路径**，文件不存在时要现场生成。
 * 泛化实现会把后者误读成"从这个文件取密钥"，于是在首次启动、文件还没生成时
 * 直接把服务判为配置不完整。（实测踩过，容器首次启动必炸。）
 *
 * 所以只有真正需要"从文件读一个固定密钥"的键列在这里。新增密钥时记得加。
 */
const FILE_BACKED_KEYS = new Set(['ANON_KEY', 'SERVICE_ROLE_KEY', 'RELAY_ADMIN_TOKEN']);

function pick(key) {
  if (FILE_BACKED_KEYS.has(key)) {
    const fileRef = process.env[`${key}_FILE`];
    if (fileRef) return readSecretFile(fileRef);
  }
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

// 单租户阶段的遗留默认值。多租户下只在"引导第一个管理员账号"时用到
// （见 README「迁移到多租户」），不再是所有设备的归属账号。
const OWNER_EMAIL = pick('RELAY_OWNER_EMAIL') || 'device@remote-mcp.local';
const OWNER_PASSWORD = pick('RELAY_OWNER_PASSWORD') || 'remote-mcp-device-owner';

// 本地联调用：跳过浏览器点"批准"，/device/start 直接置为已批准。
// 生产必须为 false。
const AUTO_APPROVE = (pick('DEVICE_FLOW_AUTO_APPROVE') || 'false') === 'true';

/* ------------------------------------------------------------ 多租户鉴权 */

/*
 * 这里原本有一个 RELAY_REQUIRE_AUTH 开关：false 时 /mcp 不校验令牌，把请求
 * 归到遗留的单租户 owner 账号上，用来"先跑着、后收紧"。
 *
 * 它已经被**删除**，不是被改成默认 true。理由是它解决的问题不存在：
 *
 *   · 它之所以看似必要，是因为当时的凭据是"一整条隧道注入的静态令牌"——
 *     换凭据必须重新部署，所以需要一段两套并存的灰度期。
 *   · 换成 OAuth 2.1 之后，凭据是**协商式**获得的：没带令牌就回 401 +
 *     WWW-Authenticate，客户端据此自己去走授权流程。不存在"要么全断、
 *     要么全放开"的两难，也就没有灰度的必要。
 *   · 而那条匿名回落路径本身是有害的：它让"忘了打开开关"变成一种
 *     静默的可被匿名调用的状态，且调用全都归到同一个账号上。
 *
 * 现在的行为是唯一且明确的：/mcp 只有一种身份来源 —— Authorization 头里的
 * 有效令牌（OAuth 签发的，或控制台人工创建的）。没有令牌就是 401。
 */

/**
 * 管理员令牌。持有者可看到**所有**租户的设备与审计。
 * 留空则管理员面完全关闭（404），这是更安全的默认值。
 */
const ADMIN_TOKEN = pick('RELAY_ADMIN_TOKEN') || '';

/** 会话 cookie 的签名密钥。留空则首次启动自动生成并写入 .session-secret。 */
const SESSION_SECRET = pick('RELAY_SESSION_SECRET') || '';

const SESSION_TTL_S = Number(pick('RELAY_SESSION_TTL_S') || 7 * 24 * 3600);

/** cookie 是否只在 HTTPS 下发送。本地 http 调试必须关，上公网必须开。 */
const COOKIE_SECURE = (pick('RELAY_COOKIE_SECURE') || 'false') === 'true';
const COOKIE_NAME = pick('RELAY_COOKIE_NAME') || 'rmcp_session';

/** 令牌校验结果的内存缓存时长。撤销同进程内立即生效，这个 TTL 只约束跨进程场景。 */
const TOKEN_CACHE_TTL_MS = Number(pick('TOKEN_CACHE_TTL_MS') || 30 * 1000);

/** 同一令牌的 last_used_at 最多多久写一次库（避免每次调用都产生一次写）。 */
const TOKEN_TOUCH_INTERVAL_MS = Number(pick('TOKEN_TOUCH_INTERVAL_MS') || 60 * 1000);

/**
 * 一个租户有多台在线设备、且调用方没指定 device_id 时的行为：
 *   'auto-single'  只有一台就自动选；多台则报错并列出候选（默认，防误操作）
 *   'auto-any'     自动选最近心跳的那台（旧的全局语义，仅租户内）
 */
const ROUTE_POLICY = pick('RELAY_ROUTE_POLICY') || 'auto-single';

/* ------------------------------------------------------------------ 限速 */

/**
 * 针对 user_code 的暴力猜测必须限速：猜中一个 user_code 就能批准它，
 * 而"批准"意味着**那台机器会变成批准者的远程设备** —— 受害者的机器
 * 会被绑到攻击者账号上，远比"绑错账号"严重。
 */
const RL_APPROVE_MAX = Number(pick('RELAY_RL_APPROVE_MAX') || 10);
const RL_APPROVE_WINDOW_MS = Number(pick('RELAY_RL_APPROVE_WINDOW_MS') || 5 * 60 * 1000);
const RL_LOGIN_MAX = Number(pick('RELAY_RL_LOGIN_MAX') || 20);
const RL_LOGIN_WINDOW_MS = Number(pick('RELAY_RL_LOGIN_WINDOW_MS') || 5 * 60 * 1000);
const RL_MCP_AUTH_MAX = Number(pick('RELAY_RL_MCP_AUTH_MAX') || 60);
const RL_MCP_AUTH_WINDOW_MS = Number(pick('RELAY_RL_MCP_AUTH_WINDOW_MS') || 60 * 1000);

/** 注册开关。单租户自建内网友好，上公网前应评估是否关闭。 */
const ALLOW_SIGNUP = (pick('RELAY_ALLOW_SIGNUP') || 'true') === 'true';

/**
 * 是否信任 X-Forwarded-For 的第一跳作为客户端 IP。
 *
 * 中继本身不直接暴露公网（前面是隧道或反向代理），所以默认 true 是合理的。
 * 但如果有人把中继端口直接暴露出去，XFF 就是可伪造的 —— 后果仅限于限速被绕过
 * （鉴权不受影响，它是靠令牌而不是 IP）。真要直连公网就置 false。
 */
const TRUST_PROXY = (pick('RELAY_TRUST_PROXY') || 'true') === 'true';


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

// 可选：给 /mcp 端点加一条路径令牌（放 URL 路径里）。
//
// 多租户下**不是主路径** —— 隧道的 connector 只会把 Authorization 头转发过来，
// 不会转发 AI 客户端请求的路径（隧道把请求固定打到配置的那一个 MCP 路径）。
// 所以路径令牌只在"直连中继、不经隧道"的场景有用，例如运维自测。
const MCP_PATH_TOKEN = pick('MCP_PATH_TOKEN') || '';

/**
 * 会话密钥落盘位置。不放进 .env 是为了避免"每次手抄一遍" ——
 * 自动生成一次、之后所有重启都复用它，用户不会因为重启中继而掉线。
 */
const SESSION_SECRET_FILE = pick('RELAY_SESSION_SECRET_FILE') || path.join(RELAY_ROOT, '.session-secret');

function validate() {
  const problems = [...fileReadErrors];
  if (!ANON_KEY) {
    problems.push('ANON_KEY 缺失（环境变量 / relay/.env / supabase/selfhosted/.env 三处都没有）');
  }
  if (!SERVICE_ROLE_KEY) {
    problems.push('SERVICE_ROLE_KEY 缺失（环境变量 / relay/.env / supabase/selfhosted/.env 三处都没有）');
  }
  if (!fs.existsSync(CATALOG_PATH)) {
    problems.push(`工具目录不存在：${CATALOG_PATH}（先跑 node tools/gen-catalog.js）`);
  }
  if (ROUTE_POLICY !== 'auto-single' && ROUTE_POLICY !== 'auto-any') {
    problems.push(`RELAY_ROUTE_POLICY 只能是 auto-single 或 auto-any，当前是 "${ROUTE_POLICY}"`);
  }
  return problems;
}

/** 启动时的安全体检。返回告警数组 —— 不阻断启动，但必须显式打出来。 */
function securityWarnings() {
  const warns = [];
  if (AUTO_APPROVE) {
    warns.push('DEVICE_FLOW_AUTO_APPROVE=true —— 设备授权无需人工批准。仅适用于本地联调。');
  }
  if (ALLOW_SIGNUP) {
    warns.push('RELAY_ALLOW_SIGNUP=true —— 任何人可自助注册账号（并因此获得操作其自有设备的能力）。');
  }
  if (MCP_PATH_TOKEN) {
    warns.push('MCP_PATH_TOKEN 已设置 —— 路径令牌是单租户遗留机制，注意它不会识别租户身份。');
  }
  if (ADMIN_TOKEN && ADMIN_TOKEN.length < 24) {
    warns.push('RELAY_ADMIN_TOKEN 短于 24 字符，建议换成高熵随机值。');
  }
  if (!COOKIE_SECURE) {
    warns.push('RELAY_COOKIE_SECURE=false —— 会话 cookie 会在明文 HTTP 上发送。本地 http 调试需要这样，上公网必须置 true。');
  }

  // OAuth 授权服务器**必须**能被终端用户的浏览器打开 —— 这是 OpenAI 侧的
  // 硬约束（授权服务器不会随隧道路径一起被代理）。所以公开地址必须是
  // 真实的、外部可达的 HTTPS，否则用户点"连接"后会停在一个打不开的页面上，
  // 而现象只是"授权一直失败"，极难定位。
  const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(RELAY_PUBLIC_URL);
  if (!isLoopback && !RELAY_PUBLIC_URL.startsWith('https://')) {
    warns.push(
      `RELAY_PUBLIC_URL=${RELAY_PUBLIC_URL} 不是 https —— ` +
        'OAuth 授权页需要用户浏览器直接打开，浏览器与 ChatGPT 都要求 HTTPS。'
    );
  }
  return warns;
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
  ADMIN_TOKEN,
  SESSION_SECRET,
  SESSION_SECRET_FILE,
  SESSION_TTL_S,
  COOKIE_SECURE,
  COOKIE_NAME,
  TOKEN_CACHE_TTL_MS,
  TOKEN_TOUCH_INTERVAL_MS,
  ROUTE_POLICY,
  RL_APPROVE_MAX,
  RL_APPROVE_WINDOW_MS,
  RL_LOGIN_MAX,
  RL_LOGIN_WINDOW_MS,
  RL_MCP_AUTH_MAX,
  RL_MCP_AUTH_WINDOW_MS,
  ALLOW_SIGNUP,
  TRUST_PROXY,
  CALL_TIMEOUT_MS,
  CALL_POLL_INTERVAL_MS,
  DEVICE_CODE_TTL_S,
  DEVICE_POLL_INTERVAL_S,
  DEVICE_FRESH_MS,
  CATALOG_PATH,
  MCP_PATH_TOKEN,
  validate,
  securityWarnings,
};
