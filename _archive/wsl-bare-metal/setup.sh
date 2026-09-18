#!/usr/bin/env bash
#
# setup.sh —— 在 WSL 里把「tunnel-client + 本地 MCP server」装好，并做分层验证
#
# 设计原则：**凡是能在没有 OpenAI 凭据的情况下验证的，都先验证掉。**
# 所以前 6 步全都不需要任何密钥，只有第 7 步（生成 profile）才用到 tunnel_id。
#
# 用法：
#   bash setup.sh
#     只装二进制 + 跑离线验证。
#
#   CONTROL_PLANE_TUNNEL_ID=tunnel_xxx CONTROL_PLANE_API_KEY=sk-xxx bash setup.sh
#     顺带生成 profile 并跑 doctor。key 会被落成 0600 文件，不放环境变量。
#
#   CONTROL_PLANE_TUNNEL_ID=tunnel_xxx CONTROL_PLANE_API_KEY_FILE=/path/to/key bash setup.sh
#     同上，但直接用已存在的 key 文件（推荐：key 不经过 shell 历史和环境变量）。
#
# 幂等：可重复跑。不碰系统目录，全部装在 $HOME 下。
#
# 如果报 "command not found" 或 \r 相关语法错误，先去掉 Windows 换行：
#   sed -i 's/\r$//' setup.sh

set -euo pipefail

# 从 Windows 侧以 `wsl.exe -e bash setup.sh` 调用时是非 login shell，
# .profile/.bashrc 都不会被 source，$HOME/.local/bin 可能不在 PATH 里
# （node 常装在那里）。这里显式补上，保证两种调用方式行为一致。
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/minimal-mcp-server"
PROFILE_NAME="wsl-stdio"
PROFILE_DIR="$HOME/.config/tunnel-client"
KEY_FILE="$PROFILE_DIR/control-plane.key"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; }
die()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; exit 1; }

# 端口占用探测：优先 ss（Linux 原生），退回 /dev/tcp
port_busy() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk 'NR>1 {print $4}' | grep -qE "[:.]$p\$"
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null && { exec 3>&-; return 0; } || return 1
  fi
}

say "0/7 环境确认"
if grep -qi microsoft /proc/version 2>/dev/null; then
  ok "运行在 WSL：$(grep -o 'WSL[0-9]*' /proc/version | head -1 || echo WSL)"
else
  warn "看起来不是 WSL（/proc/version 里没有 microsoft）—— 继续，但路径假设可能不成立"
fi

if ! command -v node >/dev/null 2>&1; then
  # 兜底：node 可能装在 PATH 之外（nvm / 手动解包 / Windows 侧 node）
  for cand in "$HOME/.local/bin/node" /usr/local/bin/node /usr/bin/node; do
    if [ -x "$cand" ]; then export PATH="$(dirname "$cand"):$PATH"; break; fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  die "没有 node。请先执行：sudo apt update && sudo apt install -y nodejs npm  （Ubuntu 24.04 自带 v18，够用）"
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node 版本过低（$(node -v)），MCP server 需要 >= 18"
fi
ok "node $(node -v) @ $NODE_BIN"

say "1/7 安装二进制到 $BIN_DIR"
mkdir -p "$BIN_DIR"
# install 顺带设权限位 —— 从 /mnt/c 直接执行会因为 drvfs 不带可执行位而失败，
# 所以必须复制到 Linux 文件系统里，不能就地跑。
install -m 0755 "$SRC_DIR/bin/tunnel-client" "$BIN_DIR/tunnel-client"
install -m 0755 "$SRC_DIR/bin/cloudflared"   "$BIN_DIR/cloudflared"
ok "tunnel-client（与 cloudflared 同目录，它是同级发现的，别拆散）"

case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR 已在 PATH 中" ;;
  *) warn "$BIN_DIR 不在 PATH 中，先执行：export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

say "2/7 确认 CLI 可用"
"$BIN_DIR/tunnel-client" help quickstart >/dev/null 2>&1 \
  && ok "$("$BIN_DIR/tunnel-client" version 2>/dev/null || echo 'v0.0.14（CLI 响应正常）')" \
  || die "tunnel-client 无法执行"

say "3/7 部署本地 MCP server 到 $APP_DIR"
mkdir -p "$APP_DIR"
cp "$SRC_DIR/mcp-server/server.js"   "$APP_DIR/server.js"
cp "$SRC_DIR/mcp-server/selftest.js" "$APP_DIR/selftest.js"
chmod 0644 "$APP_DIR/server.js" "$APP_DIR/selftest.js"
ok "server.js / selftest.js 已就位"

say "4/7 MCP 协议自检（stdio，本地这一半）"
if node "$APP_DIR/selftest.js" -- "$NODE_BIN" "$APP_DIR/server.js"; then
  ok "协议链路通过"
else
  die "MCP 自检失败 —— 上面的 FAIL 行就是问题所在"
fi

say "5/7 shell 执行能力自检"
if node "$APP_DIR/selftest.js" --call run_command '{"command":"uname -a; echo ---; whoami; echo ---; pwd"}' -- "$NODE_BIN" "$APP_DIR/server.js"; then
  ok "run_command 能在 WSL 里执行命令"
else
  warn "run_command 自检未通过（不影响链路，但会影响真实使用）"
fi

say "6/7 隧道数据通路离线验证（不需要任何 OpenAI 凭据）"
# tunnel-client 自带 dev proxy：本地内存控制面 + 进程内 runtime，
# 会暴露一个本地 MCP ingress。打它等于验证「控制面 → 隧道 → 本地 server」这条链。
# 它证明不了 OpenAI 托管侧，但能把「隧道这一半是不是好的」这个变量消掉。
if [ -x "$SRC_DIR/verify-tunnel-path.sh" ] || [ -f "$SRC_DIR/verify-tunnel-path.sh" ]; then
  if bash "$SRC_DIR/verify-tunnel-path.sh"; then
    ok "隧道数据通路离线验证通过"
  else
    warn "隧道离线验证未全绿 —— 看上面的 FAIL 行"
  fi
else
  warn "找不到 verify-tunnel-path.sh，跳过（它是本目录里的独立脚本）"
fi

say "7/7 tunnel profile"
if [ -z "${CONTROL_PLANE_TUNNEL_ID:-}" ]; then
  warn "未提供 CONTROL_PLANE_TUNNEL_ID，跳过 profile 生成"
  cat <<EOF

  拿到 tunnel_id 之后重跑本脚本即可（前 6 步会快速重过）：

    CONTROL_PLANE_TUNNEL_ID=tunnel_xxx \\
    CONTROL_PLANE_API_KEY_FILE=/path/to/key \\
    bash setup.sh

  值从哪来见同目录 README.md 的「你需要提供什么」。
EOF
  exit 0
fi

# ---- 选择 health 端口 ----
# 官方样例默认 127.0.0.1:8080，但这台机器上 8080 被 Docker Desktop 占了
# （com.docker.backend + wslrelay 转发进 WSL），照抄样例必然 EADDRINUSE。
HEALTH_PORT="${HEALTH_PORT:-}"
if [ -z "$HEALTH_PORT" ]; then
  for p in 18080 18081 18082 28080 38080; do
    if ! port_busy "$p"; then HEALTH_PORT="$p"; break; fi
  done
fi
if [ -n "$HEALTH_PORT" ]; then
  HEALTH_ADDR="127.0.0.1:$HEALTH_PORT"
  ok "health/admin 端口选定 $HEALTH_ADDR（8080 已被占用，故避开）"
else
  HEALTH_ADDR="127.0.0.1:0"
  warn "候选端口都被占用，改用临时端口 $HEALTH_ADDR —— admin UI 地址每次启动都会变"
fi

# ---- 选择 api key 引用方式 ----
# 优先 file: 引用：key 不进 shell 历史、不进环境变量、不进 ps/docker inspect。
mkdir -p "$PROFILE_DIR"
chmod 700 "$PROFILE_DIR"
if [ -n "${CONTROL_PLANE_API_KEY_FILE:-}" ]; then
  [ -r "$CONTROL_PLANE_API_KEY_FILE" ] || die "CONTROL_PLANE_API_KEY_FILE 不可读：$CONTROL_PLANE_API_KEY_FILE"
  KEY_REF="file:$CONTROL_PLANE_API_KEY_FILE"
  ok "使用已有的 key 文件：$CONTROL_PLANE_API_KEY_FILE"
elif [ -n "${CONTROL_PLANE_API_KEY:-}" ]; then
  umask 077
  printf '%s\n' "$CONTROL_PLANE_API_KEY" > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  KEY_REF="file:$KEY_FILE"
  ok "key 已落盘为 0600 文件：$KEY_FILE（比环境变量更不容易泄漏）"
else
  KEY_REF="env:CONTROL_PLANE_API_KEY"
  warn "未提供 key，profile 将引用 env:CONTROL_PLANE_API_KEY —— 跑 run 之前必须先 export"
fi

"$BIN_DIR/tunnel-client" init \
  --sample sample_mcp_stdio_local \
  --profile "$PROFILE_NAME" \
  --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --mcp-command "$NODE_BIN $APP_DIR/server.js" \
  --health-listen-addr "$HEALTH_ADDR" \
  --control-plane-api-key-ref "$KEY_REF" \
  --force
ok "profile 已生成：$PROFILE_NAME"

set +e
"$BIN_DIR/tunnel-client" doctor --profile "$PROFILE_NAME" --explain
DOC=$?
set -e
if [ "$DOC" -eq 0 ]; then
  ok "doctor 全绿"
else
  warn "doctor 未全绿（退出码 $DOC）—— 上面 FAILED_CHECKS 那几行就是要处理的"
fi

cat <<EOF

  下一步（前台跑，窗口别关）：

    $BIN_DIR/tunnel-client run --profile $PROFILE_NAME

  起来之后另开一个窗口验证：

    curl -fsS http://$HEALTH_ADDR/readyz && echo
    # admin UI: http://$HEALTH_ADDR/ui

  然后去 ChatGPT 建 connector（**必须先保证 daemon 在跑**，否则 ChatGPT 发现不到 tunnel）：
    https://chatgpt.com/#settings/Connectors

EOF
