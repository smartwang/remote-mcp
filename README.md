# remote-mcp

自建一套「云端·闭源」层，替换 <https://mcp.desktopcommander.app/>，
让 ChatGPT / Claude 能操作本机上未改一行的 DesktopCommander。

**基线状态（2026-09-18）**：全链路已跑通，26 个工具可从 ChatGPT 侧调用，
执行落点在 Windows 宿主上。**多租户鉴权已完成**（令牌 / 浏览器控制台 / 管理员面 /
设备按租户隔离），隔离性有 48 条对抗性断言实测支撑。尚未上公网 —— 剩下的前置条件
是 TLS、反代与部署收敛，见文末。

---

## 整体拓扑

```
        ChatGPT / Claude
               │  HTTPS (MCP)
               ▼
     OpenAI Secure MCP Tunnel          ← 当前这一跳是临时的，去公网时替换掉
               │  出站长轮询，不开入站端口
               ▼
   ┌───────────────────────────┐
   │  relay      127.0.0.1:18086│      ← 本项目写的部分：
   │  /api/mcp-info             │        只做「协议转译 + 门铃派发」
   │  /device/*                 │        4 个端点，代码在 relay/
   │  /mcp                      │
   └───────────────────────────┘
               │  PostgREST 写队列 + Realtime 广播
               ▼
      自托管 Supabase  127.0.0.1:8000     ← 数据层与实时广播，官方 docker 栈
               ▲
               │  device 直连（不过 relay）
               │
  Windows 上的 `desktop-commander remote`   ← 官方 CLI，零改动
               │  stdio
               ▼
  DesktopCommander MCP（26 个工具）
```

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
| `windows/` | Windows 宿主侧的辅助件（早期 7 工具 server、启动脚本、调试客户端） | ✅ |
| `docker/` | 把 tunnel-client 与 MCP server 打成单容器的 Compose | ✅ |
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
node tools/gen-env.js --force        # 生成 .env（JWT secret + anon/service key）
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

### 3. 取回 tunnel-client（仅当需要本地二进制）

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

Windows 侧（cmd）：

```cmd
set MCP_SERVER_URL=http://127.0.0.1:18086
npx @wonderwhy-er/desktop-commander@latest remote
```

然后浏览器打开 <http://127.0.0.1:18086/device> 点批准。授权是**人工的**，
不存在自动批准（已用 30 秒 × 10 次轮询实测确认）。

> 同机跑第二个 device 实例会覆盖官方那台的凭据（device 用 `os.homedir()`
> 定位 `~/.desktop-commander-device/device.json`）。要并存必须给它独立的
> `USERPROFILE`。

### 6. 接到 ChatGPT（可选）

```bash
# docker/.env
MCP_SERVER_URL=http://host.docker.internal:18086/mcp
docker compose up -d
```

## 自检与探针

| 脚本 | 验什么 |
|---|---|
| `relay/tools/probe-realtime.js` | 风险最高的一环：service_role 广播能否送达私有频道订阅者（无此则整个方案不成立） |
| `relay/tools/smoke.js` | 把 device 会走的每一步原样走一遍 + RLS 正反断言 + MCP 协议 |
| `relay/tools/probe-capabilities.js` | 上游 DesktopCommander 的能力声明与工具表形状（`tools/list` 净化逻辑的依据） |
| `windows/mcp-call.js` | 调试用的 HTTP MCP 客户端，手工调单个工具 |
| `docker/scripts/verify.sh` | 容器侧链路验证 |

## 运维

- 面板 <http://127.0.0.1:18086/status> —— 只读，5 秒自刷：设备在线状态、
  广播投递成败计数、待批准授权。
- 数据源 `GET /healthz`（JSON）。
- 协议面与排错细节见 `relay/README.md`。

## 安全边界（上公网前必读）

现在这套是**单机、单账号、可信网络**的形态，下面每一条都是上公网的前置条件，
不是优化项：

1. **`/device/start` 建的是单账号。** 授权页谁都能点，没有身份校验。
2. **`tools/call` 的目标设备是全局挑选的。** 多设备/多租户会串数据，
   必须按 `user_id` 收窄。
3. **`run_powershell` 级别的工具等于当前用户的任意命令权限。** 这是权限放大，
   不是沙箱 —— 沙箱边界只有「哪个 OS 账号在跑 device 进程」。
4. **密钥全在本机 `.env` 里**，已全部排除在版本控制外。Supabase 侧的
   `JWT_SECRET` / `ANON_KEY` / `SERVICE_ROLE_KEY` / `POSTGRES_PASSWORD` /
   `DASHBOARD_PASSWORD` 等由 `supabase/selfhosted/tools/gen-env.js` 现场生成，
   每个部署一套；`docker/.env` 里的 `CONTROL_PLANE_API_KEY` 与
   `windows/server.env` 里的 `MCP_PATH_TOKEN` 同理。
5. **有 5 个 KEY 沿用官方公开默认值**（等于 `.env.example` 里的示例值，
   全球部署都一样）。本地无碍，**上公网必须换**：

   `MINIO_ROOT_PASSWORD`、`S3_PROTOCOL_ACCESS_KEY_ID`、
   `S3_PROTOCOL_ACCESS_KEY_SECRET`、`SMTP_PASS`、`OPENAI_API_KEY`

   `gen-env.js` 有意没有替换它们 —— 改这些会牵连 storage 服务与 Kong 的
   配置联动，属于已知遗留项，不是疏漏。
6. 去掉隧道这一跳后，需要自己实现：入站 TLS、MCP 端点鉴权、限流。
7. `MCP_BIND=::` 之类的监听地址若改成对外，**路径 token 是唯一的门**，
   而它只提供「不知道 URL 就进不来」这层保护，不是认证。

可复用的部署与排错经验记在 skill `openai-mcp-tunnel-deploy`。
