# 中继 relay 的容器镜像。
#
# 零依赖（package.json 的 dependencies 是空对象），所以**没有 npm install 这一步** ——
# 镜像里只有 node 运行时 + 源码，构建是秒级的。
#
# 这个镜像的用途是让中继和隧道作为同一个部署单元上服务器：
#
#   ┌─ 服务器 ────────────────────────────────┐
#   │  relay（主服务）+ tunnel-client（边车）  │
#   └─────────────────────────────────────────┘
#                    ↑ 出站
#   Windows 宿主：device 进程（只出站）
#
# 本地开发时中继仍可以直接 `node src/index.js` 跑在宿主上 —— 见 README。

FROM node:22-alpine

# OCI 标签。org.opencontainers.image.source 不只是注释 —— GHCR 靠它把这个
# package 认领给仓库，这样镜像页会显示仓库 README，也才有"这张镜像从哪来的"。
LABEL org.opencontainers.image.title="remote-mcp-relay" \
      org.opencontainers.image.description="自建 MCP 中继：多租户 OAuth 2.1 鉴权 + 按租户设备路由" \
      org.opencontainers.image.source="https://github.com/smartwang/remote-mcp" \
      org.opencontainers.image.url="https://github.com/smartwang/remote-mcp" \
      org.opencontainers.image.documentation="https://github.com/smartwang/remote-mcp/blob/main/relay/README.md" \
      org.opencontainers.image.vendor="smartwang"

WORKDIR /app

# 源码。catalog.json 是工具表，已纳入版本控制，必须随镜像走 ——
# 缺了它 config.validate() 会直接拒绝启动。
COPY package.json ./
COPY src ./src
COPY tools ./tools
COPY catalog.json ./

# RELAY_HOST 默认值是 127.0.0.1（本机开发用），容器里必须显式改成 0.0.0.0，
# 否则容器内监听回环、宿主侧发布端口拿到的是 connection refused。
#
# 会话签名密钥走文件而不是环境变量：它一旦重新生成，所有已登录用户立刻掉线，
# 所以必须在重启之间稳定。挂一个 named volume 到 /app/state 即可。
ENV NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=18086 \
    RELAY_SESSION_SECRET_FILE=/app/state/session-secret

RUN mkdir -p /app/state && chown -R node:node /app

USER node

EXPOSE 18086

# 用 node 自带的 fetch，不装 curl/wget —— 镜像里没有多余东西可留。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18086/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
