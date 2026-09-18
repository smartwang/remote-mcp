# relay-device —— 把本机接到自建 relay

让这台 Windows 作为**第二台** device 接入自建中继 `https://mcp.example.com`，
同时**不碰**已经在跑的那台官方 device（连 `mcp.desktopcommander.app`）。

```
ChatGPT ──► https://mcp.example.com/mcp        自建 relay（Supabase + device OAuth）
                 │  Supabase Realtime WebSocket
                 ▼
           本目录启动的 device 进程                ← 本脚本负责的就是这一层
                 │  stdio 拉起同包的 dist/index.js
                 ▼
           本机 DesktopCommander server（25 工具）
```

---

## 为什么不能直接 `npx ... remote`

两个坑，都是实测出来的，不是推导：

**坑 1 —— npx 起不来（EBUSY）。**
官方那台 device 用 `npx @wonderwhy-er/desktop-commander@latest remote` 启动，它把
`<npx-cache>\...\desktop-commander\dist` 当工作目录用
（`desktop-commander-integration.js:127` 用 `process.execPath` spawn 同包的
`dist/index.js`，`cwd=dist`）。于是那个目录被锁住，npx 升级时 rename 目录
→ `EBUSY: resource busy or locked`。**npx 死在安装阶段，device 进程从未存活。**
报错长得像 config 没生效，很容易读错方向。

**坑 2 —— 状态文件撞车（更麻烦）。**
`dist/remote-device/device.js:21`

```js
return path.join(os.homedir(), '.desktop-commander-device', 'device.json');
```

这行是**硬编码**的（`getRemoteDeviceConfigPath()`），全 dist 仅此一处，
**没有任何环境变量能覆盖**。而它存的内容只有 `{deviceId, session}`，
**不记 server URL**。两台 device 必然抢同一个文件：后启动的覆写身份，
官方那台下次重启就废了。

`MCP_SERVER_URL` 是唯一的切换开关（`device.js:27`）。

---

## 做法：私有副本 + 改掉那一行状态路径

```
relay-device\
  start-device.cmd      启动器
  prepare.mjs           副本准备 + 打补丁 + 校验（幂等）
  device.env            本机配置（不入库）
  device.env.example    配置模板
  _device\              运行时产物（不入库）
    node_modules\       ← 从本机 npx 缓存复制，约 200MB
    state\device.json   ← 这台 device 自己的凭据
```

**零下载。** 副本从本机已有的 npx 缓存复制；一份完整的依赖树本地就有。

补丁只改那一行，改成：

```js
const dir = process.env.DCD_DEVICE_STATE_DIR || path.join(os.homedir(), '.desktop-commander-device-relay');
return path.join(dir, 'device.json');
```

两个要点：

- 支持 `DCD_DEVICE_STATE_DIR` 覆盖，于是状态文件落在 `_device\state\`，整个目录自包含；
- **默认值也不再是官方那个目录**（`.desktop-commander-device-relay`）。就算哪次忘了设
  环境变量，也绝不会去动官方那台的身份文件。这条是刻意留的第二道保险。

官方那份**一个字节不碰**。

---

## 用法

```cmd
cd C:\Users\longyuan\workspace\remote-mcp\windows\relay-device

start-device.cmd                 :: 准备（仅首次，见下方耗时）+ 启动
start-device.cmd check           :: 只看解析出来的路径和补丁状态，不起进程
start-device.cmd prepare         :: 只准备，不启动
start-device.cmd reinstall       :: 强制重新复制副本，然后启动
start-device.cmd logout          :: 删掉本机的设备凭据
start-device.cmd --no-persist-session    :: 其余参数透传给 device.js
```

首次启动会打印设备码和验证 URL，去 `https://mcp.example.com/device` 用控制台账号
登录后批准。（控制台账号见 `../../deploy/server/README.md`。）

准备好之后每次启动就是「读一遍 marker → 校验 → 拉进程」，约 1 秒。

### 首次准备要多久（实测）

| 阶段 | 实测值 |
|---|---|
| 复制 19,890 个文件 / 155.2 MB | **599.7 s（约 10 分钟）** |
| 打补丁 + 静态校验 | < 0.1 s |
| 之后每次 `prepare`（幂等跳过） | **0.5 s** |

10 分钟对 155MB 来说慢得反常（约 0.26 MB/s），瓶颈是**实时杀软逐文件扫描**，
不是磁盘带宽。只发生一次；嫌慢就把 `_device\` 加进杀软排除目录，
或者用 `DCD_DEVICE_ROOT` 指到别处。

---

## 配置（device.env）

| 键 | 默认 | 说明 |
|---|---|---|
| `MCP_SERVER_URL` | **必填，无默认** | 中继地址。OAuth 与 Realtime 地址都由它推导。没设会直接报错退出，不会退回某个"看起来像对的"地址 |
| `DCD_DEVICE_ROOT` | `.\_device` | 私有副本根目录。别指到 npx 缓存本身 |
| `DCD_SOURCE_NODE_MODULES` | 自动扫描 | 从哪个 `node_modules` 复制。自动扫描 `_npx\*\node_modules` 取版本最高的一份 |
| `DCD_NODE_EXE` | 自动探测 | 一般不用设 |

`MCP_SERVER_URL` **故意不设默认值**：一个有默认值的地址在配错时会表现成
DNS / 连接失败，而真正的错因是"你根本没配"。现在它会在启动前就把话说清楚。

---

## 排除掉的错解（别再走一遍）

- ❌ **改用 `USERPROFILE` 做隔离。** 会让 DesktopCommander 的配置目录
  （`dist/config.js:5` → `~/.claude-server-commander/config.json`，文件白名单在这）
  一起搬家 → 它只能看到一个空目录 → **访问不到用户文件**。
- ❌ **`npm install` 到独立目录。** 空 cache 会现下 puppeteer 那一坨，实测下了
  **304MB 还没完**，纯浪费。本地 `node_modules` 已经是完整的一份。
- ❌ **直接改 npx 缓存里那份 device.js。** 官方那台的下次重启会读到改过的文件；
  而且 npx 一升级就覆盖。

---

## 已知代价 / 边界

- **磁盘 +200MB。** 换的是「npx 一升级就把你搞坏的副本」变成「自己的一份，
  上游怎么变都不影响」。
- **上游版本升级不会自动跟随。** 想跟新版：先让官方那台 npx 升上去
  （注意它升级时会因为坑 1 失败，得先停掉它），再
  `start-device.cmd reinstall` 从新缓存重新复制。
  或者手动清掉 `_device\` 后重跑。
- **这不是沙箱。** device 拉起来的 `dist/index.js` 是 DesktopCommander 的完整
  MCP server（25 工具，含命令执行）。它能做的东西等于你的用户权限。
  `allowedDirectories` / `blockedCommands` 是护栏不是围栏（见它自己的 SECURITY.md）。
- 两个 device 共用同一份 `~/.claude-server-commander/config.json`，只读，无冲突。

---

## 验证状态（2026-09-18）

**已实测：**

| 项 | 证据 |
|---|---|
| 副本复制 + 幂等 | 首次 599.7s / 19,890 文件 / 155.2MB；重跑 0.5s 跳过 |
| 补丁语义 | `prepare.mjs` 抽取函数体求值：无 env 时落 `.desktop-commander-device-relay`、有 env 时落 `_device\state`，两条断言都过 |
| 启动器 | `start-device.cmd check` 退出码 0，node/env/路径解析全部正确 |
| device 能从副本起来 | 打到不可达 URL：日志显示 `Found local MCP server at ...\_device\...\dist\index.js` 并 `🔌 Connected to Desktop Commander MCP` |
| `MCP_SERVER_URL` 被读取 | 同一日志：`Connecting to Remote MCP https://127.0.0.1:9/` |
| relay 侧端点 | `/api/mcp-info`、`/device/start` 均 200，字段与客户端读取的名字一致 |

**未验证（别当成已完成）：**

- **真实设备授权全流程**（`/device/poll` 拿到 token → Supabase Realtime 连上 → 标记 online）。
  需要人去浏览器批准设备码，没跑过。
- **ChatGPT 侧 connector 真能调通 `tools/call`**。一次都没跑通。
- **官方那台 device 在副本存在期间是否完好**。理论上零接触（另一份 dist、另一个状态文件），
  但需要它下次重启才能证伪。

---

## 和 `../` 那套的关系

| | `../`（tunnel-client） | 本目录 |
|---|---|---|
| 中继 | OpenAI 托管 | **自建**（Supabase + device OAuth） |
| 执行体 | 本目录外的 `server.js`（7 工具，自己写的） | 官方 `dist/index.js`（25 工具） |
| 授权 | OpenAI 平台组织级 RBAC | 每设备 device flow |
| 能否产品化 | **不能**（平台组织级 RBAC） | 能 |

两套并存互不干扰：端口不重叠、进程独立、配置独立。
