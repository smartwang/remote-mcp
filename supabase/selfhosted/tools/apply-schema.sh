#!/usr/bin/env bash
# 把 remote-mcp/supabase/schema.sql 应用到自托管 Supabase 的 postgres 容器。
#
# 幂等：schema.sql 全部用 create ... if not exists / create or replace / drop policy if exists，
# 重复执行安全。
#
# 用法：
#   bash tools/apply-schema.sh
#   bash tools/apply-schema.sh ../schema.sql
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCHEMA="${1:-$HERE/../../schema.sql}"
CONTAINER="${SUPABASE_DB_CONTAINER:-supabase-db}"
DB_USER="${SUPABASE_DB_USER:-postgres}"
DB_NAME="${SUPABASE_DB_NAME:-postgres}"

if [ ! -f "$SCHEMA" ]; then
  echo "❌ 找不到 schema 文件：$SCHEMA" >&2
  exit 1
fi

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "❌ 容器 $CONTAINER 不存在。先起 Supabase 栈：
     cd ../selfhosted && docker compose up -d" >&2
  exit 1
fi

STATE=$(docker inspect -f '{{.State.Status}}' "$CONTAINER")
if [ "$STATE" != "running" ]; then
  echo "❌ 容器 $CONTAINER 状态是 $STATE，不是 running" >&2
  exit 1
fi

echo "→ 应用 $SCHEMA 到 $CONTAINER ($DB_USER@$DB_NAME)"
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$SCHEMA"

echo
echo "→ 自检"
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -At -F '|' -c "
  select 'tables', string_agg(tablename, ',' order by tablename)
    from pg_tables where schemaname='public' and tablename like 'mcp_%'
  union all
  select 'views', string_agg(viewname, ',' order by viewname)
    from pg_views where schemaname='public' and viewname like 'mcp_%'
  union all
  select 'policies', string_agg(schemaname||'.'||tablename||':'||policyname, ',' order by policyname)
    from pg_policies where (schemaname='public' and tablename like 'mcp_%') or schemaname='realtime'
  union all
  select 'functions', string_agg(proname, ',' order by proname)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and proname like 'sweep%'
  union all
  select 'grants_authenticated', string_agg(distinct table_name||':'||privilege_type, ',' order by table_name||':'||privilege_type)
    from information_schema.role_table_grants
    where grantee='authenticated' and table_name like 'mcp_%'
"

# realtime.messages 由 Realtime 服务自己建，可能晚于本脚本。
# 缺了它，第 4 节的两个私有频道策略就没建上 —— 必须重跑。
echo
RT_EXISTS=$(docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -At -c "
  select count(*) from information_schema.tables
   where table_schema='realtime' and table_name='messages'")
if [ "$RT_EXISTS" = "1" ]; then
  echo "✓ realtime.messages 存在，私有频道策略已生效"
else
  echo "⚠ realtime.messages 还不存在 —— Realtime 容器还没跑完迁移。"
  echo "  等下面这条返回 running/healthy 后，重跑本脚本即可（幂等）："
  echo "    docker compose -f ../selfhosted/docker-compose.yml ps realtime"
fi
