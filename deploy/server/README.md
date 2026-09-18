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

## 安装：三个密钥文件 + 四条命令

> **部署状态**：一次完整部署已于 2026-09-18 走通（表已建、relay 健康、
> device 在线、ChatGPT 侧走完 OAuth 并真实触发过 `tools/call`）。
> 下面是重新来一遍的步骤。

部署目录（服务器上的 `/root/remote-mcp-relay/`）里，代码之外只有三样东西要你填。
都是**单行、只放值**：不要引号、不要 `Bearer ` 前缀、不要行尾注释。

| # | 填到哪 | 内容形态 | 从哪拿 |
|---|---|---|---|
| 1 | `secrets/supabase-publishable-key.txt` | `sb_publishable_…` | Supabase → Settings → **API Keys** → `API Keys` 页签 → Publishable key |
| 2 | `secrets/supabase-secret-key.txt` | `sb_secret_…` | 同一个页签 → Secret keys（点 Reveal 才显示） |
| 3 | `secrets/supabase-db-url.txt` | 整串 URI | Supabase → **Connect** → **Session pooler** → URI |

第三个只给 `./migrate.sh` 建表用，不会进容器。

> ⚠️ 第 3 个别用 **Direct connection**（`db.<ref>.supabase.co`）—— Supabase 对它
> 只给 AAAA 记录，而这台机器**没有全局 IPv6**，psql 会卡到超时、报错还很难读。
> Session pooler 有 IPv4。`migrate.sh` 认得出这个形态并直接拒跑。

填完的标准流程：

```bash
cd /root/remote-mcp-relay
./migrate.sh        # 建表；幂等，跑几次都行
./setup.sh          # 体检 + 把 secrets 属主设成 1000:1000
docker compose up -d
curl -s http://127.0.0.1:18086/healthz   # db_error 应为 null
```

`setup.sh` 也支持用环境变量喂值（见其文件头）。手工 `vi` 的路径更短，但
**改完一定要再跑一次 `setup.sh`** —— 它负责 `chown 1000:1000 secrets/*.txt`。
漏了这步容器会以 EACCES 无限重启，而日志里只有一句"读不到文件"，很难定位。

---

## 前置条件

### 1. Supabase 项目

需要一个 Supabase 实例（云或自建都行，本目录按**云托管**写）。拿到四样东西：

| 用途 | 从哪拿 | 填到哪 |
|---|---|---|
| `SUPABASE_URL` | 顶部 **Connect** 对话框，或 Settings → Data API → Project URL | `.env` |
| `PUBLIC_SUPABASE_URL` | 同上（托管实例这两个同值） | `.env` |
| publishable key | Settings → **API Keys** → **`API keys`** 页签 → `Publishable key` | `secrets/supabase-publishable-key.txt` |
| secret key | 同一个页签 → `Secret keys` | `secrets/supabase-secret-key.txt` |
| 数据库连接串 | 顶部 **Connect** → **Session pooler** → URI（IPv4 可达） | `secrets/supabase-db-url.txt`（只给 `migrate.sh` 用） |

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
> 回退成本是零：把这两个文件的内容换成 Legacy key 再 `docker compose up -d`，
> **不用改代码、不用重建镜像**（文件名不用动 —— 那两个文件装的是"低权限那把 /
> 高权限那把"，跟密钥是新格式还是 Legacy 无关）。
>
> 反过来说 —— 为了一个"可零成本回退"的风险，从一条**官方已弃用**的凭据路径起步，
> 是不划算的。先上新格式。

### 2. 建表

数据库是空的，先跑迁移。**顺序不能换**：`schema.sql` 建基础表，
`002` 加多租户，`003` 加 OAuth。

```bash
cd /root/remote-mcp-relay
printf '%s\n' 'postgresql://postgres.<ref>:<口令>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
  > secrets/supabase-db-url.txt
chmod 600 secrets/supabase-db-url.txt
./migrate.sh
```

`migrate.sh` 做四件事：拒掉 Direct connection 形态、先连通性自检、
按顺序跑三个文件（`ON_ERROR_STOP=1`，任一失败即停）、最后列出 `public.mcp_*` 核对。
三个 SQL 都是 `if not exists` / `or replace`，**幂等** —— 跑一半失败、修掉再跑是正常操作。

跑完应当看到七张表：

```
mcp_api_tokens
mcp_audit_log
mcp_devices
mcp_oauth_clients      ← 以下三张来自 003
mcp_oauth_codes
mcp_oauth_grants
mcp_remote_calls
```

> 带 `_oauth_` 的三张必须存在。缺了 `003` 的表现是：`/oauth/authorize` 直接 500，
> 而 ChatGPT 那侧只显示"授权失败"，看不到任何原因。

不想用脚本的话，等价的手工方式（SQL 已随部署目录放在 `db/`）：

```bash
CONN='postgresql://...'
for f in db/schema.sql db/002-multi-tenant-auth.sql db/003-oauth-authorization-server.sql; do
  echo "── $f"
  docker run --rm -i postgres:18-alpine psql "$CONN" -v ON_ERROR_STOP=1 -q -f - < "$f"
done
```

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

# 从 Supabase 项目拷贝。文件名、变量名、控制台上的按钮名**三者字面一致**：
#   Publishable key → secrets/supabase-publishable-key.txt
#   Secret keys     → secrets/supabase-secret-key.txt
printf '%s\n' 'sb_publishable_...' > secrets/supabase-publishable-key.txt
printf '%s\n' 'sb_secret_...'      > secrets/supabase-secret-key.txt

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

> ⚠️ **secret key**（旧称 `service_role`）绕开 RLS。它进容器的唯一路径是
> secret 文件，不以环境变量形式存在 —— 环境变量会出现在 `docker inspect` 的明文里。
> 中继用高权限密钥直连是**有意为之**（`supa.tenantScope()` 在代码层做隔离，
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

5. **如果反代前面还有 Cloudflare，`X-Forwarded-For` 不能当限速依据。**
   2026-09-18 实测（CF 橙云 + SafeLine，用 `tools/probe-headers.py` 复现）：

   ```
   $ curl -H "X-Forwarded-For: 1.2.3.4" https://mcp.example.com/
   源站收到 → X-Forwarded-For: 1.2.3.4,<真实客户端>,<CF 回源 IP>
              CF-Connecting-IP: <真实客户端>
   ```

   CF 对 XFF 是**追加**而非覆盖，所以链首那个值来自请求方自己。而中继的
   `auth.clientIp()` 取 XFF 第一个 —— 拿到的是伪造值。`CF-Connecting-IP`
   才是 CF 每次覆盖、伪造不了的那个。

   影响面仅限**限速与审计日志**（鉴权不看 IP），所以不是"能绕进来"，而是
   "能绕过限速去暴力猜 user_code / 撞口令"。加固二选一：

   - 改中继（推荐，与反代配置解耦）：`clientIp()` 里优先读 `cf-connecting-ip`，
     没有再回落 XFF；
   - 只在反代侧改：给 `custom_params/backend_4` 加一行
     `proxy_set_header X-Forwarded-For $http_cf_connecting_ip;`。但它会被
     SafeLine 的界面保存动作覆写，得记着（且不走 CF 时该头为空，要一起想清楚）。

### Cloudflare 橙云：实测结论与注意事项

生产环境是橙云（解析到 `104.21.x` / `172.67.x`）。**已实测走通的**：

- 回源链路正常 —— 经 CF 访问返回 200，`cf-cache-status: DYNAMIC`。
- **`/oauth/token` 的 POST 没有被 WAF 或人机验证拦住** —— 授权码 → 换令牌 →
  拿到 Bearer 令牌整条走通（2026-09-18，且是 ChatGPT 侧真实发起的）。
- streamable HTTP 没有出现「initialize 成功但后续流断」—— 真实 `tools/call`
  2.3 秒返回。
- ChatGPT 的出口 IP 是 **Azure 段（`23.101.217.x`）**，不是 chatgpt.com 的域。
  看日志时别认错，也别把它当成攻击流量。

仍然要注意的：

- **人机验证 / 拦截**：CF 的 Bot Fight Mode、或 zone 安全级别调到 High 之后，
  非浏览器 UA 的请求（ChatGPT 的 connector 正是）可能被 challenge。若 OAuth
  在 ChatGPT 侧莫名失败而 curl 正常，先查这里。
- **响应缓冲与长连接**：万一出现「initialize 成功但后续流断」，试试把这条记录
  改成 **DNS only（灰云）**，让 CF 只做解析 —— 源站已经有 SafeLine 做 TLS 终结，
  多一层 CF 只是多一个变量。
- **别让 `/.well-known/*` 与 `/oauth/*` 落进任何缓存规则**。发现文档被缓存后，
  改配置不会立即生效。

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

> ⚠️ **`RELAY_OWNER_EMAIL` 那个账号不会自动创建。** 关掉自助注册之后，服务端
> 没有任何建号入口 —— `/signup` 返回 403，而 `ensureUser()` 唯一的调用点在
> device flow 的 `AUTO_APPROVE` 分支里（那只在本地联调开）。所以**先建号再登录**：
>
> ```bash
> cd /root/remote-mcp-relay
> docker compose exec -T relay node tools/create-account.js
> ```
>
> 否则现象是"登录页一直说密码错"，而真实原因是账号根本不存在。这一步不是可选的：
> 登录控制台是 OAuth 授权流程的**必经一步**（ChatGPT 首次调用工具 → 浏览器打开
> 授权页 → 登录 → 同意），没有账号 = ChatGPT 走到授权页就卡住。
>
> 脚本是幂等的（账号已存在**不会**改口令，避免重跑时把在用的口令换掉）；
> 要改口令显式加 `--set-password --password-stdin`。
> 中继启动时若检测到"库里无账号 + 自助注册已关闭"，会直接把上面这条命令打进日志。

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
| 容器起不来，日志报 `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` 缺失 | secrets 文件没建，或写成 `<KEY>_FILE` 之外的形式 |
| 日志报 `ANON_KEY 已改名` | 配置里还在用 2026-09-18 之前的旧变量名 / 旧文件名，照提示换成 `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY`（`setup.sh` 会自动搬旧文件名） |
| 一切 Supabase 调用都 401 `Invalid JWT` | 密钥值本身有问题（截断、带引号、被停用），或它根本不是这个项目的 key。**注入位置不用你操心** —— `supa.js` 已按官方 SDK 规则按前缀自动决定发不发 Bearer |
| 只有 device 连不上（中继正常） | `PUBLIC_SUPABASE_URL` 或下发的那把 publishable key 不对 —— device 是独立进程，它的报错不会出现在 relay 日志里 |
| 日志报 `RELAY_PUBLIC_URL 必填` | `.env` 没填或 compose 没读到（注意要在同目录） |
| `/console` 登录后立刻掉线 | `RELAY_COOKIE_SECURE=true` 但你在用 http 访问 |
| ChatGPT 点连接后停在打不开的页面 | `RELAY_PUBLIC_URL` 不是公网 HTTPS |
| 401 循环、授权一直失败 | 反代把 `/oauth/*` 或 `/.well-known/*` 拦了，或剥了 Authorization |
| 401 但 `WWW-Authenticate` 里的地址是 127.0.0.1 | `RELAY_PUBLIC_URL` 没改 |
| `/oauth/authorize` 500 | 数据库缺 `003` 迁移，`mcp_oauth_*` 表不存在 |
| 容器内 `EACCES: /app/state` | 卷属主不对，见 compose 里的 chown 命令 |
