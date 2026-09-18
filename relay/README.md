# remote-mcp relay —— 自建版「云端·闭源」层

复刻 `mcp.desktopcommander.app` 的服务端职责，让**未修改的**开源 DesktopCommander
device 进程通过 `MCP_SERVER_URL` 指过来就能工作，从而把本机全部 26 个工具
（而不是自写 server 的 7 个）暴露给 ChatGPT / Claude。

## 它在整体里的位置

```
ChatGPT / Claude 网页版
        │ HTTP MCP
        ▼
┌─────────────────────────────────────────────────────────────────┐
│ 部署单元 = 控制面（服务器 / 任意宿主机 —— **不要求是 Windows**）    │
│   docker compose --profile server up -d                         │
│                                                                 │
│   relay（本目录）   ← 主体：鉴权 · 租户隔离 · 调用派发              │
│     ▲   http://relay:18086/mcp   ← 同 compose 服务名，不走宿主     │
│   tunnel-client     ← 边车：把 relay 接到 OpenAI 控制面            │
│                                                                 │
│   Supabase（自托管栈或托管实例）← PostgREST / GoTrue / Realtime    │
└─────────────────────────────────────────────────────────────────┘
        │ Realtime 私有频道 user:<uid> 广播 new_call
        ▼
desktop-commander remote（device 进程，未修改的开源代码，**只出站**）
        │ MCP stdio
        ▼
本地 DesktopCommander MCP（26 个工具）
```

**中继是服务端组件，不是"跑在 Windows 上的本地服务"。** 它不执行任何命令，只在
Supabase 与调用方之间做鉴权与派发，因此没有理由和 device 同机 —— 同机会造成权限
放大（执行面失陷 ⇒ 控制面失陷 ⇒ 全库失陷），理由见「已知约束」。
它和 device 之间**没有直连**：稳态下两者都只跟 Supabase 说话，所以拆到两台机器
是改配置而不是重构。本机开发时它当然可以直接在宿主上跑，但那是**开发形态**。

**为什么必须有这个中继**：DesktopCommanderMCP 本体是 stdio-only
（`src/index.ts` 只创建 `FilteredStdioServerTransport`，全仓库没有任何 HTTP
transport），它没法直接当云端 HTTP MCP 端点。中继补的就是这一层。

**为什么用自托管 Supabase**：device 侧硬依赖 Supabase SDK 的四块能力 ——
GoTrue 的 session/refresh、PostgREST 的 `.from()`、Realtime 私有频道 + presence、
JWT。自己重写 Realtime 的 Phoenix 协议不划算。中继自己实现的只有 4 个端点。

## 术语：三个"anon / service_role"不是一回事

这块是**最容易把人绕晕的地方**，而且 2026-09-18 之前本仓库的命名是错的，所以单独说清。

| 东西 | 叫什么 | 能不能改 |
|---|---|---|
| **Supabase 的密钥格式** | 旧：`anon` / `service_role`，值形如 `eyJ…`（**Legacy，2026 年底弃用**）<br>新：`Publishable key` / `Secret keys`，值形如 `sb_publishable_…` / `sb_secret_…` | 你选哪个用。**新部署用新的** |
| **本中继的配置项** | `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` | 已统一成上面**新格式的名字** |
| **上游自托管 Supabase 的 .env 键名** | `ANON_KEY` / `SERVICE_ROLE_KEY` | **不能改** —— 自托管走 HS256 + `JWT_SECRET`，那两个值是 `{"role":"anon"}` / `{"role":"service_role"}` 签出来的 JWT，角色名写在令牌里 |

所以：

- **你只需要认识 `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY`。** 名字与
  Supabase 控制台的按钮字面一致，填的值就是那两把 `sb_…` 密钥。
- 早先本仓库把配置项叫 `ANON_KEY` / `SERVICE_ROLE_KEY`（`ANON_KEY_FILE`、
  `secrets/supabase-anon-key.txt` 同理）。**这套名字已废弃、不再被读取** ——
  照抄了 Postgres 的角色名当变量名，结果是"文件名说 anon、内容却是 `sb_` 开头"，
  会让人误以为要去控制台取 Legacy 那把。改名后中继会检测到旧名并直接在报错里
  给出新名（`config.js` 的 `RENAMED_KEYS`）。
- **读上游 `supabase/selfhosted/.env` 兜底那一级仍按上游的名字取**（`config.js` 的
  `UPSTREAM_ENV_ALIAS`），且**只在这一级生效** —— 它不会让 `ANON_KEY` 重新变成一个
  你可以填的配置项。

## 部署形态

两种形态，差别只有 `MCP_SERVER_URL` 一个变量 —— 中继服务在 compose 里被 profile
挡住，所以开发形态下不会多起一个中继去抢宿主上的 18086。

| | 服务器形态 | 本机开发形态 |
|---|---|---|
| 启动 | `docker compose --profile server up -d` | `docker compose up -d` |
| 中继在哪 | compose 里的 `relay` 服务 | 宿主上 `node src/index.js` |
| `MCP_SERVER_URL` | `http://relay:18086/mcp` | `http://host.docker.internal:18086/mcp` |
| 中继配置来源 | compose 环境变量 + `secrets/` 文件 | `relay/.env` |
| 用途 | 真部署；device 在别的机器上 | 改中继代码时 2 秒重启的迭代循环 |

容器相关的三件事：

- **镜像零依赖。** `package.json` 的 `dependencies` 是空对象，所以 `relay/Dockerfile`
  **没有 `npm install`** —— 只拷运行时 + 源码，构建是秒级的。`catalog.json` 随镜像走
  （缺了它会拒绝启动）。
- **密钥走文件，不走环境变量。** 中继支持 Docker 惯例的 `<KEY>_FILE`，值不经过
  环境变量，因此不出现在 `docker inspect` 的明文里。compose 里用的是
  `SUPABASE_SECRET_KEY_FILE=/run/secrets/supabase_secret_key` 这个形式。
  > ⚠️ 这个约定**是白名单制的**（见 `config.js` 的 `FILE_BACKED_KEYS`），不是对每个
  > 键都拼 `_FILE`。泛化实现会和 `RELAY_SESSION_SECRET_FILE` 撞车 —— 后者是会话密钥的
  > **读写路径**（不存在时要现场生成），泛化实现会误当成"从这个文件读密钥"，
  > 于是容器首次启动必炸。加新密钥时记得往白名单里加。
- **会话签名密钥要持久化。** 它一旦重新生成，所有已登录用户立刻掉线，所以
  `RELAY_SESSION_SECRET_FILE` 指向 named volume（`relay_state:/app/state`），
  而不是容器可写层。首次启动会自动生成。

`RELAY_HOST` 的默认值是 `127.0.0.1`（本机开发用），镜像里已显式改成 `0.0.0.0` ——
否则容器内监听回环，宿主侧发布端口拿到的是 connection refused。

## 快速开始

```bash
# 1) 起自托管 Supabase（约 11 个容器，首次要拉 2-3GB 镜像）
cd ../supabase/selfhosted
node tools/gen-env.js            # 生成 .env（含 JWT_SECRET 与上游的 ANON_KEY / SERVICE_ROLE_KEY）
docker compose up -d

# 2) 建表（两段：基础 schema + 多租户迁移）
bash tools/apply-schema.sh
bash tools/apply-migrations.sh   # 应用 supabase/migrations/（记账 + 校验和 + 事务）

# 3) 生成工具目录（需要本机有 DesktopCommander）
cd ../../relay
node tools/gen-catalog.js        # → catalog.json，26 个工具

# 4) 起点检
cp .env.example .env             # 按需改；密钥自动从 supabase/selfhosted/.env 读
node tools/probe-realtime.js     # 上游体检：PostgREST / GoTrue / Realtime 门铃
npm start                        # 起中继
node tools/smoke.js              # 中继自检：device flow 全流程 + MCP 端点

# 5) 建一个控制台账号（**必需，别跳**）
#    关掉自助注册后，服务端没有任何别的建号入口，而登录控制台是 OAuth
#    授权流程的必经一步 —— 没账号，ChatGPT 走到授权页就卡住，且看起来
#    像"密码错"。脚本是幂等的：账号已存在不会改密码。
node tools/create-account.js     # 用 RELAY_OWNER_EMAIL / RELAY_OWNER_PASSWORD
#    容器部署：docker compose exec -T relay node tools/create-account.js
#    改口令：  ... --set-password --password-stdin

# 6) 在设备上接入
#    Windows (cmd)：
#      set MCP_SERVER_URL=http://127.0.0.1:18086
#      npx @wonderwhy-er/desktop-commander@latest remote
#    然后浏览器打开 http://127.0.0.1:18086/device 点批准（**需先登录控制台**）

# 7) 多租户验收（48 条对抗性断言，约 6 秒）
node tools/test-tenant-isolation.js
```

> `apply-migrations.sh` 与 `apply-schema.sh` 的分工：前者管**增量**（`migrations/`
> 目录按序号应用，`public.schema_migrations` 记账 + sha256 校验和防篡改，
> 每个迁移单事务、已应用的跳过），后者管**初始**建表。
> 全新部署两个都跑；已有部署只需跑 migrations。

> 第 5 步为什么不能省：中继启动时会检测"库里一个账号都没有 + 自助注册已关闭"，
> 状态是**死锁**（登录不进去，而登录又是建号之外的唯一入口）。它只打印提示、
> 不自动建号 —— 因为 `RELAY_OWNER_PASSWORD` 有公开默认值，自动建等于用一个人人
> 皆知的密码开管理员入口。建号这一步刻意留给运维。

## 端点契约

中继对 device 侧要满足的全部接口（字段名来自 `device-authenticator.ts` /
`device.ts` / `remote-channel.ts`，不要改名）：

| 端点 | 调用方 | 用途 |
|---|---|---|
| `GET /api/mcp-info` | `device.ts:313` | 返回 `{supabaseUrl, supabasePublishableKey}`，免鉴权 |
| `POST /device/start` | `device-authenticator.ts:66` | 返回 `device_code / user_code / verification_uri / verification_uri_complete / expires_in / interval` |
| `POST /device/poll` | `device-authenticator.ts:112` | 未批准 → `{error:'authorization_pending'}`；过快 → `slow_down`；批准 → `{access_token, refresh_token, token_type, expires_in, device_id}` |
| `GET /device` | 人（浏览器） | 批准页（需登录，见「多租户鉴权」） |
| `GET /status` | 人（浏览器） | 302 跳 `/console`（单租户时期的只读面板，已被控制台取代） |
| `POST /mcp` | ChatGPT / Claude | HTTP MCP：`initialize` / `tools/list` / `tools/call`。**需 Bearer 令牌** |
| `GET /healthz` | 运维 / 程序 | 存活探针（JSON）。**已收敛**：不含设备清单、不含 Supabase 地址 |
| `GET /login` `POST /login` | 人（浏览器） | 登录 / 提交登录 |
| `POST /signup` | 人（浏览器） | 自助注册（`RELAY_ALLOW_SIGNUP=false` 时返回 403） |
| `GET /console` | 人（浏览器） | 租户控制台：本账号设备、授权给哪些 AI 客户端、调用记录 |
| `POST /console/tokens` | 人（浏览器） | 创建访问令牌（**明文只返回这一次**） |
| `POST /console/tokens/revoke` | 人（浏览器） | 吊销令牌（同进程内立即失效） |
| `POST /console/grants/revoke` | 人（浏览器） | **撤销某个 AI 客户端的授权**（同时吊销它名下全部令牌） |
| `POST /console/devices/approve\|deny` | 人（浏览器） | 批准 / 拒绝设备授权 |
| `GET /api/status` | 控制台页面（JS） | 当前登录租户的设备与调用（JSON），需 cookie |
| `GET /admin` | 运维（浏览器 / curl） | 全部租户的设备、用户、AI 客户端授权与审计。需 `RELAY_ADMIN_TOKEN` |

OAuth 2.1 授权服务器（详见「鉴权：OAuth 2.1」一节）：

| 端点 | 调用方 | 用途 |
|---|---|---|
| `GET /.well-known/oauth-protected-resource` | AI 客户端 | RFC 9728。也接受路径插入形式 `…/oauth-protected-resource/mcp` |
| `GET /.well-known/oauth-authorization-server` | AI 客户端 | RFC 8414。授权 / 令牌 / 注册三个端点地址 |
| `POST /oauth/register` | AI 客户端 | RFC 7591 动态客户端注册，**不预置任何客户端** |
| `GET /oauth/authorize` | 人（浏览器） | 未登录先 302 到 `/login`（`next` 保留完整查询串）；已登录渲染同意页 |
| `POST /oauth/authorize` | 同意页表单 | 批准 / 拒绝，签发授权码后回跳 |
| `POST /oauth/token` | AI 客户端 | 授权码换令牌、`refresh_token` 轮换 |

> `/oauth/*`、`/login`、`/.well-known/*` 是**面向终端用户浏览器**的路径，
> 上线时必须直接公网可达 —— 它们**不走** OpenAI 隧道。见 OAuth 一节的「部署门槛」。

device 进程拿到 session 后**不经过中继**，直接对 Supabase 说话
（PostgREST 读写 `mcp_devices` / `mcp_remote_calls`，Realtime 订阅私有频道）。
这正是官方架构的形状，中继只在授权和派发入口上出现。

## 多租户鉴权

三类身份，走不同的路由，**互不复用**：

| 身份 | 路由 | 凭据 | 能做什么 |
|---|---|---|---|
| AI 客户端 | `/mcp` | `Authorization: Bearer rmcp_<prefix>_<secret>` | 只能操作**自己账号**的设备 |
| 人（浏览器） | `/console` `/device` `/oauth/authorize` | `rmcp_session` cookie（HMAC-SHA256 签名） | 管理本账号的设备、令牌、授权 |
| 运维 | `/admin` | `RELAY_ADMIN_TOKEN`（Basic 或 Bearer） | 查看**全部**租户。未配置则完全关闭 |

**AI 客户端那枚 `rmcp_` 令牌有两个来源，校验路径完全相同**（同 `prefix` + 同
`sha256(secret)` 比对），区别只在 `mcp_api_tokens.kind`：

- `kind='oauth'` —— 用户在自己浏览器里授权后由 OAuth 流程签发，**绑定到该用户账号**，
  带 `refresh_token_hash` 可自动续期，可在控制台一键撤销。这是给 ChatGPT / Claude /
  Codex 这类有浏览器、能走 OAuth 的客户端用的。
- `kind='manual'` —— 人在 `/console` 里手工创建，明文只返回一次。给 CLI、脚本、
  自测这类**没有浏览器、走不了 OAuth** 的场景用。

两者不复用签发流程，但复用同一套校验实现 —— 这是刻意的：两条独立的校验路径迟早会漂移，
而漂移的表现是"某个来源的令牌偶发失败"，极难定位。**多租户的真实性只由 `kind='oauth'`
提供**，因为只有它知道"现在是谁在用" —— 见下一节。

### 令牌形态

```
rmcp_  a1b2c3d4e5  _  <43 字符 base64url>
└ scheme  prefix(10) └ 32 字节随机数的 base64url
```

- `prefix` **明文**存库、明文回显。作用只是"一句话定位到行"，避免每次校验全表比对哈希。
  它不是秘密。
- `secret` 只在创建时返回**一次**，库里只留 `sha256(secret)`，比对用常数时间。
- 所以库泄露 ≠ 令牌泄露 —— 攻击者拿到的哈希无法反推出可用令牌。

> ⚠️ **解析必须按固定位置，不能用 `split('_')`。** secret 是 base64url，字母表
> `[A-Za-z0-9_-]` **包含下划线**。用 `split('_')` 会把 secret 里恰好出现的 `_` 也当
> 分隔符 —— 43 字符的 secret 有约 `1-(63/64)^43 ≈ 49%` 的概率被切碎，症状是
> **"随机一半的令牌校验失败"**，换一个就好，极难定位。这是实际踩过的坑，
> 现在 `tokens.generate()` 自带往返自检，生成后立刻 parse 一遍，不匹配就抛错。
> 测试脚本里另有 500 次穷举自检。

### 为什么走 Bearer 而不是 URL 路径令牌

因为 **OpenAI 隧道会把 AI 客户端的 `Authorization` 头转发给 MCP 服务，但不会转发
请求路径** —— 隧道把请求固定打到配置里的那一个 MCP 路径上。所以路径令牌（`MCP_PATH_TOKEN`）
在多租户下没有意义，它只适合"直连中继"的运维自测。

### 为什么不能靠"隧道已经鉴权过了"省掉这一步

隧道鉴的是**它自己**——`tunnel_id` + runtime key，向 OpenAI 证明"我是哪条隧道"。
它对「调用方是谁」是透明的：转发不转发 `Authorization`，取决于 connector 那档认证
模式的配置，而隧道自己不解释这个头。所以"让隧道代替中继鉴权"这个想法本身落不下来 ——
它把"谁在调"这个信息在整条链路上唯一一次能建立的机会放弃掉。

三个容易踩的前提，逐个更正：

1. **"隧道和中继部署在一起 / 同一个容器网络"** —— 不是。中继跑在 **Windows 宿主**上，
   绑 `127.0.0.1`（`RELAY_HOST` 默认值，`config.js:54`）；compose 里只有 `tunnel`
   一个 service，没有自定义 network，隧道靠 `host.docker.internal` 跨出容器去够中继。
   而且同一个 docker 网络本来就不构成安全边界 —— 同网容器之间端口是全通的。
   绑 `127.0.0.1` 挡住的是局域网，**挡不住宿主上的本机进程** —— 而那恰恰是最现实的
   一类：任意 npm 包的 postinstall、编辑器插件、随手一个脚本，都能 POST 这个端口。

2. **"令牌是静态的，所以它算不上身份认证"** —— 这点要承认。`MCP_EXTRA_HEADERS` 里的
   令牌是**隧道配置里的固定值**，它证明的是"请求来自这条隧道"，不是"这是哪个用户"。
   真正的 per-caller 身份，只有 connector 走 OAuth、由最终用户各自授权才拿得到。
   所以当前形态下的"多租户"实际是 **多隧道 / 多 connector 各自一个令牌**，
   不是多终端用户 —— 这一点在文档里不该被含糊过去。

3. **"那换别的机制就行"** —— 换任何机制（OAuth、mTLS、别的），**校验点仍然在中继**，
   因为只有中继知道租户是什么。换掉的是签发流程，不是执行位置。

**所以中继这边的口径是：`/mcp` 只有一种身份来源 —— `Authorization` 头里的有效令牌。**
没有令牌就 401，没有例外、没有回落、没有开关。承载它的机制见下一节（OAuth 2.1）。

几条不那么显然、但必须知道的边界：

- `/device/*` 与 `/api/mcp-info` **不走** Bearer 校验 —— 否则设备会掉线。这两条路有各自
  独立的保护（设备配对码 + 限速），**不能拿"/mcp 已经收紧了"去推断它们也收紧了**。
- 一个反直觉的后果：绑 `127.0.0.1` **不等于**"只有我能调"。宿主上任何进程若能拿到令牌，
  `POST 127.0.0.1:18086/mcp` 就等价于拿到真 Windows 上的 `run_powershell`。
  这正是"令牌必须 per-user、且必须能即时撤销"的根本原因。

### 隔离靠什么（重点）

中继用**高权限的 secret key**（旧称 `service_role`，`SUPABASE_SECRET_KEY`）
读写 Supabase，绕过 RLS。`schema.sql` 里那些
`mcp_devices` / `mcp_remote_calls` 的 RLS 策略保护的是 **device 进程直连 PostgREST**
那条路，对中继自己**完全无效**。

也就是说：**如果中继某处漏写 `user_id = 本租户`，数据库不会拦。**

所以隔离实现在代码层，靠 `supa.tenantScope(userId)`：

- 它把 `user_id` 从"每次查询都要记得加的条件"变成"作用域对象的固有属性"——
  `select/insert/update/find/count` 都强制注入，调用方**拿不到一个不带租户的查询**；
- 调用方若自己传了冲突的 `user_id`，**直接抛错**而不是静默覆盖（静默覆盖会把
  "代码里写错租户"变成一个永远查不到数据的怪现象，比报错难查得多）。

全仓库仅有两处合法的"无租户条件"数据库访问，都在 `tokens.js` 里且都写了理由：
`loadByPrefix()`（身份还没建立，正是要靠这次查询才知道是哪个租户）和
`touch()`（按上一次校验得到的主键精确更新）。

**RLS 仍然要保留** —— 它是 device 直连那一路的兜底。纵深防御，不是二选一。

### MCP 会话 ID 不是身份凭据

`initialize` 时中继就把会话绑定到解析出的租户；之后任何请求只要身份不一致，
就删会话并 401（审计记 `security.session_tenant_mismatch`）。

⚠️ **这意味着 `initialize` 也必须带令牌。** 真实客户端每个 POST 都带 `Authorization`，
所以没问题；但测试脚本曾经漏传。在还允许匿名回落的那段时期，症状是
**"租户 A 全对、租户 B 全错"** —— A 恰好是回落到的那个遗留 owner，所以看不出问题。
这条"静默把所有人归到同一个账号"的路径，就是它后来被删掉的原因之一。

### 设备路由：为什么"多台必须显式指定"

`RELAY_ROUTE_POLICY` 默认 `auto-single`，三种情形各自全定：

| 该账号在线设备 | 行为 |
|---|---|
| 0 台 | 报错，并给出接入设备的具体命令 |
| 1 台 | **自动选中**（多数人的日常，用户零感知） |
| 多台 | **拒绝执行** + 列出候选（设备名 / `device_id` / 最后心跳）+ 给一段可照抄的调用示例 |

为什么多台时宁可报错也不"挑最近心跳的那台"：自动挑是**静默地选了一台用户没在想的
机器**。一次 `write_file` 落到错误机器上的代价，远高于多一轮交互。候选列表直接写进错误
文案里，模型会把它转述给用户，用户回一句"用 xxx"即可继续。

两个容易忽略但很关键的点：

- **拒绝发生在派发之前。** 库里不会多出派发行 —— 否则"报错"只是文案，实际已经在某台
  机器上跑了一半。`tools/test-device-routing.js` 专门断言了这一点。
- **显式指定的失败要能分辨**：指定一台**离线**设备 → 报"离线（最后一次心跳 X，超出
  15 分钟窗口）"；指定一个**不存在 / 属于别人**的 UUID → 报"找不到设备（它不属于当前
  账号，或已被删除）"。两种措辞不混用，前者要引导用户去看设备进程，后者不能透露存在性。

选设备永远先按 `user_id` 收窄，**跨租户指定 `device_id` 会被拒且不透露存在性**：
拿别人的 UUID 试，返回的与"不存在"是同一句话。这种尝试会记审计（`security.*`），
因为它是"有人在试探"的最早信号。

取证的窍门：**派发行里的 `device_id` 就是路由结果**。测试不等 300s 设备超时去读超时
文案，而是给请求一个 4 秒 `AbortSignal` 掐掉连接后直接查库 —— 快 5 分钟，也更直接。

### 鉴权：OAuth 2.1（2026-09-18 起）

#### 为什么删掉 `RELAY_REQUIRE_AUTH`

那个开关（`false` = 无令牌请求归到遗留 owner 账号）之所以存在，是因为当时的凭据是
**一整条隧道注入的静态令牌** —— 换凭据必须重新部署，所以需要一段"两套并存"的灰度期。

它已被**删除**，而且不是"改成默认 true"。理由：

- OAuth 的凭据是**协商式取得**的：没带令牌就回 401 + `WWW-Authenticate`，
  客户端据此自行发起授权。不存在"要么全断、要么全放开"的两难，也就没有灰度的必要。
- 那条匿名回落路径本身有害：它让"忘了打开开关"变成一种**静默的、人人可调用**的状态，
  且所有调用都归到同一个账号上 —— 多租户被压成了单租户。

现在的行为唯一且明确：`/mcp` 只有一种身份来源 —— `Authorization` 头里的有效令牌
（OAuth 签发的，或控制台人工创建的）。**没有令牌就是 401。**

#### 为什么静态令牌不够

静态令牌能回答"这是不是一枚有效凭据"，回答不了"**现在是谁在用**"。

ChatGPT 的隧道型 connector 只有一个静态凭据位，整条隧道注入同一个头 —— 无论多少个
ChatGPT 用户在用，中继看到的都是同一个人。于是 `mcp_api_tokens` / `tenantScope` /
审计这一整套设计在**入口处**就失去了输入：它们全都依赖"这枚令牌代表谁"，而静态令牌
给不出这个答案。

OAuth 的作用不是"更安全地传令牌"，而是**让每个终端用户各自拿到一枚绑定到自己账号的
令牌**。

#### 机制：身份映射是在授权那一步建立的

中继同时充当**资源服务器**和**授权服务器**（单体部署下最务实的形态）。四个端点：

| 端点 | 作用 |
|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728。客户端从这里知道授权服务器是谁 |
| `GET /.well-known/oauth-authorization-server` | RFC 8414。授权 / 令牌 / 注册三个端点地址 |
| `POST /oauth/register` | RFC 7591 动态客户端注册。ChatGPT 自助注册，无需预置 |
| `GET/POST /oauth/authorize` | 用户登录 + 同意页 |
| `POST /oauth/token` | 授权码换令牌、refresh 轮换 |

完整链路（`tools/test-oauth-flow.js` 逐步验证，68 条断言）：

```
① 客户端打 /mcp，不带令牌
② 中继回 401 + WWW-Authenticate: Bearer resource_metadata="…", scope="mcp:tools"
③ 客户端读 PRM → 拿到 authorization_servers
④ 客户端读 AS metadata → 拿到 authorize / token / register
⑤ 客户端 DCR 注册自己 → 拿到 client_id
⑥ 浏览器被送到 /oauth/authorize
⑦ 用户在**我们这边**登录（他是谁，就是谁）
⑧ 用户点「批准」→ 写入 mcp_oauth_grants（身份映射在此固化）
⑨ 回跳带 code → 客户端用 code + PKCE verifier 换 access_token
⑩ 此后每个请求带这枚令牌 → 中继解出 userId → tenantScope 隔离 → 路由到该用户的设备
```

关键点分两半说，混在一起就会得出错误结论：

- **ChatGPT 不告诉我们"它是谁的用户"。** 没有 `X-ChatGPT-User-Id` 这类东西；而且它
  **明确不支持** M2M 授权（`client_credentials` / service account / JWT bearer assertion），
  所以"一个连接器共享一个身份"在规范上就不是一条合法路径。
- **但它必然把令牌带回来。** 每个终端用户**首次调用工具时**，ChatGPT 会在**他自己的浏览器**里
  发起一次授权码 + PKCE 流程；用户在我们这边认证并同意后，此后**每一个** MCP 请求都带
  `Authorization: Bearer <那一次授权换来的令牌>`。

所以身份不是"ChatGPT 告知我们的"，而是**我们在授权那一刻绑上去、由 ChatGPT 逐请求搬运回来**的。
第 ⑩ 步能解出 `userId`，靠的正是这个 —— 否则整个 OAuth 流程毫无意义。

⚠️ 这段以前写的是"ChatGPT 传不了用户身份，所以这个维度不存在"。**那句话是错的**，
错在把"不传它自己的用户标识"讲成了"身份到不了我们这里"。两者的差别正是多租户能否成立。

另外两个维度也顺手分清，避免和用户身份混淆：

| 维度 | 谁提供 | 用途 |
|---|---|---|
| **终端用户身份** | 我们的授权页登录（承载物 = 令牌） | 决定租户、决定路由到谁的设备 |
| ChatGPT 作为客户端 | mTLS 客户端证书（SAN = `mtls.prod.connectors.openai.com`）、出口 IP | 证明"请求来自 ChatGPT 平台"，**不**用于识别用户 |
| 客户端注册身份 | DCR 的 `client_id` | 决定授权记录挂在哪个客户端名下 |

⚠️ 走隧道时 mTLS 到不了中继（中继看到的是 tunnel-client），所以客户端身份在隧道形态下
只能靠 IP 段；**用户身份不依赖它**，令牌已经足够。

#### 授权端点的错误分两层（错了会各踩一个坑）

| 时机 | 处理 | 为什么 |
|---|---|---|
| client 未注册 / `redirect_uri` 不匹配 | **400 + 错误页，绝不重定向** | 重定向等于把错误送到一个未验证的地址上，那就是个开放反射点 |
| 上述两项已通过，后续出错（缺 PKCE、scope 不支持、response_type 不支持） | **302 回 `redirect_uri`**，带 `error` / `error_description` / `state` / `iss` | 客户端在等回调，不告诉它就是让它挂到超时 |

另有一条**反直觉**的：**授权端点的错误不能用 401。** 401 是 RFC 6749 §5.2（令牌端点）
的错误码，授权端点的合法错误码里没有它；更要紧的是**401 是"去重新发现"的信号** ——
会做 OAuth 发现的客户端看到 401 会重走一遍 PRM → AS metadata → authorize，
而我们仍然拒它，用户就卡在循环里、看不到任何有意义的提示。
所以未注册的 `client_id` 在这里返回 **400 + `invalid_request`**。
（`loadClient()` 本身仍抛 401 —— 令牌端点那边是对的，翻译只发生在授权端点这一层。）

#### 部署门槛（这一条不做，OAuth 走不通）

**授权页必须能被终端用户的浏览器直接打开。**

OpenAI 的文档写得很明确：隧道路径可以承载 OAuth **发现**流量，但
"授权服务器本身不会自动通过隧道传输"；如果它从公网和 tunnel-client 主机都不可达，
即使 MCP 服务器可达，OAuth 流程仍会失败。

具体到我们这里：`AS metadata` 里回给客户端的是 `RELAY_PUBLIC_URL` 拼出来的绝对地址。
浏览器会**直接跳过去**。所以：

- 本机调试：`http://127.0.0.1:18086` 可以（你自己那台机器能打开）。
- 给真实用户用：**必须**是一个公网可达的 HTTPS 域名，反向代理到中继的
  `/oauth/*`、`/login`、`/.well-known/*`（`/console` 也应一起，否则用户没法自助撤销）。
  认证前端是面向用户的产品面，本来就不该藏在隧道后面。

配错的症状很好认：用户在 ChatGPT 里点「连接」后，浏览器停在一个打不开的页面。

#### ChatGPT connector 怎么配

| 项 | 值 |
|---|---|
| 连接方式 | 隧道（或直接填 `server_url`，如果中继已公网可达） |
| 身份验证 | **OAuth** |
| 客户端注册 | **DCR**（我们只实现了这一种，见下面的缺口说明） |

#### 已知缺口：没有实现 CIMD（不影响当前可用）

MCP 规范给客户端注册定了明确优先级：**① 预注册 → ② CIMD → ③ DCR**，
选择依据是授权服务器元数据里的两个字段：

- `client_id_metadata_document_supported: true` → 可以用 CIMD
- `registration_endpoint` 存在 → 可以用 DCR

**我们只实现了 DCR，而且刻意不在元数据里声明 CIMD 支持** —— 不声明，规范客户端
就按优先级回落到 DCR。所以功能上是通的（DCR 路径已 68/68 验过）。

两点需要知道：

- 规范已经把 **DCR 标为 deprecated**，保留只为向后兼容；OpenAI 也建议"优先支持 CIMD 的
  提供方"。长期看要走 CIMD。
- 但 CIMD 不是加个字段就完事：它要求授权服务器**去抓取客户端提供的 https URL**，
  这就新增了一个 SSRF 面（相当于让外部输入决定我们往哪里发请求）。真要做得配套：
  https 强制 + 私网地址拒绝 + 超时与响应体上限 + 校验文档内 `client_id` 与 URL 逐字相等
  + 用文档里的 `redirect_uris` 做白名单 + 按 HTTP 缓存头缓存。
  **宁可暂时不做，也不要做一个能被用来探测内网的半成品。**

DCR 路径有一条运维红线（官方文档明说）：**已注册的 client 在连接存续期间不能删**。
ChatGPT 每个 connector 连接只注册一次并长期复用，我们若把记录清掉，用户和审核者
会直接收到 `invalid_client`。

**关于隧道路径的切换顺序**（正式生产**不走**这条路，见本节末）：

生产形态是「中继直接挂公网 + connector 走 OAuth」（[`../deploy/server/README.md`](../deploy/server/README.md)），
链路上**根本没有隧道**，所以不存在下面这个问题。但如果你还在用隧道形态
（[`../docker/README.md`](../docker/README.md)），从静态令牌切到 OAuth 是有顺序讲究的 ——
反过来会有一段谁也连不上的空档：

1. 先在中继这边把 OAuth 立起来（已完成：端点、DCR、授权页、撤销都在跑）。
2. 再在 ChatGPT 的 connector 里把身份验证改成 **OAuth**，走完一次授权，确认能调用。
3. **最后**才把 `docker/.env` 里的 `MCP_EXTRA_HEADERS` 注释掉、重建隧道容器。
   ⚠️ 该变量在 `docker/.env` 里**目前仍然是活的**（那条路径只是保留着）。

第 3 步必须在第 2 步**验证通过之后**做。理由是这两者的优先级没有实测过：
如果隧道注入的静态头排在 connector 转发来的 `Authorization` **之后**，
那么它会把所有终端用户重新压回同一个身份 —— 也就是多租户又退化掉了，
而且**不会报任何错**（每个请求都"鉴权成功"）。这种静默退化比直接失败危险得多，
所以别赌优先级，直接让链路上只剩一条身份来源。

#### 撤销与轮换

- **refresh token 一次性**：每次使用都轮换（直接改写 `refresh_token_hash`，旧值消失即失效）。
  被截获的 refresh 用一次之后，真正用户的续期会失败 —— 异常因此可见。
- **用户自助撤销**：控制台「已授权的 AI 客户端」→ 撤销。这**同时**置 `grants.revoked_at`
  并吊销该客户端下全部令牌（含清内存缓存），所以是**立即**生效，不等令牌过期。
- 授权被撤销后，refresh 也会因为回查 grant 而失败 —— 撤不掉"靠续期绕开撤销"这条路。

### 会话与限速

- cookie 是 HMAC-SHA256 签名的，中继**不存密码也不存会话表**。签名密钥首次启动
  自动生成并写入 `relay/.session-secret`（已在 `.gitignore` 里），之后所有重启复用它 ——
  否则每次重启都会把所有人踢下线。
- `SameSite=Lax` + `Origin` 校验防 CSRF。
- **`user_code` 暴力猜解必须限速**：猜中一个就能批准它，而"批准"意味着
  **受害者那台机器会变成攻击者账号下的远程设备** —— 比"绑错账号"严重得多。
  所以批准接口单独一条更严的限速窗口（默认 10 次 / 5 分钟）。
  登录、令牌校验失败同样限速（后者防前缀存在性探测）。

### 数据层

迁移在 `supabase/migrations/`，用 `supabase/selfhosted/tools/apply-migrations.sh` 应用
（`schema_migrations` 记账 + sha256 校验和防改 + 事务包裹 + 跳过已应用）。

`002-multi-tenant-auth.sql` 建 `mcp_api_tokens` / `mcp_audit_log`，并**显式
`revoke all ... from anon, authenticated`** —— 因为自托管 Supabase 的默认权限比托管版宽，
不给策略时新表对 `anon`/`authenticated` 默认拿到 `arwdDxtm` 全部权限。
这一条不能省：device 拿的是 authenticated JWT，若它能读令牌表，
就等于能批量吊销别人（还是权限放大）。

## 运维面板（`/status` → `/console`）

单租户时期的 `/status` 只读面板**已退役**，`/status` 现在 302 跳到 `/console`。

原因是它无法回答多租户下的核心问题（"这个账号有哪些设备/令牌/调用"），而且它把
**全站设备清单**暴露给任何能访问该端口的人。控制台天然按租户收窄。

控制台的待批准列表**默认对 `user_code` 打码**，只有聚焦的那个才显示完整设备名 ——
否则任何人打开控制台就能看到别人正在授权的机器名。

仍然是"页面拿数据自绘"的形状：服务端不往 HTML 里注入任何设备数据，所以这个页面
没有注入面。看什么：

| 字段 | 含义 | 什么时候要担心 |
|---|---|---|
| 工具数 / 工具目录来源 | 中继持有的工具表，以及它是从哪个 DesktopCommander 构建产物抓的 | 数字不是 26，或路径指向了旧版本 |
| 广播投递 | `service_role` 往私有频道发门铃的成功/失败计数 | **失败数在涨** —— 设备收不到 `new_call`，调用必然超时 |
| 设备 · 在线 | 心跳距今是否在 15 分钟窗口内 | 显示离线 → ChatGPT 调用会快速失败 |
| 设备 · 最后心跳 | device 进程直连 Supabase 上报的 `last_seen` | 时间不推进 = device 进程死了 |
| 设备 · 广播通道 | `capabilities.transport_broadcast_v1` | **不可用** → 该设备收不到门铃，必须重启 device 进程 |
| 待批准的授权 | `/device/start` 已发出但没点批准 | 卡在这里 = 有设备在等你点批准 |

两个口径要注意：

- **在线判定用的是 15 分钟心跳窗口**，与 `supabase/schema.sql` 里 `mcp_device_presence`
  视图一致，只用来过滤死进程（device 实际心跳比这密得多）。
- 心跳是 **device 直连 Supabase** 上报的，**不经过中继**。所以中继重启后面板短暂显示
  会话数归零是正常的，设备状态不受影响。

全局视角（跨租户）用 `/admin`，不是这里。

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
- **多租户隔离在代码层，不靠数据库。** 中继走 `service_role`，绕过 RLS；
  `schema.sql` 的 RLS 只保护 device 直连那一路。所以任何新增的数据访问**必须**
  走 `supa.tenantScope(userId)`，绕过它就是绕过隔离。见「多租户鉴权 · 隔离靠什么」。
- **令牌吊销在多副本下不是精确的。** 单进程内 `revoke()` 会立刻清缓存，精确生效；
  跨进程最坏有 `TOKEN_CACHE_TTL_MS`（默认 30s）的延迟。要精确就得走数据库或广播，
  现阶段不值当 —— 但要知道这个边界。
- **`DEVICE_FLOW_AUTO_APPROVE=true` 等价于放开设备权限**：任何能访问
  `/device/start` 的人都能拿到一台设备的执行权。只在本地联调用。
- **中继和 device 现在同机，这是权限放大。** 这台 Windows 上同时躺着控制面和执行面，
  于是任何拿到 `run_powershell` 的主体都顺手能读到：`relay/.env` 的
  `RELAY_ADMIN_TOKEN`（可看全部租户）、`relay/.session-secret`（可伪造任意会话）、
  `supabase/selfhosted/.env` 的 `SERVICE_ROLE_KEY`（上游键名；绕过 RLS = 整个库）、
  `docker/.env` 的 OpenAI runtime key 与 tunnel id。也就是
  **执行面失陷 ⇒ 控制面失陷 ⇒ 全库失陷**，此时上面的租户隔离形同装饰。
  收紧 `/mcp` 鉴权（已完成）只堵住了**走 HTTP** 那条路；本机进程不需要走 HTTP ——
  直接读文件就够了。所以**权限放大本身没有消失**，正解仍是分机（把控制面与执行面
  分到两台机器上）。见下一条。
- **中继是可移植的，同机部署是开发便利而非约束。** `dependencies` 为空、零平台耦合
  （源码里唯二两处 `win32` 匹配都在工具描述字符串里）、不调任何系统接口。它启动只读
  4 个文件（`relay/.env`、`catalog.json`、`.session-secret`、
  `../supabase/selfhosted/.env`），全可挂载。**稳态下它与 device 之间没有直连** ——
  两者都只跟 Supabase 说话（device→Supabase Realtime 收门铃，relay→Supabase 写派发行
  + 广播），所以拆到两台机器是改配置而不是重构。唯一要留意的远端化代价：device
  **每次启动**都会 GET `relay/api/mcp-info`（`device.ts:124`），首次授权还要走
  `/device/start` + `/device/poll`，因此中继必须有一个带 TLS 的公网入口。
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

六份报告，按依赖顺序。**除了 `test-auth-enforcement.js` 会另起一个隔离实例之外，
其余全部是对线上实例（`127.0.0.1:18086`）实跑的结果。**

| 报告 | 断言 | 验的是什么 |
|---|---|---|
| `tools/probe-realtime.js` | 7/7 | 上游三件套（PostgREST / GoTrue / Realtime）能不能用 |
| `tools/smoke.js` | 22/22 | device flow 全流程 + MCP 端点 |
| `tools/probe-capabilities.js` | — | 上游工具表里带了哪些 UI 组件广告（诊断工具） |
| `tools/test-tenant-isolation.js` | 48/48 | 跨租户隔离（主动越权并确认失败） |
| `tools/test-auth-enforcement.js` | 28/28 | 鉴权强制，且**没有误伤** |
| `tools/test-oauth-flow.js` | 68/68 | OAuth 2.1 端到端（扮演 ChatGPT） |
| `tools/test-device-routing.js` | 29/29 | 多台设备时的路由语义 |

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
PASS  device 能用该地址+publishable key 打通 PostgREST
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

### `tools/test-tenant-isolation.js` —— 48/48 PASS（约 6 秒）

**这不是"跑一遍正常流程"，而是主动尝试越权并确认失败。** 每条断言对应一个攻击面：

```
0. 前置        /healthz 存活 · 26 工具 · 令牌格式往返自检 500 次 · 两租户就绪
1. 令牌签发    A/B 各自走真实 /login + /console/tokens 拿到令牌，互不相同
2. 正常路径    A 拿到 26 工具 · instructions 带自己的设备 · 真读到 Windows hosts 文件
3. 跨租户越权  A 指定 B 的 device_id → -32602，且**不透露 B 的设备是否存在**
4. B 侧视角    B 的调用派发到 B 自己的设备行（查库取证 device_id）·
               A 的设备上没有任何来自其他租户的调用行
5. 控制台隔离  A 的页面不含 B 的设备名/邮箱，反之亦然
6. 令牌反例    不存在的令牌 → 401（响应体不区分失败原因）·
               吊销后**同进程立即**失效
7. 会话 ID     A 的令牌 + B 的会话 ID → 401（会话已绑租户，不是身份凭据）
8. 运维面收敛  /healthz 不含设备清单与 Supabase 地址 · /admin 无凭据 401、
               带凭据 200 且能看到全部租户
```

脚本会**造一台带 `transport_broadcast_v1` 的假设备行**（这是 HTTP 面上故意不开放
的路径，所以直接复用中继自己的模块），结束时用 service_role 删干净 ——
这一步不能省，否则真实调用会被路由到一台不存在的设备上。

> 阶段 4 刻意**不等**那 300s 的设备超时，而是直接查派发行：行里的 `device_id`
> **就是**路由结果，比"读超时文案"直接得多。做法是给请求一个 4 秒的
> `AbortSignal`，掐掉连接后再查库。

### `tools/test-auth-enforcement.js` —— 28/28 PASS（约 2 秒）

**这个脚本存在的唯一理由，是把"鉴权收紧会不会误伤"变成一条可证伪的断言。**

误伤比"漏放行"难查得多：某个本该放行的路径（隧道路径、会话续用、前缀匹配）被一起拒掉，
症状是"平时都好、偶发 401"。所以它既验负向（一律 401），也验正向（有效令牌仍通）。

隔离做法：另起一个实例（`RELAY_PORT=18087`），同一个库、同一份令牌。**现在两个实例
的姿态本来就该完全一致**（开关已经不存在了）—— 不一致就说明有进程级状态在起作用。
中继只广播不订阅，所以第二个实例不会抢走调用；脚本也刻意不做 `tools/call`，
不产生任何派发行。

```
0. 前提       秘密文件可读且是合法 rmcp_ 令牌 · 尾部至多一个行尾 · 令牌本体无空白
              （空白会被 tunnel-client 的 splitHeaderList 切碎）
1. 起实例     18087，健康检查确认 auth=required
2. 负向       无头 → 401 · 格式合法但不存在 → 401 · 垃圾字符串 → 401
              塞进 Basic 头 → 401（Basic 只属于管理员面，不能误放行）
              401 带 WWW-Authenticate 质询 · **响应体不泄露 reason**
              且"不存在"与"未提供"的响应逐字节相同
3. 正向       带一枚有效令牌 → initialize 200 + 拿到 sid → tools/list 200
              （OAuth 签发的令牌与手工令牌走同一条校验路径，这一条同时覆盖两者）
              同一会话里换成无效令牌 → 401（不会一次通过就永久放行）
4. 对照       同一无头请求打 live 也是 401 · 同一令牌打 live 也是 200
              → 两个实例零差别（这就是"没有灰度态"的实证）
              两个实例的工具表一致 · 隔离实例的 /healthz 不含设备清单
5. 收尾       子进程已停、端口释放、无派发行残留
```

它**不碰**正在服务 ChatGPT 的那个实例，所以随时可跑，不需要停机窗口。

### `tools/test-oauth-flow.js` —— 68/68 PASS

扮演一个真实 MCP 客户端（ChatGPT 的角色），把下面这条链一步步走完：

```
401 + WWW-Authenticate → PRM → AS metadata → DCR 注册 → 授权页登录 → 批准
→ 回跳拿 code → PKCE 换令牌 → tools/call → 跨租户隔离 → refresh 轮换 → 撤销
```

重点验的不是"能通"，而是几个**只有跑起来才暴露**的点：

- refresh 用一次之后，**旧值立刻失效**（改写 `refresh_token_hash`，旧哈希不存在了）；
- 撤销 grant 后，**同进程内立即** 401（不等令牌过期、不走缓存）；
- 授权码**单次有效**：同一个 code 换两次令牌，第二次必失败；
- 租户 A 的令牌拿不到租户 B 的任何东西，且失败措辞不透露存在性。

同一套断言也对**线上实例**（`127.0.0.1:18086`）跑过一遍。

### `tools/test-device-routing.js` —— 29/29 PASS

隔离测试验的是**租户维度**（"B 碰不到 A 的设备"）。这个脚本补上剩下的那一半：
**同一个账号下有多台设备时选哪台** —— 也就是 `auto-single` 的全部内容，
此前从未端到端验证过。

```
0. 前置     owner 名下有真实设备 · auth=required · ROUTE_POLICY=auto-single
1. 显式指定 指定真实设备 → 派发行 device_id 就是它（真跑一次 list_directory 拿到目录列表）
            指定一台离线设备 → 报"离线（最后心跳 X，超出 15 分钟窗口）"· 不产生派发行
2. 不存在的 id → "找不到设备（不属于当前账号，或已被删除）"· 措辞里回显尝试的 id
3. 多台在线  不指定 → 拒绝执行 · 候选含两台的名字/id/最后心跳 · 带可照抄示例
            **库里没有多出任何派发行**（拒绝发生在派发之前，这才是关键）
4. 显式指定  指定假设备 → 派发行 == 假设备；改指真实设备 → 派发行跟着变（不串台）
5. 回到单台  删掉假设备 → 自动选中那唯一一台，不再报"无法自动判断"
            重连一次 initialize，instructions 里出现"无需指定 device_id"
6. 收尾      假设备行与其派发行全部清掉 · 派发行只比基线多 3 条（都是真实设备的正常调用）
```

两个断言值得单独说，因为它们是"看起来通过、实际没验到"的重灾区：

- **"不产生派发行"不能靠读错误文案来判断。** 必须查库数行数。否则文案说"已拒绝"、
  实际已经在某台机器上跑了一半，测试照样全绿。
- **派发行数用基线偏移量，不用绝对值。** owner 是真实在用的账号，库里本来就有历史行；
  写 `=== 1` 会因为历史数据而假失败（第一版就是这么错的，基线 40 条）。

假设备行是脚本自己直接插的（`supa.tenantScope`，绕过 HTTP）—— 设备注册这条路径在
HTTP 面上故意不开放，客户端不该能伪造设备。用完连派发行一起删，否则会留下永远 pending
的孤儿行。

### 尚未验证

- **CIMD 路径完全没有实现**（见上面的已知缺口）。当前靠 DCR 回落，功能可用；
  但 DCR 已被规范标为 deprecated，且规范建议授权服务器支持 CIMD。属于**已知未做**，
  不是"已支持"。
- **多设备路由的显式 `device_id` 在真实 ChatGPT 会话里的表现**。协议层验过（`tools/call`
  参数透传），但 ChatGPT 是否会稳定地照我们错误文案里的示例去补 `device_id` 参数，
  没有实测。
- **真实的多租户并发**（两个租户同时调用各自的设备）。隔离是逐条验过的，
  但没有做过并发压测。
- **设备断线重连后的行为**。心跳新鲜窗口 15 分钟（`DEVICE_FRESH_MS`）、
  广播心跳 5 分钟，但设备进程重启后租户绑定是否稳定，没实测过。

### 已于 2026-09-18 验证（原先列在"尚未验证"里的）

- **ChatGPT 真实触发的一次 `tools/call`** ✅ —— `list_directory`
  （`C:\Users\<user>\workspace`，depth 1），`created_at` → `completed_at` **2.32 秒**，
  返回真实目录内容。
  **判据**：`mcp_remote_calls.tool_args` 里有 **`"origin":"llm"`** —— 脚本调用不带
  这个标记。注意**别再用 `metadata.client` 当判据**：本次它是
  `{"relay":true,"client":null,"transport":"relay-broadcast"}`。
  `last_used_at` 前进**仍然**不等于有真实调用（隧道探测也会让它前进），这条照旧。
- **ChatGPT 侧真的走完 OAuth** ✅ —— 注册 → 授权 → 换令牌在库里全有据：
  `oauth.client.register`（client_name = `ChatGPT`）→ 授权码签发 → `oauth.token.issue`。
  前提「授权页必须公网可达」已满足（`RELAY_PUBLIC_URL` 是公网 HTTPS 域名）。

## 与隧道版的关系

本中继**不依赖** OpenAI 隧道。三种接法，按推荐度排：

| # | 接法 | 形态 |
|---|---|---|
| 1 | **中继直接挂公网（生产现状）** | 去掉隧道。`RELAY_PUBLIC_URL` 指公网 HTTPS 域名，connector 选 `Connection = Server URL` 填 `<域名>/mcp`，身份验证选 OAuth。链路最短，也没有"静态头会不会覆盖 OAuth 头"这个不确定性。部署见 [`../deploy/server/README.md`](../deploy/server/README.md) |
| 2 | **本机联调** | `tools/call` 直接打 `http://127.0.0.1:18086/mcp`，无需反代与隧道 |
| 3 | 容器 + 隧道边车（旧形态） | 隧道把 `MCP_SERVER_URL` 指到 `http://relay:18086/mcp`（compose 网络内），connector 选「无身份验证」，租户令牌由 `MCP_EXTRA_HEADERS` 静态注入。**这是单租户形态** —— 所有 ChatGPT 用户在中继看来是同一个人 |

第 3 种**已不是推荐路径**：静态头是配置期固定的，天生做不到 per-user 身份，
已被 OAuth 取代。相关代码与 compose profile 仍保留，见
[`../docker/README.md`](../docker/README.md)。
