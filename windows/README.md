# Windows MCP server —— 让 ChatGPT 直接操作这台 Windows

## 为什么需要它

容器里**跑不了 Windows 程序**。这不是配置问题，是硬约束 —— 实测确认：

| 检查项 | 结果 |
|---|---|
| 容器内 `/proc/sys/fs/binfmt_misc/WSLInterop` | **不存在** |
| 容器内 `/mnt` | 空 |
| 容器内 `/run/desktop/mnt/host` | 不存在 |

Docker Desktop 的容器跑在 `docker-desktop` 这个 Linux VM 里，没有 WSL interop，所以
`powershell.exe` 这种 PE 可执行文件根本无法 exec。挂载 `C:\` 进去也只能读写文件，
不能执行。

于是把职责切开：

```
ChatGPT / Claude 网页版
   │  streamable HTTP MCP
   ▼
OpenAI 控制面（闭源，但已托管好）
   │  出站长轮询，无需公网入站
   ▼
容器：tunnel-client                    ← 管道。凭据在这里（secret 挂载）
   │  MCP over HTTP
   ▼  http://host.docker.internal:18090/t/<token>/mcp
Windows：本目录的 server.js             ← 手。真实机器权限
   │  PowerShell / cmd.exe
   ▼
你的 Windows
```

**tunnel-client 是管道，本进程是手。** 这个拆分让凭据留在容器里（不进 Windows 文件系统），
同时执行体拿到真实的本机权限。

---

## 快速开始

### 1. 准备配置

```powershell
cd C:\Users\longyuan\workspace\remote-mcp\windows
Copy-Item server.env.example server.env
# 编辑 server.env，把 MCP_PATH_TOKEN 改成你自己的随机串：
#   MCP_PATH_TOKEN=<32 位十六进制>
# 生成一个：node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

### 2. 启动

```powershell
.\start-mcp.cmd
```

前台跑，`Ctrl+C` 停。看到这几行就成了：

```
[windows-mcp-server] 已就绪(http) | 监听 ::18090 | runtime=windows-host | pid=...
[windows-mcp-server] MCP 端点: http://<本机IP>:18090/t/<token>/mcp
[windows-mcp-server] 健康检查: http://127.0.0.1:18090/healthz
[windows-mcp-server] 工具(7): run_powershell, run_cmd, read_file, write_file, ...
```

### 3. 把 docker 侧指过来

编辑 `../docker/.env`：

```ini
MCP_COMMAND=
MCP_SERVER_URL=http://host.docker.internal:18090/t/<同一个 token>/mcp
```

`MCP_COMMAND` **必须留空** —— 两个目标都指向 `main` channel 会启动失败：

```
mcp config: duplicate channel "main" from mcp.command (http-streamable already configured)
```

然后：

```bash
cd ../docker && docker compose up -d
docker compose logs tunnel | grep -E "mcp_target_kind|mcp session"
```

期望看到：

```
mcp_target_kind=http-streamable mcp_target_value=http://host.docker.internal:18090/t/.../mcp
mcp session initialized ... server_name=windows-mcp-server server_version=1.0.0
```

### 4. 开机自启（可选）

```powershell
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
# 卸载
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -Remove
```

注册一个登录时触发的计划任务，走隐藏窗口，日志落到 `server.out.log`。

---

## 工具（7 个）

| 工具 | 作用 |
|---|---|
| `run_powershell` | **主力**。任意 PowerShell 命令，支持管道与 cmdlet。进程、服务、注册表、网络、事件日志都能碰 |
| `run_cmd` | cmd.exe。少数只认 cmd 的老工具用 |
| `read_file` | 读文本文件，支持 `offset` / `limit` 分块 |
| `write_file` | 写文本文件，父目录自动创建，整文件覆盖 |
| `list_directory` | 列目录，含类型与大小 |
| `list_processes` | 按内存降序列进程，可按名字过滤 |
| `get_windows_info` | 主机名 / 用户 / OS 版本 / 磁盘 / 启动时长 / 执行环境标签 |

`get_windows_info` 的 `runtime` 字段是**判断请求落到哪台机器的唯一可靠依据**：

```
runtime       : windows-host          <- 命令实际执行的地方
is_container  : false
is_wsl        : false
hostname      : DESKTOP-4L9V2ID
```

---

## 配置（server.env）

| 键 | 默认 | 说明 |
|---|---|---|
| `MCP_PATH_TOKEN` | 空 | **强烈建议设**。设了就只接受 `/t/<token>/mcp` |
| `MCP_PORT` | `18090` | 避开 18080（隧道健康端口）和 8080（CDJ 容器） |
| `MCP_BIND` | `::` | 双栈。**不能改成 127.0.0.1** —— 容器经 `host.docker.internal` 连，绑 loopback 连不通 |
| `MCP_TRANSPORT` | `http` | `http` 给隧道用；`stdio` 给本机 MCP 客户端用（同一份代码两种形态） |
| `MCP_MAX_CHARS` | `20000` | 单次返回字符上限 |
| `MCP_ALLOWED_ROOTS` | 不限制 | 分号分隔的目录白名单，限制文件工具范围 |
| `MCP_BEARER` | 不用 | 设了就要求 `Authorization: Bearer <值>` |

真实环境变量优先级高于 `server.env`，便于临时覆盖。

### 为什么用路径里的 token

> ⚠️ **更正（2026-09-18）**：本节原先写着「`tunnel-client` 没有给 MCP server 发
> 自定义请求头的配置项」—— **这条是错的**。`mcp.extra-headers`
> （env `MCP_EXTRA_HEADERS`）就是发给所配置的 MCP server 的，官方还明确它
> **不经过 OpenAI 控制面**（见 `docs/configuration.md` 的 "Static MCP headers"
> 与 `docs/architecture.md` 的 auth / data flow 矩阵）。当初只看到
> `control_plane.extra_headers` 就下了结论，把两件事混成了一件。

路径 token 仍然是本目录的默认做法，理由与请求头无关：它另外挡住了
「同网段直接扫 18090 端口」这条路，而静态头只在经隧道转发时才生效。
想改用请求头的话：给本 server 设 `MCP_BEARER=<值>`，再在 `docker/.env` 里设
`MCP_EXTRA_HEADERS=Authorization: Bearer <同一个值>` —— 两者是一对。

代码里的路径门长这样：

```
http://host.docker.internal:18090/t/<MCP_PATH_TOKEN>/mcp
                                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 这就是门
```

不合规的路径返回 404，连 MCP 握手都进不来。

### 两个实测出来的编码坑

中文 Windows 上的输出编码是两头堵，两个都必须处理，否则看到的是乱码：

1. **`cmd.exe` 的内置字符串走 GBK**，即使命令前面加了 `chcp 65001` 也照样。
   → server 里对每个子进程的输出做判定：能严格往返 UTF-8 的当 UTF-8，否则按 GBK 解。
2. **PowerShell 的错误流在 stderr 被重定向时会序列化成 CLIXML**（一大坨 XML + `_x000D_` 转义）。
   → 用 `& { ... } *>&1 | Out-String` 把错误流并进 stdout，输出纯文本。
   代价是丢了 stdout/stderr 的区分。另外 `$ProgressPreference='SilentlyContinue'` 用来压掉
   "正在准备首次使用模块"的 progress 记录。

---

## 排错

| 现象 | 原因 |
|---|---|
| 容器日志 `duplicate channel "main"` | `docker/.env` 里 `MCP_COMMAND` 没留空 |
| 容器日志 `connection refused` | Windows 侧 server 没跑，或 `MCP_BIND` 绑成了 127.0.0.1 |
| `OAuth discovery failed` WARN | 正常。server 会回一份合法的 PRMD 元数据（无 `authorization_servers`），探测成功即无需鉴权 |
| `harpoon host auto-registration failed ... must use https` | 启动时出现 2 条，正常。Harpoon 是内置通道，拒绝注册明文 http 目标。我们不用 Harpoon |
| 工具输出乱码 | 上一节的两个编码坑被改坏了 |
| ChatGPT 看不到预期工具 | 换了 MCP server 后 ChatGPT 可能缓存旧工具列表 —— 在 Connectors 里删掉重建那个 app |

---

## 安全边界（必须清楚）

**这是本机全权限执行体，不是沙箱。**

- `run_powershell` 能跑当前用户能跑的任意命令，包括读注册表、连内网、改系统设置。
- 隔离靠"**谁能连到它**"（Docker 内部网络 + 路径 token + 可选 bearer），不靠进程内护栏。
- 但 `MCP_BIND=::` 意味着**同局域网可达**。路径 token 是唯一的门。所以：
  - token 别用弱值，别提交进 git（`server.env` 已在 `.gitignore`）。
  - 想再收紧，加一条 Windows 防火墙入站规则，只放行 Docker Desktop 的网段。
  - 只做文件操作不要命令执行的话，设 `MCP_ALLOWED_ROOTS` 并把 `run_powershell` 从工具列表里删掉。

这和 DesktopCommander 的口径一致：它的 `SECURITY.md` 也把 `allowedDirectories` 和
`blockedCommands` 明确定义为"安全护栏"而不是沙箱。

---

## 和 DesktopCommander 的关系

同一个类别（让网页版 AI 到达 NAT 后的机器），三层不同：

| | mcp.desktopcommander.app | 这套 |
|---|---|---|
| 中继 | DesktopCommander 自建（Supabase + 设备 OAuth，闭源） | **OpenAI 托管**（`tunnel-client` 出站长轮询） |
| 授权 | 每用户/每设备 OAuth device flow | OpenAI 平台组织级 RBAC |
| 执行体 | DesktopCommander server（25 工具）跑在你机器上 | 本目录的 server.js（7 工具）跑在 Windows 上 |
| 隔离 | 无，直接是宿主 | 管道在容器里，执行在 Windows |
| 能否产品化 | 能 | **不能** —— 官方明确不支持公共插件分发，RBAC 是平台组织级的 |

想升级工具数量：把 `../docker/.env` 的 `MCP_COMMAND` 换成
`npx -y @wonderwhy-er/desktop-commander@latest`、`MCP_SERVER_URL` 清空、Windows 侧 server 停掉。
但那条路是**容器内执行**，碰到了 Windows 又回到原问题 —— 所以本目录这个 server 才是
"操作 Windows"的正解。
