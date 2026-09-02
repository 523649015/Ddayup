# Ddayup 网页素材采集扩展

一款 Edge 浏览器扩展，帮助用户从任意网页采集图片、视频、音效、3D 模型等素材，并通过侧边栏预览、筛选、批量下载到本地。

## 从 Edge 商店安装（推荐）

已正式发布到 Microsoft Edge 加载项商店，点击下方链接即可安装：

👉 **[在 Microsoft Edge 加载项商店安装 Ddayup](https://microsoftedge.microsoft.com/addons/detail/ddayup%E7%BD%91%E9%A1%B5%E7%B4%A0%E6%9D%90%E7%87%87%E9%9B%86%E6%89%A9%E5%B1%95/jpcnchdcjaapokighokneachmbkeafan)**

或在 Edge 浏览器地址栏打开：`edge://extensions`，点击左侧「获取 Microsoft Edge 扩展」进入商店，搜索品牌词 **`Ddayup`** 即可找到。

## 核心功能

- 一键扫描当前页面，提取图片 / 视频 / 音效 / 3D 模型素材
- 智能识别 YouTube、Bilibili、抖音、视频号等平台真实直链
- 自定义保存目录，批量下载
- 复制图片到系统剪贴板，可直接粘贴到微信 / Photoshop
- 本地 7 天试用，无需登录即可开始使用

## 原生主机（高级下载能力，可选）

扩展核心采集/下载不依赖远程服务。如需调用本机 `yt-dlp` / `ffmpeg` 进行更高质量音视频下载，需额外安装原生主机：

- Windows：`install-host.ps1`
- macOS / Linux：`install-host.sh`

详见 `STORE_SUBMISSION_NOTES.md`。

## 隐私

不收集浏览历史，不上传个人身份信息；会话 Cookie 仅用于本机下载鉴权，绝不发送至远程服务器。
隐私政策：https://523649015.github.io/Ddayup/privacy-policy.html

## 版本与更新

商店版本随 bug 修复自动升级。当前商店版本号见 Edge 扩展管理页。
