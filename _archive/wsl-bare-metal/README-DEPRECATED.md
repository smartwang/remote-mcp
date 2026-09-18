# 已废弃：WSL 裸装方案

**这套方案在 2026-09-18 被 Docker Compose 单容器方案取代。**
现役部署见 `../../docker/README.md`。

保留本目录仅为参考 —— 里面的实测经验（`README.md` 里的坑、
`setup.sh` 的端口探测思路）仍然有效，只是执行方式换了。

## 为什么废弃

裸装把 4 个东西直接写进 WSL 的运行时目录，跨会话容易丢、升级要手搓、
和 WSL 里其他东西混在一起分不清。容器化后一套 compose 管理，
`restart: unless-stopped` 顶掉"前台常驻别关窗口"这种脆弱做法。

## 原来装在 WSL 里的什么（已于同日全部删除）

| 路径 | 内容 |
|---|---|
| `/root/.local/bin/tunnel-client` | 21M，v0.0.14 |
| `/root/.local/bin/cloudflared` | 38M，必须与上面同目录 |
| `/root/.local/share/minimal-mcp-server/` | server.js + selftest.js |
| `/root/.config/tunnel-client/` | profile 目录（已空） |

**注意：`/root/.local/bin` 里还有不属于本项目的东西**
（`codebase-memory-mcp`、`herdr`、`hermes`、`uv`、`uvx`、`node`、`npm` 等），
当时只删了上面四个精确路径，没有动目录本身。

## 想恢复裸装（不推荐）

`setup.sh` 还在，能重装。但它依赖 `bin/` 下的两个 linux_amd64 二进制 ——
这两个文件**没有被保留**（体积大且可从发行包重新获取）。要恢复的话：

```bash
# 从发行包重新取二进制
cp ../../tunnel/dist/extracted/tunnel-client-v0.0.14-all/bin/linux_amd64/{tunnel-client,cloudflared} bin/
# 然后在 WSL 里跑
bash setup.sh
```

## 这个目录里有什么

| 文件 | 说明 |
|---|---|
| `README.md` | 裸装版运行手册。**里面的两个实测坑仍然值得读**（8080 冲突、环境变量静默覆盖 profile 的 key 引用） |
| `setup.sh` | 7 步安装脚本，前 6 步不需要任何凭据 |
| `verify-tunnel-path.sh` | 用 `dev proxy` 离线验证隧道数据通路，6 步 |
| `mcp-server/` | server.js / selftest.js 的旧副本（现役版本在 `docker/server/`） |
| `bin/` | 空的（二进制未保留） |
| `_scratch/` | 当初的探测输出，留作证据 |
