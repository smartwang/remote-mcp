# WSL 隧道版：先把基础流程跑通

目标：**ChatGPT → OpenAI Secure MCP Tunnel → WSL 里的本机 MCP server**，
零公网、零部署、不需要买任何东西。这一步验证的是"ChatGPT 能不能真的操作我这台机器"
这条链路本身，为后面自建中继（多用户版）排除不确定性。

---

## 0. 现在的状态（证据分级，别混着看）

| 项 | 状态 | 怎么验的 |
|---|---|---|
| tunnel-client 二进制 | **已验证** | v0.0.14，164,274,450 字节，SHA256 与官方 `SHA256SUMS.txt` 一致 |
| 自研 MCP server 协议层 | **已验证** | stdio 自检 **7/7 PASS** |
| 官方 stub 的 HTTP 通路 | **已验证** | `dev mcp-stub` 自检 **7/7 PASS** |
| WSL 内实际执行 | **已验证** | `wsl.exe` 权限已放开，在 WSL 里跑通自检 7/7，`is_wsl: true` |
| **隧道数据通路** | **已验证（离线）** | 用 `tunnel-client dev proxy` 起本地内存控制面 + 真实 runtime，真实 shell 命令穿透回传 |
| `doctor` 配置校验 | **已验证** | `RESULT ok`，全部 CHECK 通过（占位 tunnel_id + 占位 key） |
| 真实 tunnel 连接（OpenAI 托管侧） | **未验证** | 缺真实 `tunnel_id` 与 runtime key |
| ChatGPT 侧 connector | **未验证** | 必须在 ChatGPT UI 里操作，且要求 daemon 在跑 |

> **"隧道数据通路已验证"要准确理解**：`dev proxy` 用的是**内存实现的控制面**，
> 不是 OpenAI 托管的那套。所以它证明的是"tunnel-client 这一侧 + 本地 MCP server
> + 隧道传输逻辑都是好的"，**没有**证明 OpenAI 控制面侧的鉴权、tunnel 注册、
> ChatGPT connector 发现。后三者仍待你的凭据。

---

## 1. 你需要提供什么（全部来自 OpenAI 平台）

平台地址：<https://platform.openai.com/settings/organization/tunnels>

| 值 | 从哪拿 | 谁在用 | 权限要求 |
|---|---|---|---|
| `tunnel_id` | Tunnels 管理页新建/复制 | 写进 profile | 创建者需 Tunnels **Read + Manage** |
| `CONTROL_PLANE_API_KEY` | Runtime API keys 页新建 | **常驻 daemon 用这个** | 该 key 的主体需 Tunnels **Read + Use** |
| `OPENAI_ADMIN_KEY`（可选） | Admin API keys 页 | 只在用 CLI 做 tunnel 增删改时要 | 另外需要 admin-key 权限 |

三条硬规矩（官方 help 里反复强调的）：

1. **两个 key 不能混用。** runtime key 给 daemon，admin key 只给 `tunnel-client admin tunnels ...`。
   把 admin key 塞给常驻进程是明确的错误用法。
2. **角色分配后最多要等 30 分钟生效。** 刚授完权就失败，先等，别急着 debug。
3. **ChatGPT 侧建 connector 必须在 daemon 运行时进行**，之后每次调用也都要求 daemon 活着。
   daemon 不跑，ChatGPT 里连 tunnel 都发现不到 —— 这是最容易误判成"配置错了"的点。

---

## 2. 目录内容

```
remote-mcp/wsl/
├── bin/
│   ├── tunnel-client           # linux amd64，v0.0.14
│   └── cloudflared             # 必须和上面同目录（tunnel-client 同级发现它）
├── mcp-server/
│   ├── server.js               # 零依赖 stdio MCP server，5 个工具
│   └── selftest.js             # 最小 MCP 客户端，stdio + HTTP 双传输
├── setup.sh                    # 幂等安装 + 分层验证（7 步，前 6 步不需要任何凭据）
├── verify-tunnel-path.sh       # 隧道数据通路离线验证（不需要 OpenAI 凭据）
└── README.md                   # 本文件
```

在 WSL 里对应的路径是 `/mnt/c/Users/longyuan/workspace/remote-mcp/wsl`。

⚠️ **不要直接跑 `/mnt/c/...` 下的二进制**。drvfs 挂载不带可执行位，会 `Permission denied`。
`setup.sh` 用 `install -m 0755` 复制到 `~/.local/bin` 再执行，这是唯一可靠的做法。

---

## 3. 在 WSL 里执行

### 第一步：装好 + 跑完全部离线验证（不需要任何凭据）

```bash
cd /mnt/c/Users/longyuan/workspace/remote-mcp/wsl
bash setup.sh
```

七步逐项打 OK/WARN：

| 步 | 做什么 |
|---|---|
| 0 | 确认在 WSL；找 Node（v18 就够） |
| 1 | 两个二进制 `install` 到 `~/.local/bin` |
| 2 | `tunnel-client` CLI 可用性 |
| 3 | 部署 MCP server 到 `~/.local/share/minimal-mcp-server` |
| 4 | MCP 协议自检（stdio，7 项断言） |
| 5 | `run_command` 真实执行自检 |
| 6 | **隧道数据通路离线验证**（`dev proxy`，不需要凭据） |
| 7 | 生成 profile + `doctor`（这一步才需要 `tunnel_id`） |

第 6 步是这轮新增的重点，单独跑也行：

```bash
bash verify-tunnel-path.sh
```

它做的事：起本地内存控制面 + 真实 tunnel-client runtime，拿到本地 MCP ingress URL，
然后对这个 URL 发完整 MCP 请求并让**真实 shell 命令**穿透回来。跑绿了就等于
"隧道这一半没问题"，把后面排查时的变量从两个减到一个。

### 第二步：生成 profile 并让 daemon 起来

三种给 key 的方式，**推荐第一种**：

```bash
export PATH="$HOME/.local/bin:$PATH"

# A) 已有 key 文件（最稳：key 不进 shell 历史、不进环境变量、不进 ps）
CONTROL_PLANE_TUNNEL_ID=tunnel_xxx \
CONTROL_PLANE_API_KEY_FILE=/path/to/control-plane.key \
bash setup.sh

# B) 直接给 key —— 脚本会落盘成 0600 文件，并在 profile 里引用该文件
CONTROL_PLANE_TUNNEL_ID=tunnel_xxx CONTROL_PLANE_API_KEY=sk-xxx bash setup.sh

# C) 什么都不给 —— profile 里写 env:CONTROL_PLANE_API_KEY，跑之前自己 export
CONTROL_PLANE_TUNNEL_ID=tunnel_xxx bash setup.sh
```

然后前台跑（窗口别关）：

```bash
tunnel-client run --profile wsl-stdio
```

### 第三步：确认 daemon 真健康

另开一个 WSL 窗口：

```bash
curl -fsS http://127.0.0.1:18080/readyz && echo
```

看 UI（本机浏览器打开）：<http://127.0.0.1:18080/ui>

**注意端口不是 8080** —— 见下面的已知坑。

**`readyz` 绿了再碰 ChatGPT。** 官方文档特别提醒：本地健康和控制面轮询是两回事 ——
`/healthz`、`/readyz` 绿着，也可能因为代理问题根本没在轮询控制面。
所以除了 `readyz`，也要在 `/ui` 里确认 `control_plane_poll_health` 是好的。

---

## 4. ChatGPT 侧

1. <https://chatgpt.com/#settings/Connectors> → 新建 developer-mode app
2. Connection 类型选 **Tunnel**
3. 列表里选中你的 tunnel（选不到就粘 `tunnel_id`）
4. 试这三句，验证工具真的落地了：

```
用 get_system_info 告诉我这台机器的信息
用 run_command 跑一下 uname -a 和 pwd
列出我主目录里的文件
```

**选不到 tunnel 时按顺序查**：tunnel 是否关联到了**目标 ChatGPT 工作区**
（只挂 Platform 组织不够）→ 创建者是否有 Tunnels **Read + Use** → daemon 是否在跑。

---

## 5. 验证阶梯（每级都要独立过，别跳）

| 级 | 检查 | 期望 | 现状 |
|---|---|---|---|
| 1 | `bash setup.sh` 的 MCP 自检 | 7/7 PASS | **已过** |
| 2 | `bash verify-tunnel-path.sh` | 隧道通路 7/7 PASS | **已过** |
| 3 | `tunnel-client doctor --profile wsl-stdio --explain` | `RESULT ok` | **已过**（占位值） |
| 4 | `curl /readyz` | HTTP 200 | 待真实凭据 |
| 5 | `/ui` 的 control_plane_poll_health | 正常 | 待真实凭据 |
| 6 | ChatGPT 里 connector 能发现 tunnel | 列表可见/可选 | 待你操作 |
| 7 | ChatGPT 调 `get_system_info` | 返回 WSL hostname、`is_wsl: true` | 待你操作 |
| 8 | ChatGPT 调 `run_command` | 真执行并回显 | 待你操作 |

第 7 级返回里 `is_wsl: true` 是**关键判据** —— 它证明请求落到了 WSL 而不是 Windows 宿主。

---

## 6. 两个实测踩到的坑（官方文档没写）

### ① 8080 端口在这台机器上被 Docker Desktop 占了

官方样例 `sample_mcp_stdio_local` 默认 `health.listen_addr: 127.0.0.1:8080`。
但本机 `com.docker.backend`（PID 13596）占着 `0.0.0.0:8080`，`wslrelay` 又把它转发进
WSL，所以照抄样例必然报：

```
CHECK health_listener  FAIL  listen tcp 127.0.0.1:8080: bind: address already in use
```

`setup.sh` 现在会自动探测空闲端口（从 18080 起），选中的端口会打印出来。
手动指定用 `HEALTH_PORT=28080 bash setup.sh`。

### ② 环境变量会**静默覆盖** profile 里的 key 文件引用

文档写的优先级是 `flags > 环境 > YAML > 默认`。实测确认：

```
不导出环境变量  → CHECK control_plane_api_key  PASS  configured      （走 profile 的 file: 引用）
导出假值        → CHECK control_plane_api_key  PASS  env:CONTROL_PLANE_API_KEY
```

两行都是 PASS —— **看不出实际用了哪个**。所以：如果你曾经 export 过
`CONTROL_PLANE_API_KEY`，之后换了 key 文件也不会生效，直到那个环境变量消失。
`doctor` 不会告诉你这件事。排查鉴权失败时先 `unset CONTROL_PLANE_API_KEY` 再看。

---

## 7. 已知约束（都来自官方内建帮助）

- **不要用 `nohup` / `disown` 守护 daemon。** 官方明说 supervision 要走
  `tunnel-client runtimes connect ...`，前台常驻才用 `run --profile`。
  之后用 `tunnel-client runtimes status <alias>` 确认（`--json` 会给
  `process_running` / `healthy` / `ready` 三个字段）。
- **`cloudflared` 和 `tunnel-client` 不能拆散。** 发行包靠"同级目录发现"定位 cloudflared。
- **日志/UI 导出会脱敏**：API key、bearer token、cookie、URL 里的凭据都会被涂掉，
  可以放心贴出来排查。
- **headless 场景**用 `--health.listen-addr 127.0.0.1:0 --health.url-file <path>`，
  端口由系统分配后写进文件，避免端口冲突。
- **这条隧道不能产品化。** 官方文档明确：隧道不支持公共插件提交或分发，且 RBAC 是
  OpenAI **平台组织级**的 —— 每个用户都得有自己的组织、tunnel、runtime key。
  所以多用户产品最终仍要走自建中继，这个隧道版只用于**开发和自用验证**。
- **`--mcp-command` 的完整语法**是 `command=...,channel=...`（可重复）。
  只给命令时默认绑 `channel: main`，与官方样例一致。

---

## 8. 安全提醒（本机实际情况）

这个 WSL 实例**不是干净环境**：默认用户是 **root**，里面还跑着 nginx、redis、mongodb、
chromium、codeanywhere 等服务。所以：

- MCP server 的 `run_command` 在这里拿到的是 **WSL 内的 root shell**。
  这是自动化所需，但不要把它当成隔离层 —— 它是权限放大，不是沙箱。
- 隧道给 ChatGPT 的能力边界 = 这个进程能碰到的全部，包含 `/mnt/c` 下的 Windows 文件。
- 想收紧就把 `server.js` 的 `run_command` 换成白名单，或者换成一个只读的 server。

---

## 9. 第二阶段：换成真正的 DesktopCommander

基础流程通了之后，把 `--mcp-command` 换掉就行 —— 只是改一个字符串：

```bash
tunnel-client init --sample sample_mcp_stdio_local --profile dc-stdio \
  --tunnel-id 'tunnel_...' \
  --mcp-command "npx -y @wonderwhy-er/desktop-commander@latest" \
  --health-listen-addr 127.0.0.1:18080 --force
```

换之前先用自检脚本确认它 stdout 干净（MCP stdio 传输下，任何非协议输出都会污染流）：

```bash
node ~/.local/share/minimal-mcp-server/selftest.js -- \
  npx -y @wonderwhy-er/desktop-commander@latest
```

自检里那条 `stdout 干净（无协议外输出）` 就是专门为这个场景加的。
（DesktopCommander 的 README 里有登录横幅/日志，这一步别跳过。）

> 注意作用域：在 WSL 里跑它，它操作的是 **WSL 的文件系统**（Windows 的 C: 挂在 `/mnt/c`，
> 所以也能碰到 Windows 文件）。这本身是一层弱隔离，别当成沙箱。

---

## 10. 与最终目标的关系

这一步跑通之后，你会拿到一个"ChatGPT 确实能操作我这台机器"的确定性事实。
之后自建中继要复刻的就是这条链路里除 OpenAI 之外的部分：

```
本版（隧道）        ChatGPT → OpenAI 控制面 → cloudflared 隧道 → tunnel-client → 本地 MCP server
目标（自建中继）    ChatGPT → 你的 MCP endpoint → 你的 relay → device 进程 → 本地 MCP server
```

`tunnel-client` 已替掉的东西：NAT 穿透、控制面长轮询、健康与 UI 运维面、
profile/状态管理。自建版要自己实现的部分：device flow 授权、调用队列与状态机、
设备与工具清单注册（对应 remote-mcp 的任务 #2 / #3 / #4）。
