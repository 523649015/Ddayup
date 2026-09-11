# Ddayup 扩展 ·「截图识文」能力架构评审报告

> 评审人：高见远（架构师） ｜ 日期：2026-09-11 ｜ 范围：侧栏智能机器人浮标 → 悬停 1s → 截图识文 → 翻译/提取文字/复制截图 → 粘贴微信
> 依据：仓库 `F:\Work\HMDAODAO\extension` 已核实代码事实 + 用户本轮 6 条澄清（A–F）

---

## 0. 结论速览（Executive Summary）

| 澄清项 | 核心结论 |
|---|---|
| A 受限页 | `captureVisibleTab` 在 chrome://、chrome-extension://、edge://、about:*、view-source:、DevTools、Chrome 网上应用店、data: 上**必然失败**；file:// 需开启「允许访问文件网址」；其余 http(s) 可截。扩展 API 截的是**网页内容区**，不是整个屏幕/浏览器 UI。 |
| B 长截图 | **推荐方案 1（滚动+逐视口 captureVisibleTab+Canvas/OffscreenCanvas 拼接）**为默认；方案 2（debugger/CDP）作为可选「高质量长截图」模式（需新增 `debugger` 权限、弹持久黄条）。 |
| C 不传画布 | 确认移除 `HMDAO_AGENT_UPLOAD`/画布路径。截图仅用于：本地 Canvas 裁切 + 复制到剪贴板 + 发后端做 OCR/翻译。架构因此显著简化。 |
| D 架构合理性 | **部分合理但技术债偏重**。文件级拆分是好习惯，应升级为真正的「特性模块」体系；`sidepanel.js` 6580 行巨无霸 + 全局变量 + 中央 if 链分发必须改造。 |
| E 臃肿度 | **臃肿（严重）**。直接塞入 `sidepanel.js` 会带来 +400~700 行、合并冲突加剧、无法独立开关/测试等代价。应独立成 `features/` 文件。 |
| F 可插拔 | 设计 `FeatureManager` + `HMDAO_FEATURES` 自注册 + 后台 `HMDAO_BG_HANDLERS` 注册表。新增/移除特性 = 增删一个文件 + `sidepanel.html` 一行 `<script>`（+ background 一行 `importScripts`）。 |

---

## 1. 受限页对照表（澄清 A）

### 1.1 关键认知纠正
用户的疑问「屏幕上能看到的难道不都该能截图吗」——需要区分两层：

- **扩展截图 API 截的是「网页内容区」（active tab 的可视区域），不是整个显示器，也不是浏览器 UI（工具栏/地址栏/侧栏本身）。**
- 浏览器对**特权上下文（privileged contexts）**设有硬性安全边界：扩展截图被明确禁止在浏览器自身页面、其他扩展页面、应用店等上执行，否则会泄露浏览器设置、扩展列表、登录态等。这是 MV3 的设计约束，非本扩展缺陷。

### 1.2 可截图 / 不可截图 对照表

| 页面类型 / Scheme | 能否截图 | 原因 / 限制 | 典型例子 |
|---|:--:|---|---|
| `https://` 普通网页 | ✅ | 需 host 权限（本扩展已有 `<all_urls>` + `activeTab`） | 博客、新闻、电商、小红书 |
| `http://` 普通网页 | ✅ | 同上（明文页亦可，混合内容图片可能不加载但页面可截） | 内网后台、老站点 |
| `http://localhost` / `127.0.0.1` | ✅ | 视为 http(s)，正常可截 | 本机 Ddayup 后端 3000 页 |
| `file://` | ⚠️ 条件 | 须在扩展管理页开启「允许访问文件网址」；否则静默失败 | 本地 HTML、本地图片 |
| `about:blank` | ❌ | 空文档，无可视内容；API 报/返回空 | 新标签空白 |
| `about:newtab` / `about:settings` / `about:flags` / `about:history` 等 | ❌ | `about:` 系特权页 | 新标签页、设置页、实验室 |
| `chrome://*` | ❌ | Chrome 内部页，明确禁止 | 扩展管理、下载、密码、历史、`chrome://flags` |
| `chrome-extension://*` | ❌ | 含**本扩展自身页面**（sidepanel/options）与其他扩展页 | 扩展选项页、PDF 阅读器 `mhjfbmdgcfjbbpaeojofohoefgiehjai` |
| `chrome-untrusted://*` | ❌ | 特权上下文 | 部分内部沙箱页 |
| `edge://*` | ❌ | Edge 内部页，同 chrome:// 约束 | Edge 设置、扩展管理 |
| `view-source:` | ❌ | 特殊 scheme，非网页内容 | 查看源代码页 |
| DevTools 窗口（`devtools://` 或 F12 调试窗） | ❌ | 调试器自身上下文，禁止 | F12 开发者工具 |
| `chrome.google.com/webstore` / `chromewebstore.google.com` | ❌ | 应用店被硬性保护，纵使有 host 权限也禁止 | Chrome 网上应用店 |
| `data:` | ❌ | 非真实 tab 页，浏览器拦截 | `data:text/html,…` 页 |
| 内置 PDF 阅读器 | ❌ | 实际运行在 `chrome-extension://` 下 → 受上条约束 | 浏览器直接打开的 PDF |

### 1.3 无痕模式（Incognito）特殊性
- 普通 `https://` 页在「允许扩展用于无痕」开启**后**可截；但 `chrome://` 等特权页**仍不可截**。
- 部分 Chrome 版本在无痕下 `captureVisibleTab` 会返回**空白/黑图**（split 模式下跨源限制），属已知坑，需在 UX 上提示「无痕下可能截到空白」。
- 结论：无痕**不新增不可截图类型**，但会增加「截到空白」的失败率，需降级提示。

### 1.4 对「截图识文」的影响
- 入口挂载点 `#aiBotBtn` 在 `sidepanel.js`（L5471 `initAiBot`），但截图目标永远是**当前网页 tab**。`captureVisibleTab(tab.windowId)` 截的是该 tab 内容区——侧栏打开不影响 active tab。
- 现有 L1831 的缩略图是 `jpeg q60`（预览用、有损、低清），**不能直接用于 OCR**。截图识文必须走**独立的 png/高保真** capture 路径。
- 受限页（chrome://、应用店等）截图必然失败，且现有 L1832-1834 的 `try/catch` **吞掉了异常**——截图识文必须区分「受限页」并给友好提示，不能让用户以为功能坏了。

---

## 2. 长截图（跨视口）方案决策（澄清 B）

### 2.1 方案对比表

| 维度 | 方案 1：滚动 + 逐视口 captureVisibleTab + Canvas 拼接 | 方案 2：chrome.debugger + CDP `Page.captureScreenshot({captureBeyondViewport:true})` |
|---|---|---|
| 新增权限 | **无**（复用现有 `activeTab`/`tabs`） | **需 `debugger` 权限** |
| UX 影响 | 无侵入 | 浏览器顶部出现**持久黄色「已暂停以进行调试」条**，用户易恐慌；且被调试 tab 不能同时开 F12 |
| 实现位置 | 后台 SW 协调 `executeScript` 滚动 + `captureVisibleTab` 逐张 + `OffscreenCanvas` 拼接 | 后台 `chrome.debugger.attach` 后用 CDP 一次性出整页 PNG |
| fixed/sticky 头部 | 会重复出现在每张切片 → 需检测并裁掉/只合成一次 | CDP 内部合成，处理更好但仍非完美 |
| 懒加载空白 | 需先滚动触发图片加载再截 → 额外等待 | CDP 内部滚动等待，同样有空白风险 |
| 拼接缝 | 需处理 devicePixelRatio、滚动条宽度、smooth-scroll → 可能有缝 | 无拼接缝（整页一次） |
| 超大页内存 | 多张 + 拼接，内存可控；但 canvas 单维有上限 | base64 巨大，需分片回传 |
| 长截图质量 | 中（受上述缺陷影响） | 高 |
| 商店审核风险 | 低 | **高**（debugger 权限触发更严格人工审核 + 隐私质询） |
| 与「区域截图」关系 | 天然契合：先拼全页，再让用户选区裁切 | 整页一次性，区域裁切需另做 |

### 2.2 推荐
**默认采用方案 1（滚动拼接）；方案 2 作为可选「高质量长截图」模式（开关控制）。**

理由：
1. **零新权限、零 UX 侵入**——不弹黄条，不触发更严审核，用户信任度高。
2. **复用度高、增量风险低**：仓库已有 `captureVisibleTab` 经验（L1831）、`canvas.drawImage→toBlob` 经验（`paintHoverFrame` L4991）、复制到剪贴板经验（`copyImageToClipboard` L413）。方案 1 完全建立在这些已有能力上。
3. **与核心诉求一致**：用户主需求是「截网页某块区域」，长截图是增强。方案 1 的流程是「拼全页 → 选区裁切」，与区域截图天然统一；方案 2 出整页反而还要再裁。
4. **debugger 黄条的产品代价过大**：对一款素材采集消费扩展，持久黄条会显著降低留存，且 `debugger` 权限在 Chrome Web Store 审核中属于敏感权限，易被拒或要求额外声明。

### 2.3 方案 1 的风险与缓解
| 风险 | 缓解 |
|---|---|
| 滚动容器识别错误（页面在内层 div 滚动而非 window） | 注入脚本探测 `document.scrollingElement` 与可滚动祖先，统一滚动正确容器 |
| 懒加载图片空白 | 滚动到位后等待 `load`/`IntersectionObserver` 触发，再延时截该视口 |
| fixed/sticky 头部在切片中重复 | 注入脚本检测 `position:fixed` 元素，逐切片裁除重复带，仅在最终图合成一次 |
| 拼接缝（DPR/滚动条/smooth-scroll） | 临时 `scroll-behavior:auto`；按 `devicePixelRatio` 换算；剔除滚动条宽度 |
| 超长页超出 canvas 尺寸上限（单维 ≈65535px、面积上限） | 超过阈值则分片导出多张 PNG 或在 UI 提示降级 |
| 截图过程中用户滚动/打断 | 截图前锁定交互、结束时恢复滚动位置；失败则回退「仅当前视口」 |

### 2.4 降级策略
- 页面**不可滚动**（`scrollHeight - innerHeight < 阈值`）→ 直接走「当前视口区域截图」，不进入长截图流程。
- 任一视口 capture **受限/失败** → 中止长截图，回退到「可见区域截图」并提示。
- 拼接产物超出 canvas 上限 → 拆成多张或提示「该页过长，已截当前视口」。
- 始终保留「仅截当前视口」作为兜底入口。

---

## 3. 架构合理性 Verdict（澄清 D）

### 3.1 现有模式
仓库采用「**一个功能一个独立 js 文件 + 全局函数/全局变量通信**」：
- `sidepanel.html` 用多个独立 `<script src>` 顺序加载（`ui-utils`/`config-runtime`/`media-transcode`/`sidepanel.js`(主编排)/`media-fetch`/`card-render`/`bulk-actions`/`audio-*`/`context-menu`/`progress`/`download`/`preview-render`/`model-preview` 等）。
- `background.js` 用 `importScripts` 把 `rules.js`/`router.js`/`scan.js`/`polling.js`/`mv3-state.js`/`model-magic.js` 拆出（L6-16）。
- `shared/messages.js` 已作为 **HMDAO_* 消息类型单一真相源**（SSOT）——这是非常好的实践。

### 3.2 优点
| 优点 | 说明 |
|---|---|
| 文件级功能分解已存在 | 媒体/卡片/批量/音频/进度/下载/预览各自独立，认知边界清晰 |
| 消息常量已集中 | `messages.js` 把「字符串拼写错误运行时才暴露」变为「加载即暴露」 |
| 后台已有 importScripts 拆分先例 | 证明团队接受「按关注点拆文件」的方向，可平滑升级为特性模块 |
| HTML 显式顺序保留依赖线索 | 虽脆弱但比完全隐式好 |

### 3.3 缺陷 / 隐患
| 缺陷 | 危害 |
|---|---|
| **`sidepanel.js` 6580 行巨无霸** | AI 机器人、网盘、模型预览、扫描编排、剪贴板、悬停框、选文字全部塞一起；改动风险高、合并冲突重、无法单测 |
| **全局命名空间污染** | 各文件往 `window`/`self` 挂全局函数/变量，命名冲突风险，无封装 |
| **加载顺序耦合** | 文件依赖 HTML `<script>` 先后；加特性必须懂顺序，错序即运行时静默失败（正如 `messages.js` 注释自述的痛点，但函数依赖仍未解） |
| **无显式依赖声明** | 文件隐式依赖别处全局，缺「import 即知依赖」能力 |
| **后台中央 if 链分发**（L713 起一大串 `if (msg.type===…)`） | 每加一个处理器就要改中央文件，与可插拔目标直接冲突 |
| **无生命周期/开关契约** | 特性无法独立 init/teardown、无法一键开关 |

### 3.4 总体结论
**部分合理、技术债偏重，但方向正确。** 文件级拆分是好习惯，应把它从「约定」升级为「机制」——建立 `FeatureManager` + 自注册 + 后台处理器注册表，让「一个功能一个文件」成为**有契约、可开关、不污染中央文件**的一等公民。截图识文正是落地这套机制的最佳试点。

---

## 4. 代码臃肿度 Verdict（澄清 E）

### 4.1 数据支撑
| 文件 | 行数 | 角色 |
|---|---:|---|
| `sidepanel.js` | **6580** | 侧栏主编排（AI 机器人/网盘/模型预览/扫描/剪贴板/悬停框/选文字） |
| `background.js` | **5277** | Service Worker（消息分发/fetch 代理/DASH 合并/扫描/网盘/AI） |
| `inject-main.js` | **2305** | MAIN world 内容脚本 |
| 三者合计 | **≈14162** | 核心巨型文件群 |
| 其余 ~35 个 js | 各自 2k–87k 字节 | 已拆分的功能模块（整体拆分良好） |

### 4.2 臃肿判断
**臃肿（严重级）。** 行业经验值：单文件 >800–1000 行即应考虑拆分，>2000 行是强信号，`sidepanel.js` 6580 行属「God File」级别。`background.js` 5277 行同理。两者都把多条正交关注点堆在一个文件，是典型的技术债。

### 4.3 若直接把截图识文塞进 `sidepanel.js` 的代价
- **+400~700 行**（悬停检测、选区覆盖层、Canvas 拼接、OCR/翻译调用、弹窗 UI、状态机）→ 逼近 7000+ 行，雪上加霜。
- **合并冲突加剧**：该文件已是多人/多分支的争用点，新增大块逻辑放大冲突概率。
- **认知负荷翻倍**：机器人悬停行为更难推理，回归风险上升。
- **无法独立开关/灰度**：截图识文 bug 或商店合规问题会牵连核心侧栏。
- **不可单测**：与 6580 行主逻辑耦合，无法隔离验证选区/拼接/OCR。
- **违背既有约定**：仓库已奉行「一功能一文件」，塞进 `sidepanel.js` 自相矛盾。
- **结论**：必须独立为 `features/screenshot-ocr.js`（+ 拆分辅助文件），**绝不进 `sidepanel.js` 主逻辑**。

---

## 5. 可插拔特性模块设计（澄清 C + F）

### 5.1 设计目标（复述用户要求）
1. 新增/移除「截图识文」= 增删**一个文件** + `sidepanel.html` **一行 `<script>`**，**不改 `sidepanel.js` 主逻辑**。
2. 特性**自注册**：挂到 `window.HMDAO_FEATURES` 或 `FeatureManager`，含 `{id, enabled, init(), onMessage()}` 契约。
3. `background.js` 路由从「巨型 if 链」改为「**按特性注册的处理器分发**」。
4. 给出截图识文模块的**文件清单、职责、通信契约**（基于现有 `chrome.runtime` 总线）。
5. 支持**一键开关**（options 页 / storage 标志）。

### 5.2 注册契约（Feature 描述符）
```js
// 契约形状（非实现）；特性文件加载即 push 到 window.HMDAO_FEATURES
{
  id: 'screenshot-ocr',
  title: '截图识文',
  enabled: () => storageGet('feature:screenshotOcr', true), // 开关读取
  init(ctx)   { /* 挂 #aiBotBtn 悬停、注入选区、提供动作按钮 */ },
  onMessage(msg, sender, sendResponse) { /* 处理本特性拥有的侧栏侧消息 */ },
  teardown()  { /* 移除监听、清理 DOM、注销后台处理器 */ }
}
```
- `ctx` 由 `FeatureManager` 注入：`{ HMDAO_MSG, sendToBackground, captureVisibleTab, copyImageToClipboard, storage }`。
- `enabled()` 决定 `init()` 是否执行；支持运行时 `FeatureManager.setEnabled(id, bool)` 热插拔。

### 5.3 FeatureManager（基础设施，独立文件，一次性接入）
- 新增 `features/feature-manager.js`，在 `sidepanel.html` 中 `shared/messages.js` 之后、`sidepanel.js` 之前加载（**一次性、基础设施级**）。
- 职责：定义 `window.HMDAO_FEATURES = []` 与 `FeatureManager`；**自引导**（监听 `DOMContentLoaded` 或在 DOM 已就绪时立即）遍历已注册特性 → 校验 `enabled()` → 调用 `init(ctx)`；提供 `handleMessage()` 扇出到各特性 `onMessage()`；提供 `setEnabled()` 热开关。
- **关键**：`FeatureManager` 自引导，故特性文件**无需改 `sidepanel.js`** 即被初始化。

### 5.4 background.js 路由改造（一次性 + 每特性一行 importScripts）
- 新增 `features/feature-background-router.js`，`background.js` 顶部 `importScripts('features/feature-background-router.js')`（**一次性、基础设施级**），定义 `self.HMDAO_BG_HANDLERS = {}` 与 `registerBgHandler(type, fn)`。
- 后台中央 `chrome.runtime.onMessage.addListener`（L713）**仅做一次小改造**：在 if 链最前插入
  `if (HMDAO_BG_HANDLERS[msg.type]) { HMDAO_BG_HANDLERS[msg.type](msg,_sender,sendResponse); return; }`
  命中注册表则分发，**未命中回退既有 if 链**。
- 各特性的后台处理器文件（如 `screenshot-ocr-bg.js`）在 `importScripts` 时调用 `registerBgHandler(...)` 自注册。
- **净效果**：新特性逻辑全部外置；`background.js` 主链不被每个特性篡改，只增删「一行 `importScripts`」。这与现有 `rules.js`/`router.js`/`scan.js` 的 importScripts 约定一致。

> 说明：SW 无法动态 `import`，后台处理器必须在 SW 上下文定义 → 每个后台特性需 `background.js` 加**一行 `importScripts`**。用户「不改动 sidepanel.js 主逻辑」的硬约束已满足；background 仅做一次性基础设施改造 + 每特性一行 importScripts（非改分发链）。

### 5.5 「截图识文」模块文件清单与职责

| 文件 | 上下文 | 职责 | 注册/依赖 |
|---|---|---|---|
| `features/feature-manager.js` | sidepanel（HTML 引入） | 定义 `HMDAO_FEATURES` + `FeatureManager`；自引导 init / 消息扇出 / 热开关 | 依赖 `shared/messages.js`（已先于它加载） |
| `features/screenshot-ocr.js` | sidepanel（HTML 引入，**新增即一行 `<script>`**） | 自注册特性；`#aiBotBtn` 悬停 1s → 弹「截图识文」按钮；点击 → 开启选区；接收 dataURL → 本地 Canvas 裁切（复用 `paintHoverFrame` 思路）；渲染「翻译/提取文字/复制截图」动作条；调用 OCR/翻译；复制走现有 `copyImageToClipboard` | 注册到 `HMDAO_FEATURES`；发 `SCREENSHOT_CAPTURE`/`SCREENSHOT_OCR` 给后台 |
| `features/screenshot-select-inject.js` | 注入目标页（按需 `chrome.scripting.executeScript`） | 渲染**选区覆盖层**（pointer-events:auto 可拖拽，区别于现有选文字的 pointer-events:none）；回传选区矩形 `{x,y,w,h,dpr,scrollX,scrollY}`；长截图时提供滚动/度量辅助 | 由 sidepanel/后台 `executeScript` 注入，结果经 `runtime.sendMessage(SCREENSHOT_REGION_READY)` 回传 |
| `features/screenshot-ocr-bg.js` | background SW（`importScripts` 一行） | 注册后台处理器：`SCREENSHOT_CAPTURE`（png 高保真 captureVisibleTab，受限页返回 `restricted:true`）、`SCREENSHOT_CAPTURE_LONG`（协调注入脚本滚动 + 逐视口 capture + `OffscreenCanvas` 拼接）、`SCREENSHOT_OCR`、`SCREENSHOT_TRANSLATE`（POST 后端） | `registerBgHandler(...)` 自注册 |
| `features/screenshot-ocr.css`（可选） | sidepanel/注入 | 弹窗与覆盖层样式（或内联） | — |
| `shared/messages.js`（**追加键**） | 全局 SSOT | 新增 `SCREENSHOT_OPEN` / `SCREENSHOT_CAPTURE` / `SCREENSHOT_CAPTURE_LONG` / `SCREENSHOT_REGION_READY` / `SCREENSHOT_OCR` / `SCREENSHOT_TRANSLATE` | 禁止硬编码字符串 |

### 5.6 通信协议（基于现有 `chrome.runtime` 总线）

| 方向 | 消息 / 调用 | 说明 |
|---|---|---|
| sidepanel → background | `runtime.sendMessage({type: SCREENSHOT_CAPTURE, payload:{format:'png', tabId}})` | 后台 `captureVisibleTab` 出高保真图 |
| background → sidepanel | `sendResponse({ok, dataUrl, restricted})` | **必须用 `return true` 保持异步通道**（同 L2121 模式），受限页回 `restricted:true` |
| sidepanel → page | `scripting.executeScript({files:['features/screenshot-select-inject.js']})` 后 `tabs.sendMessage(tabId,{type:SCREENSHOT_OPEN})` | 注入选区层 |
| page → sidepanel | `runtime.sendMessage({type: SCREENSHOT_REGION_READY, payload: rect})` | 回传选区 |
| background → page（长截图） | `scripting.executeScript(scrollFn)` 返回 `scrollY` | 逐视口滚动取度量 |
| sidepanel → background | `runtime.sendMessage({type: SCREENSHOT_OCR, payload:{image:dataUrl, task:'ocr'\|'translate', lang}})` | 后台 POST 后端 |
| background → 后端 | `fetch(base+'/api/extension-ocr', {image, task, lang})` | **见 5.7（C：不传画布）** |
| background → sidepanel | `sendResponse({ok, text})` | 回 OCR/翻译结果 |

### 5.7 澄清 C：不传画布 → 架构简化
- **移除 `HMDAO_AGENT_UPLOAD` / `RUN_AGENT_WORKFLOW` 画布路径**（现有 L2064-2107）。截图识文不走画布、不触发 SmartAgent 媒体工作流。
- 截图的三条去路全部本地/直连后端：
  1. **复制截图** → 复用现有 `copyImageToClipboard`（L413，png→剪贴板，已验证可粘微信/PS）。
  2. **提取文字（OCR）** → 裁切图发后端 `/api/extension-ocr`（新端点）或扩展 `/api/extension-ai` 支持 image 入参。
  3. **翻译** → 同上，带 `lang` 参数。
- 因此本特性**无画布依赖、无 Agent 工作流依赖**，与现有 AI 聊天（`AI_CHAT`）共用后端但独立成处理器，解耦干净。

### 5.8 一键开关机制
- **storage 标志**：`hmdao:feature:screenshotOcr`（经 `config.js` 的 storage helper 读写，与现有 `apiBase`/`apiKey` 模式一致），默认 `true`（或 GA 前 `false`）。
- **options 页**：在 `options.html` 加「截图识文」开关项，`options.js` 按现有 `saveBtn` 模式读写该 key。
- **侧栏内快捷开关**（可选）：在 AI 机器人菜单下加同标志切换。
- **生效链路**：`FeatureManager` 在 `init` 时读 `enabled()`；切换调用 `FeatureManager.setEnabled(id,bool)` → 写 storage + 实时 `teardown()`/`init()`；后台处理器在调用时亦校验该标志，disabled 则早返回 `{ok:false, disabled:true}`。
- **移除特性**：删 `features/screenshot-ocr.js` + `sidepanel.html` 一行 `<script>`（+ `background.js` 一行 `importScripts` + `screenshot-ocr-bg.js`），**不动 `sidepanel.js`/`background.js` 主逻辑**。

---

## 6. 待确认问题 / 风险清单（≤8，P0/P1）

| # | 级别 | 风险 / 待确认 | 影响与建议 |
|---|:--:|---|---|
| 1 | **P0** | **后端必须支持多模态图片输入**。当前 `/api/extension-ai` 仅收 `text`（L2047 证实）。「提取文字/翻译」若无图片入参则无法实现。 | 需后端新增 `/api/extension-ocr`（或扩展 `extension-ai` 收 `image` base64）。属跨端阻塞项。 |
| 2 | **P0** | **受限页截图必然失败且现有 try/catch 吞异常**（L1831-1834）。用户在 chrome://、应用店等点截图会「没反应」。 | 特性须先判受限 scheme，隐藏入口或给友好提示；后台 `SCREENSHOT_CAPTURE` 回 `restricted:true`。 |
| 3 | **P0** | **长截图方案选型待拍板**。默认方案 1 有 fixed 重复/懒加载空白/拼接缝等已知缺陷；方案 2 需 `debugger` 权限+黄条。 | 建议方案 1 默认 + 方案 2 作可选高质量模式。需产品确认是否接受缺陷/是否引入 `debugger`。 |
| 4 | **P0** | **`debugger` 权限取舍**。若采用方案 2 必须加，且触发 Chrome 商店更严审核 + 持久黄条。 | 产品/合规决策：是否值得为长截图质量引入敏感权限。 |
| 5 | P1 | **file:// 与特殊 scheme 边界**：file:// 需「允许访问文件网址」，data:/about: 不可截。 | 选型文档与 UX 提示需注明，避免用户误判。 |
| 6 | P1 | **选区覆盖层与 `boxSelectPageText` 冲突**：现有覆盖层 `pointer-events:none`（选文字），截图选区需 `pointer-events:auto` 拖拽。 | 两者并存须隔离（不同注入或参数化 `mode`），避免互相吞事件。 |
| 7 | P1 | **超长页 canvas 尺寸/内存上限**（单维 ≈65535px、面积上限）。 | 超阈值分片导出或降级「仅当前视口」，已在 2.4 降级策略覆盖。 |
| 8 | P1 | **选区坐标须含 `devicePixelRatio` 与滚动偏移**（长图跨视口尤甚），否则裁切错位。 | 注入脚本必须回传 `dpr/scrollX/scrollY`（见 5.5 矩形契约）。 |

---

## 附：与现有代码的衔接点（供工程师落地参考）
- 悬停入口：`sidepanel.js` `#aiBotBtn`（L296）/ `initAiBot`（L5471）——特性在此挂 1s 悬停，不改动主逻辑。
- 高保真截图：新增后台 `SCREENSHOT_CAPTURE`，**不复用** L1831 的 jpeg q60 缩略图。
- Canvas 裁切：复用 `paintHoverFrame`（L4991）的 `drawImage→toBlob` 套路。
- 选区注入：复用 `boxSelectPageText`（L6365）的 `executeScript` 注入+回传坐标套路（改 pointer-events）。
- 复制：直接复用 `copyImageToClipboard`（L413）。
- 消息：全部走 `shared/messages.js` SSOT，不在业务代码硬编码字符串。
