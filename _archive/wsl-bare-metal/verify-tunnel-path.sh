#!/usr/bin/env bash
#
# verify-tunnel-path.sh —— 不依赖 OpenAI 凭据，端到端验证「隧道数据通路」
#
# 原理：tunnel-client 自带 `dev proxy`，它会在本地起一个**内存版控制面**
# 和一个进程内的 tunnel-client runtime，然后暴露一个本地 MCP ingress URL。
# 对这个 URL 发 MCP 请求，等价于「控制面 → tunnel → 本地 stdio server」这条链，
# 只是把 OpenAI 托管的控制面换成了内存实现。
#
# 因此本脚本能证明：隧道这一半是通的。
# 它**不能**证明：OpenAI 控制面侧的鉴权、tunnel 注册、ChatGPT connector 发现。
#
# 退出码 0 = 全绿。

set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"

TC="$HOME/.local/bin/tunnel-client"
NODE="$(command -v node)"
SERVER="$HOME/.local/share/minimal-mcp-server/server.js"
ST="$HOME/.local/share/minimal-mcp-server/selftest.js"
WORK="/tmp/tunnel-verify"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; }

for f in "$TC" "$NODE" "$SERVER" "$ST"; do
  [ -e "$f" ] || { bad "缺少 $f —— 先跑 setup.sh"; exit 2; }
done

rm -rf "$WORK"; mkdir -p "$WORK"
PROXY_PID=""
cleanup() { [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null; }
trap cleanup EXIT

say "1/6 启动 dev proxy（内存控制面 + tunnel-client runtime）"
"$TC" dev proxy \
  --mcp-command "$NODE $SERVER" \
  --url-file "$WORK/proxy.json" \
  --health-url-file "$WORK/health.txt" \
  --readiness-timeout 30s \
  >"$WORK/proxy.log" 2>&1 &
PROXY_PID=$!
ok "pid=$PROXY_PID"

for _ in $(seq 1 100); do
  [ -s "$WORK/proxy.json" ] && break
  kill -0 "$PROXY_PID" 2>/dev/null || break
  sleep 0.3
done

if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  bad "dev proxy 已退出。日志："
  sed -n '1,80p' "$WORK/proxy.log"
  exit 1
fi

say "2/6 proxy 交接信息"
printf '  proxy.json : %s\n' "$(cat "$WORK/proxy.json" 2>/dev/null || echo '(缺)')"
printf '  health.txt : %s\n' "$(cat "$WORK/health.txt" 2>/dev/null || echo '(缺)')"

say "3/6 从交接 JSON 里解析 MCP ingress URL"
URL="$("$NODE" -e '
const fs = require("fs");
let raw = "";
try { raw = fs.readFileSync(process.argv[1], "utf8"); } catch { process.exit(0); }
let j;
try { j = JSON.parse(raw); } catch { process.exit(0); }
const hits = [];
(function walk(o, path) {
  if (typeof o === "string") {
    if (/^https?:\/\//.test(o) && /(mcp|ingress)/i.test(path)) hits.push({ path, url: o });
    return;
  }
  if (o && typeof o === "object") for (const k of Object.keys(o)) walk(o[k], path + "." + k);
})(j, "");
if (hits.length) { process.stdout.write(hits[0].url); }
else {
  // 没带 mcp/ingress 字样就退回：取第一个 loopback http 地址
  const all = [];
  (function walk2(o) {
    if (typeof o === "string") { if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(o)) all.push(o); return; }
    if (o && typeof o === "object") for (const k of Object.keys(o)) walk2(o[k]);
  })(j);
  process.stdout.write(all[0] || "");
}
' "$WORK/proxy.json" 2>/dev/null)"

if [ -z "$URL" ]; then
  bad "解析不到 URL，原始交接 JSON 见上。以下是完整 proxy 日志："
  sed -n '1,100p' "$WORK/proxy.log"
  exit 1
fi
ok "URL = $URL"

say "4/6 对隧道 ingress 跑 MCP 协议自检"
# ingress 可能挂在根路径，也可能挂在 /mcp；两个都试
TARGET=""
for cand in "$URL" "${URL%/}/mcp"; do
  if node "$ST" --http "$cand" >"$WORK/st-try.log" 2>&1; then TARGET="$cand"; break; fi
done

if [ -z "$TARGET" ]; then
  bad "根路径和 /mcp 都不通。最后一次尝试的输出："
  sed -n '1,60p' "$WORK/st-try.log"
  exit 1
fi
ok "可用 endpoint = $TARGET"

say "5/6 完整自检输出（tools/call get_system_info 穿过隧道）"
node "$ST" --http "$TARGET"
RC=$?

printf '\n'
if [ "$RC" -eq 0 ]; then
  ok "隧道数据通路验证通过（控制面为内存实现，非 OpenAI 托管）"
else
  bad "自检未全绿，退出码 $RC"
  exit "$RC"
fi

say "6/6 真实 shell 命令穿透隧道（run_command）"
node "$ST" --http "$TARGET" \
  --call run_command '{"command":"echo TUNNEL_REACHED_WSL; uname -r; whoami; pwd; ls /mnt/c/Users/longyuan/workspace/remote-mcp"}'
RC2=$?

printf '\n'
if [ "$RC2" -eq 0 ]; then
  ok "命令在 WSL 内真实执行并回传 —— 这不是模拟"
else
  bad "run_command 穿透失败，退出码 $RC2"
fi
exit "$RC2"
