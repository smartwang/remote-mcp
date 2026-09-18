# syntax=docker/dockerfile:1
#
# tunnel-client + minimal-mcp-server，单容器
#
# 为什么要分两层：
#   官方镜像 ghcr.io/openai/tunnel-client 是 alpine 底，里面**只有** tunnel-client
#   和 cloudflared，没有 node —— 而我们的 MCP server 是 Node 脚本。
#   所以从这里取两个二进制，拷进 node 镜像，而不是反过来。
#
#   两个二进制必须落在**同一目录**：tunnel-client 按"可执行文件同级"发现 cloudflared。

ARG TUNNEL_IMAGE=ghcr.io/openai/tunnel-client:v0.0.14
FROM ${TUNNEL_IMAGE} AS tunnel

FROM node:22-alpine

LABEL org.opencontainers.image.title="tunnel-client + minimal-mcp-server"
LABEL org.opencontainers.image.description="OpenAI Secure MCP Tunnel with an in-container stdio MCP server"
LABEL org.opencontainers.image.source="https://github.com/openai/tunnel-client"

COPY --from=tunnel /usr/bin/tunnel-client /usr/bin/tunnel-client
COPY --from=tunnel /usr/bin/cloudflared  /usr/bin/cloudflared

# run_command 得有能用的工具，否则容器里什么都干不了。
# 刻意不装 docker CLI —— 不需要让容器去操作宿主 daemon。
RUN apk add --no-cache \
      bash curl git jq ripgrep procps less \
      ca-certificates tzdata \
 && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && mkdir -p /app /workspace /host

WORKDIR /app
COPY server/server.js   /app/server.js
COPY server/selftest.js /app/selftest.js
COPY scripts/verify.sh  /app/verify.sh
RUN chmod 0755 /app/verify.sh

# MCP_COMMAND 用 legacy 形式（直接给命令）即绑定 main channel。
# 换别的 MCP server 只改这一个变量，见 README「换成 DesktopCommander」。
ENV MCP_SHELL=/bin/bash \
    MCP_SCOPE=container \
    MCP_COMMAND="node /app/server.js" \
    HEALTH_LISTEN_ADDR=":8080" \
    LOG_LEVEL=info \
    LOG_FORMAT=struct-text

EXPOSE 8080

# 与官方镜像保持一致。compose 通过 environment / command 追加参数。
ENTRYPOINT ["/usr/bin/tunnel-client", "run"]
