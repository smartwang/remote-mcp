# deploy/server —— 生产部署（VPS + 反代，无隧道）

这个目录是**服务器上要放的东西**。镜像从 GHCR 拉，服务器上不需要源码。

```
   ChatGPT / Claude
          │  HTTPS  Authorization: Bearer <OAuth 令牌>
          ▼
   反代（TLS 终结）  mcp.example.com
          │  明文 HTTP，只走回环
          ▼
   127.0.0.1:18086  relay            ← 本目录起的东西
          │
          ├─ 出站 HTTPS ─▶ Supabase Cloud（PostgREST + GoTrue + Realtime）
          │
          └─ Realtime 广播 ─▶ user:<uid> 频道 ─▶ 该租户的 device（Windows）
```

relay 不执行任何命令，只做鉴权与派发。真正跑命令的是 Windows 上的 device 进程。

---

## 前置条件

### 1. Supabase 项目

需要一个 Supabase 实例（云或自建都行，本目录按**云托管**写）。拿到四样东西：

| 用途 | 从哪拿 | 填到哪 |
|---|---|---|
| `SUPABASE_URL` | 顶部 **Connect** 对话框，或 Settings → Data API → Project URL | `.env` |
| `PUBLIC_SUPABASE_URL` | 同上（托管实例这两个同值） | `.env` |
| publishable key | Settings → **API Keys** → **`API keys`** 页签 → `Publishable key` | `secrets/supabase-anon-key.txt` |
| secret key | 同一个页签 → `Secret keys` | `secrets/supabase-service-role-key.txt` |
| 数据库连接串 | Settings → **Database** → Connection string → **Session pooler**（IPv4 可达） | 只在建表时用一次，不落盘 |

### 密钥：用**新格式**（`sb_publishable_…` / `sb_secret_…`），不要用 Legacy

取的是 `API keys` 页签，**不是** `Legacy API keys`。旧项目该页签下若显示
`Create new API keys`，点一次即可 —— 它只是**新增**，不会吊销你现有的 key，
旧 key 照常有效。新 key 默认名叫 `default`。

**为什么新格式是对的：**

1. **Legacy 是官方明确要停用的东西。** 迁移文档原话：anon / service_role
   "deprecated by the end of 2026"。新部署没有理由从一条弃用路径起步。
2. **本项目两种格式都支持。** `supa.js` 的 `keyHeaders()` 直接照抄官方 SDK
   （`@supabase/supabase-js@2.116.0`）的判定规则 —— 只有 `sb_publishable_` /
   `sb_secret_` 走纯 `apikey`，**其余一律保留 `Authorization: Bearer`**。
   四种形态都实测过：legacy JWT ✓带 Bearer、`sb_publishable_` ✓不带、
   `sb_secret_` ✓不带、`sb_temp_` ✓带（上游就是这么定的）。
3. **device 侧不用改，也不用升级。** 它用的是 `@supabase/supabase-js@2.89.0`，
   该版本对密钥**不做格式判断、两个头都发** —— 这与 2.116.0 的**默认行为一致**
   （新版只是额外提供 `omitApiKeyAsBearer` 开关让你能关掉 Bearer 那一份）。
   即 device 的行为 = 官方当前默认行为。Realtime 那条路走的是 WS 查询参数
   `?apikey=…`，本来就是新格式该走的位置。

> **万一** device 侧在新格式下连不上（这是唯一没在真 Supabase 上跑过的路径），
> 回退成本是零：把这两个文件换回 Legacy key 再 `docker compose up -d`，
> **不用改代码、不用重建镜像**。
>
> 反过来说 —— 为了一个"可零成本回退"的风险，从一条**官方已弃用**的凭据路径起步，
> 是不划算的。先上新格式。

### 2. 建表

数据库是空的，先跑仓库里的 SQL。**顺序不能换**：`schema.sql` 建基础表，
`002` 加多租户，`003` 加 OAuth。

```bash
# 在仓库根目录
CONN='postgresql://postgres.<ref>:<pwd>@aws-0-<region>.pooler.supabase.com:5432/postgres'
for f in supabase/schema.sql supabase/migrations/002-multi-tenant-auth.sql supabase/migrations/003-oauth-authorization-server.sql; do
  echo "── $f"
  docker run --rm -i postgres:15 psql "$CONN" -v ON_ERROR_STOP=1 -q -f - < "$f"
done
```

跑完自检（应当看到七张 `mcp_*` 表，且带 `_oauth_` 的三张存在）：

```bash
docker run --rm -i postgres:15 psql "$CONN" -c "\dt public.mcp*"
```

> 这三张 OAuth 表必须存在。缺了 `003` 的表现是：`/oauth/authorize` 直接 500，
> 而 ChatGPT 那侧只显示"授权失败"，看不到任何原因。

### 3. 服务器

Docker 与 compose 已装。端口 **18086 不需要在防火墙放行** —— 它只绑回环，
公网入口是反代的 443。

---

## 安装

```bash
mkdir -p /root/remote-mcp-relay && cd /root/remote-mcp-relay
# 把本目录的 docker-compose.yml、.env.example 拷过来
mkdir -p secrets
```

### 生成密钥

三个 secrets 文件，每个**单行、裸值**（不要 `Bearer ` 前缀 —— 那是隧道静态头的格式）：

```bash
# 管理员面令牌。持有者能看到所有租户的设备与审计。
printf '%s\n' "rmcpadmin_$(openssl rand -hex 24)" > secrets/relay-admin-token.txt

# 从 Supabase 项目拷贝（值是新格式 sb_publishable_… / sb_secret_…）
# 文件名里的 anon / service_role 是历史命名（代码里的变量名也叫 ANON_KEY /
# SERVICE_ROLE_KEY），**指代的是"低权限那把"和"高权限那把"**，不是要你去
# Legacy 页签取 key。
printf '%s\n' 'sb_publishable_...' > secrets/supabase-anon-key.txt
printf '%s\n' 'sb_secret_...'      > secrets/supabase-service-role-key.txt

chmod 600 secrets/*.txt
```

> ### ⚠️ 必须把属主改成容器用户，否则容器起不来
>
> compose 的 file 型 secret 是**按宿主文件的 uid/权限**绑定挂载进容器的，
> 而中继镜像以非 root 的 `node`（**uid=1000**）运行。用 root 建的 `600` 文件，
> 容器读不了，症状是反复重启 + 日志里：
>
> ```
> <变量名>_FILE 指向的 /run/secrets/relay_admin_token 读取失败：EACCES: permission denied
> ```
>
> ```bash
> chown 1000:1000 secrets/*.txt
> chmod 600 secrets/*.txt
> ls -lan secrets/    # 期望看到 1000 1000
> ```
>
> **这个坑在 Windows/Docker Desktop 上不会出现**（Windows 文件系统不套用这套
> 权限语义），所以本机联调一切正常、一上 Linux 就全挂。用 `deploy/server/setup.sh`
> 可以避免手抄。

> ⚠️ `service_role` key 绕开 RLS。它进容器的唯一路径是 secret 文件，
> 不以环境变量形式存在 —— 环境变量会出现在 `docker inspect` 的明文里。
> 中继用 service_role 直连是**有意为之**（`supa.tenantScope()` 在代码层做隔离，
> 因为 RLS 对高权限连接根本不生效）。

```bash
cp .env.example .env
# 填 RELAY_PUBLIC_URL / SUPABASE_URL / PUBLIC_SUPABASE_URL / RELAY_OWNER_PASSWORD
vi .env
```

### 起服务

```bash
docker compose up -d
docker compose logs -f --tail=40 relay
```

启动日志会打出 OAuth 授权服务器的地址。**看到它才说明配置被真的读进去了。**

---

## 反代 / WAF 要求

用 SafeLine（或任何反代）把 `mcp.example.com` → `http://127.0.0.1:18086`。四条硬要求：

1. **转发 `Authorization` 头。** 有些 WAF 规则集默认剥掉它 —— 剥掉之后所有
   请求都是 401，而现象只是"ChatGPT 连不上"。
2. **不要把 401 改成 403 或自定义页面。** 401 带 `WWW-Authenticate` 质询是
   OAuth 发现流程的起点，改了客户端就找不到授权服务器。
3. **`/oauth/*` 与 `/.well-known/*` 必须放行到普通请求级别。** 这些路径里的
   参数是长 base64url 串，SQL 注入 / XSS 规则集容易误判。**先确认它们不在拦截名单里。**
4. **`Host` 头保持原值。** 中继靠 `RELAY_PUBLIC_URL` 拼绝对地址，不依赖 Host，
   但把 Host 改写成 `127.0.0.1:18086` 会让某些 WAF 的日志失去取证价值。

TLS 证书必须覆盖 `mcp.example.com`。ChatGPT 侧不接受自签名证书。

---

## 起来之后立刻做这三件事

```bash
# ① 健康检查
curl -fsS http://127.0.0.1:18086/healthz | head -c 400

# ② 从公网验证发现文档（这一步不通过，ChatGPT 一定连不上）
curl -fsS https://mcp.example.com/.well-known/oauth-protected-resource
curl -fsS https://mcp.example.com/.well-known/oauth-authorization-server
#   两份文档里的 issuer / resource 都应该是 https://mcp.example.com
#   ——出现 127.0.0.1 或 http:// 说明 RELAY_PUBLIC_URL 填错了

# ③ 未带令牌打 /mcp，应当是 401 且带 WWW-Authenticate
curl -sS -o /dev/null -D- -X POST https://mcp.example.com/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | head -5
```

然后浏览器打开 `https://mcp.example.com/console`，用 `RELAY_OWNER_EMAIL` /
`RELAY_OWNER_PASSWORD` 登录，**立刻改掉口令**。

### 接一台 device

device 侧要的是 `PUBLIC_SUPABASE_URL` 和那把低权限 key —— 它走
`GET /api/mcp-info` 拿，JSON 字段名就叫 `supabasePublishableKey`
（这个字段名是既有的，正好对上新的 publishable key）。device 起来后到
`/console` 批准它 —— 批准动作把设备绑到**当前登录的那个账号**，这就是租户边界。

---

## ChatGPT connector 要填什么

| 项 | 值 |
|---|---|
| 连接方式 | `Server URL`（本形态不用隧道） |
| Server URL | `https://mcp.example.com/mcp` |
| 身份验证 | **OAuth** |
| Client ID / Secret | 留空 —— 让 ChatGPT 走 DCR 自助注册 |
| 授权地址 / Token 地址 | 留空 —— 由发现文档自动带出 |

授权页是 `https://mcp.example.com/oauth/authorize`，**用户必须在自己的浏览器
里打开它**。这是 OpenAI 侧的硬约束：授权服务器不通过隧道路径代理，
所以它必须是公网可直接访问的地址 —— 本形态满足。

---

## 运维

```bash
docker compose logs -f --tail=100 relay    # 日志
docker compose pull && docker compose up -d  # 升级到最新镜像

# 钉版本（生产推荐）
docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/smartwang/remote-mcp-relay:latest
# 把摘要写进 .env 的 RELAY_IMAGE=<repo>@sha256:<digest>，然后 up -d
```

**不要删 `mcp_oauth_clients` 里的行。** ChatGPT 每个 connector 连接只走一次
DCR 注册并长期复用那个 `client_id`。删了之后用户下一次刷新会收到 `invalid_client`，
且因为客户端已经"注册过"，它不会再注册一次 —— 只能把 connector 删掉重建。

撤销授权走 `/console` →「已授权的 AI 客户端」→ 撤销。它同时吊销该客户端名下
全部令牌并清进程内缓存，**立即生效**，不用等令牌过期。

---

## 排障

| 现象 | 大概率原因 |
|---|---|
| 容器起不来，日志报 `ANON_KEY 缺失` | secrets 文件没建，或写成 `<KEY>_FILE` 之外的形式 |
| 一切 Supabase 调用都 401 `Invalid JWT` | 密钥值本身有问题（截断、带引号、被停用），或它根本不是这个项目的 key。**注入位置不用你操心** —— `supa.js` 已按官方 SDK 规则按前缀自动决定发不发 Bearer |
| 只有 device 连不上（中继正常） | `PUBLIC_SUPABASE_URL` 或下发的那把 publishable key 不对 —— device 是独立进程，它的报错不会出现在 relay 日志里 |
| 日志报 `RELAY_PUBLIC_URL 必填` | `.env` 没填或 compose 没读到（注意要在同目录） |
| `/console` 登录后立刻掉线 | `RELAY_COOKIE_SECURE=true` 但你在用 http 访问 |
| ChatGPT 点连接后停在打不开的页面 | `RELAY_PUBLIC_URL` 不是公网 HTTPS |
| 401 循环、授权一直失败 | 反代把 `/oauth/*` 或 `/.well-known/*` 拦了，或剥了 Authorization |
| 401 但 `WWW-Authenticate` 里的地址是 127.0.0.1 | `RELAY_PUBLIC_URL` 没改 |
| `/oauth/authorize` 500 | 数据库缺 `003` 迁移，`mcp_oauth_*` 表不存在 |
| 容器内 `EACCES: /app/state` | 卷属主不对，见 compose 里的 chown 命令 |
