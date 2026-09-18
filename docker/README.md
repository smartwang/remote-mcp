# Docker Compose 部署：tunnel-client + MCP server

把原先裸装在 WSL 里的那套（`/root/.local/bin/tunnel-client`、`cloudflared`、
`/root/.local/share/minimal-mcp-server`）换成一个 compose 管理的自包含镜像。

**裸装产物已于 2026-09-18 全部清除**，原来的 `wsl/` 目录归档在
`_archive/wsl-bare-metal/`。

这个 compose 支持**两种执行模式**，靠 `.env` 切换，文件本身不用改：

| 模式 | MCP server 在哪 | `run_*` 实际执行 | 能力 |
|---|---|---|---|
| **A. 容器内**（原方案） | 容器内 `node /app/server.js` | 容器内 shell | 隔离好，但碰不到 Windows |
| **B. Windows 宿主**（当前） | `../windows/server.js`，监听 18090 | **真实 Windows** 的 PowerShell / cmd | 直接操作本机 |

模式 B 的原因是个硬约束：**容器里跑不了 Windows 程序**（无 binfmt/WSLInterop，
挂载 `C:\` 也只能读写不能执行）。详见 [`../windows/README.md`](../windows/README.md)。

## 快速开始

```bash
cd /mnt/c/Users/longyuan/workspace/remote-mcp/docker

# 1) 配置
cp .env.example .env
#    编辑 .env，填 CONTROL_PLANE_TUNNEL_ID
printf '%s\n' 'sk-你的RuntimeAPIKey' > secrets/control-plane.key
chmod 600 secrets/control-plane.key
#    模式 C（自建中继）还要一枚中继令牌 —— 这两条命令一起把文件建好并填进 .env：
node ../relay/tools/mint-tunnel-token.js
#    然后 .env 里设 MCP_EXTRA_HEADERS=Authorization: file:/run/secrets/relay_mcp_token
#    （模式 A/B 不用，MCP_EXTRA_HEADERS 留空即可；但 secrets/relay-mcp-token.txt
#      这个文件仍会被挂载，建个空文件即可）

# 2) 起
docker compose up -d --build

# 3) 验
docker compose ps                       # 期望 Up (healthy)
curl -fsS http://127.0.0.1:18080/readyz # 期望 ready
docker compose logs -f tunnel
```

`secrets/control-plane.key` 里必须放 **Runtime API key**，不是 admin key ——
admin key 喂给 daemon 会鉴权失败。

### 服务器形态：relay + tunnel 作为一个单元

前面那个 `up -d` 起的是**本机开发形态**（中继跑在宿主上）。要真正部署到服务器，
加上 `--profile server` —— 这时中继作为主服务、隧道作为它的边车一起起来：

```bash
# 1) 建三个 server 专用 secret（内容单行，结尾换行会被 trim）
cd docker
printf '%s\n' "$(openssl rand -hex 32)"     > secrets/relay-admin-token.txt
printf '%s\n' '<Supabase 的 ANON_KEY>'      > secrets/supabase-anon-key.txt
printf '%s\n' '<Supabase 的 SERVICE_ROLE_KEY>' > secrets/supabase-service-role-key.txt
chmod 600 secrets/*

# 2) .env 里切到服务器形态（三个变量，见 .env.example 末尾一节）
#    MCP_SERVER_URL=http://relay:18086/mcp      ← 用 compose 服务名，不走宿主
#    RELAY_PUBLIC_URL=https://mcp.example.com   ← device 授权链接靠它拼绝对地址
#    PUBLIC_SUPABASE_URL=https://<ref>.supabase.co

# 3) 起
docker compose --profile server up -d --build

# 4) 验
docker compose ps                                # 两个服务都应 Up (healthy)
curl -fsS http://127.0.0.1:18080/readyz          # 隧道就绪
docker compose exec relay node -e "fetch('http://127.0.0.1:18086/healthz').then(r=>r.text()).then(console.log)"
```

两个形态共用同一个 compose 文件，差别只有 `MCP_SERVER_URL` 一个变量。中继服务被
profile 挡住，所以开发形态下不会多起一个中继去抢宿主上的 18086。

三点要知道为什么这样设计：

- **compose 里的 relay 段用 `${VAR-default}` 而不用 `${VAR:?}`。** compose 的 `:?`
  插值对**所有**服务生效、**不认 profile** —— 用它会让本机开发形态也一起起不来。
  "必须有值"交给中继自己判（缺 ANON_KEY / SERVICE_ROLE_KEY 时拒绝启动并列出缺哪项）。
- **relay 的 18086 默认不发布到宿主。** 前面有 TLS 反代时应该让它走 compose 网络，
  端口不出现在宿主上。要自己直连就把 `ports` 那段取消注释 —— **只绑 127.0.0.1**，
  绑 0.0.0.0 会让 `/console` 与 `/api/mcp-info` 对局域网敞开。
- **`RELAY_COOKIE_SECURE` / `RELAY_ALLOW_SIGNUP` 在服务器形态下默认是紧的**
  （true / false）。注意 `RELAY_ALLOW_SIGNUP` 在源码里的默认值是
  `true`（开放注册），所以服务器上必须由 compose 显式压成 false。
  （`RELAY_REQUIRE_AUTH` 这个开关已经不存在了 —— `/mcp` 一律要求有效令牌，
  改用 OAuth 2.1 签发，见 `../relay/README.md`。）

中继的容器细节（零依赖镜像、`<KEY>_FILE` 白名单、会话密钥为什么必须持久化）
见 `../relay/README.md` 的「部署形态」。

### 别把「权限」和「key」搞混（三个页面）

官方 `docs/permissions.md` 开头就警告这是最常见的失败模式：混淆了**权限配置**、
**key 创建**、**tunnel 管理**三件事。

| 页面 | 管什么 |
| --- | --- |
| People & Permissions → **Roles** | 配置 Tunnels 的 **Read / Manage / Use**，授予人 / 组 |
| **api-keys**（Runtime API keys） | 创建 daemon 用的 key，建议选 Restricted 并勾 Tunnels Read + Use |
| **admin-keys**（Admin API keys） | 只给 `tunnel-client admin tunnels ...` 用，**不要**配进 daemon |

**「Use」这个权限不在 api-keys 页面上。** 它在
**Roles 页面 → 某个角色的 Permissions 按钮 → Manage permissions 弹窗 → Tunnels 这一行**
的下拉里，三个勾选项就是 Read / Manage / Use（对应权限原子
`api.organization.tunnel.read` / `.write` / `.use`）。

daemon 要能 poll，两层必须都满足：

1. **创建该 key 的 principal**（人 / 服务账号）拥有目标 tunnel 的 Tunnels **Read + Use**
2. **key 自身的范围**没把它排除（Restricted 建 key 时勾上 Tunnels）

缺任一层 → `403`。另外官方还提供预置的 **per-tunnel `User` 角色**（描述为
"Read-only role for API tunnels. Can read and use the tunnel..."），直接分配给
人 / 组也能覆盖 read + use，不用自建角色。

权限授完后官方建议**最多等 30 分钟**再重试 `tunnel-client doctor --explain`。

## 架构与执行边界（先读这段）

两条链路，只有最后一跳不同：

```
ChatGPT / Claude 网页版
   │  HTTPS
   ▼
OpenAI 控制面 (api.openai.com)          ← 默认；可用 CONTROL_PLANE_BASE_URL 换成自建中继
   │  出站长轮询（不需要公网入站）
   ▼
remote-mcp-tunnel 容器
   └─ tunnel-client
        ├─ 【模式 A】──stdio──▶ node /app/server.js          执行体在容器内
        └─ 【模式 B】──HTTP──▶ host.docker.internal:18090  执行体在 Windows 宿主
                                  → powershell.exe / cmd.exe → 真实 Windows
```

模式 B 的拆分逻辑：**tunnel-client 是管道，Windows 上的 server 是手。**
凭据留在容器里（secret 挂载，不进 Windows 文件系统），执行体拿到真实本机权限。

### 两种模式下「执行边界」怎么看

| 想看什么 | 模式 A（容器内） | 模式 B（Windows，当前） |
|---|---|---|
| 命令在哪跑 | `get_system_info` 的 `runtime` → `container` | `get_windows_info` 的 `runtime` → **`windows-host`** |
| 能不能碰宿主 | 只看 `host_mounts` 那行 | 直接就是宿主，无需挂载 |
| 工具集 | `run_command` + 文件工具（5 个） | `run_powershell` / `run_cmd` + 文件与进程工具（7 个） |

**模式 A 的两个直接后果**（切回去时注意）：

| 想看什么 | 怎么看 |
|---|---|
| 命令在哪跑 | `get_system_info` 的 `runtime` 字段 → `container` |
| 能不能碰宿主 | 只看 `host_mounts` 那行；没挂载就是碰不到 |
| 原来 `is_wsl: true` 的判据 | **失效了**。容器里恒为 `is_wsl: false` + `is_container: true` |

模式 A 下要碰宿主文件，走 compose 里的两行挂载（默认已给）：

```yaml
- ${HOST_WORKSPACE:-/mnt/c/Users/longyuan/workspace}:/host/workspace
- ${HOST_HOME:-/root}:/host/wsl-home
```

不想要宿主访问就整段删掉，server 会自报「当前没有挂载宿主目录」。

### 怎么切模式

只改 `.env`：

```ini
# 模式 A
MCP_COMMAND=node /app/server.js
MCP_SERVER_URL=

# 模式 B
MCP_COMMAND=
MCP_SERVER_URL=http://host.docker.internal:18090/t/<token>/mcp
```

`MCP_COMMAND` 在模式 B 下**必须留空**。两个目标都指向 `main` channel 会启动失败：

```
mcp config: duplicate channel "main" from mcp.command (http-streamable already configured)
```

compose 里用的是 `${MCP_COMMAND-...}`（`-` 而不是 `:-`），这样空字符串能原样传进去 ——
实测 tunnel-client 把空值当作「未设置」。

## 端口为什么是 18080

容器内固定 8080，宿主侧映射到 **18080**。原因：宿主 8080 被
`cdj-local-deploy-public-api-1`（你自己的 CDJ 容器，`0.0.0.0:8080->8080/tcp`）
占着 —— 不是 Docker Desktop 自己占的，是那个容器。

只绑 `127.0.0.1`：官方明确提醒健康端口不要暴露到非可信网络。

**顺带一个发现**：健康端口不只是 `/readyz`，还挂了内置 admin UI 和 metrics：

- `http://localhost:18080/ui` —— 运行态、日志、指标
- `http://localhost:18080/metrics`

调试时会很有用。

## 已验证 / 未验证

**已实测通过（2026-09-18，WSL2 + Docker Desktop 4.69 + Windows 11 26200）：**

| 项 | 结果 |
|---|---|
| 镜像构建 | `remote-mcp-tunnel:local` 构建成功 |
| 容器内 stdio 协议自检（模式 A） | **7/7 PASS** |
| 容器内 `run_command` 穿透隧道 | **7/7 PASS**，`runtime=container` |
| **真实 OpenAI 控制面** | `tunnel metadata fetched`，`name=smartwang-dev-pc`；`/readyz` → `ready`；**零 403** |
| ChatGPT connector | 已建成，工具列表可见 |
| Windows server 本机 7 个工具 | **7/7 PASS** |
| **模式 B 全链路**（WSL 客户端 → 容器 ingress → 内存控制面 → 容器 tunnel-client → HTTP → Windows server → PowerShell） | **7/7 PASS**，返回 `runtime=windows-host` / `is_wsl=false` |
| 模式 B 正式链路（真实控制面 + 容器内 tunnel-client 指向 Windows） | `mcp_target_kind=http-streamable`、`mcp session initialized server_name=windows-mcp-server` |
| 中文编码（PowerShell 与 cmd 两条路） | 正常，无乱码 |
| compose 完整启动 | `Up (healthy)` |
| secret 挂进容器 | `/run/secrets/control_plane_key` |

模式 B 的链路是在**容器内用 `dev proxy`**（内存版控制面 + 完整 runtime）验证的，
所以不依赖 OpenAI 凭据就能证明"隧道 → Windows 执行体"这一段是通的。

**未验证：** 模式 B 下**经 ChatGPT 触发**的一次真实调用。链路各段都单独验过，
但"ChatGPT 点一下 → 打到 Windows"这个组合还没走过。

## 容器内自验证（不需要任何凭据）

```bash
cd /mnt/c/Users/longyuan/workspace/remote-mcp/docker
docker run --rm --entrypoint /app/verify.sh \
  -v /mnt/c/Users/longyuan/workspace:/host/workspace \
  -v /root:/host/wsl-home \
  remote-mcp-tunnel:local
```

6 步：执行环境 → stdio 自检 → 起 dev proxy → 解析 ingress URL →
HTTP 自检 → 真实命令穿透。全绿退出码 0。

## 常用操作

```bash
docker compose logs -f tunnel          # 跟日志
docker compose restart tunnel          # 重启
docker compose down                    # 停 + 删容器（镜像和配置留着）
docker compose up -d --build           # 改完代码/版本后重建
docker compose config                  # 看插值后的最终配置
```

**换 MCP server**（模式 A 下换容器内的执行体）：只改 `.env` 一行。

```bash
MCP_COMMAND=npx -y @wonderwhy-er/desktop-commander@latest
```

但注意：DesktopCommander 也是**容器内**执行，碰不到 Windows。要操作 Windows
就用模式 B 的 `../windows/server.js` —— 那是同一条链路上唯一能在 Windows 上执行的一环。

换之前建议先跑一遍 `selftest.js` 查它的 stdout 干不干净 —— stdio 传输下
往 stdout 打任何非协议内容都会污染协议流。镜像里已经有这个自检：

```bash
docker run --rm --entrypoint node remote-mcp-tunnel:local \
  /app/selftest.js -- npx -y @wonderwhy-er/desktop-commander@latest
```

模式 B 的对应自检（直接打 Windows server，不经过容器）：

```bash
node ../windows/mcp-call.js http://127.0.0.1:18090/t/<token>/mcp --list
```

**指向自建控制面**：改 `.env` 的 `CONTROL_PLANE_BASE_URL` 即可
（这一行默认就是 `https://api.openai.com`，为后续自建中继预留）。

## 三个实测踩过的坑

**① 宿主 8080 被占。** 官方容器文档的示例是 `-p 8080:8080`，在你这台机器上必然失败。
占用者是 `cdj-local-deploy-public-api-1`。已改用 18080。

**② 命令行 flag 不覆盖 profile 里的值。** 这与 `--help` 里写的
`flags > environment > YAML > defaults` 优先级不符，实测确认过。
容器方案里我们**不用 profile**，全走环境变量 + 一个 `command` flag，
所以绕开了这个问题 —— 但也别往容器里塞 profile。

**③ 环境变量会静默覆盖 profile 的 key 文件引用。** 两行都显示 PASS，
doctor 不告诉你用了哪个。容器里不用 profile，同样不受影响。

## 安全提醒

- 容器内默认 root，`run_command` 等于**容器内的 root shell**。比裸装在 WSL 里
  更收敛（碰不到宿主，除非挂载），但仍是全权限执行体。
- 挂载了 `/host/workspace` 和 `/host/wsl-home`，所以容器能读写这两棵树 —— 这是你
  明确要的能力，但要知道边界在哪。
- `secrets/control-plane.key` 在 `.gitignore` 里。注意 compose 的非 swarm
  secrets 是 bind mount，容器内看到的权限跟随宿主文件，设不成 0400。
- 隧道版**不能产品化**（官方不支持公共插件分发，RBAC 是平台组织级）。
  它的价值是给你一个"ChatGPT 确实能操作我这套"的确定性事实。

## 日常使用

### 本地 admin UI（容器 8080 → 宿主 18080）

`http://localhost:18080/ui` —— **这是运维面板，不是使用入口**。它只用来确认 runtime
真的活着、以及看真实错误。使用入口在 ChatGPT 那一侧。

实测 tab 有 **7 个**（官方 `end-user-guide.md` 只列了 4 个）：

| Tab | 看什么 |
| --- | --- |
| Overview | Client（版本 / uptime / 健康地址）+ Control plane（base URL、tunnel id、tunnel name、poll timeout、max inflight）+ Channels 表 |
| Metrics | 同 `/metrics` 的 Prometheus 指标。`commands_poll_cycles_total` 与 `commands_poll_*_error` 是判断控制面连通的关键 |
| Logs | 实时日志流 + 过滤 + 导出 support bundle。**排错首选** |
| System | 运行时系统信息 |
| OAuth | OAuth 发现状态。我们用 stdio 无鉴权，这里应为空 |
| Harpoon | 内置 in-memory 通道。我们没配 targets → `disabled` / `no harpoon targets registered`，属正常 |
| Assistant | Codex bridge 状态。不用 Codex 可忽略 |

右上角三个徽章 **Health / Ready / Logs** 对应 `/healthz`、`/readyz` 与日志流连通状态。

同端口的裸端点：`/healthz`（进程活着）、`/readyz`（启动检查 + 下游 MCP 就绪）、`/metrics`。

### 接入 ChatGPT

`https://chatgpt.com/#settings/Connectors` → **New App (BETA)**：

1. Connection 选 **Tunnel**（另一个选项是 Server URL）
2. Available tunnels 下拉里选你的 tunnel，或直接粘贴 `tunnel_id`
3. **Authentication** —— 三档：`OAuth` / `无身份验证` / `混合`（Mixed）。
   **没有 API key 这一档** —— 别去找它。选哪档取决于你的 MCP server：

   | 你的 MCP server | 选什么 | 为什么 |
   | --- | --- | --- |
   | 无鉴权（模式 A/B 的自写 server） | 无身份验证 | 没人需要出示身份 |
   | 自建中继（模式 C），令牌走静态头 | **无身份验证** | 见下条 —— 静态头由隧道注入 |
   | 自己实现了 OAuth 授权服务器 | OAuth | ChatGPT 会自己去读 protected-resource metadata |

   `混合` 的含义是：`initialize` / `tools/list` 免鉴权，单个工具调用按
   per-tool security scheme 要求认证。我们两种形态都用不上它。

   选 `OAuth` 时 ChatGPT 会去读 `/.well-known/oauth-protected-resource`；
   中继虽然提供这个路径但**不含 `authorization_servers`**（当初是为了消掉隧道的
   一条 discovery 告警），所以 OAuth 档在这里走不通 —— 我们的令牌是自签的
   `rmcp_…`，不是 OAuth access token。

   ⚠️ **为什么模式 C 必须选「无身份验证」**：connector 转发来的 `Authorization`
   头会**覆盖**隧道注入的静态头（官方：connector-forwarded headers apply last）。
   留在 `OAuth` / `混合` 档就可能把中继的令牌顶掉，导致 401。

**建 connector 期间 daemon 必须活着**，之后每次工具调用也都要求它运行 ——
connector 的发现与调用都走隧道。本 compose 是 `restart: unless-stopped`，正常不会掉。

若 picker 里看不到 tunnel，官方给三条排查：tunnel 创建时的 workspace scope 不对、
connector 操作者缺 Tunnels **Use**、或 daemon 没 ready。前两条都不满足就直接粘 `tunnel_id`。

### 给 MCP server 加静态凭据（`MCP_EXTRA_HEADERS`）

这是官方支持的两条路之一（另一条是给不可达 OpenAI 的要求直接别用隧道）。

```bash
# 1) 生成令牌 + 写文件（模式 C 用；会一并写进 docker/secrets/）
node ../relay/tools/mint-tunnel-token.js

# 2) .env 里引用它（值必须整值写成 file:/…，不能写 "Bearer file:/…"）
MCP_EXTRA_HEADERS=Authorization: file:/run/secrets/relay_mcp_token

# 3) 重建容器
docker compose up -d
```

几个容易踩的点：

- **文件内容是完整头值** `Bearer rmcp_<prefix>_<secret>`，前缀要写在文件里 ——
  `file:` 是**整值匹配**，`Authorization: Bearer file:/path` 会被当字面量。
  末尾可以有且仅有一个换行，tunnel-client 会裁掉一个行尾。
- **值里不能有 `,` 或 `;`** —— 环境变量形式按这两个字符切成多个头。
- 作用域只有「tunnel-client → 配置的 MCP server 源」这一跳，官方明确
  **不发往 OpenAI 控制面**；但它是**静态配置**，不是按请求签发的短期令牌。
- 留空 `MCP_EXTRA_HEADERS=` 就完全不注入（模式 A/B 的形态）。

## 当前状态与下一步

凭据已配齐，隧道实时连着。**当前是模式 B（Windows 宿主）**：

```bash
# 1) 确认 Windows 侧 server 在跑（另开一个窗口，或已装开机自启）
Windows: C:\Users\longyuan\workspace\remote-mcp\windows\start-mcp.cmd
   或:   powershell -ExecutionPolicy Bypass -File ...\windows\install-autostart.ps1

# 2) 确认容器侧指到了它
docker compose logs tunnel | grep mcp_target_kind
# 期望 mcp_target_kind=http-streamable mcp_target_value=http://host.docker.internal:18090/t/.../mcp

# 3) 不经 ChatGPT 先验一遍（可选，但能省掉大量排查）
node ../windows/mcp-call.js http://127.0.0.1:18090/t/<token>/mcp get_windows_info
```

4) **回 ChatGPT 里刷新 connector。** 换了 MCP server 之后 ChatGPT 可能还缓存着
旧工具列表（模式 A 的 5 个工具）。在 Connectors 里删掉那个 app 重建，或看有没有刷新入口。

验收判据：让 ChatGPT 调 `get_windows_info`，返回 **`runtime: windows-host`**、
`is_wsl: false`。那才说明请求真的落到了 Windows，而不是容器或 WSL。
