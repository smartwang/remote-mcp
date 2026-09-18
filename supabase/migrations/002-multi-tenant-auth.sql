-- ============================================================================
-- 002 · 多租户鉴权
--
-- 基线 (supabase/schema.sql) 是单租户形态：device flow 把每台设备都绑到写死的
-- OWNER_EMAIL 账号上，/mcp 端点完全免鉴权，tools/call 全局挑设备。
-- 本迁移补上"多租户"缺的那部分数据层。
--
-- 租户的定义：**一个 GoTrue 用户就是一个租户**。
-- 不另建 tenants 表 —— mcp_devices.user_id 已经是租户键，再引一层 user↔tenant
-- 映射只会增加复杂度，而当前没有"多人共用一个租户"的需求。
--
-- ── 一个必须记住的架构事实 ─────────────────────────────────────────────────
-- 中继用 service_role 读写数据库，**service_role 绕过 RLS**。
-- 所以本文件里的 RLS 策略保护的是"device 进程直连 PostgREST"那条路，
-- 它**保护不到中继自己**。中继侧的租户隔离必须靠代码里显式注入 user_id
-- 条件（见 relay/src/supa.js 的 tenantScope）。两边都要有，缺一不可。
-- ────────────────────────────────────────────────────────────────────────────
--
-- 幂等：全部 create ... if not exists / drop ... if exists，可重复执行。
-- ============================================================================


-- ============================================================================
-- 1. 访问令牌
--
-- 用途：ChatGPT / Claude 的 connector 在 Authorization 头里带这个令牌，
--       中继据此判定"这是哪个租户"，进而把 tools/call 路由到该租户的设备。
--
-- 存储原则：**明文令牌只在创建时返回一次，库里只存哈希**。
--   · prefix     明文。用于按前缀定位到行，避免每次都全表比对哈希。
--                前缀不是秘密，即使库被读走也无法据此伪造令牌。
--   · token_hash sha256(secret) 的 hex。比对用常数时间，防时序侧信道。
--
-- 为什么不用 Supabase JWT 当 MCP 令牌：JWT 1 小时就过期，而 ChatGPT connector
-- 里填的是一个静态值、无法自动刷新。个人访问令牌还额外给了"可单独吊销"的能力。
-- ============================================================================

create table if not exists public.mcp_api_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  label        text not null default '',
  prefix       text not null unique,
  token_hash   text not null,
  created_at   timestamptz not null default now(),
  created_ip   text,
  last_used_at timestamptz,
  last_used_ip text,
  expires_at   timestamptz,
  revoked_at   timestamptz
);

comment on table  public.mcp_api_tokens is 'AI 客户端访问 /mcp 的个人访问令牌。明文不落库，只存 sha256(secret) 与用于定位的明文前缀';
comment on column public.mcp_api_tokens.prefix is '令牌前缀（明文，非秘密）。形如 rmcp_a1b2c3d4e5 —— 用于 O(1) 定位到行';
comment on column public.mcp_api_tokens.token_hash is 'sha256(secret) 的 hex。比对必须用常数时间，否则可被时序攻击逐字节猜出';
comment on column public.mcp_api_tokens.expires_at is 'null = 永不过期。撤销优先于过期：revoked_at 一旦有值立即失效';

create index if not exists mcp_api_tokens_user_idx on public.mcp_api_tokens (user_id, created_at desc);

-- prefix 上的 unique 约束已经建了隐式索引，定位走它。


-- ============================================================================
-- 2. 审计日志
--
-- 追加写，只由中继以 service_role 写。对客户端完全不可见（见第 4 节）。
--
-- 记什么：令牌的创建/吊销、设备批准/拒绝、登录成功与失败、以及被拒绝的
-- 跨租户访问尝试。最后这条是安全运营最需要的信号 —— 它代表"有人在试探"。
-- ============================================================================

create table if not exists public.mcp_audit_log (
  id         bigserial primary key,
  user_id    uuid references auth.users(id) on delete set null,
  actor      text not null,
  action     text not null,
  target     text,
  detail     jsonb not null default '{}'::jsonb,
  ip         text,
  created_at timestamptz not null default now()
);

comment on table  public.mcp_audit_log is '安全审计流水（追加写）。令牌生命周期、设备授权、登录、越权尝试都记在这里';
comment on column public.mcp_audit_log.actor is 'relay | device | admin | anonymous —— 谁发起的动作';
comment on column public.mcp_audit_log.user_id is '可空：登录失败、越权尝试这类事件没有已认证用户';

create index if not exists mcp_audit_user_idx    on public.mcp_audit_log (user_id, created_at desc);
create index if not exists mcp_audit_action_idx  on public.mcp_audit_log (action, created_at desc);

create sequence if not exists public.mcp_audit_log_id_seq owned by public.mcp_audit_log.id;


-- ============================================================================
-- 3. RLS：两张表都对客户端完全关闭
--
-- 关键选型：**不给 authenticated 任何策略**。
--
-- 为什么不给"只能读自己的令牌"这种策略（看起来更友好）：
--   device 进程持有的是一个真实的用户 JWT。如果令牌表对 authenticated 开放，
--   那么任何拿到该 JWT 的人（例如设备被入侵、或某个第三方 MCP 客户端被塞了
--   恶意代码）就能读出该租户所有令牌的哈希、甚至批量吊销 —— 权限被放大了。
--   而 device 进程**根本不需要**碰令牌表：它只读写 mcp_devices/mcp_remote_calls。
--   所以最小权限原则的答案是"完全不给"。
--
-- enabled + 无策略 = 对 anon/authenticated 全拒；service_role 绕过 RLS 照常工作。
-- ============================================================================

alter table public.mcp_api_tokens enable row level security;
alter table public.mcp_audit_log  enable row level security;


-- ============================================================================
-- 4. 显式收回表权限（不是可选步骤）
--
-- 自建 Supabase 的 default privileges 是：
--   postgres|public|r|{...anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,...}
-- 也就是**在 public 新建的表会自动授予 anon 与 authenticated 全部权限**
-- （SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER）。
-- 光开 RLS 不够靠得住：一旦有人日后误加一条宽松策略，权限立刻就在那里等着。
-- 所以这里直接收回，让"能碰到这张表"这件事本身就不成立。
--
-- 注意序列也要收回：bigserial 的序列同样被自动授了 anon=rwU，
-- 留着的话客户端可以 nextval() 抬走 ID，制造审计日志的序号空洞。
-- ============================================================================

revoke all on public.mcp_api_tokens from anon, authenticated;
revoke all on public.mcp_audit_log  from anon, authenticated;
revoke all on sequence public.mcp_audit_log_id_seq from anon, authenticated;

grant all on public.mcp_api_tokens to service_role;
grant all on public.mcp_audit_log  to service_role;
grant all on sequence public.mcp_audit_log_id_seq to service_role;


-- ============================================================================
-- 5. 令牌清理
--
-- 吊销/过期的令牌行没有保留价值（审计日志里已经记了"谁在何时吊销了哪个"），
-- 留着只会让表越长越大、并让"这个 prefix 到底还能不能用"变得需要额外判断。
-- ============================================================================

create or replace function public.sweep_dead_tokens(
  retention_interval interval default '30 days'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  delete from public.mcp_api_tokens
   where (revoked_at is not null and revoked_at < now() - retention_interval)
      or (expires_at is not null and expires_at < now() - retention_interval);

  get diagnostics affected = row_count;
  return affected;
end;
$$;

comment on function public.sweep_dead_tokens(interval) is '删除已吊销/已过期超过保留期的令牌行，返回删除行数';

revoke all on function public.sweep_dead_tokens(interval) from public, anon, authenticated;


-- ============================================================================
-- 6. 执行后自检（人工核对，不要放进自动化）
-- ============================================================================

-- 6.1 两张表都在
-- select tablename from pg_tables
--  where schemaname='public' and tablename in ('mcp_api_tokens','mcp_audit_log');

-- 6.2 表权限已收回 —— 期望 anon/authenticated **零行**
-- select relname, grantee, privilege_type
--   from information_schema.role_table_grants
--  where table_name in ('mcp_api_tokens','mcp_audit_log')
--    and grantee in ('anon','authenticated');
-- 期望输出：0 行

-- 6.3 RLS 已开且确实没有策略
-- select relname, relrowsecurity from pg_class
--  where relname in ('mcp_api_tokens','mcp_audit_log');
-- select tablename, count(*) from pg_policies
--  where tablename in ('mcp_api_tokens','mcp_audit_log') group by tablename;
-- 期望：relrowsecurity = t，且没有任何策略行

-- 6.4 端到端反证（最有价值的一条）：用 anon key 直连 PostgREST 读令牌表
--   curl -s -o /dev/null -w '%{http_code}\n' \
--     -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
--     "$SUPABASE_URL/rest/v1/mcp_api_tokens?select=id&limit=1"
-- 期望：401 或 403（permission denied），**不是** 200
-- 这一条如果不通过，说明权限没收干净 —— 后续所有隔离设计都白搭。
