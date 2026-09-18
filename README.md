# remote-mcp

自建一套「云端·闭源」层，替换 <https://mcp.desktopcommander.app/>，
让 ChatGPT / Claude 能操作本机上未改一行的 DesktopCommander。

**状态（2026-09-18 末）**：全链路已跑通，**并已上公网** —— ChatGPT 侧完成
DCR → 授权 → 换令牌后，真实触发过 `tools/call`（`list_directory`，落到 Windows
宿主上，2.3 秒完成），26 个工具可用。**多租户鉴权已完成**（令牌 / 浏览器控制台 /
管理员面 / 设备按租户隔离），隔离性有 48 条对抗性断言实测支撑；**OAuth 2.1 已上线承重**。

这套东西有三种摆法，本文件是总览，按需要挑一个看：

| 形态 | 说明 | 去哪看 |
|---|---|---|
| **生产（推荐）** | 公网 VPS + 反代，**不用隧道**，connector 走 OAuth | `deploy/server/README.md` |
| 本机联调 | 中继跑在宿主 `127.0.0.1:18086`，device 直连它 | 本文件「从零重建」 |
| 容器化（含隧道边车） | compose 起 relay + tunnel 一个单元 | `docker/README.md` |

---

## 整体拓扑

生产形态（`deploy/server/`，无隧道）：

```
        ChatGPT / Claude
               │  HTTPS  Authorization: Bearer <OAuth 令牌>
               ▼
   Cloudflare（橙云）──► SafeLine / 反代（TLS 终结）
               │  明文 HTTP，只走回环
               ▼
   ┌──────────────────────────────┐
   │  relay        127.0.0.1:18086│    ← 本项目写的部分：
   │  /oauth/*   /device/*        │      只做「鉴权 + 协议转译 + 门铃派发」
   │  /mcp       /console /admin  │      代码在 relay/
   └──────────────────────────────┘
               │  出站 HTTPS：PostgREST 写队列 + Realtime 广播
               ▼
    Supabase（生产用托管项目；开发用自托管栈 127.0.0.1:8000）
               ▲
               │  device 直连（不过 relay）
               │
  Windows 上的 `desktop-commander remote`   ← 官方 CLI，零改动
               │  stdio
               ▼
  DesktopCommander MCP（26 个工具）
```

本机联调形态只差一层：device 的 `MCP_SERVER_URL` 直接指向
`http://127.0.0.1:18086`，没有 CF / 反代那一跳。

两个设计要点：

1. **Windows 侧零改动。** 官方 CLI 在 `src/remote-device/device.ts:43` 有
   `process.env.MCP_SERVER_URL || 'https://mcp.desktopcommander.app'` ——
   这就是留给我们换源的开头。只改一个环境变量，26 个工具由 CLI 自己带出来。
2. **device 不经过 relay。** 拿完授权后设备直连 Supabase 读写队列，
   relay 只在「授权入口」和「派发入口」出现。所以重启 relay 不影响已连接设备。

## 目录

| 路径 | 内容 | 是否入库 |
|---|---|---|
| `relay/` | 中继服务本体（零依赖 Node），本项目核心 | ✅ |
| `supabase/schema.sql` | 表结构、RLS 策略、Realtime 权限、清扫函数 | ✅ |
| `supabase/selfhosted/` | 自托管 Supabase 部署包（官方 docker 目录的副本 + 我们的生成脚本） | ✅ 除运行时数据 |
| `windows/` | Windows 宿主侧辅助件（启动脚本、调试客户端、`relay-device/` 第二台设备接入） | ✅ 除 `device.env`、`_device/` |
| `docker/` | compose：relay（可带隧道边车）与 MCP server 打包成单元 | ✅ |
| `deploy/server/` | **生产部署**（VPS + 反代，无隧道）：compose、密钥模板、迁移与体检工具 | ✅ |
| `docs/` | 设计文档（自托管 Supabase 的取舍） | ✅ |
| `tunnel/mcp-server/` | WSL 阶段的 7 工具 MCP server（历史） | ✅ |
| `_archive/` | 废弃方案归档（WSL 裸装），保留以防回溯 | ✅ 除二进制 |
| `tunnel/dist/` | tunnel-client v0.0.14 发行包，**509MB** | ❌ 见重建 |
| `supabase/_src/` | supabase 官方仓库的稀疏克隆，**5.9MB** | ❌ 见重建 |
| `supabase/selfhosted/volumes/db/data/` | Postgres 数据目录，**68MB+ 真实数据** | ❌ 见重建 |

## 从零重建

被忽略的三块各有确定的重建路径，都不需要手工凑。

### 1. 自托管 Supabase

```bash
cd supabase/selfhosted
node tools/gen-env.js --force        # 生成 .env（JWT secret + 上游的 anon/service_role key）
docker compose up -d                 # 约 10 个容器，首次拉 2-3GB 镜像
bash tools/apply-schema.sh           # 应用 supabase/schema.sql + 自检
```

`volumes/db/data/` 会被自动创建成空的 Postgres 数据目录 —— **数据不迁移**，
表结构由 `schema.sql` 重建。

### 2. 取回 supabase 官方 docker 目录（仅当需要更新 selfhosted/）

```bash
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/supabase/supabase.git supabase/_src
cd supabase/_src && git sparse-checkout set docker
# 再把 _src/docker 下需要的文件复制进 supabase/selfhosted/
```

### 3. 取回 tunnel-client（**仅容器 / 隧道形态需要**）

生产形态（`deploy/server/`）**不用隧道**，这一步可跳过。

```bash
# 规范路径：docker/Dockerfile 直接拉 ghcr.io/openai/tunnel-client:v0.0.14
# 需要本地跑时，下载 all.zip 并按 tunnel/dist/SHA256SUMS.txt 校验：
#   linux_amd64 / windows_amd64 / darwin_* 各一份，含 cloudflared
```

### 4. 生成工具目录并启动中继

```bash
cd relay
node tools/gen-catalog.js            # 起子进程拉真实 tools/list → catalog.json
node src/index.js                    # 监听 127.0.0.1:18086
```

`catalog.json` 是**必须入库的构建产物**：DesktopCommander 的 device 进程不上报
工具表（上游 `remote-channel.ts:441` 把 `capabilities` 参数整个丢弃），
所以 relay 必须自己持有工具目录，只用它做 `tools/list`，执行仍然路由到设备。

### 5. 接入设备

Windows 侧（cmd）—— 地址按形态选：本机联调 `http://127.0.0.1:18086`，
公网部署 `https://<你的域名>`：

```cmd
set MCP_SERVER_URL=http://127.0.0.1:18086
npx @wonderwhy-er/desktop-commander@latest remote
```

然后浏览器打开该地址的 `/device` 页点批准（公网形态要先登录 `/console`）。
授权是**人工的**，不存在自动批准（已用 30 秒 × 10 次轮询实测确认）。

> ⚠️ **同机跑第二个 device 会覆盖官方那台的凭据。** device 用 `os.homedir()`
> 定位 `~/.desktop-commander-device/device.json`，而这条路径在
> `dist/remote-device/device.js:21` 是**硬编码**的，没有现成环境变量可覆盖
> （`MCP_SERVER_URL` 只换服务地址，不改状态文件）。要并存得复制一份 dist 副本
> 并改那一行。现成做法见 [`windows/relay-device/`](windows/relay-device/README.md)。

### 6. 接到 ChatGPT

**生产形态（OAuth，推荐）**：connector 选 `Connection = Server URL`，填
`https://<你的域名>/mcp`，Client ID / Secret **留空**（走 DCR 自助注册），
授权时用控制台账号登录。完整步骤见
[`deploy/server/README.md`](deploy/server/README.md) 的「ChatGPT connector 要填什么」。

**容器 + 隧道那条备选路径**（静态令牌由 `MCP_EXTRA_HEADERS` 注入、connector 选
「无身份验证」）见 [`docker/README.md`](docker/README.md)。注意它**已不是推荐形态**：
静态头是配置期的，不是按请求签发的，所以那套只能做到「一个隧道 = 一个租户」。
需要每个终端用户各自登录，必须走 OAuth。

## 自检与探针

| 脚本 | 验什么 |
|---|---|
| `relay/tools/probe-realtime.js` | 风险最高的一环：高权限密钥（`service_role` 角色）广播能否送达私有频道订阅者（无此则整个方案不成立） |
| `relay/tools/smoke.js` | 把 device 会走的每一步原样走一遍 + RLS 正反断言 + MCP 协议 |
| `relay/tools/probe-capabilities.js` | 上游 DesktopCommander 的能力声明与工具表形状（`tools/list` 净化逻辑的依据） |
| `windows/mcp-call.js` | 调试用的 HTTP MCP 客户端，手工调单个工具 |
| `docker/scripts/verify.sh` | 容器侧链路验证 |

## 运维

- **控制台** `<MCP_SERVER_URL>/console` —— 设备在线状态、待批准授权、令牌管理。
  （旧的只读 `/status` 面板已退役，302 跳 `/console`。）
- **数据源** `GET /healthz`（JSON，`db_error` 应为 `null`）。
- **协议面与排错**见 `relay/README.md`；**部署、灰度与反代**见 `deploy/server/README.md`。

## 安全边界

上公网时逐条要求过的东西，现在**已经落地**（不再算待办）：

| # | 项 | 现状 |
|---|---|---|
| 1 | `/mcp` 端点鉴权 | ✅ 无条件要求 Bearer 令牌 —— `RELAY_REQUIRE_AUTH` 开关本身已删除 |
| 2 | 终端用户身份 | ✅ OAuth 2.1（DCR + PKCE + refresh 轮换）；设备授权页要求先登录控制台 |
| 3 | 多租户隔离 | ✅ 按 `user_id` 收窄，业务查询强制走 `supa.tenantScope()` |
| 4 | 入站 TLS / 反代 | ✅ 反代终结 TLS，回源只走 `127.0.0.1:18086` |
| 5 | 限流 | ✅ 按客户端 IP 的滑动窗口；批准接口单独一条更严的规则 |
| 6 | 注册开关 | ✅ `RELAY_ALLOW_SIGNUP=false`，只有管理员能开账号 |

**仍然成立、别忘的**：

- **`run_powershell` 级别的工具 = 当前用户的任意命令权限。** 这是权限放大，
  不是沙箱 —— 沙箱边界只有「哪个 OS 账号在跑 device 进程」。
  要收敛只能把 device 跑在专用的低权限账号下。
- **`device.json` 就是设备身份**，拿到它等于拿到那台机器的工具执行权。
  它落在 device 进程的 `os.homedir()` 下 —— 别让它进同步盘或备份。
- **`tools/call` 的落点由 `RELAY_ROUTE_POLICY` 决定**（默认 `auto-single`）：
  单台在线自动选，多台拒绝执行并列出候选。`auto-any`（自动选最近心跳）少一次确认，
  多一次写错机器的机会。
- **自托管 Supabase 那 5 个 KEY 仍沿用官方公开默认值**
  （`MINIO_ROOT_PASSWORD`、`S3_PROTOCOL_ACCESS_KEY_ID`、
  `S3_PROTOCOL_ACCESS_KEY_SECRET`、`SMTP_PASS`、`OPENAI_API_KEY`）。
  本地无碍；**只要把自托管那套暴露到公网就必须换**。生产用托管 Supabase
  不涉及这一条。（`gen-env.js` 有意没替换 —— 改这些会牵连 storage 与 Kong 的
  配置联动，属已知遗留项，不是疏漏。）
- **`MCP_BIND=::` 之类的监听地址若改成对外，路径 token 是唯一的门**，
  而它只提供「不知道 URL 就进不来」这层保护，不是认证。
- **密钥一律不入库。** 部署侧密钥走部署机上的 `secrets/*.txt`；
  `*.env` / `*.key` / `relay/.session-secret` 全在 `.gitignore` 里。
  提交前跑凭据反查（流程见 skill `git-baseline-secret-scan`）。

可复用的部署与排错经验记在 skill `openai-mcp-tunnel-deploy`。
