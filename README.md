# HMDAODAO Canvas Node System

这是给 `F:\Work\HMDAODAO` 准备的可迁移画布节点系统骨架。当前会先放在 `F:\Work\CinStudio\docs\HMDAODAO-canvas-system`，因为目标目录没有写入权限且当前为空。

## 已对齐的 Infinite Canvas 关键机制

- DOM 绝对定位节点 + SVG 贝塞尔连线。
- `viewport = { x, y, scale }` 统一控制画布平移和缩放。
- 鼠标位置为中心的滚轮缩放。
- 节点拖拽、多选、删除、右键创建节点。
- Port 拖拽连线，双击连线删除。
- Prompt / Image / LLM / API Generate / ComfyUI / Output 节点类型。
- 生成节点自动寻找或创建 Output 节点。
- 生成调用采用“创建任务 + 输出 pending + 轮询结果 + 追加输出”的闭环。
- `/api/config`、`/api/workflows`、`/api/canvas-image-tasks`、`/api/canvas-llm` 对接点保留。
- API 不可用时降级到本地 mock 输出，便于离线验证交互。
- 本地 `localStorage` 持久化，后端保存失败时显示 `Saved locally`。

## 使用

直接打开：

```text
F:\Work\CinStudio\docs\HMDAODAO-canvas-system\index.html
```

迁移到 `HMDAODAO` 时，将本目录内容复制到 `F:\Work\HMDAODAO` 即可作为静态版本运行。若 `HMDAODAO` 是 Vite/React 项目，可把 `src/app.js` 的状态模型、几何函数、任务轮询流程拆成 React hooks/store。

## 后续建议

- 若目标项目已有后端，补齐 `/api/canvases` 系列接口，实现多画布管理与冲突检测。
- 若目标项目已有模型网关，直接把 `createCanvasImageTask()` 改为项目内真实生成入口。
- 若要 1:1 迁移 Infinite Canvas 的 Smart Canvas，可继续加入撤销栈、级联执行路径、素材库和工作流导入导出。

---

## Ddayup 网页素材采集扩展（已上架 Edge 商店）

一款 Edge 浏览器扩展，从任意网页采集图片 / 视频 / 音效 / 3D 模型素材并批量下载。

👉 **[在 Microsoft Edge 加载项商店安装 Ddayup](https://microsoftedge.microsoft.com/addons/detail/ddayup%E7%BD%91%E9%A1%B5%E7%B4%A0%E6%9D%90%E7%87%87%E9%9B%86%E6%89%A9%E5%B1%95/jpcnchdcjaapokighokneachmbkeafan)**

扩展源码、权限说明与上架信息见 [`extension/`](./extension) 目录（`extension/README.md`、`extension/STORE_SUBMISSION_NOTES.md`）。

---

## 部署到云端（多用户共享后端 + 自动 yt-dlp）

默认情况下扩展连接本机 `http://127.0.0.1:3000`。要让**其他用户**通过扩展使用共享的
yt-dlp 后端，需把后端部署到腾讯云 / 阿里云等公网服务器，并把扩展指向云端地址。

所有部署产物集中在 [`deploy/`](./deploy) 目录：

| 文件 | 用途 |
|---|---|
| `deploy/ecosystem.config.cjs` | pm2 配置：双进程 `ddayup-backend`(8792 API) + `ddayup-web-proxy`(3000 Web UI)，production 环境暴露公网并启用运维 Key |
| `deploy/ddayup.service` | systemd 用户级单元（无 root 也可用），`Restart=always` 保活 |
| `deploy/deploy-cloud.sh` | Linux 一键部署：生成随机 Key → pm2 启动 → 注册开机自启 → 回显云端地址 |
| `deploy/deploy-cloud.ps1` | Windows 版一键部署（等价） |
| `deploy/inject-cloud-domain.sh` / `.ps1` | 扩展打包前「一行注入」云端域名（用户免手填 options） |
| `deploy/INJECT_GUIDE.md` | 注入脚本的跨平台（bash / PowerShell）等价说明 |

### 快速流程

```bash
# 1) 后端一键上线（Linux 示例；Windows 用 deploy-cloud.ps1）
bash deploy/deploy-cloud.sh --domain ddayup.example.com
#   → 输出：运维 API Key + 扩展需填的云端地址（如 https://ddayup.example.com）

# 2) 让扩展默认连云端（打包分发，用户免配置）
bash deploy/inject-cloud-domain.sh https://ddayup.example.com
#   → 重新打包 extension/ 分发即可

# 3) 云端安全组放行 3000（或你的 443 反代）与 8792
```

### 鉴权说明

- 后端写操作（`/api/health/local-post/runtime/install` 等 yt-dlp 安装接口）受
  `HMDAO_API_KEY` 保护：仅当服务器设了该环境变量才强制校验，本地开发不设则放行。
- 云端部署时 `deploy-cloud.*` 会自动生成强随机 Key 并注入 pm2 环境。
- 扩展端在「选项」页填写同一个 Key（storage key `ddayupApiKey`）后即可**自助触发云端
  yt-dlp 安装**；普通用户未填 Key 时，云端运行时未就绪仅提示"联系站长"，杜绝匿名滥用。

### 保活与重启

- pm2：`pm2 restart ddayup-backend ddayup-web-proxy`、`pm2 logs` 看日志、`pm2 save` 固化开机自启。
- systemd：`systemctl --user enable --now ddayup`（家目录下需 `loginctl enable-linger $USER`）。
- yt-dlp 本身不是常驻服务，由后端进程按需调用，装一次永久可用，无需反复拉起。

