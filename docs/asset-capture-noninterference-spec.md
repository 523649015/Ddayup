# Ddayup 资源采集零干扰规范框架（Non-Interference Capture Spec）

> 版本：v1.0 · 生效日期：2026-08-02
> 适用范围：Ddayup 浏览器扩展（extension/）对网页素材的采集行为
> 强制等级：所有采集相关代码改动必须符合本规范，违者禁止合并。

---

## 0. 目标

在用户开启 Ddayup 侧栏的前提下，**源网页的所有媒体必须正常播放（含声音）**，
同时侧栏必须**完整采集**当前网页的素材资源：图片、音频、视频（含音轨）、
3D 模型、压缩文件、文档等。

**不可逾越的红线**：采集行为**不得劫持、静音、暂停、跳过、改属性、改 DOM、
或改变源页媒体元素的任何播放状态与音频输出**。

---

## 1. 零干扰总原则（ZERO-TOUCH）

| 编号 | 红线 | 说明 |
|------|------|------|
| ZT-1 | 不修改源页媒体元素 | 禁止对 `video`/`audio`/`AudioContext` 调用 `.play()`/`.pause()`/`.muted=`/`.volume=`/`.src=`/`.load()`/`.currentTime=`，除非是该元素由扩展自身创建且不在 DOM 中。 |
| ZT-2 | 不修改源页 DOM 结构 | 禁止插入/删除/移动源页节点；禁止给源页节点挂属性、事件、样式。 |
| ZT-3 | 不劫持媒体事件 | 禁止 `addEventListener` 后 `stopPropagation`/`preventDefault` 源页的 `play`/`pause`/`volumechange`/`ended` 等事件。被动监听（不改传播）允许。 |
| ZT-4 | 不消费源页响应体 | 禁止在注入脚本里对源页播放器发出的 fetch/XHR 响应调用 `.arrayBuffer()`/`.blob()`/`.text()`/`.json()`/`.clone()` 并**丢弃原响应**——这会破坏流媒体/MSE 的 appendBuffer 时序。 |
| ZT-5 | 不注入全局请求头 | 禁止通过 `fetch` 拦截器给源页请求 set `Referer`/`Origin`/`Cookie` 等禁设头，或改写原请求头。 |
| ZT-6 | 不触碰源页自动播放策略 | 禁止以解锁"自动播放"为由触发源页媒体播放。扩展自身播放须由**用户显式手势**驱动。 |
| ZT-7 | 网络层规则不覆盖媒体流 | 任何 `declarativeNetRequest` 头改写规则**绝对禁止匹配 `resourceTypes: ['media']`**，否则会覆盖播放器原生防盗链签名 → CDN 拒绝 → 视频无法播放且无声。 |
| ZT-8 | 隔离世界不串扰 | 注入脚本仅运行在 `MAIN`/`ISOLATED` 世界；跨世界数据交换须经 `chrome.runtime` 消息，不得污染源页全局对象（除 `window.__hmdao_*`（只读捕获缓冲）外）。 |

---

## 2. 分层采集架构（Layered Capture）

采集必须分三层，互不干扰、按优先级降级：

### 2.1 网络层（Network Layer）—— 被动嗅探
- 通过 `chrome.webRequest` / `webNavigation` 被动捕获响应 URL + `Content-Type`。
- **只读**：不拦截、不修改、不重发源页请求。
- 捕获到的真实 CDN 直链进入 `NETWORK_ASSETS`（background 内存 + 持久化）。
- 适用：有扩展名媒体、Content-Type 明确的流、模型文件、压缩包、文档。

### 2.2 注入层（Inject Layer）—— 被动钩子
- `inject-main.js`（MAIN 世界）仅做**旁路记录**：
  - `window.fetch` / `XMLHttpRequest` 包装时，**对源页请求只记录 URL，绝不消费响应体、绝不改请求头**（ZT-4/ZT-5）。
  - 只对 `googlevideo.com/videoplayback` 等**已知可安全克隆**的响应做字节捕获（YouTube 专用，且已熔断 B站/抖音）。
- `model-api-capture.js`（MAIN 世界）仅 `remember` 已播放音频 URL，不创建/不控制媒体元素。
- **熔断清单（Circuit Breaker）**：对以下站点，注入层**完全静默**（不包装 fetch/XHR、不触发任何播放）：
  - `bilibili.com/video/`、`bilibili.com/bangumi/` —— B站播放页
  - `douyin.com`、`iesdouyin.com`、`tiktok.com` —— 抖音/TikTok 播放页
  - `player.youku.com`、`v.youku.com` —— 优酷嵌入
  - 其它视频站播放页可经 `isVideoHost` 自动识别并静默。

### 2.3 后台层（Background Layer）—— 按需拉取
- 仅在**用户触发下载/预览**时，由 background SW 用 `fetch`（带 `credentials:'omit'` + dNR 注入的 Referer）拉取字节 → 回传侧栏 → 本地 blob。
- 该 fetch 的 `resourceType` 为 `other`/`xmlhttprequest`，**不触碰源页 `media` 流**（ZT-7）。
- 预览/试听音频走 `HMDAO_PLAY_AUDIO_IN_PAGE`：在源页创建**游离 `Audio` 元素（不在 DOM）**，由用户手势触发，播放完毕/悬停移开立即 `pause()`+`removeAttribute('src')`+`load()` 销毁，不影响页面其它音频。

---

## 3. declarativeNetRequest 头改写铁律

| 规则 | 允许匹配类型 | 禁止匹配类型 | 说明 |
|------|-------------|-------------|------|
| 通用 Referer 注入（`installRefererRuleForDomain`） | `xmlhttprequest`, `other`, `image` | **`media`** | 后台拉字节用 other/xmlhttprequest；绝不影响页面 video/audio 原生流 |
| B站专用 Referer | `other` | `media`, `xmlhttprequest` | B站播放页完全静默（ZT-7 特例强化） |
| 音频/媒体 CORS 放行（`installAudioCorsRule`） | `xmlhttprequest`, `other` | **`media`** | 响应头 ACAO/ACAC 仅用于后台跨域读字节 |
| 第三方 Cookie 注入（YouTube） | `xmlhttprequest`, `other` | **`media`** | 仅后台 fetch googlevideo 时注入 |

**理由**：源页 `<video>`/`<audio>` 拉流请求的 `resourceType` 始终是 `media`。一旦 dNR 给它 set Referer/Origin，会破坏抖音 `a_bogus`/`x-bogus`、B站防盗链、YouTube `n` 签名等**依赖精确原始请求头**的鉴权 → CDN 返回错误流 → **视频无法播放且无声**（即本规范要解决的核心故障）。

---

## 4. 采集完整性矩阵（Coverage Matrix）

开启侧栏后，下列资源**必须**被采集（无论源页是否播放）：

| 资源类型 | 采集路径 | 零干扰保障 |
|---------|---------|-----------|
| 图片 | 网络层（img/背景图）+ DOM 扫描 | 只读 DOM 查询 |
| 音频 | `model-api-capture.js` 旁路 `audioPlays` + 网络层 Content-Type | 不创建播放器、不触发播放 |
| 视频 | 网络层 + 抖音 RENDER_DATA 解析 + YouTube ytPlay + B站/优酷经 yt-dlp 后端 | 解析不消费页面响应、不播放 |
| 3D 模型 | 网络层扩展名 + DOM（model-viewer/A-Frame） | 只读 |
| 压缩包 | 网络层扩展名 + Content-Disposition + 下载事件兜底 | 只读 |
| 文档 | 网络层扩展名（pdf/doc/xlsx 等） | 只读 |
| 网盘/归档 | 动态链接自动点击揭示 + 深链解析（独立标签，不影响源页） | 在**新标签**完成，不触源页 |

---

## 5. 合规自检清单（Pre-Merge Checklist）

每次改动采集相关代码，必须通过：

- [ ] 在 B站/douyin/YouTube 播放页实测：**视频正常播放且有声**（核心验收）
- [ ] `grep` 确认无任何 `installRefererRuleForDomain`/`installAudioCorsRule` 调用命中 `media` 类型
- [ ] 注入层 `fetch`/`XHR` 包装对源页请求**无 `.clone()`/`.arrayBuffer()` 消费**
- [ ] 无 `video.play()`/`audio.play()` 在源页上下文被非用户手势触发
- [ ] `inject-main.js` 熔断清单覆盖 B站/douyin/TikTok/优酷播放页
- [ ] 后台拉字节仅 `other`/`xmlhttprequest`，无 `media`
- [ ] `mv3-state` 持久化不含会导致重放的请求头/签名状态

---

## 6. 故障对照表

| 症状 | 根因 | 规范条款 |
|------|------|---------|
| 抖音/B站视频无法播放且无声 | dNR Referer 规则匹配 `media` 覆盖播放器签名 | ZT-7 / §3 |
| 预览黑屏但能下载 | yt-dlp `extract` 把封面图当直链返回 | §2.3（后端修正） |
| 悬停刷一排 403 | 侧栏裸 `<audio>` 直连签名 CDN | ZT-5（已落地跳过） |
| 源页卡顿 | 注入脚本消费大响应体 | ZT-4 |
| 控制台权限策略告警 | 注入脚本触发传感器/自动播放 | ZT-6 |

---

## 7. 实施状态（2026-08-02）

- ✅ `rules.js` `installRefererRuleForDomain` 默认 `resourceTypes` 去 `media`（改为 `xmlhttprequest,other,image`）
- ✅ `rules.js` `installAudioCorsRule` 去 `media`（改为 `xmlhttprequest,other`）
- ✅ `inject-main.js` 已含 B站/YouTube 熔断；**抖音/TikTok 播放页熔断已补强**（§2.2 熔断清单）
- ✅ `model-api-capture.js` 已含 B站 + 抖音/TikTok 播放页熔断（模型/音频捕获 IIFE 同步）
- ✅ 后端 `media.mjs` `extract` 封面图过滤已含 `m.ykimg.com`（优酷）
- ✅ 悬停预览 m3u8 已走 hls.js
- ✅ 抖音/TikTok 注入层熔断已落地（确保 `douyin.com`/`tiktok.com` 下 fetch/XHR 包装完全透传、零干扰）
