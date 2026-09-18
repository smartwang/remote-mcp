#!/usr/bin/env bash
# deploy/server 的一键初始化。在服务器上的部署目录里跑：
#
#   cd /root/remote-mcp-relay
#   SUPABASE_URL=https://xxx.supabase.co \
#   PUBLIC_SUPABASE_URL=https://xxx.supabase.co \
#   SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
#   SUPABASE_SECRET_KEY=sb_secret_... \
#   ./setup.sh
#
# 两个 key 从 Supabase 控制台拿：Settings → API Keys → Publishable key / Secret keys。
# **不要用 Legacy 那两把**（叫 anon / service_role，值形如 eyJ…）：官方已标弃用
# （2026 年底），新部署没有理由从弃用路径起步。
#
# 已存在的东西不会被覆盖 —— 重复执行是安全的（幂等的），
# 这样"改一个值再跑一遍"不会把已生成的令牌和口令冲掉。
#
# 它替你做三件手工容易做错的事：
#   ① secret 文件属主改成 1000:1000 —— 否则容器以 node 用户读不了（EACCES）；
#   ② .env 从 .env.example 生成并填好必填项，不手抄；
#   ③ 生成高熵的 admin 令牌与初始管理员口令。

set -euo pipefail

cd "$(dirname "$0")"

# 容器里跑 relay 的用户。见 relay/Dockerfile 的 USER node 与 --chown。
CONTAINER_UID=1000
CONTAINER_GID=1000

say() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v openssl >/dev/null || die "缺 openssl，先装：apt-get install -y openssl"
command -v docker >/dev/null || die "缺 docker"

mkdir -p secrets

# ---------------------------------------------------------------------------
# ① .env
# ---------------------------------------------------------------------------
if [ -f .env ]; then
  say "· .env 已存在，保留不动"
else
  cp .env.example .env
  say "· 已从 .env.example 生成 .env"
fi

set_kv() {
  # set_kv KEY VALUE —— 存在则替换整行，不存在则追加。值里的 / 和 & 都要安全。
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    # 用 | 当分隔符：URL 和 key 里含 / 但不是 |。
    # 值里若含 | 会出问题 —— Supabase 的 key 是 base64url，不含 |。
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}

# ---------------------------------------------------------------------------
# ② Supabase —— 四个值都从环境变量来；没传就跳过，由最后的体检报出来
# ---------------------------------------------------------------------------
if [ -n "${SUPABASE_URL:-}" ]; then set_kv SUPABASE_URL "$SUPABASE_URL"; say "· SUPABASE_URL 已写入"; fi
if [ -n "${PUBLIC_SUPABASE_URL:-}" ]; then set_kv PUBLIC_SUPABASE_URL "$PUBLIC_SUPABASE_URL"; say "· PUBLIC_SUPABASE_URL 已写入"; fi

if [ -n "${SUPABASE_PUBLISHABLE_KEY:-}" ]; then
  printf '%s\n' "$SUPABASE_PUBLISHABLE_KEY" > secrets/supabase-publishable-key.txt
  say "· secrets/supabase-publishable-key.txt 已写入"
fi
if [ -n "${SUPABASE_SECRET_KEY:-}" ]; then
  printf '%s\n' "$SUPABASE_SECRET_KEY" > secrets/supabase-secret-key.txt
  say "· secrets/supabase-secret-key.txt 已写入"
fi

# 改名前的旧文件名：留一份搬走而不是留一份报错说明 —— 免得老手照着旧文档
# 又把文件建回来，那时容器会以"缺 key"启动失败，而目录里明明摆着两个 txt。
for old in supabase-anon-key:supabase-publishable-key supabase-service-role-key:supabase-secret-key; do
  from="secrets/${old%%:*}.txt"
  to="secrets/${old##*:}.txt"
  if [ -s "$from" ] && [ ! -s "$to" ]; then
    mv "$from" "$to"
    warn "· 已把旧文件名 $from 改名为 $to（2026-09-18 更名，旧名不再被读取）"
  fi
done

# ---------------------------------------------------------------------------
# ③ 自生成的密钥
# ---------------------------------------------------------------------------
if [ -s secrets/relay-admin-token.txt ]; then
  say "· admin 令牌已存在，保留不动"
else
  printf '%s\n' "rmcpadmin_$(openssl rand -hex 24)" > secrets/relay-admin-token.txt
  say "· 已生成 admin 令牌 → secrets/relay-admin-token.txt"
fi

if grep -qE '^RELAY_OWNER_PASSWORD=..+' .env; then
  say "· 初始管理员口令已存在，保留不动"
else
  OWNER_PW="$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 28)"
  set_kv RELAY_OWNER_PASSWORD "$OWNER_PW"
  say "· 已生成初始管理员口令 → .env 的 RELAY_OWNER_PASSWORD"
fi

# ---------------------------------------------------------------------------
# ④ 属主 —— 最容易漏的一步，放在最后确保前面新建的文件都被覆盖
# ---------------------------------------------------------------------------
chown "${CONTAINER_UID}:${CONTAINER_GID}" secrets/*.txt
chmod 600 secrets/*.txt .env 2>/dev/null || true
say "· secrets/*.txt 属主已设为 ${CONTAINER_UID}:${CONTAINER_GID}，权限 600"

# ---------------------------------------------------------------------------
# ⑤ 体检
# ---------------------------------------------------------------------------
echo
say "── 体检 ──"

fail=0
[ -s secrets/supabase-publishable-key.txt ] || { warn "  ✗ 缺 secrets/supabase-publishable-key.txt（传 SUPABASE_PUBLISHABLE_KEY=sb_publishable_... 重跑）"; fail=1; }
[ -s secrets/supabase-secret-key.txt ]      || { warn "  ✗ 缺 secrets/supabase-secret-key.txt（传 SUPABASE_SECRET_KEY=sb_secret_... 重跑）"; fail=1; }
# 兜一句：Legacy 的 anon / service_role 不是"另一种可选填法"，是弃用凭据。
for f in secrets/supabase-publishable-key.txt secrets/supabase-secret-key.txt; do
  [ -s "$f" ] || continue
  case "$(cut -c1-3 "$f")" in
    eyJ) warn "  ! $f 的内容是 JWT（eyJ…）。"
         warn "    · 连 Supabase Cloud → 这是 Legacy 的 anon / service_role，请换成"
         warn "      sb_publishable_… / sb_secret_…（官方已标弃用，2026 年底停用）。"
         warn "    · 连自托管 Supabase → 正常，那边就是 HS256 + JWT_SECRET 签出来的角色 JWT。" ;;
  esac
done
grep -qE '^SUPABASE_URL=https' .env          || { warn "  ✗ .env 的 SUPABASE_URL 未填或非 https"; fail=1; }
grep -qE '^PUBLIC_SUPABASE_URL=https' .env   || { warn "  ✗ .env 的 PUBLIC_SUPABASE_URL 未填或非 https"; fail=1; }
grep -qE '^RELAY_PUBLIC_URL=https://[^/]+$' .env || warn "  ! RELAY_PUBLIC_URL 不是以 https:// 开头、或不带结尾斜杠的形式 —— 请核对"

if [ "$fail" -ne 0 ]; then
  echo
  die "还差上面的东西，补齐后再跑一次本脚本。"
fi

echo
say "✓ 初始化完成。下一步："
echo "     docker compose up -d"
echo "     docker compose logs -f --tail=40 relay"
echo
echo "  控制台入口（登录后请立刻改口令）："
echo "     $(grep '^RELAY_PUBLIC_URL=' .env | cut -d= -f2-)/console"
echo "     账号：$(grep '^RELAY_OWNER_EMAIL=' .env | cut -d= -f2-)"
echo "     初口令：cat .env | grep RELAY_OWNER_PASSWORD"
