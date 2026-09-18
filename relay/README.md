# remote-mcp relay —— 自建版「云端·闭源」层

复刻 `mcp.desktopcommander.app` 的服务端职责，让**未修改的**开源 DesktopCommander
device 进程通过 `MCP_SERVER_URL` 指过来就能工作，从而把本机全部 26 个工具
（而不是自写 server 的 7 个）暴露给 ChatGPT / Claude。

## 它在整体里的位置

```
ChatGPT / Claude 网页版
        │ HTTP MCP
        ▼
┌───────────────────────────────┐
│  红框 = 本目录 + 自托管 Supabase │
│                               │
│  relay (本目录)                │  ← /mcp 给 AI 端
│    ├─ /api/mcp-info           │  ← 给 device
│    ├─ /device/start|poll      │  ← 给 device（OAuth Device Flow）
│    └─ service_role 写库 + 广播  │
│                               │
│  Supabase(自托管)              │  ← PostgREST / GoTrue / Realtime
└───────────────────────────────┘
        │ Realtime 私有频道 user:<uid> 广播 new_call
        ▼
desktop-commander remote（device 进程，未修改的开源代码）
        │ MCP stdio
        ▼
本地 DesktopCommander MCP（26 个工具）
```

**为什么必须有这个中继**：DesktopCommanderMCP 本体是 stdio-only
（`src/index.ts` 只创建 `FilteredStdioServerTransport`，全仓库没有任何 HTTP
transport），它没法直接当云端 HTTP MCP 端点。中继补的就是这一层。

**为什么用自托管 Supabase**：device 侧硬依赖 Supabase SDK 的四块能力 ——
GoTrue 的 session/refresh、PostgREST 的 `.from()`、Realtime 私有频道 + presence、
JWT。自己重写 Realtime 的 Phoenix 协议不划算。中继自己实现的只有 4 个端点。

## 快速开始

```bash
# 1) 起自托管 Supabase（约 11 个容器，首次要拉 2-3GB 镜像）
cd ../supabase/selfhosted
node tools/gen-env.js            # 生成 .env（含 JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY）
docker compose up -d

# 2) 建表
bash tools/apply-schema.sh

# 3) 生成工具目录（需要本机有 DesktopCommander）
cd ../../relay
node tools/gen-catalog.js        # → catalog.json，26 个工具

# 4) 起点检
cp .env.example .env             # 按需改；密钥自动从 supabase/selfhosted/.env 读
node tools/probe-realtime.js     # 上游体检：PostgREST / GoTrue / Realtime 门铃
npm start                        # 起中继
node tools/smoke.js              # 中继自检：device flow 全流程 + MCP 端点

# 5) 在设备上接入
#    Windows (cmd)：
#      set MCP_SERVER_URL=http://127.0.0.1:18086
#      npx @wonderwhy-er/desktop-commander@latest remote
#    然后浏览器打开 http://127.0.0.1:18086/device 点批准
```

## 端点契约

中继对 device 侧要满足的全部接口（字段名来自 `device-authenticator.ts` /
`device.ts` / `remote-channel.ts`，不要改名）：

| 端点 | 调用方 | 用途 |
|---|---|---|
| `GET /api/mcp-info` | `device.ts:313` | 返回 `{supabaseUrl, supabasePublishableKey}`，免鉴权 |
| `POST /device/start` | `device-authenticator.ts:66` | 返回 `device_code / user_code / verification_uri / verification_uri_complete / expires_in / interval` |
| `POST /device/poll` | `device-authenticator.ts:112` | 未批准 → `{error:'authorization_pending'}`；过快 → `slow_down`；批准 → `{access_token, refresh_token, token_type, expires_in, device_id}` |
| `GET /device` | 人（浏览器） | 批准页 |
| `GET /status` | 人（浏览器） | **只读运维面板**：设备在线状态、广播投递、待批准授权。每 5 秒自刷 |
| `POST /mcp` | ChatGPT / Claude | HTTP MCP：`initialize` / `tools/list` / `tools/call` |
| `GET /healthz` | 运维 / 程序 | 上面那个页面拉的数据源（JSON） |

device 进程拿到 session 后**不经过中继**，直接对 Supabase 说话
（PostgREST 读写 `mcp_devices` / `mcp_remote_calls`，Realtime 订阅私有频道）。
这正是官方架构的形状，中继只在授权和派发入口上出现。

## 运维面板（`/status`）

浏览器打开 <http://127.0.0.1:18086/status>。只读、每 5 秒自刷一次，数据全部来自
`GET /healthz`（页面 HTML 是静态骨架，不含任何服务端注入的数据）。

看什么：

| 字段 | 含义 | 什么时候要担心 |
|---|---|---|
| 工具数 / 工具目录来源 | 中继持有的工具表，以及它是从哪个 DesktopCommander 构建产物抓的 | 数字不是 26，或路径指向了旧版本 |
| 广播投递 | `service_role` 往私有频道发门铃的成功/失败计数 | **失败数在涨** —— 设备收不到 `new_call`，调用必然超时 |
| 活跃 MCP 会话 | 当前持有 `mcp-session-id` 的客户端数 | 一直为 0 说明 ChatGPT 侧没连上 |
| 设备 · 在线 | 心跳距今是否在 15 分钟窗口内 | 显示离线 → ChatGPT 调用会快速失败 |
| 设备 · 最后心跳 | device 进程直连 Supabase 上报的 `last_seen` | 时间不推进 = device 进程死了 |
| 设备 · 广播通道 | `capabilities.transport_broadcast_v1` | **不可用** → 该设备收不到门铃，必须重启 device 进程 |
| 待批准的授权 | `/device/start` 已发出但没点批准 | 卡在这里 = 有设备在等你点批准 |

两个口径要注意：

- **在线判定用的是 15 分钟心跳窗口**，与 `supabase/schema.sql` 里 `mcp_device_presence`
  视图一致，只用来过滤死进程（device 实际心跳比这密得多）。
- 心跳是 **device 直连 Supabase** 上报的，**不经过中继**。所以中继重启后面板短暂显示
  `活跃 MCP 会话 0` 是正常的，设备状态不受影响。

## 派发机制（`tools/call` 的五步）

1. 选目标设备：`mcp_devices` 里 `last_seen` 落在新鲜窗口内、且声明了
   `transport_broadcast_v1` 的那台。全部离线则**快速失败**并说明原因，不干等。
2. `service_role` 往 `mcp_remote_calls` 插一行 `status='pending'`。
3. `service_role` 往私有频道 `user:<user_id>` 广播 `new_call`，
   payload 只有 `{call_id, device_id}`。
4. 轮询该行直到 `completed` / `failed` / `timeout`，间隔 400ms，上限 5 分钟
   （对齐 `remote-channel.ts` 里写明的服务端契约）。
5. 把行里的 `result` 原样作为 MCP 结果返回。

**门铃广播失败会立即失败**（并把行结算成 `failed`），不是继续等 —— 因为
device 侧没有任何轮询兜底（`remote-channel.ts` 只认广播），广播失败等于
这次调用永远不会被看到，等满 5 分钟只是浪费。

## 已知约束

- **工具表由中继持有，不是问设备要的。** 上游 `remote-channel.ts` 的
  `registerDevice()` 把传入的 `capabilities` 参数整个丢弃（写成只含
  `app_version` 的 payload），所以 `device.ts:196` 传进去的
  `listClientTools()` 到不了服务端。→ `catalog.json` 必须在本机跑
  `tools/gen-catalog.js` 生成，DesktopCommander 升级后要重新生成。
- **device flow 状态存在进程内存**。中继重启会让进行中的授权失效
  （用户重跑一次即可）。要跨重启就得建表。
- **单租户**。`/device/start` 批准后建立的账号由 `RELAY_OWNER_EMAIL` 决定；
  `tools/call` 的目标设备是全局挑的，没有按调用方身份隔离。
  公网部署前必须补上真实的多租户鉴权 —— 这是上公网的前置条件，不是可选优化。
- **`DEVICE_FLOW_AUTO_APPROVE=true` 等价于放开设备权限**：任何能访问
  `/device/start` 的人都能拿到一台设备的执行权。只在本地联调用。
- 所有请求体都过 `stripNul()`：Postgres 的 jsonb/text 拒绝 NUL（22P05），
  否则一次二进制读就足以让调用卡在 `executing` 直到超时。

## 工具表的净化（为什么摘掉 UI 组件广告）

`tools/list` 返回的**不是** `catalog.json` 的原样内容 —— 中继会先摘掉 UI 组件广告。

原因（实测，见 `tools/probe-capabilities.js`）：

```
DesktopCommander 本体 capabilities = { tools:{}, resources:{}, prompts:{}, logging:{} }
resources/list → ui://desktop-commander/file-preview     (text/html;profile=mcp-app)
                 ui://desktop-commander/config-editor    （读出来 48 万字符）
26 个工具里 5 个带 _meta：
  _meta["ui/resourceUri"] / ["openai/outputTemplate"]
  / ["openai/widgetAccessible"] / _meta.ui.resourceUri
```

中继**只声明 `tools` 能力、且 `resources/*` 到不了设备**（device 代理只转发
`listTools` / `callTool`，见 `desktop-commander-integration.ts`）。如果原样透传这些
`_meta`，就自相矛盾：工具一边广告 `ui://` 模板，服务一边说"我没有 resources 能力"。
ChatGPT 会按 MCP-Apps 规范去 `resources/read`，中继只能报错 →
**连接直接失败（"Something went wrong"）**。

所以 `mcp.js` 的 `sanitizeTool()` 会删掉：`_meta` 里的上述四个键、
以及 `inputSchema.$schema`。`RELAY_KEEP_UI_META=true` 可保留 UI 广告做对比。

**副作用**：ChatGPT 里看不到 DesktopCommander 的组件预览（config editor /
file preview）。想恢复就得走"方案 B"——生成目录时把两个组件的 HTML 预烘焙进来，
让中继静态服务 `resources/list` + `resources/read`。现阶段不做：目标是"从 ChatGPT
操作这台机器"，组件预览是锦上添花。

相关：`resources/read` 现在回 **-32002（resource not found）** 而不是 -32601
（method not found）—— 后者会让客户端判定整个服务不兼容。

## 请求级日志

`/mcp` 上每一次调用都会打一行，失败时直接定位到哪一跳：

```
[12:31:02] [mcp] ← initialize（id=0，session 新建=8f3a1c02）·client=chatgpt proto=2025-06-18
[12:31:02] [mcp] ← 通知 notifications/initialized（notif）
[12:31:03] [mcp] ← tools/list（id=1，session 沿用=8f3a1c02）·26 个工具
[12:31:04] [mcp] ✗ resources/read（id=2，session 沿用=8f3a1c02）→ -32002 中继不提供资源：ui://...
```

## 实测验证状态（2026-09-18，全部在本机实跑）

三份报告，按依赖顺序：

### `tools/probe-realtime.js` —— 7/7 PASS

这条是整个方案里唯一"要么通要么全废"的环节，所以在接设备之前先单独证明了：

```
PASS  PostgREST 可读
PASS  GoTrue 可发 session        （刷新令牌可续期也已验证）
PASS  GoTrue 可续期
PASS  Realtime WS 可连
PASS  私有频道可 join            ← realtime.messages 的 RLS 策略真的生效
PASS  REST broadcast 可发        （service_role 走 /realtime/v1/api/broadcast）
PASS  门铃可送达                ← 订阅者收到的 payload 与 device 期望的完全一致
```

收到的门铃原文：
`{"event":"new_call","payload":{"call_id":"…","device_id":"…"},"type":"broadcast"}`

### `tools/smoke.js` —— 22/22 PASS

把 device 进程会走的每一步原样走了一遍（不含 Realtime，那是上一份管的）：

```
PASS  /healthz · 设备列表 · /api/mcp-info 三项
PASS  device 能用该地址+anon key 打通 PostgREST
PASS  /device/start → user_code · verification_uri
PASS  未批准时返回 authorization_pending
PASS  /device/approve
PASS  批准后拿到完整 session（access_token + refresh_token + device_id）
PASS  PKCE 错 verifier 被拒
PASS  能读到自己的设备行（RLS 放行）
PASS  anon 身份读不到任何设备（RLS 生效）
PASS  authenticated 无法伪造调用行（无 insert 策略）
PASS  authenticated 无法自建设备行
PASS  能更新自己的设备行（device.ts updateDevice 同款调用）
PASS  MCP initialize + mcp-session-id 头
PASS  tools/list 返回 26 个，且每个都有 name 与 inputSchema
```

> 关于"authenticated 无法伪造调用行"这两条：自托管 Supabase 的**默认权限比托管版宽**
> —— anon/authenticated 对 public schema 的新表默认拿到 ALL（实测
> `role_table_grants` 里能看到 DELETE/INSERT/TRUNCATE）。schema.sql 里没有 insert
> 策略，所以 RLS 拦得住，但这个结论**必须实测**，不能靠 GRANT 推断。

### 端到端（真实 device 进程）

以独立的 `USERPROFILE` 起了一个 device 进程（避免覆盖现有官方 device 的
`~/.desktop-commander-device/device.json`）：

```
🚀 Starting MCP Device...
 - 🔌 Connected to Desktop Commander MCP          ← 它自己 spawn 的本地 stdio 子进程
⏳ Connecting to Remote MCP http://127.0.0.1:18086
 - ✅ Device ID assigned: a6c20300-…              ← 我们的中继发的
✅ Channel subscribed
👋 Presence tracked (device … visible as online)
   - Device Name:  DESKTOP-4L9V2ID
```

中继侧派发日志（三连发，每笔都是 pending → completed）：

```
[mcp] call f21bca1e get_config     → device DESKTOP-4L9V2ID(a6c20300)
[mcp] call 3aa188bc read_file      → device DESKTOP-4L9V2ID(a6c20300)
[mcp] call 1f5190e8 list_directory → device DESKTOP-4L9V2ID(a6c20300)
```

返回内容自证落点：`get_config` 给出 `defaultShell: powershell.exe`、
`currentClient.name: desktop-commander-client`；`read_file` 读到了真实的
`C:\Windows\System32\drivers\etc\hosts`；`list_directory` 列出了
`C:\Users\longyuan\workspace\remote-mcp` 的真实内容。

**授权环节是人工的**：设备进程会自己 `open()` 浏览器打开
`http://127.0.0.1:18086/device?user_code=XXXX-XXXX`，需要在那页上点「批准」。
已用隔离实验验证过**不存在自动批准**（连续 10 次轮询、30 秒，始终
`authorization_pending`）。

### 尚未验证

- **经 ChatGPT 真实触发的一次调用**。到中继这一段全通了，但 ChatGPT 侧还没接。
  接法见下一节。
- 多设备、多用户（当前是单租户全局挑设备）。

## 与隧道版的关系

本中继**不依赖** OpenAI 隧道。两种接法：

- **本机联调**：`tools/call` 直接打 `http://127.0.0.1:18086/mcp`。
- **接 ChatGPT 网页版**：把已有隧道的 `MCP_SERVER_URL` 从
  `host.docker.internal:18090/t/<token>/mcp` 改成
  `host.docker.internal:18086/mcp`。ChatGPT 侧 connector 不用动。
  将来去掉隧道、把中继挂公网时，ChatGPT 的 connector 改成
  `Connection = Server URL` 填公网地址即可。
