-- ============================================================================
-- remote-mcp · Supabase 数据层
--
-- 目标：复刻 mcp.desktopcommander.app 的服务端数据层，使开源 device 端在
--       设置 MCP_SERVER_URL 指向本服务后可以正常工作，并支撑 ChatGPT/Claude
--       通过自定义 connector 调用本机电脑。
--
-- 契约来源（字段名严格对齐，勿随意改名）：
--   DesktopCommanderMCP/src/remote-device/remote-channel.ts
--   DesktopCommanderMCP/src/remote-device/device.ts
--   DesktopCommanderMCP/src/remote-device/device-authenticator.ts
--
-- 角色划分：
--   · device 进程        → anon(publishable) key + 用户 JWT，读写均受 RLS 约束
--   · 你的服务(VPS)      → service_role key，绕过 RLS，负责建行/广播/结算
--   · ChatGPT / Claude   → 只经你的服务，永远不直接触碰 Supabase
-- ============================================================================

create extension if not exists pgcrypto;


-- ============================================================================
-- 1. 设备表
--
-- device 端行为对应的契约：
--   findDevice      select id, device_name where id=? and user_id=?
--   updateDevice    update {status, last_seen, capabilities, device_name}
--   updateHeartbeat update {last_seen, status='online'}      (定时)
--   setOnlineStatus update {status}
--   setOffline      update {status='offline'}
--   capabilities    jsonb，device 端只写 {app_version, transport_broadcast_v1?}
-- ============================================================================

create table if not exists public.mcp_devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  device_name  text not null default '',
  status       text not null default 'offline'
                 check (status in ('online', 'offline')),
  last_seen    timestamptz not null default now(),
  capabilities jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

comment on table  public.mcp_devices is '用户授权过的远程设备（一台机器一行）';
comment on column public.mcp_devices.status is 'device 自报状态；崩溃时会滞留在 online，真实在线请用 mcp_device_presence 视图判定';
comment on column public.mcp_devices.last_seen is '心跳写入时间，用于过期判定';
comment on column public.mcp_devices.capabilities is 'device 能力声明。transport_broadcast_v1=true 表示可走 Realtime 广播派发；tools 由 fork 后的 device 端上报（见 tasks #4）';

create index if not exists mcp_devices_user_idx      on public.mcp_devices (user_id);
create index if not exists mcp_devices_last_seen_idx on public.mcp_devices (last_seen desc);


-- ============================================================================
-- 2. 调用表
--
-- 生命周期（务必保持这个状态机，device 端的幂等抢占依赖它）：
--   pending ──claim──> executing ──> completed
--                                   └> failed
--   pending/executing ──超时──> timeout
--
-- device 端行为对应的契约：
--   onDoorbell             select * where id=?             （必须能读到整行）
--   markCallExecuting      update {status='executing'} where id=? and status='pending'
--                          ↑ 这个条件是幂等的关键：并发/重投递时只有一个能抢到
--   updateCallResult       update {status, result, error_message, completed_at}
-- ============================================================================

create table if not exists public.mcp_remote_calls (
  id            uuid primary key default gen_random_uuid(),
  device_id     uuid not null references public.mcp_devices(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  tool_name     text not null,
  tool_args     jsonb not null default '{}'::jsonb,
  metadata      jsonb not null default '{}'::jsonb,
  status        text not null default 'pending'
                  check (status in ('pending', 'executing', 'completed', 'failed', 'timeout')),
  result        jsonb,
  error_message text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

comment on table  public.mcp_remote_calls is '一次工具调用的完整生命周期记录，同时充当服务端与 device 之间的传输通道';
comment on column public.mcp_remote_calls.result is 'jsonb。写入前必须剥离 NUL(U+0000)，否则 Postgres 22P05 会整体拒绝本次写入，调用将卡在 executing 直到超时';
comment on column public.mcp_remote_calls.error_message is 'text。同样不能含 NUL';

-- 门铃只带 id，device 按主键回查，所以主键索引是热路径
create index if not exists mcp_calls_device_status_idx on public.mcp_remote_calls (device_id, status);
create index if not exists mcp_calls_user_idx          on public.mcp_remote_calls (user_id, created_at desc);
-- 超时清扫用
create index if not exists mcp_calls_pending_idx       on public.mcp_remote_calls (created_at)
  where status in ('pending', 'executing');


-- ============================================================================
-- 3. RLS：多用户隔离
--
-- 注意：/api/mcp-info 会把 anon(publishable) key 明文下发给 device，这是设计
-- 如此。安全性完全由这里兜底，因此策略必须收紧。
-- ============================================================================

alter table public.mcp_devices      enable row level security;
alter table public.mcp_remote_calls enable row level security;

-- 设备：只能看/改自己的行。建行由服务端 service_role 负责，不开放给客户端。
drop policy if exists mcp_devices_select_own on public.mcp_devices;
create policy mcp_devices_select_own on public.mcp_devices
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists mcp_devices_update_own on public.mcp_devices;
create policy mcp_devices_update_own on public.mcp_devices
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 调用：通过 device 归属间接限定，device 只能碰自己设备的调用
drop policy if exists mcp_calls_select_own on public.mcp_remote_calls;
create policy mcp_calls_select_own on public.mcp_remote_calls
  for select to authenticated
  using (device_id in (select id from public.mcp_devices where user_id = auth.uid()));

drop policy if exists mcp_calls_update_own on public.mcp_remote_calls;
create policy mcp_calls_update_own on public.mcp_remote_calls
  for update to authenticated
  using (device_id in (select id from public.mcp_devices where user_id = auth.uid()))
  with check (device_id in (select id from public.mcp_devices where user_id = auth.uid()));

-- 不提供 insert 策略：调用行只能由服务端创建，
-- 否则客户端可以伪造调用记录，绕过 tools/call 的路由与配额。


-- ---------------------------------------------------------------------------
-- 3.1 表权限
--
-- 托管版 Supabase 会给 public schema 的新表自动授予 anon/authenticated，
-- 自建版沿用同一套 default privileges，通常也不用管。但显式写一遍成本为零，
-- 而且能避免"策略写对了却仍然 42501 permission denied"这种排查半小时的坑。
-- 注意：权限是前提，RLS 是限制，两者都要有。
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;

grant select, update         on public.mcp_devices      to authenticated;
grant select, update         on public.mcp_remote_calls to authenticated;

-- 注意：mcp_device_presence 是视图，在第 5 节才创建 ——
-- 授权必须放在视图创建之后，否则这里会报 relation does not exist。

-- 服务端用 service_role（绕过 RLS），需要完整权限
grant all on public.mcp_devices, public.mcp_remote_calls to service_role;


-- ============================================================================
-- 4. Realtime 私有频道
--
-- device 端订阅：channel('user:<user_id>', { private: true, presence: {...} })
--               .on('broadcast', { event: 'new_call' }, ...)
-- 门铃由服务端用 service_role 广播，payload 仅 {call_id, device_id}。
-- 私有频道（private: true）的订阅授权走 realtime.messages 的 RLS。
--
-- 注意：realtime.messages 的 RLS 默认就是打开的，官方明确说不需要（也不建议）
-- 再执行 ALTER TABLE ... ENABLE ROW LEVEL SECURITY，realtime schema 被锁得很死。
-- 这里只创建 policy，不动表结构。
--
-- device 端的实际动作只有两类（已核对 remote-channel.ts）：
--   · 收 broadcast  → 需要 select
--   · presence track → 需要 insert
-- 它自己从不 broadcast，所以 insert 策略按 extension='presence' 收紧。
-- 若要放开给客户端广播，再把 'broadcast' 加进 in 列表。
-- ============================================================================

-- 注意：realtime.messages **不是**本仓库建的，是 Realtime 服务启动时自己跑
-- Ecto 迁移创建的（volumes/db/realtime.sql 只建了 _realtime schema）。
-- 所以这里必须做存在性判断，否则在 Realtime 首次启动完成之前执行本文件
-- 会直接报 relation "realtime.messages" does not exist，
-- 而 psql -v ON_ERROR_STOP=1 会因此中断整个脚本、连前面的表都白建。
--
-- 如果看到下面的 NOTICE，说明要等 Realtime 起来后再重跑一次本文件。

do $$
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'realtime' and table_name = 'messages'
  ) then
    raise notice 'realtime.messages 尚不存在 —— 先启动 Realtime 容器让它跑完迁移，然后重新执行本文件第 4 节。';
    return;
  end if;

  -- 直接用 topic 列而不是 realtime.topic()：语义相同，但少依赖一个 helper 函数。
  execute 'drop policy if exists mcp_realtime_read_own_channel on realtime.messages';
  execute $p$
    create policy mcp_realtime_read_own_channel on realtime.messages
      for select to authenticated
      using (topic = 'user:' || auth.uid()::text)
  $p$;

  execute 'drop policy if exists mcp_realtime_write_own_channel on realtime.messages';
  execute $p$
    create policy mcp_realtime_write_own_channel on realtime.messages
      for insert to authenticated
      with check (
        extension in ('presence')
        and topic = 'user:' || auth.uid()::text
      )
  $p$;

  raise notice 'realtime.messages 策略已就位（select + insert/presence）';
end $$;


-- ============================================================================
-- 5. 真实在线判定
--
-- 不要直接信 mcp_devices.status：device 异常退出时它会滞留在 'online'。
-- 心跳节奏（来自 remote-channel.ts:51-52）：
--   · 具备广播能力  CAPABLE_HEARTBEAT_INTERVAL = 5 分钟
--   · 旧版/降级     LEGACY_HEARTBEAT_INTERVAL  = 15 秒
-- 判定窗口取上游服务端同款阈值（remote-channel.ts:49-50 注释写明服务端
-- 常量是 capable -> 15 min / unflagged -> 45s），不要收得更紧：
-- 心跳本身 5 分钟一次，窗口若只给 6 分钟会在下一次心跳前抖动成离线。
--
-- 备注：窗口仍是"最后心跳"推断，不是真在线。要精确判定可用 Realtime
-- Presence（device 已按 device_id 作 key 上报 presence），但那需要拿 tenant
-- admin token 调 Realtime 的 API，属于后续优化项。
-- ============================================================================

create or replace view public.mcp_device_presence
with (security_invoker = true) as
select
  d.*,
  (d.last_seen > now() - case
      when (d.capabilities ->> 'transport_broadcast_v1') = 'true'
        then interval '15 minutes'
      else interval '45 seconds'
    end) as is_online
from public.mcp_devices d;

comment on view public.mcp_device_presence is '带真实在线判定的设备视图。服务端路由调用前应以此判定，而不是读 status 字段';

-- 视图的授权（必须在 create view 之后）
grant select on public.mcp_device_presence to authenticated;


-- ============================================================================
-- 6. 超时清扫
--
-- device 端不负责超时：它只写 completed/failed。所有"没有下文"的调用
-- 都必须由服务端收回，否则调用方要干等满超时。
--
-- 注意：device-authenticator / remote-channel 里的调用方超时是 5 分钟，
-- 所以默认阈值必须与之对齐。
-- ============================================================================

create or replace function public.sweep_stale_calls(
  timeout_interval interval default '5 minutes'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.mcp_remote_calls
     set status        = 'timeout',
         error_message = 'Timed out awaiting device response',
         completed_at  = now()
   where status in ('pending', 'executing')
     and created_at < now() - timeout_interval;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

comment on function public.sweep_stale_calls(interval) is '把超时未结算的调用置为 timeout，返回受影响行数。建议用 pg_cron 每分钟调用';

revoke all on function public.sweep_stale_calls(interval) from public, anon, authenticated;


-- 可选：开启 pg_cron 后按分钟清扫
-- 托管版：Dashboard → Database → Extensions 启用后执行下面的 schedule
-- 自建版：supabase/postgres 镜像自带 pg_cron，create extension if not exists pg_cron; 即可
-- select cron.schedule('sweep-stale-calls', '* * * * *',
--   $$select public.sweep_stale_calls('5 minutes')$$);


-- ============================================================================
-- 7. 执行后自检
--
-- 这几条是"一次性人工核对"，不要放进迁移脚本里自动跑。
-- 前四条在托管版和自建版都要过；第五条只在自建版需要确认。
-- ============================================================================

-- 7.1 两张表 + 视图都在
-- select table_name from information_schema.tables
--  where table_schema = 'public' and table_name like 'mcp_%';

-- 7.2 策略数量与预期一致（devices 2 条、calls 2 条、realtime 2 条）
-- select schemaname, tablename, policyname from pg_policies
--  where schemaname in ('public', 'realtime') order by schemaname, tablename;

-- 7.3 权限到位（authenticated 对两张表应有 SELECT/UPDATE）
-- select table_name, privilege_type from information_schema.role_table_grants
--  where grantee = 'authenticated' and table_name like 'mcp_%';

-- 7.4 清扫函数可调用，且客户端调不动
-- select public.sweep_stale_calls('5 minutes');   -- 应返回受影响行数（0 也算通过）

-- 7.5 【仅自建版】确认 private 频道的鉴权真的被强制执行。
-- 托管版靠 Dashboard 的 "Allow public access to channels" 开关；
-- 自建版没有这个开关（官方 changelog 标 "Self-hosted: Not affected"），
-- 默认行为我没有从官方文档确认到，所以必须实测，不要假设。
--   a) 用 A 账号跑 device，确认能正常 SUBSCRIBED 且 presence 上报成功；
--   b) 用 B 账号的 JWT 尝试订阅 'user:<A的uuid>'，期望被拒；
--   c) 若 (b) 意外成功，说明鉴权没生效——此时先查是否存在放通所有 topic 的
--      兜底策略，再去 Realtime 的 tenant 配置里找 private-only 开关。
-- select * from _realtime.tenants;   -- 看租户配置里与 private 相关的字段
-- 注意：影响面有限但不能忽略。即使频道被蹭，门铃 payload 只有
-- {call_id, device_id}，而这两张表的 RLS 决定了蹭频道的人既读不到调用内容、
-- 也无法伪造调用行。所以最坏情况是"信号泄露"，不是"数据泄露"。
