-- ============================================================================
-- 003 · OAuth 2.1 授权服务器
--
-- 为什么要有这个迁移
-- ----------------------------------------------------------------------------
-- 002 之后 /mcp 的凭据是一枚**静态个人访问令牌**（rmcp_...）。它的致命问题不是
-- "不安全"，而是**它无法表达"谁在用"**：
--
--   ChatGPT 的隧道型 connector 只有一个静态凭据入口，整条隧道注入同一个头。
--   于是无论多少个 ChatGPT 用户在用，中继看到的都是同一个身份 ——
--   多租户在"入口"这一层就已经退化掉了，后面所有 tenantScope 都拿不到区分度。
--
-- 正解是 MCP 规范要求的 OAuth 2.1：**每个终端用户各自走一次授权**，
-- 各自拿到一枚绑定到自己账号的 access token。于是：
--
--   ChatGPT 用户 A ──授权──▶ 我们这边的账号 a@x.com   ┐
--   ChatGPT 用户 B ──授权──▶ 我们这边的账号 b@x.com   ├─ 每人一枚 token
--   ChatGPT 用户 C ──授权──▶ 我们这边的账号 c@x.com   ┘
--
-- **身份映射就是在授权这一步建立的**，不需要 ChatGPT 传任何用户信息过来
-- （它也传不了）。用户在我们的 /oauth/authorize 页面上登录自己是谁，
-- 那次授权就固化成 mcp_oauth_grants 里的一行。
--
-- ── 四张表/字段各自解决什么 ──────────────────────────────────────────────────
--   mcp_oauth_clients  ChatGPT/Claude/Codex 这些 OAuth 客户端（DCR 自助注册）
--   mcp_oauth_codes    授权码。短命、一次性、绑定 PKCE —— 换取 token 的凭证
--   mcp_oauth_grants   **身份映射表**：哪个我们这边的用户，授权了哪个客户端
--   mcp_api_tokens.*   OAuth 签发的 access/refresh token 落在这里（见第 4 节）
--
-- ── 与 002 的关系 ───────────────────────────────────────────────────────────
-- 本迁移**不删除**任何东西：人工创建的个人访问令牌（kind='manual'）继续可用，
-- 用于 CLI、脚本、自测这类没有浏览器、走不了 OAuth 的场景。
-- 迁移后 RELAY_REQUIRE_AUTH 这个开关会一并删除 —— 见第 6 节说明。
--
-- 幂等：全部 if not exists / drop if exists，可重复执行。
-- ============================================================================


-- ============================================================================
-- 1. OAuth 客户端（DCR 注册）
--
-- ChatGPT 在 connector 首次连接时会调 /oauth/register 自助注册（RFC 7591），
-- 拿到 client_id 后再走授权码流程。我们**不预置任何客户端**，全靠 DCR ——
-- 这样新增一个客户端（Claude、Codex、Cursor）不需要改代码重新部署。
--
-- 关于 client_secret：ChatGPT 这类公开客户端用的是 PKCE，不需要 secret，
-- token_endpoint_auth_method 固定为 'none'。但表里保留 secret 字段，
-- 是为了将来接"企业预注册 client"（confidential client）时不用再改表。
-- ============================================================================

create table if not exists public.mcp_oauth_clients (
  client_id                  text primary key,
  client_name                text not null default '',
  redirect_uris              text[] not null,
  grant_types                text[] not null default '{authorization_code,refresh_token}',
  response_types             text[] not null default '{code}',
  token_endpoint_auth_method text not null default 'none',
  scope                      text not null default 'mcp:tools',
  -- 注册时客户端自报的来源，仅用于审计与运营识别（可被伪造，不可作为安全依据）
  client_uri                 text,
  logo_uri                   text,
  client_secret_hash         text,
  created_at                 timestamptz not null default now(),
  created_ip                 text,
  last_used_at               timestamptz,
  revoked_at                 timestamptz,
  constraint mcp_oauth_clients_redirect_uris_nonempty check (array_length(redirect_uris, 1) >= 1)
);

comment on table  public.mcp_oauth_clients is 'OAuth 客户端（DCR 自助注册）。ChatGPT/Claude/Codex 各自是这里的一行';
comment on column public.mcp_oauth_clients.client_id is 'RFC 7591 的 client_id。公开信息，不是秘密';
comment on column public.mcp_oauth_clients.redirect_uris is '**授权码只能回跳到这里的 URI**。不做前缀匹配、不做通配 —— 精确比对是防重定向劫持的唯一可靠手段';
comment on column public.mcp_oauth_clients.client_secret_hash is '仅 confidential client 使用。公开客户端（PKCE）留空';

create index if not exists mcp_oauth_clients_created_idx on public.mcp_oauth_clients (created_at desc);


-- ============================================================================
-- 2. 授权码
--
-- 三个必须做对的点，每一个做错都等于把授权码流程变成漏洞：
--
--   · **一次性**：consumed_at 一旦有值就不能再用。授权码重放是 OAuth 里
--     最经典的攻击面（攻击者抢先用偷来的 code 换 token）。
--   · **短命**：expires_at 默认 60 秒。授权码是要立刻兑换的，不需要长命。
--   · **绑定 PKCE**：code_challenge 在授权时写入，换 token 时必须用
--     code_verifier 反推出同一个值。没有 PKCE，公开客户端的授权码
--     一旦被截获就能直接换 token。
--
-- 存 sha256(code) 而不是 code 本身：这张表的泄露不该等于"任意用户可被冒充"。
-- ============================================================================

create table if not exists public.mcp_oauth_codes (
  code_hash             text primary key,
  client_id             text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  user_id               uuid not null references auth.users(id) on delete cascade,
  redirect_uri          text not null,
  scope                 text not null default 'mcp:tools',
  -- RFC 8707 的 resource 参数：客户端声明"这个 token 是给哪个资源用的"。
  -- 发放与校验都带上它，token 就无法被拿去打另一个 MCP 服务器。
  resource              text,
  code_challenge        text not null,
  code_challenge_method text not null default 'S256',
  created_at            timestamptz not null default now(),
  expires_at            timestamptz not null,
  consumed_at           timestamptz
);

comment on table  public.mcp_oauth_codes is 'OAuth 授权码。短命、一次性、绑定 PKCE。存 sha256(code)';
comment on column public.mcp_oauth_codes.consumed_at is '非空 = 已被兑换过。再次兑换必须拒绝（重放防护）';
comment on column public.mcp_oauth_codes.code_challenge is 'PKCE。换 token 时用 code_verifier 反推比对，不匹配即拒';

create index if not exists mcp_oauth_codes_expiry_idx on public.mcp_oauth_codes (expires_at);


-- ============================================================================
-- 3. 授权关系（**身份映射表**）
--
-- 这一行就是"ChatGPT 那边的一个连接"和"我们这边的一个账号"之间的映射。
--
-- 用户在 /oauth/authorize 页面上登录 → 批准 → 这里 upsert 一行 (user_id, client_id)。
-- 控制台的「已授权的 AI 客户端」列表读的就是这张表，用户点"撤销"就是
-- 把这行置 revoked_at，同时吊销该 (user_id, client_id) 下所有 OAuth 令牌。
--
-- 为什么按 (user_id, client_id) 而不按 ChatGPT 的用户 id：
-- ChatGPT **不会**把终端用户标识传给 MCP 服务器（它只代表用户发起 OAuth），
-- 所以"ChatGPT 用户"这个维度在我们这里根本不存在。我们能识别的身份，
-- 只有"用户在自己浏览器里登录的那个账号"。这不是缺陷 —— 它是唯一可靠的口径。
-- ============================================================================

create table if not exists public.mcp_oauth_grants (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  client_id          text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  scope              text not null default 'mcp:tools',
  created_at         timestamptz not null default now(),
  last_authorized_at timestamptz,
  revoked_at         timestamptz,
  unique (user_id, client_id)
);

comment on table  public.mcp_oauth_grants is '身份映射：哪个本服务账号授权了哪个 AI 客户端。控制台「已授权的 AI 客户端」读它';
comment on column public.mcp_oauth_grants.revoked_at is '非空 = 用户已撤销。撤销时须同时吊销该 user_id+client_id 下的所有令牌';

create index if not exists mcp_oauth_grants_user_idx   on public.mcp_oauth_grants (user_id, created_at desc);
create index if not exists mcp_oauth_grants_client_idx on public.mcp_oauth_grants (client_id);


-- ============================================================================
-- 4. 令牌表扩展：承载 OAuth 签发的 access / refresh token
--
-- 为什么复用 mcp_api_tokens 而不是新建一张 mcp_oauth_tokens：
--   · 校验路径完全一样（prefix 定位 + sha256 比对 + 缓存 + 精确吊销），
--     新表等于把 tokens.js 里已经写对的那套逻辑复制一遍，必然漂移。
--   · tenantScope / 审计 / 控制台列表都直接复用，不需要为 OAuth 再写一遍。
--   · 唯一需要的区分是 kind —— 人工令牌「不过期」是合理的，OAuth 令牌
--     必须有 TTL，这个差异在签发时由代码控制，不需要两张表。
--
-- refresh 轮换：refresh token 每次使用都会换新，做法是**直接改写
-- refresh_token_hash** —— 旧的哈希随之消失，天然失效，不需要额外的黑名单。
-- refresh_rotated_at 只是审计用的时间戳。
-- ============================================================================

alter table public.mcp_api_tokens
  add column if not exists kind               text not null default 'manual',
  add column if not exists client_id          text,
  add column if not exists refresh_token_hash text,
  add column if not exists refresh_expires_at timestamptz,
  add column if not exists refresh_rotated_at timestamptz;

comment on column public.mcp_api_tokens.kind is 'manual = 控制台人工创建；oauth = OAuth 授权流程签发';
comment on column public.mcp_api_tokens.client_id is 'OAuth 签发时记录来源客户端。人工令牌为 null';
comment on column public.mcp_api_tokens.refresh_token_hash is 'sha256(refresh_token)。轮换时直接改写本列 —— 旧值消失即失效';

-- client_id 上的外键单独加，方便用 if not exists 的写法（alter table 的
-- add constraint 没有 if not exists，用 do 块判存在性）。
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'mcp_api_tokens_client_id_fkey'
  ) then
    alter table public.mcp_api_tokens
      add constraint mcp_api_tokens_client_id_fkey
      foreign key (client_id) references public.mcp_oauth_clients(client_id) on delete set null;
  end if;
end $$;

create index if not exists mcp_api_tokens_client_idx on public.mcp_api_tokens (client_id);
create index if not exists mcp_api_tokens_refresh_idx on public.mcp_api_tokens (refresh_token_hash)
  where refresh_token_hash is not null;


-- ============================================================================
-- 5. RLS 与权限：四张表对客户端一律关闭
--
-- 与 002 同样的理由：device 进程持有的是真实用户 JWT，而它**不需要**碰
-- 这几张表。让"能碰到"这件事本身不成立，比事后靠策略约束可靠得多。
--
-- 特别注意 mcp_oauth_clients：它看起来像"公开信息"（client_id 确实公开），
-- 但表里还有 redirect_uris —— 攻击者若能把某个 client 的 redirect_uri
-- 改掉，就等于劫持了那个客户端的授权码。所以这张表对外也必须关闭。
-- ============================================================================

alter table public.mcp_oauth_clients enable row level security;
alter table public.mcp_oauth_codes   enable row level security;
alter table public.mcp_oauth_grants  enable row level security;

revoke all on public.mcp_oauth_clients from anon, authenticated;
revoke all on public.mcp_oauth_codes   from anon, authenticated;
revoke all on public.mcp_oauth_grants  from anon, authenticated;

grant all on public.mcp_oauth_clients to service_role;
grant all on public.mcp_oauth_codes   to service_role;
grant all on public.mcp_oauth_grants  to service_role;


-- ============================================================================
-- 6. 清理：授权码过期即无价值
--
-- 与 002 的 sweep_dead_tokens 同一思路，但没有保留期 —— 授权码过了 60 秒
-- 就是垃圾，留着只会让"这个 code 到底还能不能用"变得需要额外判断。
-- ============================================================================

create or replace function public.sweep_oauth_codes()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  delete from public.mcp_oauth_codes where expires_at < now() - interval '10 minutes';
  get diagnostics affected = row_count;
  return affected;
end;
$$;

comment on function public.sweep_oauth_codes() is '删除过期超过 10 分钟的授权码，返回删除行数';

revoke all on function public.sweep_oauth_codes() from public, anon, authenticated;


-- ============================================================================
-- 7. 执行后自检
-- ============================================================================

-- 7.1 四张表/字段都在
-- select tablename from pg_tables where schemaname='public'
--  and tablename in ('mcp_oauth_clients','mcp_oauth_codes','mcp_oauth_grants');
-- select column_name from information_schema.columns
--  where table_name='mcp_api_tokens'
--    and column_name in ('kind','client_id','refresh_token_hash','refresh_expires_at');

-- 7.2 权限已收回 —— 期望 0 行
-- select relname, grantee from information_schema.role_table_grants
--  where table_name like 'mcp_oauth_%' and grantee in ('anon','authenticated');

-- 7.3 RLS 已开、无策略
-- select relname, relrowsecurity from pg_class where relname like 'mcp_oauth_%';

-- 7.4 外键确实建上了（第 4 节的 do 块容易被静默跳过）
-- select conname from pg_constraint where conname = 'mcp_api_tokens_client_id_fkey';
-- 期望：1 行
