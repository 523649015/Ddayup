# 运行环境对照表：本地开发 vs 线上部署

> 目的：一眼分清每个脚本**在哪执行**、**影响哪套环境**，避免再出现
> 「重启了本机后端，却以为线上 mingmingchuangyi.cn 已更新」这类误判。
>
> ⚠️ **最关键的一条**：本机 `restart_*.ps1` 只会重启**本机**进程，
> **不会**更新线上站点。线上必须用 `deploy/` 下带 scp/ssh 的部署脚本。

## 一、环境定义

| 环境 | 地址 | 说明 |
|---|---|---|
| **本地开发** | `http://127.0.0.1:3000` / `localhost` / 局域网 IP | 本机 Node 进程；`ui-static-proxy.mjs`(3000) 服务 `app/dist` |
| **线上部署** | `https://mingmingchuangyi.cn` | 服务器 `43.139.15.112`：静态 nginx root `/var/www/hmdao`；API 为 `node /home/ubuntu/app/server/hmdao-api.mjs`（ubuntu 用户手动运行，8792） |

> ⚠️ **2026-09-16 实测纠正（此前文档是错的）**：
> - 仓库在 **`/home/ubuntu/app`**，**不是** `/opt/ddayup`（服务器上 `/opt` 是空目录）。
> - 后端守护：**已迁移到 systemd `ddayup-api.service`**（2026-09-16），单进程、开机自启、崩溃自动拉起。
>   （历史：此前由 **ubuntu 用户上下文的 PM2** 管理Apps——用 root 执行 `pm2 list` 会看到空表、误判为"没有 pm2"，
>   这正是此前"杀不死/进程复活"混乱的根源；PM2 中的 `ddayup-backend` 已删除并 `pm2 save`，`pm2-ubuntu.service` 已停用。）
> - nginx 负责静态站点 + `/api/`、`/ws/` 反代到 `127.0.0.1:8792`；**不是** Caddy。
> - 改后端代码后的生效方式：`systemctl restart ddayup-api`（或 ubuntu-deploy.sh 第 4 步）。
> - 前端部署只需替换 `/var/www/hmdao`（deploy-dist.ps1）。

前端会按 `window.location.hostname` 自动判定环境（见 `app/src/config/environment.ts`）：
本地/局域网 → 显示「开发者模式 / edge://extensions 本地加载」引导；公网域名 → 整块隐藏。

## 二、脚本清单（按环境分类）

### 🖥️ 本地环境（在本机执行，只影响本机）

| 脚本 | 作用 |
|---|---|
| `app/restart_api.ps1` | 重启本机后端 API（`hmdao-api.mjs`，8792） |
| `app/restart_proxy.ps1` | 重启本机静态代理（`ui-static-proxy.mjs`，3000，服务 `app/dist`） |
| `extension/build-store-package.ps1` | 打包 Edge 商店用的 zip（本机产物） |
| `extension/tools/update-edge-store.ps1` | 一键打包 + 调用 Edge 商店 API 上传（本机发起，作用于**商店**） |
| `extension/tools/verify-store-package.ps1` | 校验商店包内容（本机） |
| `extension/native-host/install-host.ps1` | 安装原生主机（在**用户机器**上执行） |

### ☁️ 线上部署（上传/作用于服务器）

| 脚本 | 执行位置 | 状态 | 作用 |
|---|---|---|---|
| `deploy/deploy-dist.ps1` | **本机**发起 | ✅ **推荐** | **增量**：只传 `app/dist` + 改动源码 → 备份 → 覆盖合并到 `/var/www/hmdao`。不碰后端，最快 |
| `deploy/ubuntu-deploy.sh` | **服务器**执行 | ✅ **全量部署用这个** | 装依赖 → build → 复制静态文件 → 重启 API → 部署 nginx → 证书。路径与线上一致（`/home/ubuntu/app`、`/var/www/hmdao`） |
| `deploy/deploy-server.ps1` | **本机**发起 | ✅ **只改后端时用这个** | **增量**：只传 `app/server` → 远端备份 `server.bak-<ts>` → `cp -rf` 覆盖 → `systemctl restart ddayup-api` → 本机/公网健康断言。加 `-VerifyYtDlp` 可顺带做采集运行时闭环校验 |
| `deploy/verify-runtime-install.sh` | **服务器**执行 | ✅ 新增 | 泛化校验（yt-dlp / aria2 / ffmpeg / …）：幂等检查 → 按需触发安装 → 轮询 `configured` → 用探测路径跑版本命令（真可执行，而非"文件存在"）。由 `deploy-server.ps1 -VerifyRuntime` 上传执行 |
| `deploy/verify-install-gate.sh` | **服务器**执行 | ✅ 新增 | 鉴权闸门实测：匿名 401 / 伪造 deviceId 402 / 本机回环 400 / 已授权设备 400 |
| `deploy/probe-github-mirrors.sh` | **服务器**执行 | ✅ 新增 | 探测可用的 GitHub 加速镜像前缀（结果写进 `HMDAO_GITHUB_MIRROR`） |
| `deploy/set-github-mirror.sh` | **服务器**执行 | ✅ 新增 | 幂等写入 `.env` 的 `HMDAO_GITHUB_MIRROR` 并重启后端 |
| `deploy/install-runtimes-apt.sh` | **服务器**执行 | ✅ 新增 | apt 兜底安装 aria2 / ffmpeg（境内源，快且稳），产物在 `/usr/bin` |
| `deploy/nginx-hmdao.conf` | 服务器 | ✅ 生效中 | nginx 站点配置（`sites-available/hmdao` → `sites-enabled/hmdao`） |
| `deploy/run-deploy.ps1` | 本机发起 | ⛔ **已弃用** | 整仓 tar → 传到 `/opt/ddayup` → 跑 `centos-deploy.sh`（路径与技术栈都不对） |
| `deploy/centos-deploy.sh` | 服务器 | ⛔ **已弃用** | CentOS + pm2 + Caddy + `/opt/ddayup`，与线上 Ubuntu+Nginx 不符 |
| `deploy/deploy-cloud.ps1` | 服务器 | ⛔ **已弃用** | 基于 pm2 启动后端，与线上"手动 node"不符 |
| `deploy/Caddyfile`、`ddayup.service` | — | ⛔ 未使用 | 属于 CentOS/Caddy 方案，当前服务器未采用 |

### ⚠️ 雷区：不要在服务器上用 pm2 / pkill+nohup 启动后端

线上 API 由 **systemd 服务 `ddayup-api`** 托管（`User=ubuntu`，监听 8792，开机自启、崩溃自动拉起）。
任何 `pm2 start` 或 `pkill + nohup node server/hmdao-api.mjs` 都会新起进程去抢已被占用的 **8792**
→ 启动失败/反复重启，可能把线上 API 搞挂（历史故障根因）。

- ✅ 改后端代码后的正确生效方式：`systemctl restart ddayup-api`
- ✅ 查看状态/日志：`systemctl status ddayup-api` / `journalctl -u ddayup-api -n 80 --no-pager`
- ⛔ 不要用 `deploy/deploy-cloud.ps1`（基于 pm2，已弃用）
- ⛔ 不要用 `deploy/deploy-dist.ps1 -RestartApi` 的旧实现（已修为 `systemctl restart`）

## 三、日常发版该用哪个

- **只改了前端（`app/src`）** → `npm run build` → `deploy/deploy-dist.ps1`（快，推荐）
- **改了后端（`app/server`）或依赖** → 在服务器上执行 `bash deploy/ubuntu-deploy.sh`（全量：build + 重启 API + nginx）
- **只在本机验证** → `npm run build` + `app/restart_proxy.ps1`（**线上不变**）

## 四、前端环境开关

- 默认按 hostname 自动判定，无需配置。
- 需要强制控制时设构建期环境变量：
  - `VITE_SHOW_DEV_INSTALL=false` → 任何环境都隐藏本地加载引导
  - `VITE_SHOW_DEV_INSTALL=true` → 任何环境都显示

## 五、采集运行时（yt-dlp / aria2 / ffmpeg）安装与验证

扩展采集视频/网盘直链依赖后端三个独立运行时，安装产物落在
`<repo>/.hmdao-data/local-post-runtimes/<runtime>/current/`。

### 关键坑：产物名按平台不同（2026-09-16 服务器实测）

| 平台 | yt-dlp 压缩包 | 解压后二进制名 |
|---|---|---|
| Windows | `yt-dlp_win.zip` | `yt-dlp.exe` |
| macOS | `yt-dlp_macos.zip` | `yt-dlp_macos` |
| Linux | `yt-dlp_linux.zip` | **`yt-dlp_linux`** ← 无 `.exe` 且带平台后缀 |

`findFileRecursively` 是**文件名精确匹配**，因此探测/安装的候选名必须包含平台后缀，
否则会出现"安装报 `ytdlp-executable-missing-after-prepare`、探测恒 `configured=false`"。
候选名统一由 `app/server/platform-utils.mjs` 的 `platformExecutableCandidates()` 产出（单一来源）。

### 网络约束：境外下载源在境内服务器常不可达（2026-09-16 服务器实测）

| 目标 | 实测结果 |
|---|---|
| `api.github.com`（只用于查版本） | 可达 |
| `github.com`（真正下载资产） | **被重置 / 超时（http=000）** → 一键安装大体积运行时必然失败 |

**镜像兜底（能力早已内置，只是线上一直没配）**：`app/server/runtime-download.mjs` 的
`downloadFileWithProgress()` 会读取 **`HMDAO_GITHUB_MIRROR`**（多个前缀用逗号/分号/空格分隔），
只对 `github.com` / `objects.githubusercontent.com` 套用「前缀 + 原 URL」并逐个回退
（首个源允许续传，换源后禁用续传）。

- 探测可用前缀：`bash deploy/probe-github-mirrors.sh`
  （实测：`gh-proxy.com` / `ghproxy.net` / `ghfast.top` / `gh.ddlc.top` 返回 206；其余候选 000）
- 幂等写入配置：`bash deploy/set-github-mirror.sh 'https://gh-proxy.com/,https://ghproxy.net/,https://ghfast.top/'`
- ⚠️ 实测速度：镜像对 **100MB 级**资产（ffmpeg）仍然很慢（下载 ~1 小时），
  适合 yt-dlp（~10MB）这类小资产，不适合 ffmpeg。

### 兜底方式（按推荐顺序）

1. **系统包管理器（推荐的 aria2 / ffmpeg 方案）**：`bash deploy/install-runtimes-apt.sh`
   → `apt install aria2 ffmpeg`，产物在 `/usr/bin`，经 PATH 回退被识别（实测 `configured=true`）。
2. **环境变量直指**：手工装好后设 `HMDAO_YT_DLP_PATH=/绝对/路径`（yt-dlp 第一优先采纳）。
3. **PyPI 镜像安装（yt-dlp 实测可用）**：
   `sudo -u ubuntu -H python3 -m pip install --user yt-dlp -i https://pypi.tuna.tsinghua.edu.cn/simple`
   → 产物位于 `/home/ubuntu/.local/bin/yt-dlp`（后端会扫描 `~/.local/bin`）。
4. 手工把二进制放进托管目录 `.../ytdlp/current/`（Linux 下命名为 `yt-dlp_linux` 即可被探测到）。

> **探测口径（2026-09-16 起）**：托管清单 → 托管目录（平台候选名）→ **系统 PATH 回退**
> （`local-post-processing.mjs` 的 `findInSystemPath`，扫描 `~/.local/bin` + `/usr/local/bin` +
> `/usr/bin` 等 × 平台候选名）。因此 apt / brew / pip 安装的运行时也能被识别。

### 闭环验证方式（泛化，覆盖多运行时）

```powershell
# 本机执行：上传并运行服务器端泛化校验（幂等：已就绪则只校验，不重装）
scp deploy/verify-runtime-install.sh root@43.139.15.112:/tmp/
ssh root@43.139.15.112 'bash /tmp/verify-runtime-install.sh ytdlp aria2 ffmpeg'
```
期望每项 `-> PASS`、末行 `RESULT=PASS`。
（等价写法：`powershell -File deploy/deploy-server.ps1 -VerifyRuntime -RuntimeKeys 'ytdlp aria2 ffmpeg'`）

## 六、运行时安装接口的鉴权口径（2026-09-16 收紧）

`POST /api/health/local-post/runtime/install`（以及 `uninstall` / `rollback` / `cleanup` /
`GET .../install/{jobId}`）此前**只在配置了 `HMDAO_API_KEY` 时才校验**；线上未配该变量
→ 等于**匿名即可触发服务器下载安装**（带宽/磁盘被白嫖）。现已改为三类放行：

| 放行条件 | 说明 |
|---|---|
| 运维 Key | `Authorization: Bearer <HMDAO_API_KEY>` 或 `?apiKey=`（保留原语义，供脚本/运维） |
| **真实回环** | 真实客户端 IP 为 `127.0.0.1` / `::1` → 本机开发与本机 Web 面板「一键安装」不受影响 |
| 已授权设备 | `deviceId`（body 或 query）经 `checkExtensionEntitlement` 判定为 trial/paid |

拒绝语义：无 `deviceId` → **401 `NO_DEVICE`**；有但 `none`/`expired` → **402 `LICENSE_REQUIRED`**（带 `mode`）。

> ⚠️ **回环判定必须用 XFF 首跳**：nginx 反代到 `127.0.0.1:8792` 后，`req.socket.remoteAddress`
> 对**所有公网请求**都是 127.0.0.1；只看 socket 会把公网请求误判为本机（`media.mjs` 的历史实现
> 就有此缺陷，本轮已一并修正）。统一实现在 `app/server/lib/client-ip.mjs`。

实测（`bash deploy/verify-install-gate.sh`）：匿名 **401** / 伪造 deviceId **402** /
本机回环 **400（已放行到参数校验）** / 已授权设备 **400（已放行）**。
