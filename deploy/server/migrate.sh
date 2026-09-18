#!/usr/bin/env bash
# 把 relay 需要的表结构应用到**外部** Supabase 实例（Cloud 或自托管）。
#
# 用法：
#   1) 把连接串写进 secrets/supabase-db-url.txt（单行，整串 URI）
#   2) ./migrate.sh
#
# 连接串从 Supabase 控制台取：项目右上角 Connect → 选 **Session pooler** →
# 复制 URI，形如
#   postgresql://postgres.<ref>:<口令>@aws-0-<region>.pooler.supabase.com:5432/postgres
#
# ⚠️ 别用 Direct connection（db.<ref>.supabase.co）：Supabase 对它只给 AAAA 记录，
#    而这台机器没有全局 IPv6，psql 会卡到超时、报错还很难读。Session pooler
#    有 IPv4，走它。脚本检测到这个形态会直接拒跑，而不是让你等一分钟超时。
#
# 幂等：三个 SQL 里都是 create ... if not exists / create or replace，
# 重复执行是安全的。"跑一半失败 → 修掉 → 重跑"是正常操作。
#
# 关于口令暴露：连接串经 --env-file 传进容器，不出现在 docker run 的命令行参数里
# （命令行参数宿主上任何用户都能从 ps 看到）。临时 env 文件用完即删。
# SQL 同样走环境变量传参，避免在 sh -c 的引号里打架。

set -euo pipefail

cd "$(dirname "$0")"

DB_URL_FILE="secrets/supabase-db-url.txt"
PSQL_IMAGE="${PSQL_IMAGE:-postgres:18-alpine}"
FILES=(
  "db/schema.sql"
  "db/002-multi-tenant-auth.sql"
  "db/003-oauth-authorization-server.sql"
)

say() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "缺 docker"

# --------------------------------------------------------------------- 入参
if [ ! -s "$DB_URL_FILE" ]; then
  die "缺 $DB_URL_FILE

  从 Supabase 控制台 → Connect → **Session pooler** 复制 URI，然后：

    printf '%s\\n' 'postgresql://postgres.xxx:口令@aws-0-区域.pooler.supabase.com:5432/postgres' > $DB_URL_FILE
    chmod 600 $DB_URL_FILE"
fi

DB_URL="$(tr -d '\r\n' < "$DB_URL_FILE")"

case "$DB_URL" in
  postgres://*|postgresql://*) ;;
  *) die "$DB_URL_FILE 的内容不像连接串（应以 postgresql:// 开头）。
   控制台复制出来的是完整 URI；只填口令是跑不了的。" ;;
esac

case "$DB_URL" in
  *@db.*.supabase.co*|*@db.*.supabase.in*)
    die "这是 Direct connection（db.<ref>.supabase.co），本机没有全局 IPv6，连不上。
   改用 Session pooler：控制台 → Connect → Session pooler → URI。" ;;
esac

for f in "${FILES[@]}"; do
  [ -s "$f" ] || die "缺 $f（迁移 SQL 没随部署目录一起上传？）"
done

MASKED="$(printf '%s' "$DB_URL" | sed -E 's#(//[^:/@]+):[^@]*@#\1:***@#')"

# ---------------------------------------------------------------- psql 封装
# 两个薄封装，区别只在是喂 SQL 字符串还是喂 SQL 文件。
# 每次都用一个新的临时 env 文件 —— 不图省事复用，免得某次忘了删。
_psql_env() {
  local f
  f="$(mktemp)"
  chmod 600 "$f"
  printf 'DBURL=%s\n' "$DB_URL" > "$f"
  printf '%s' "$f"
}

# 注意两个封装里都显式 `|| rc=$?` 再 return：直接让 rm 收尾的话，
# 函数的退出码会变成 rm 的（0），于是"psql 失败"被吞掉 —— 调用点那边的
# if 会以为成功。这种错在迁移脚本里代价是"表建了一半却提示完成"。

# run_sql <SQL>：执行一句 SQL，返回输出
run_sql() {
  local sql="$1" f rc=0
  f="$(_psql_env)"
  printf 'Q=%s\n' "$sql" >> "$f"
  docker run --rm --env-file "$f" "$PSQL_IMAGE" \
    sh -c 'psql "$DBURL" -v ON_ERROR_STOP=1 -q -tA -c "$Q"' || rc=$?
  rm -f "$f"
  return $rc
}

# run_file <路径>：把文件当脚本执行
run_file() {
  local path="$1" f rc=0
  f="$(_psql_env)"
  docker run --rm -i --env-file "$f" "$PSQL_IMAGE" \
    sh -c 'psql "$DBURL" -v ON_ERROR_STOP=1 -q' < "$path" || rc=$?
  rm -f "$f"
  return $rc
}

# ----------------------------------------------------------------- 连接自检
say "目标实例：$MASKED"
say "将按顺序应用 ${#FILES[@]} 个文件"
echo
say "· 连通性自检"
if ! run_sql 'select current_user || chr(10) || version()' 2>&1 | head -3; then
  die "连不上。依次检查：
   1) 口令是否正确（控制台里改过口令的话，连接串要重新复制）
   2) 连接串是否被截断 —— 粘贴时最容易丢尾部的 /postgres 或整个口令段
   3) 是否用的 Session pooler（Direct connection 在本机连不上）"
fi
echo

# --------------------------------------------------------------------- 应用
for f in "${FILES[@]}"; do
  say "· 应用 $f"
  if ! run_file "$f"; then
    die "$f 执行失败。上面 psql 的报错就是原因；修掉后重跑本脚本即可（幂等）。"
  fi
done

# --------------------------------------------------------------------- 核对
echo
say "── 核对：public 下的 mcp_* 表 ──"
run_sql "select tablename from pg_tables where schemaname='public' and tablename ~ '^mcp_' order by 1"

echo
say "✓ 迁移完成。接下来："
echo "     docker compose up -d"
echo "     curl -s http://127.0.0.1:18086/healthz   # 看 db_error 是否为 null"
