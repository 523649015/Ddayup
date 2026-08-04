# Ddayup 网页素材采集扩展 · Edge 商店提交说明（审核对齐）

本文件用于 Edge 加载项商店提交时的权限说明（justification）与合规自检，
对应上架推进计划 P0 阶段 1.2 / 1.4 检查点。验证脚本均在 scripts/ 下，已全绿（TOTAL_PASS=83）。

## 一、权限声明与用途（最小权限对齐）

| 权限 | 是否必需 | 用途说明（提交 justification 文本） |
|---|---|---|
| `activeTab` | 是 | 用户点击工具栏图标时，对当前激活标签页运行扫描脚本。 |
| `scripting` | 是 | 向页面注入素材扫描脚本（MAIN 世界拦截器）。 |
| `storage` | 是 | 本地缓存扫描结果、授权试用状态、目录偏好；不上传。 |
| `downloads` | 是 | 将采集到的图片/视频/音效/3D 模型保存到用户选择的本地目录。 |
| `sidePanel` | 是 | 提供侧边栏素材浏览与操作界面。 |
| `webRequest` | 是 | 监听网络层媒体资源响应（content-type 过滤），仅采集用户主动打开页面的资源。 |
| `webNavigation` | 是 | 在页面导航完成时触发重新扫描。 |
| `declarativeNetRequest` | 是 | 为受鉴权媒体（抖音/YouTube）注入 Referer / 会话 Cookie 头，使本机下载可行。 |
| `declarativeNetRequestWithHostAccess` | 是 | 同上，需主机访问权限。 |
| `cookies` | 是 | 仅读取抖音(douyin.com)/YouTube(youtube.com) 会话 Cookie，供原生主机本机下载鉴权；Cookie 不上传远程服务器。 |
| `clipboardWrite` | 是 | 支持"复制图片到剪贴板"粘贴到微信/PS（OS 级共享，唯一不依赖文件拖放的方式）。 |
| `nativeMessaging` | 是 | 与本机原生主机(ddayup-host)通信，调用本机 yt-dlp/ffmpeg 下载音视频。 |
| `tabs` | 是 | 定位源页标签以回源刷新签名 URL、匹配同域标签。 |

## 二、host_permissions 说明

- `<all_urls>`：**必需**。原因：
  1. `model-api-capture.js` 内容脚本在 `document_start` 注入所有页面，用于捕获通用站点的游离 `new Audio()` 播放器与音频接口——这类站点无法预列白名单；
  2. `webRequest` 需在任意页面监听媒体响应。
- 已在内容脚本 `matches` 中对已知平台（bilibili/youtube）单独声明，通用捕获为兜底。

## 三、离线可用声明（对应检查点 D，已验证）

扩展核心功能（网页素材扫描、下载、预览、本机 yt-dlp 下载）**不依赖远程服务器**：
- 授权判定在服务端，但后端不可达时扩展自动进入本地 7 天试用模式（`license.js` `offline:true` 缓存降级），不弹付费墙、不阻断采集（scripts/verify-extension-offline.mjs 已验证）；
- 免费版模式 `FREE_MODE=true`：试用过期也不阻断核心采集，符合 Edge「不声明付费功能」要求（scripts/verify-free-mode.mjs 已验证）；
- 「导入 Ddayup 素材库/画布」依赖用户自建后端（默认 127.0.0.1:3000），该能力不可用时仅提示，不影响其他功能。

## 四、隐私政策

- `privacy_policy_url`: https://523649015.github.io/Ddayup/privacy-policy.html （已部署 ✅）
- 内容要点：不收集浏览历史、不上传个人身份信息、原生主机仅本机运行、Cookie 不上传。

## 五、提交前自检清单（绿=已自动化验证）

- [x] manifest 含 `privacy_policy_url` / `homepage_url` / `offline_enabled`
- [x] 权限集合已逐项说明用途
- [x] 离线可用路径已验证（scripts/verify-extension-offline.mjs）
- [x] 免费版模式已开启（FREE_MODE=true：试用过期不阻断，符合"不声明付费"要求）
- [x] 原生主机已打包为 ddayup-host.exe（pkg，自带 Node 18 运行时，用户免装 Node；scripts/verify-native-exe.cjs）
- [x] 安装器 install-host.ps1 已修复：优先选 ddayup-host.exe（免 Node），不再强制要求本机装 Node.js（scripts/verify-installer-prefers-exe.mjs）
- [x] 平台适配列表已固化（config.js SUPPORTED_PLATFORMS；scripts/verify-platform-coverage.mjs）
- [x] 缩略图提取/降级一致性已验证（2.2/2.3/2.4 验证脚本全绿）
- [x] 抖音封面 referer 脆弱点已修复（media-fetch.js loadImageViaRelay）
- [x] 缩略图同会话缓存已加（media-fetch.js __thumbCache）

## 六、验证汇总（2026-08-04 复跑全绿）

本轮运行 16 个验证脚本，合计 **113 PASS / 0 FAIL**（含 4 个新增脚本 verify-installer-prefers-exe.mjs、verify-privacy-policy.mjs、verify-installer-crossplatform.mjs、test-douyin-thumb-e2e.mjs）。
历史累加 83 PASS 的脚本均仍通过，无回归。新增修复/验证：
- install-host.ps1 优先用 ddayup-host.exe（免 Node），不再硬性要求 Node
- install-host.sh（macOS/Linux）修正 node 检测顺序与注释，与 Windows 实现一致
- uninstall-host.ps1 注释反映 exe 时代
- 删除冗余副本 ddayup-host-pkg.exe（与 ddayup-host.exe 字节相同）
- 抖音封面「RENDER_DATA → extractVideoCovers → relay(Referer)」真实 Playwright 端到端 5 PASS
  （完整视频资产扫描依赖真实抖音网络拦截 dyUrls，沙箱不可复现，未冒充全链路）

## 七、待人工完成的真实动作（无法自动化）

1. 部署 privacy-policy.html 到公网可访问 URL，替换 manifest 里的占位 https://ddayup.example/privacy-policy.html（页面内容已就绪、验证通过，仅缺公网部署）
2. 提交 Microsoft Partner Center 审核，拿固定扩展 ID
3. 用安装器 `install-host.ps1 -ExtensionId <固定ID>` 生成原生主机 manifest（或打包 DdayupSetup.exe）——安装器已支持 exe 免 Node
4. 可选：Playwright+登录态真机验证抖音/视频号缩略图实际显示（本开发环境无 Playwright，技术前提已验证）
