#!/usr/bin/env bash
# 按序应用 supabase/migrations/*.sql 到自托管 Supabase 的 postgres 容器。
#
# 与 apply-schema.sh 的分工：
#   apply-schema.sh      建"基线" —— schema.sql 那套表结构（已冻结的内容）
#   apply-migrations.sh  增量演进 —— 基线之后的新变更，一个文件一个版本
#
# 用法：
#   bash tools/apply-migrations.sh              # 只跑未应用过的
#   bash tools/apply-migrations.sh --force      # 全部重跑（迁移都写成幂等，安全）
#   bash tools/apply-migrations.sh --list       # 只看状态，不执行
#
# 记账方式：public.schema_migrations 记录每个文件的应用时间与内容校验和。
# 校验和不匹配会告警 —— 说明"已应用的文件被改过"，这是最该被发现的情况：
# 它在别人机器上重跑时会产生与你这台不同的结果。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="$HERE/../../migrations"
CONTAINER="${SUPABASE_DB_CONTAINER:-supabase-db}"
DB_USER="${SUPABASE_DB_USER:-postgres}"
DB_NAME="${SUPABASE_DB_NAME:-postgres}"

FORCE=0
LIST_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --list)  LIST_ONLY=1 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

[ -d "$MIGRATIONS_DIR" ] || { echo "❌ 找不到迁移目录：$MIGRATIONS_DIR" >&2; exit 1; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "❌ 容器 $CONTAINER 不存在" >&2; exit 1; }
[ "$(docker inspect -f '{{.State.Status}}' "$CONTAINER")" = "running" ] \
  || { echo "❌ 容器 $CONTAINER 不在 running 状态" >&2; exit 1; }

psql_do() { docker exec -i "$CONTAINER" psql -q -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }

psql_do <<'SQL' >/dev/null
create table if not exists public.schema_migrations (
  filename   text primary key,
  checksum   text not null,
  applied_at timestamptz not null default now()
);
SQL

# 兼容 Windows 上的 Git Bash / macOS：优先用系统自带工具算 sha256
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

applied_checksum() {
  psql_do -At -c "select checksum from public.schema_migrations where filename = '$1'" 2>/dev/null | tr -d '\r'
}

echo "迁移目录：$MIGRATIONS_DIR"
echo

shopt -s nullglob
FILES=("$MIGRATIONS_DIR"/*.sql)
shopt -u nullglob

if [ ${#FILES[@]} -eq 0 ]; then
  echo "（没有迁移文件）"
  exit 0
fi

ran=0
skipped=0

for f in "${FILES[@]}"; do
  name="$(basename "$f")"
  sum="$(sha256_of "$f")"
  prev="$(applied_checksum "$name")"

  if [ -n "$prev" ] && [ "$prev" != "$sum" ]; then
    echo "⚠ $name 已应用过，但文件内容变了"
    echo "    已记录校验和：${prev:0:12}…"
    echo "    当前文件校验和：${sum:0:12}…"
    echo "    → 这意味着别人重跑会得到与你不同的结果。确认这是有意修改后，"
    echo "      用 --force 重跑，并考虑改成新的迁移文件而不是改这个。"
  fi

  if [ "$LIST_ONLY" = "1" ]; then
    if [ -n "$prev" ]; then echo "  已应用  $name"; else echo "  待应用  $name"; fi
    continue
  fi

  if [ -n "$prev" ] && [ "$prev" = "$sum" ] && [ "$FORCE" != "1" ]; then
    echo "  ── 跳过  $name（已应用）"
    skipped=$((skipped + 1))
    continue
  fi

  echo "  →  应用  $name"
  # 单个迁移放进一个事务：中途失败不会留下半截状态。
  # 迁移文件里刻意不写 begin/commit —— 由这里统一包裹。
  if (echo "begin;"; cat "$f"; echo "commit;") \
       | docker exec -i "$CONTAINER" psql -q -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME"; then
    psql_do -c "
      insert into public.schema_migrations (filename, checksum, applied_at)
      values ('$name', '$sum', now())
      on conflict (filename) do update
        set checksum = excluded.checksum, applied_at = excluded.applied_at" >/dev/null
    echo "     ✓ 完成"
    ran=$((ran + 1))
  else
    echo "     ❌ 失败 —— 已回滚，未记账" >&2
    exit 1
  fi
done

echo
echo "→ 迁移总览"
psql_do -At -F ' | ' -c "
  select filename, to_char(applied_at, 'MM-DD HH24:MI'), left(checksum, 12)
    from public.schema_migrations order by filename"

echo
echo "→ 多租户表自检"
psql_do -At -F '|' -c "
  select 'tables', string_agg(tablename, ',' order by tablename)
    from pg_tables where schemaname='public'
     and tablename in ('mcp_api_tokens','mcp_audit_log','schema_migrations')
  union all
  select 'rls_enabled', coalesce(string_agg(relname, ',' order by relname), '(无)')
    from pg_class where relname in ('mcp_api_tokens','mcp_audit_log') and relrowsecurity
  union all
  select 'policies', coalesce(string_agg(tablename||':'||policyname, ',' ), '(无 —— 这是预期结果)')
    from pg_policies where tablename in ('mcp_api_tokens','mcp_audit_log')
  union all
  select 'client_grants', coalesce(string_agg(distinct grantee||':'||table_name||':'||privilege_type, ','), '(无 —— 这是预期结果)')
    from information_schema.role_table_grants
   where table_name in ('mcp_api_tokens','mcp_audit_log') and grantee in ('anon','authenticated')
"

echo
echo "提示：client_grants 必须是「(无 —— 这是预期结果)」。"
echo "      若列出了任何权限，说明匿名/登录用户能读到令牌表 —— 必须立刻修掉。"
