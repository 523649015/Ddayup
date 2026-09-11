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

## 七、已发布状态（2026-08-17 更新）

- ✅ 已提交 Microsoft Partner Center 审核并 **成功发布**（官方发布邮件已确认 "successfully published on the Microsoft Edge Add-ons Store"）。
- ✅ 官方商店安装直链（已验证可访问 200）：
  ```
  https://microsoftedge.microsoft.com/addons/detail/ddayup%E7%BD%91%E9%A1%B5%E7%B4%A0%E6%9D%90%E7%87%87%E9%9B%86%E6%89%A9%E5%B1%95/jpcnchdcjaapokighokneachmbkeafan
  ```
- ✅ privacy-policy.html 已部署到 `https://523649015.github.io/Ddayup/privacy-policy.html`（HTTP 200，已验证）。
- ⚠️ 搜索可见性问题：新上架扩展默认搜索排名极低，且纯中文扩展名在英文商店搜索中权重弱。当前主要靠**品牌词 `Ddayup`** 与**商店直链**分发，详见第八节英文列表优化。

## 八、英文商店列表文案（供 Partner Center 补充，提升英文用户搜索可见性）

当前商店列表仅有中文。建议在 Partner Center「列表」里补充 English (US) 市场信息，填写以下内容：

**Display name (English):**
```
Ddayup Web Media Collector
```
（保留中文名 `Ddayup网页素材采集扩展` 作为默认，英文作为补充市场名）

**Short description (English, ≤ 132 字符):**
```
Collect images, videos, audio and 3D models from any web page. One-click save to local folder via side panel.
```

**Detailed description (English) — 前 2 段塞关键词：**
```
Ddayup is a web media collector extension that helps you grab images, videos, audio clips and 3D models from any web page you visit. It scans the page and the network layer to find real media URLs, then lets you preview and download them to a local folder of your choice.

Key features:
- One-click scan of the current page for images, videos, audio and 3D model assets
- Smart detection for YouTube, Bilibili, Douyin, WeChat Channels and more
- Batch download with custom save directory
- Copy images to clipboard for WeChat / Photoshop (OS-level paste)
- Local 7-day trial, no account required to start

Ddayup runs locally and respects your privacy: no browsing history is uploaded, session cookies are used only for on-device download authentication and are never sent to a remote server.
```

**Search keywords / tags (English):**
```
web asset downloader, image downloader, video downloader, audio downloader, 3d model downloader,
media collector, batch download, save images from web, youtube download helper, bilibili, douyin
```

**Categories:** Productivity / Photo & Media

### 8.1 最终提交文本块（可直接复制粘贴到 Partner Center）

下面每一段都是独立文本框要填的内容，复制时只取 ``` 内的纯文本。

**① Display name（英文显示名）**
```
Ddayup Web Media Collector
```

**② Short description（简短描述，≤132 字符）**
```
Collect images, videos, audio and 3D models from any web page. One-click save to local folder via side panel.
```

**③ Description（详细描述）**
```
Ddayup is a web media collector extension that helps you grab images, videos, audio clips and 3D models from any web page you visit. It scans the page and the network layer to find real media URLs, then lets you preview and download them to a local folder of your choice.

Key features:
- One-click scan of the current page for images, videos, audio and 3D model assets
- Smart detection for YouTube, Bilibili, Douyin, WeChat Channels and more
- Batch download with custom save directory
- Copy images to clipboard for WeChat / Photoshop (OS-level paste)
- Local 7-day trial, no account required to start

Ddayup runs locally and respects your privacy: no browsing history is uploaded, session cookies are used only for on-device download authentication and are never sent to a remote server.
```

**④ Search keywords / tags（搜索关键词，可填在关键词或描述里）**
```
web asset downloader, image downloader, video downloader, audio downloader, 3d model downloader, media collector, batch download, save images from web, youtube download helper, bilibili, douyin
```

**⑤ Category（分类）**
```
Productivity / Photo & Media
```

**⑥ Logo / screenshots（截图与图标，建议上传）**
- 用 `icons/icon-128.png` 作为商店图标；
- 上传 2–4 张 side panel 扫描/下载界面的清晰截图（PNG，1280×800 或更大），带英文标注更佳，可提升转化率与排名。

### 8.2 登录 Partner Center 并走 Update 的完整操作步骤

**第 0 步 · 登录网址**
- Microsoft Partner Center 主页：https://partner.microsoft.com/dashboard
- Edge 附加组件（加载项）管理入口：https://partner.microsoft.com/dashboard/microsoftedge/overview
  （登录需使用你提交扩展时用的同一个开发者账号；若未登录会跳到 Microsoft 账号登录页，用注册开发者的邮箱登录。）

**第 1 步 · 进入扩展管理**
1. 打开 https://partner.microsoft.com/dashboard/microsoftedge/overview
2. 在左侧导航或主面板的「Your products / 你的产品」列表里，找到 **Ddayup网页素材采集扩展**（已发布状态）。
3. 点击该扩展名称进入其**产品概览页（Product overview）**。

**第 2 步 · 发起更新（Update）**
1. 在产品概览页顶部或左侧，点击 **Update（更新）** 按钮。
   - 注意：Update 会创建一个基于当前已发布版本的新草稿（submission draft），不会立刻覆盖线上版本。
2. 进入草稿编辑界面，通常左侧有几个分区：**Packages（包） / Listings（列表） / Properties（属性） / Availability（可用性）**。

**第 3 步 · 替换包（Packages）**
1. 在 **Packages** 分区，找到现有的 `0.1.3` 包，点 **Remove（移除）**。
2. 点 **Upload（上传）**，选择本地文件：
   `F:\Work\HMDAODAO\extension\ddayup-edge-store-v0.1.4.zip`
3. 上传后系统会校验 manifest（版本号必须 > 0.1.3，已设为 0.1.4 ✅）。校验通过即显示新包。

**第 4 步 · 补英文列表（Listings，关键：解决搜索看不到）**
1. 进入 **Listings** 分区。
2. 点 **Add a listing / 添加市场列表**，选择 **English (United States)**。
3. 在打开的英文列表表单里，依次粘贴 8.1 节的文本块：
   - Display name → ①
   - Short description → ②
   - Description → ③
   - Search keywords / tags（若表单有该字段）→ ④；若没有独立关键词字段，把 ④ 的关键词自然融入 ③ 描述靠前位置。
   - Category → ⑤
   - 上传图标/截图 → ⑥
4. 原有的中文（简体）列表保留不动（它是默认市场）。
5. 保存英文列表。

**第 5 步 · 填更新说明（Submission notes / What's new）**
在提交页的「Notes for certification（认证说明）」或列表里的「What's new in this version」填入：
```
修复若干素材采集稳定性问题；优化 YouTube / 抖音 / 网盘资源捕获；补全英文商店列表提升搜索可见性。
（Fixed several media-capture stability issues; improved YouTube / Douyin / netdisk asset capture; added English store listing for better search visibility.）
```

**第 6 步 · 提交审核（Submit）**
1. 回到草稿页，点 **Submit（提交）** / **Submit for approval**。
2. 系统会做一次自动预检（包完整性、manifest 合法性、隐私政策链接可达）。
3. 预检通过后进入**人工审核队列**，更新审核通常 **1–3 个工作日**（比首次快）。
4. 审核状态可在 Overview 页查看；结果会发到你开发者账号绑定的邮箱。

**第 7 步 · 发布与用户升级**
1. 审核通过即**自动覆盖**线上版本，商店 ID `jpcnchdcjaapokighokneachmbkeafan` 不变。
2. 已安装 0.1.3 的用户：Edge 会在后台**自动静默升级**到 0.1.4（通常几小时内，或用户重启浏览器时）。
3. 新用户通过商店直链或搜索（补英文列表后英文语言用户也能搜到）安装即直接是 0.1.4。

**注意事项**
- 版本号只能递增，0.1.4 已 > 0.1.3，上传不会被拒。
- 若提交时提示「English listing 必填某些字段」，按页面红色提示补齐即可（通常是 description 长度下限）。
- 不要动 `Availability（可用性）` 里的「Listing visibility / 可见性」，保持默认公开列出（Public in Store），否则会变成 unlisted 只能通过链接安装。

## 九、版本迭代（bug 修复发布流程）

1. 本地修复后，在 `manifest.json` 将 `version` 从当前版本递增（补丁用 `0.1.4`，小功能 `0.2.0`，大版本 `1.0.0`）。
2. 重新打包扩展目录为 `.zip`（排除 `node_modules`、开发脚本、`*.ps1` 里非提交部分按 Partner Center 要求）。
3. 在 Partner Center 该扩展页点 **Update** → 上传新 `.zip` → 填 "What's new" → 提交审核（通常 1–3 个工作日）。
4. 审核通过后自动覆盖，用户浏览器自动升级。

## 十、待人工完成的真实动作（无法自动化）

1. 在 Partner Center 补充 English (US) 商店列表（第八节文案），提升英文搜索可见性。
2. 将官方商店直链分发到 README / GitHub / 社媒 / 扩展侧栏"评分"入口。
3. bug 修复按第九节走 Update 提交流程（version 递增 + 重新打包 + 审核）。
4. 可选：Playwright+登录态真机验证抖音/视频号缩略图实际显示（本开发环境无 Playwright，技术前提已验证）

## 十一、0.1.4 提交包（2026-08-17 生成，待提交）

- 版本号已改为 `0.1.4`（`manifest.json`）。
- 打包脚本：`extension/build-store-package.ps1`（自动排除 `native-host/`、`node_modules/`、开发脚本）。
- 产物：`extension/ddayup-edge-store-v0.1.4.zip`（1.26 MB，70 文件，已验证含 manifest/background/sidepanel/privacy-policy/_locales，不含 native-host）。
- 已添加 i18n 支持：`extension/_locales/zh_CN/messages.json` + `extension/_locales/en/messages.json`，manifest 使用 `__MSG_*__` 占位符，`default_locale` 设为 `zh_CN`。
- 效果：Partner Center 会识别出 **Chinese (Simplified)** 和 **English (United States)** 两种语言，商店列表可分别维护中文/英文描述；中文浏览器用户看到中文描述，英文浏览器用户看到英文描述。
- What's new 建议文案：「修复若干素材采集稳定性问题；优化 YouTube / 抖音 / 网盘资源捕获；新增中英文商店列表支持。」

### 搜索不到的根因（2026-08-17 实测确认）
- 直接请求搜索 URL 返回 HTTP 200 且 HTML 含 `ddayup` → 微软服务端**已收录**该扩展，并非未上架。
- 真实 Edge 里搜不到 = **浏览器语言/市场过滤（英文市场下中文名权重低）+ 零安装量权重低** 叠加。
- 验证方法：把 Edge 显示语言切到**中文（简体中国）**再搜 `Ddayup`；或直接用商店直链安装。
- 治本：补中英文市场列表（第八节）+ i18n 显示名，使中英文用户都能搜到并看到对应语言。

## 十二、订阅收费模式与 7 天后收费完整操作蓝图

### A. 当前已具备的能力（不必从零做）

| 模块 | 现状 |
|---|---|
| 7 天试用 | ✅ 后端 `trialStart` 服务端计时，`computeStatus` 推导 trial/expired/paid；前端 `FREE_MODE=false`，过期弹付费墙阻断 |
| 付费档位 | ✅ `monthly(30天)` / `yearly(365天)` / `lifetime(9999天)` |
| 激活码 | ✅ `/license/activate` + 管理端 `/license/issue` 签发 `DDAYUP-xxxx`，适合一次性/赠码 |
| 订阅订单 | ✅ `/subscription/create` 已实现微信统一下单（NATIVE 扫码，返回 `codeUrl`）+ Paddle hosted checkout（返回 `checkoutUrl`）；未配置凭证时回退 mock，配置 `HMDAO_WX_*` / `HMDAO_PADDLE_*` 环境变量即走真实网关 |
| 结账入口 | ✅ 前端 `goToPricing()` 跳官网 `/pricing?deviceId=&token=`（Edge 禁止内嵌支付，必须跳网页完成） |
| 官网结账页 | ✅ 已实现 `app/src/pages/PricingPage.tsx`（三档价格展示 + 微信/Paddle 切换 + 二维码 + 状态轮询 + 明确「画布免费/扩展付费」边界） |

### B. 7 天后用户怎么订阅（标准流程）

1. 用户安装扩展 → 首次启动 `ensureTrial()` 调 `/trial/start`，服务端记录 `trialStart`。
2. 第 7 天到期，授权状态变 `expired` → 前端 `gate()` 弹付费墙（`FREE_MODE=false` 阻断采集）。
3. 用户点「升级/去订阅」→ `goToPricing()` 打开官网 `/pricing?deviceId=xxx&token=yyy`。
4. 官网页展示价格，用户选档位（月/年/永久）→ 调 `/subscription/create` 拿到真实 `checkoutUrl`。
5. 在微信/Paddle 完成支付 → 网关 webhook 回调 `/webhook/wechat` 或 `/webhook/paddle` → 后端 `applyActiveSubscriptionToDevice(deviceId, plan)` 写授权。
6. 用户回扩展点「刷新授权」→ `/license/status` 返回 `mode:paid`，付费墙消失。

### C. 收费定价建议（需你最终拍板）

| 档位 | 建议价（CNY） | 周期 | 备注 |
|---|---|---|---|
| 月付 monthly | ¥18 / 月 | 30 天 | 自动续费 |
| 年付 yearly | ¥168 / 年（≈¥14/月） | 365 天 | 比月付省 ~22% |
| 永久 lifetime | ¥398 一次性 | 9999 天 | 限首发期促销 |

> 价格仅为建议，需在 `/pricing` 页与 `extension-license.mjs` 的 `PLAN_DAYS` 一致；如走 Paddle 需以美元定价（Paddle 自动换算本地币种）。

### D. 落地操作清单（按优先级）

**P0 — 接通真实支付（必须，否则 7 天后无法收费）**
1. 注册 **Paddle**（推荐，内置 VAT/全球合规、支持信用卡+支付宝，对数字商品最友好）或 **微信支付商户号**（需企业资质）。
2. 配置环境变量：`HMDAO_PADDLE_VENDOR_ID` / `HMDAO_PADDLE_AUTH_CODE`（Paddle）或 `HMDAO_WX_MCH_ID` / `HMDAO_WX_API_KEY`（微信）。
3. 在 `extension-license.mjs` 的 `/subscription/create` 真实分支补全下单逻辑：Paddle hosted checkout 或微信统一下单，返回真实 `checkoutUrl`。
4. 实现 `/pricing` 官网结账页（`app/src` 下新增路由 + 组件）：展示三档价格、绑定 deviceId/token、调 `/subscription/create`、轮询 `/license/status` 直到 paid。
5. 验证：本地用 mock 回跳已通（`/webhook/wechat/mock`），接真实网关后跑一遍支付→授权闭环。

**P1 — 扩展侧栏订阅入口打磨**
6. 付费墙「去订阅」按钮已接 `goToPricing()`，确认文案引导清晰（"7 天试用已结束，订阅后继续采集"）。
7. 侧栏加「刷新授权」按钮（调 `/license/status`），支付完成后不必重开扩展。
8. 侧栏加「喜欢 Ddayup？去 Edge 商店评分」入口（提升搜索排名，见第八节）。

**P2 — 上线后运营**
9. 在 GitHub README 与扩展商店描述里放"订阅说明/价格"链接。
10. 用管理端 `/license/issue` 生成 `DDAYUP-xxxx` 激活码，用于首批用户赠码/优惠。
11. 监控 `extension-subscriptions.json` 的 active 数量与续费率。

### E. Edge 合规注意

- Edge 明确禁止扩展内嵌支付 UI，必须跳外部网页结账（当前 `goToPricing()` 已是该模式，✅ 合规）。
- 商店列表里需声明"应用内购买/订阅"（`in-app purchases` 标注），避免审核下架。
- 免费试用 7 天 + 过期阻断是符合"声明付费功能"要求的（当前 `FREE_MODE=false` 已是阻断模式）。
