#!/usr/bin/env bash
#
# verify.sh —— 容器内自验证：**不需要 OpenAI 凭据**，把「隧道数据通路」跑通
#
# 两段验证：
#   A. stdio 协议自检 —— tunnel-client 将来就是这样拉 server 的
#   B. tunnel-client dev proxy —— 在容器内起一个内存版控制面 + 完整 runtime，
#      并暴露本地 MCP ingress。打这个 ingress 等价于走完整条
#      「控制面 → 隧道 → 容器内 stdio server」，只是把 OpenAI 托管的那半
#      换成了内存实现。
#
# 所以本脚本能证明：隧道这一半在容器里是通的。
# 它**不能**证明：OpenAI 控制面的鉴权、tunnel 注册、ChatGPT connector 发现。
#
# 退出码 0 = 全绿。

set -uo pipefail

TC=/usr/bin/tunnel-client
NODE="$(command -v node)"
SERVER=/app/server.js
ST=/app/selftest.js
WORK=/tmp/verify

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()  { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; }

for f in "$TC" "$SERVER" "$ST"; do
  [ -e "$f" ] || { bad "缺少 $f"; exit 2; }
done

say "1/6 执行环境"
printf '  hostname    : %s\n' "$(hostname)"
printf '  user        : %s (uid=%s)\n' "$(id -un)" "$(id -u)"
printf '  kernel      : %s\n' "$(uname -r)"
printf '  node        : %s\n' "$("$NODE" -v)"
printf '  bash        : %s\n' "$(command -v bash || echo MISSING)"
printf '  cloudflared : %s\n' "$([ -x /usr/bin/cloudflared ] && echo present || echo MISSING)"
printf '  dockerenv   : %s\n' "$([ -f /.dockerenv ] && echo yes || echo no)"
echo '  挂载的宿主目录：'
FOUND_MOUNT=0
if [ -d /host ]; then
  for d in /host/*; do
    if [ -e "$d" ]; then printf '    %s\n' "$d"; FOUND_MOUNT=1; fi
  done
fi
[ "$FOUND_MOUNT" -eq 0 ] && echo '    (无 —— 容器只能访问自己的文件系统)'

say "2/6 stdio 协议自检（tunnel-client 就是这样拉 server 的）"
"$NODE" "$ST" -- "$NODE" "$SERVER"
RC1=$?
if [ "$RC1" -eq 0 ]; then ok "stdio 通路通过"; else bad "stdio 自检失败，退出码 $RC1"; fi

# dev proxy 是独立子命令，走 flag 配 server；清掉 MCP_COMMAND 避免与 flag 打架
unset MCP_COMMAND

rm -rf "$WORK"; mkdir -p "$WORK"
PROXY_PID=""
cleanup() { [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null; }
trap cleanup EXIT

say "3/6 启动 dev proxy（内存控制面 + tunnel-client runtime）"
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

say "4/6 proxy 交接信息"
printf '  proxy.json : %s\n' "$(cat "$WORK/proxy.json" 2>/dev/null || echo '(缺)')"
printf '  health.txt : %s\n' "$(cat "$WORK/health.txt" 2>/dev/null || echo '(缺)')"

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
  const all = [];
  (function walk2(o) {
    if (typeof o === "string") { if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(o)) all.push(o); return; }
    if (o && typeof o === "object") for (const k of Object.keys(o)) walk2(o[k]);
  })(j);
  process.stdout.write(all[0] || "");
}
' "$WORK/proxy.json" 2>/dev/null)"

if [ -z "$URL" ]; then
  bad "解析不到 ingress URL。完整 proxy 日志："
  sed -n '1,100p' "$WORK/proxy.log"
  exit 1
fi
ok "ingress URL = $URL"

say "5/6 对隧道 ingress 跑 MCP 协议自检"
TARGET=""
for cand in "$URL" "${URL%/}/mcp"; do
  if "$NODE" "$ST" --http "$cand" >"$WORK/st-try.log" 2>&1; then TARGET="$cand"; break; fi
done

if [ -z "$TARGET" ]; then
  bad "根路径和 /mcp 都不通。最后一次尝试："
  sed -n '1,60p' "$WORK/st-try.log"
  exit 1
fi
ok "可用 endpoint = $TARGET"
"$NODE" "$ST" --http "$TARGET"
RC2=$?

say "6/6 真实 shell 命令穿透隧道"
"$NODE" "$ST" --http "$TARGET" \
  --call run_command '{"command":"echo TUNNEL_REACHED_CONTAINER; uname -r; id -un; pwd; ls -1 /host 2>/dev/null || echo no-host-mounts"}'
RC3=$?

printf '\n'
if [ "$RC1" -eq 0 ] && [ "$RC2" -eq 0 ] && [ "$RC3" -eq 0 ]; then
  ok "全绿：stdio 协议 + 隧道数据通路（控制面为内存实现，非 OpenAI 托管）"
  exit 0
fi
bad "有失败：stdio=$RC1  http-selftest=$RC2  run_command=$RC3"
exit 1
