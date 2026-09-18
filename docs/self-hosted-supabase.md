# 自建 Supabase 作为中继后端

> **适用范围（2026-09-18）**：本文件是**自建 Supabase 这条路的评估与操作手册**。
> 需要说清楚的是 —— **当前生产部署用的是托管 Supabase**
> （见 [`../deploy/server/README.md`](../deploy/server/README.md)），
> 自建栈目前用在**本地开发与联调**（`supabase/selfhosted/`）。
> 所以下面写的不是生产路径，而是「自建会遇到什么」的完整清单，
> 以及将来真要迁自建时的依据。
>
> 结论：**可以，而且对这套架构是"免改 device 端"的替换。**
> 但有三个前提必须满足，还有一个自建版特有的验证项必须实测。
>
> 事实来源标注：`[官方]` = supabase.com/docs 或官方 changelog；`[源码]` = DesktopCommanderMCP 仓库；
> `[推断]` = 我的推理，未经验证；`[待测]` = 必须在真实实例上验证。

---

## 1. 为什么自建版能直接替换

device 端只通过一个入口拿到 Supabase 坐标 —— `device.ts:313-329`：

```
GET {MCP_SERVER_URL}/api/mcp-info
  → { supabaseUrl, supabasePublishableKey }
```

拿到后用 `@supabase/supabase-js ^2.89.0` 建连接（`remote-channel.ts:189`）。也就是说，
**客户端根本不关心这个 Supabase 是托管版还是你自建的**，它只关心两件事：

1. `supabaseUrl` 根路径下能不能访问 `/auth/v1`、`/rest/v1`、`/realtime/v1`
2. 给它的 key 能不能通过各服务的校验

自建 Supabase 的默认网关（Envoy，监听 8000）路由前缀与托管版**完全一致** `[官方]`：

| 服务 | 路径 |
|---|---|
| REST (PostgREST) | `/rest/v1/` |
| Auth (GoTrue) | `/auth/v1/` |
| Realtime | `/realtime/v1/` |

所以：前面挂一个 TLS 反代，把 `https://sb.你的域名` 指向网关，`supabaseUrl` 就成立了。
**device 端零改动**，这跟托管版是同一份代码路径。

---

## 2. 三个必须满足的前提

### 2.1 密钥：用 legacy ANON_KEY，不要用新的 opaque key

自建版同时支持两套密钥体系 `[官方]`：

| 体系 | 变量 | 说明 |
|---|---|---|
| legacy（HS256 JWT） | `JWT_SECRET` / `ANON_KEY` / `SERVICE_ROLE_KEY` | 默认生效，新变量留空时就是纯 legacy 模式 |
| 新的（ES256 + opaque） | `JWT_KEYS` / `JWT_JWKS` / `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` | 需 `sh utils/add-new-auth-keys.sh` 生成，网关同时接受两种 key |

**下发 `supabasePublishableKey` 时用 legacy `ANON_KEY`（role=anon 的 JWT）。** 理由：
device 的代码路径全程按 JWT 处理（`realtime.setAuth(jwt)`、RLS 靠 `auth.uid()`），
legacy anon key 是这条路径上被验证最多、兼容性最稳的选择。

> 这里的 legacy 是**自托管 Supabase 的实现事实**，不是命名遗留：自托管走
> HS256 + `JWT_SECRET`，那个值就是 `{"role":"anon"}` 的 JWT，角色名写在令牌里，
> 上游的 compose / envoy 模板也按 `ANON_KEY` 引用它 —— 所以**不能改名**。
>
> 而**中继那边不叫这个名字**：它读的是 `SUPABASE_PUBLISHABLE_KEY`
> （读这份上游 `.env` 时按 `UPSTREAM_ENV_ALIAS` 自动映射，见 `relay/src/config.js`）。
> 托管 Supabase 上对应的则是 `sb_publishable_…`。三处名字不同是刻意的，
> 别为了"统一"去改上游的 `.env`。

两个坑：

- **`ANON_KEY` 的 `exp` 必须足够远或干脆不带。** `.env.example` 里那个示例 anon key 的 `exp`
  是 2027 年 —— 照抄不改的话，某天全线 401，而且报错点会落在很奇怪的地方。
  用 `utils/generate-keys.sh` 生成，并确认签出来的 anon key 不影响长期运行。
- **`JWT_SECRET` 绝不能留成示例值。** 它同时是 anon/service_role 的签名密钥，
  泄露等于 RLS 全线失效（任何人都能自己签一个 role=service_role 的 token）。

### 2.2 用户 JWT 的有效期必须大于 45 分钟

device 自己驱动 token 刷新，间隔写死在 `remote-channel.ts:64`：

```
TOKEN_REFRESH_INTERVAL_MS = 45 * 60 * 1000   // 45 分钟
```

而自建版 Auth 的默认会话有效期 `[官方]`：`JWT_EXPIRY=3600`（60 分钟）。

**约束：`JWT_EXPIRY` 必须 > 2700 秒（45 分钟），否则 refresh 还没跑、token 先过期，
Realtime socket 会被服务端踢掉。** 保持默认 3600 可以，但只剩 15 分钟余量；
稳妥做法是调到 7200。

### 2.3 Auth 不能依赖 SMTP

device 端 `setSession()` 会拿你下发的 access/refresh token 去 GoTrue 换取 user 对象
（`remote-channel.ts:220-243`），所以**下发的那对 token 必须是 GoTrue 真签发的**，
不能自己手搓 JWT（refresh token 在库里，伪造的无法刷新）。

服务端拿 session 的正确做法：用 service_role key 调 Admin API 建用户，再用
`POST /auth/v1/token?grant_type=password` 换取真实 session。不需要发任何邮件。

配置上对应两项 `[官方]`：

```
ENABLE_EMAIL_AUTOCONFIRM=true    # 不配 SMTP 也能注册即用
DISABLE_SIGNUP=true              # 用户由服务端 Admin API 创建，关闭公开注册
```

如果你想让用户自己注册，那才需要配置 SMTP（`SMTP_HOST` 等）。

---

## 3. 自建版特有的两件事

### 3.1 private 频道鉴权要实测 `[待测]`

托管版有个开关 Dashboard → Realtime Settings → **"Allow public access to channels"**，
关掉才强制走 RLS `[官方]`。

**自建版没有这个开关** —— 官方 changelog 在 Realtime Settings 条目下明确标了
**"Self-hosted: Not affected"**。那自建版的默认行为是什么？

我没能从官方文档确认，所以按"必须实测"处理：

1. 用 A 账号跑 device，确认频道能 `SUBSCRIBED` 且 presence 上报成功
2. 用 B 账号的 JWT 去订阅 `user:<A的uuid>`，**期望被拒**
3. 如果居然能进，先查有没有放通所有 topic 的兜底策略，再去 tenant 配置里找 private-only 开关

影响面评估：即使频道被蹭，门铃 payload 只有 `{call_id, device_id}`；
`mcp_devices` / `mcp_remote_calls` 的 RLS 决定了蹭频道的人既读不到调用内容、
也没法伪造调用行（没有 insert 策略）。**最坏是信号泄露，不是数据泄露。**

### 3.2 反代必须给 WebSocket 长超时 `[社区实践]`

Realtime 是长连接 WebSocket。Nginx 默认 `proxy_read_timeout 60s` 会把它掐断，
表现为设备反复重连、presence 掉了又上。必须显式放大：

```nginx
location / {
    proxy_pass http://localhost:8000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;   # 关键
}
```

自建版自带 Caddy/Nginx 的 HTTPS override（`docker-compose.caddy.yml` /
`docker-compose.nginx.yml`，配 `PROXY_DOMAIN` + Let's Encrypt）`[官方]`。
**用官方这层之前先确认它给 WebSocket 留了长超时**，没有就自己补。

---

## 4. 资源与运维

### 4.1 硬件

官方最低/推荐 `[官方]`：**4GB / 2 核 / 40GB SSD**，推荐 8GB / 4 核 / 80GB SSD。

但**官方同时说明：不需要 Realtime、Storage、imgproxy、Edge Runtime 时可以从
compose 里删掉对应段落以降资源** `[官方]`。我们的用法只用到四样：

| 保留 | 用途 | 对应实现 |
|---|---|---|
| `db` | Postgres | 两张表 + RLS |
| `auth` | GoTrue | device flow 换 session |
| `rest` | PostgREST | device 读写 `mcp_devices` / `mcp_remote_calls` |
| `realtime` | Realtime | 门铃 broadcast + presence |
| 网关 | Envoy | 路由 + key 校验 |

可以删：`storage`、`imgproxy`、`functions`、`meta`（只有 Studio 用）、
`studio`（不要 Dashboard 就不跑）、`supavisor`（连接数不多就不需要池化）。
删完大约 4-6 个容器，4GB 的机器够用，2GB 不要尝试 `[推断]`。

⚠️ 保留 `realtime` 意味着它会在 Postgres 上开一个逻辑复制槽。自建版**没有 Realtime 的
监控面板**，要自己盯 WAL 堆积 `[社区实践]`：

```sql
select slot_name, active,
       pg_current_wal_lsn() - confirmed_flush_lsn as lag_bytes
  from pg_replication_slots where slot_name like 'realtime%';
```

### 4.2 自建版没有的东西（要有心理预期）

官方明列**不可用** `[官方]`：branching、超出日志的高级指标、**托管备份与 PITR**、
analytics、vector buckets、ETL、平台管理 API。

也就是说**备份得你自己做**（`pg_dump` 定时任务 + 异地存），
升级得用 `update.sh` 做三方合并（直接改镜像 tag 不保证兼容）`[官方]`。

另外两条容易踩的 `[官方]`：

- **Supabase CLI 起的本地栈 ≠ 自建部署**，那套没加固、**不能暴露到公网**
- 自建版 docker compose **不上报任何遥测**（这点对"私有化"是加分项）

---

## 5. 部署顺序（自建版）

```bash
# 1) 拉起自建 Supabase（官方 docker compose）
git clone --depth 1 https://github.com/supabase/supabase
cd supabase/docker
cp .env.example .env

sh utils/generate-keys.sh          # 生成 POSTGRES_PASSWORD / JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY
# 改 .env：
#   SUPABASE_PUBLIC_URL = https://sb.你的域名
#   API_EXTERNAL_URL    = https://sb.你的域名/auth/v1
#   SITE_URL            = https://mcp.你的域名
#   JWT_EXPIRY          = 7200
#   ENABLE_EMAIL_AUTOCONFIRM = true
#   DISABLE_SIGNUP      = true
#   DASHBOARD_PASSWORD  = <强口令>
# 按需从 docker-compose.yml 删掉 storage / imgproxy / functions / meta / studio / supavisor

docker compose up -d

# 2) 建表 + 策略
#    在 Studio 的 SQL Editor 里执行 supabase/schema.sql

# 3) 反代 + 证书（确认 WebSocket 长超时）
#    sb.你的域名  → :8000

# 4) 验活
curl https://sb.你的域名/auth/v1/health
curl https://sb.你的域名/rest/v1/mcp_devices -H "apikey: $ANON_KEY"   # 期望 200 + []
```

第 4 步的 `200 + []` 是关键信号：**它说明网关路由、PostgREST、ANON_KEY、表权限
这四层都通了**。如果这里就失败，别往下走。

然后才是 `/api/mcp-info`、四个 device flow 端点、ChatGPT 侧 MCP endpoint
（tasks #2 / #3），最后 device 端加 `MCP_SERVER_URL` 指向你的服务。

---

## 6. 还有一个更轻的选择（值得先想 30 分钟）

自建的代价集中在**运维**（4GB 起步、备份、升级、暴露面），而不是代码。
如果你要的是"私有化"，还有第三条路：

**干脆去掉 Supabase，自己写传输层。**

切点非常干净 —— `device-authenticator.ts`（device flow）跟 Supabase 无关，
只有 `remote-channel.ts` 是 Supabase 绑定的。也就是说：
替换 `remote-channel.ts` 一个文件，实现同样的公开方法
（`initialize` / `setSession` / `registerDevice` / `onDoorbell` / `setOnlineStatus` / `shutdown`），
就能把 Supabase 整层换成一个自己写的 WebSocket 中继。

| | 自建 Supabase | 自己写 WS 中继 |
|---|---|---|
| 运维单元 | 4-6 个容器 + 反代 + 备份 | 1 个进程 |
| 要写的服务端 | 3 个 HTTP 端点 + 授权页 + MCP endpoint | 同左（device flow 端点照样要写） |
| 要写的 device 端 | 1 处（上报工具清单） | 整个传输层，约 400-600 行 `[推断]` |
| 数据面 | 上公网，靠 RLS 兜 | 不上公网 |
| 借到的东西 | 上游那套打磨过的重连/presence/幂等/优雅退出 | 得自己重写一遍（可简化） |

**我的建议**：如果你本来就要做多用户产品、并且认可 RLS 这套安全模型，
自建 Supabase 是把"上游已经解决的问题"直接继承过来，划算。
如果只是"我自己 + 几台机器"，自己写 WS 更省事，且不用把数据面暴露到公网。
两者都需要先写那几个 device flow 端点，所以任务 #2 不管选哪条都跑不掉。

---

## 7. 与托管版的取舍

| 维度 | 托管版 | 自建版 |
|---|---|---|
| 成本 | 免费层 / Pro 约 $25/月 | VPS 4GB 起 |
| 数据落点 | Supabase 云 | 你的机器 |
| 出口流量 | 计入配额（**大文件回传会吃额度**）`[推断]` | 算你的 VPS 流量 |
| 备份 / PITR | 有 | 没有，自己写 |
| 升级 | 无感 | `update.sh` 三方合并 |
| 支持 | 官方支持 | 仅社区支持 `[官方]` |
| 遥测 | — | 不上报 `[官方]` |

注意"出口流量"那行：`mcp_remote_calls.result` 装的是**工具返回内容**，
读一次大文件就是几 MB，托管免费层的流量配额很容易被这种用法吃穿。
这是自建版一个被低估的优势。
