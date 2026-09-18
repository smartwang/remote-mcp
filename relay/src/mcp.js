'use strict';
/**
 * 面向 AI 端（ChatGPT / Claude）的 HTTP MCP 端点。
 *
 * 这一层就是闭源 mcp.desktopcommander.app 的对外那一半：
 *   tools/list → 从本地 catalog.json 回（device 不上报工具表，见架构记录）
 *   tools/call → 写一行 mcp_remote_calls + 广播 new_call 到私有频道 + 等结果
 *
 * 注意 tools/list 是"服务端持有工具目录"而不是"问设备要"。这是刻意的：
 * 一条调用要能被路由，前提是服务端先知道有哪些工具；同时列表响应不依赖
 * 设备在线，AI 端在设备离线时也能看到工具并拿到明确的报错。
 */

const fs = require('node:fs');
const cfg = require('./config');
const supa = require('./supa');

let catalog = null;

function loadCatalog() {
  const raw = JSON.parse(fs.readFileSync(cfg.CATALOG_PATH, 'utf8'));
  catalog = raw;
  console.log(`[mcp] 工具目录已加载：${raw.toolCount} 个工具（来自 ${raw.source.entry} v${raw.source.version}）`);
  return raw;
}

function getCatalog() {
  if (!catalog) loadCatalog();
  return catalog;
}

/* ------------------------------------------------------- 工具表净化（重要） */

/**
 * 中继**不代理** UI 组件资源，所以必须把工具上的 UI 广告一并摘掉。
 *
 * 背景（实测，见 tools/probe-capabilities.js）：
 *   DesktopCommander 本体 initialize 声明的是
 *     capabilities = { tools:{}, resources:{}, prompts:{}, logging:{} }
 *   并且 resources/list 会返回两个 MCP-Apps 组件：
 *     ui://desktop-commander/file-preview    (text/html;profile=mcp-app)
 *     ui://desktop-commander/config-editor   (同一个 mime，内容 48 万字符)
 *   26 个工具里有 5 个通过 `_meta` 广告了它们：
 *     _meta["ui/resourceUri"] / _meta["openai/outputTemplate"] / _meta.ui.resourceUri
 *     / _meta["openai/widgetAccessible"]
 *
 * 但 device 进程的代理只转发 listTools / callTool（desktop-commander-integration.ts），
 * `resources/read` **到不了设备**。于是会自相矛盾：
 *   工具广告了 UI 模板 → 客户端按 MCP-Apps 规范去读那个资源 → 中继只能回 -32601。
 * ChatGPT 就是这么崩的：它确实调了 resources/read，拿到"方法不存在"。
 *
 * 所以两条路二选一：
 *   A) 摘掉 UI 广告（本函数，默认）——中继诚实地说"我没有 UI 组件"；
 *   B) 把两个组件的 HTML 在生成目录时预烘焙进来做静态服务——能让组件真的渲染，
 *      但要改动 device 代理、且要把 48 万字符的东西发出去。
 * 现阶段选 A：目标是"从 ChatGPT 操作这台机器"，组件预览是锦上添花。
 * 摘掉的键保留在 catalog.json 里没动，随时可以用 RELAY_KEEP_UI_META=true 对比。
 */
const KEEP_UI_META = process.env.RELAY_KEEP_UI_META === 'true';

/** 从 inputSchema 里拿掉 draft-07 的 $schema 声明 —— MCP 工具 schema 不需要它。 */
function stripSchemaDialect(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const { $schema, ...rest } = schema;
  return rest;
}

/** 把工具对象裁成"中继真的能履约"的字段。 */
function sanitizeTool(tool) {
  const out = { ...tool, inputSchema: stripSchemaDialect(tool.inputSchema) };
  if (out._meta && !KEEP_UI_META) {
    const meta = { ...out._meta };
    delete meta['ui/resourceUri'];
    delete meta['openai/outputTemplate'];
    delete meta['openai/widgetAccessible'];
    delete meta.ui;
    if (Object.keys(meta).length === 0) delete out._meta;
    else out._meta = meta;
  }
  return out;
}

let toolList = null;

/** 对外暴露的工具数组（已净化、已缓存）。 */
function getToolList() {
  if (!toolList) {
    const raw = getCatalog().tools;
    toolList = raw.map(sanitizeTool);
    const dropped = raw.filter((t, i) => JSON.stringify(t) !== JSON.stringify(toolList[i])).length;
    if (dropped) {
      console.log(
        `[mcp] 工具表净化：${dropped} 个工具摘掉了 UI 组件广告 / $schema` +
          (KEEP_UI_META ? '（RELAY_KEEP_UI_META=true，UI 广告保留）' : '')
      );
    }
  }
  return toolList;
}

/* --------------------------------------------------------------- 目标设备挑选 */

function isFresh(row) {
  if (!row?.last_seen) return false;
  const ts = Date.parse(row.last_seen);
  return Number.isFinite(ts) && Date.now() - ts <= cfg.DEVICE_FRESH_MS;
}

function isBroadcastCapable(row) {
  const caps = row?.capabilities || {};
  return caps.transport_broadcast_v1 === true || caps.transport_broadcast_v1 === 'true';
}

/**
 * 选出这次调用该路由到哪台设备。
 *
 * 单租户阶段：优先"最近心跳 + 声明了广播能力"的那台。
 * 多租户要把 user_id 从调用方的身份里取，不能像现在这样全局挑。
 */
async function resolveTargetDevice(explicitDeviceId) {
  if (explicitDeviceId) {
    const rows = await supa.rest.select('mcp_devices', {
      id: `eq.${explicitDeviceId}`,
      select: 'id,user_id,device_name,status,last_seen,capabilities',
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw mcpError(`找不到设备 ${explicitDeviceId}`, -32602);
    if (!isFresh(row)) {
      throw mcpError(
        `设备 ${row.device_name}（${row.id}）最后一次心跳是 ${row.last_seen}，已超出 ${Math.round(cfg.DEVICE_FRESH_MS / 60000)} 分钟窗口，判定为离线。` +
        `请确认该设备上的 \`desktop-commander remote\` 正在运行。`,
        -32000
      );
    }
    return row;
  }

  const rows = await supa.rest.select('mcp_devices', {
    select: 'id,user_id,device_name,status,last_seen,capabilities',
    order: 'last_seen.desc',
  });
  const all = Array.isArray(rows) ? rows : [];
  if (all.length === 0) {
    throw mcpError(
      '还没有任何已授权的设备。先在本机执行一次 device flow：' +
      `设置 MCP_SERVER_URL=${cfg.RELAY_PUBLIC_URL} 后运行 \`npx @wonderwhy-er/desktop-commander@latest remote\`。`,
      -32000
    );
  }

  const fresh = all.filter(isFresh);
  if (fresh.length === 0) {
    const newest = all[0];
    throw mcpError(
      `有 ${all.length} 台已授权设备，但全部离线。最近一台是 ${newest.device_name}（最后心跳 ${newest.last_seen}）。` +
      '请确认设备上的 `desktop-commander remote` 正在运行。',
      -32000
    );
  }

  const capable = fresh.filter(isBroadcastCapable);
  const pool = capable.length ? capable : fresh;
  if (!capable.length) {
    console.warn('[mcp] 没有设备声明 transport_broadcast_v1，仍尝试广播派发');
  }
  return pool[0];
}

function mcpError(message, code = -32603) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/* ------------------------------------------------------------------- tools/call */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForResult(callId, deadline) {
  let lastStatus = null;
  while (Date.now() < deadline) {
    const rows = await supa.rest.select('mcp_remote_calls', {
      id: `eq.${callId}`,
      select: 'status,result,error_message',
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return { status: 'missing' };
    if (row.status !== lastStatus) {
      lastStatus = row.status;
      console.log(`[mcp] call ${callId.slice(0, 8)} → ${row.status}`);
    }
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'timeout') return row;
    await sleep(cfg.CALL_POLL_INTERVAL_MS);
  }
  return { status: 'client_timeout' };
}

async function callTool(name, args, meta = {}) {
  const started = Date.now();
  const explicitDeviceId = args?.__device_id || args?.device_id || meta?.device_id;
  const cleanArgs = { ...(args || {}) };
  delete cleanArgs.__device_id;      // 这两个只是路由提示，不能当作工具参数送到设备
  delete cleanArgs.device_id;

  const device = await resolveTargetDevice(explicitDeviceId);

  const inserted = await supa.rest.insert('mcp_remote_calls', {
    device_id: device.id,
    user_id: device.user_id,
    tool_name: name,
    tool_args: cleanArgs,
    metadata: {
      transport: 'relay-broadcast',
      relay: true,
      ...(meta && typeof meta === 'object' ? { client: meta.client || null } : null),
    },
  });
  const callRow = Array.isArray(inserted) ? inserted[0] : inserted;
  if (!callRow?.id) throw mcpError('写入调用行失败：没有拿到 id', -32603);

  console.log(`[mcp] call ${callRow.id.slice(0, 8)} ${name} → device ${device.device_name}(${device.id.slice(0, 8)}) args=${JSON.stringify(cleanArgs).slice(0, 120)}`);

  // 门铃。payload 只带 id —— device 会按主键回查整行（remote-channel.ts onDoorbell）。
  try {
    await supa.broadcast(`user:${device.user_id}`, 'new_call', {
      call_id: callRow.id,
      device_id: device.id,
    });
  } catch (err) {
    // 广播失败 = 设备永远不会知道有这次调用。等 5 分钟毫无意义，快速失败并
    // 把行结算掉，避免留下一个"executing 中"的幽灵。
    await supa.rest
      .update('mcp_remote_calls', { id: `eq.${callRow.id}` }, {
        status: 'failed',
        error_message: `门铃广播失败：${err.message}`,
        completed_at: new Date().toISOString(),
      })
      .catch(() => {});
    throw mcpError(
      `无法把调用派发给设备（门铃广播失败）：${err.message}。` +
      '检查中继到 Supabase Realtime 的连通性（/healthz 的 broadcast 字段）。',
      -32000
    );
  }

  const row = await waitForResult(callRow.id, Date.now() + cfg.CALL_TIMEOUT_MS);
  const elapsedMs = Date.now() - started;

  if (row.status === 'completed') {
    return normalizeResult(row.result, elapsedMs);
  }
  if (row.status === 'failed') {
    return textResult(`设备执行失败：${row.error_message || '(无错误信息)'}`, true);
  }
  if (row.status === 'timeout') {
    return textResult(
      `设备超时未响应（服务端 ${Math.round(cfg.CALL_TIMEOUT_MS / 1000)}s 已到）。` +
      `设备 ${device.device_name} 可能在此过程中掉线。`,
      true
    );
  }
  if (row.status === 'missing') {
    return textResult('调用记录在中途消失了（可能被清理）。', true);
  }
  return textResult(
    `等待设备响应超时（${Math.round(elapsedMs / 1000)}s）。调用已发出但设备未结算，` +
    `它稍后可能仍在执行 —— 这是"不知道结果"，不是"没有执行"。`,
    true
  );
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function normalizeResult(result, elapsedMs) {
  if (result === null || result === undefined) {
    return textResult(`设备返回了空结果（耗时 ${elapsedMs}ms）。`, true);
  }
  if (typeof result === 'object' && Array.isArray(result.content)) {
    return result;
  }
  if (typeof result === 'object' && result.error) {
    return textResult(`设备返回错误：${JSON.stringify(result.error)}`, true);
  }
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
  };
}

/* --------------------------------------------------------------- JSON-RPC 处理 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const LATEST = PROTOCOL_VERSIONS[0];

async function handle(msg, session) {
  const { method, params } = msg;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST;
      const cat = getCatalog();
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: 'remote-mcp-relay',
          version: require('../package.json').version,
          title: 'Remote MCP Relay',
        },
        instructions:
          `本服务把工具调用转发到用户已授权的设备上执行（当前目录基于 DesktopCommander ${cat.source.version}，` +
          `${cat.toolCount} 个工具）。工具名与 DesktopCommander 完全一致。文件路径是**设备本地**的路径，` +
          '不是你所在环境的路径。',
      };
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined;

    case 'ping':
      return {};

    case 'tools/list':
      return { tools: getToolList() };

    case 'tools/call': {
      const name = params?.name;
      if (!name) throw mcpError('tools/call 缺少 name', -32602);
      const known = getCatalog().tools.some((t) => t.name === name);
      if (!known) throw mcpError(`未知工具：${name}`, -32602);
      return callTool(name, params?.arguments || {}, {
        ...(params?._meta || {}),
        client: session?.clientInfo || null,
      });
    }

    case 'prompts/list':
      return { prompts: [] };

    // 中继不暴露设备侧的 UI 组件资源（device 代理不转发 resources/*，见上方净化说明）。
    // 列表如实给空；单个读取按规范回 -32002（resource not found），
    // 而不是 -32601（method not found）——后者会让客户端认为整个服务不兼容。
    case 'resources/list':
      return { resources: [] };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'resources/read':
      throw mcpError(
        `中继不提供资源：${params?.uri ?? '(未指定 uri)'}。` +
          '设备侧只转发工具调用，UI 组件资源请直连本机 DesktopCommander。',
        -32002
      );

    default:
      throw mcpError(`不支持的方法：${method}`, -32601);
  }
}

module.exports = { handle, getCatalog, getToolList, loadCatalog, resolveTargetDevice, callTool };
