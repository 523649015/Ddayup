# 自动排查报告：迅雷「自己网盘」转存后无法在侧栏扫描/下载

> 生成时间：2026-08-08 08:41:01  |  工具：debug-agent（自动静态分析，无需人工验证）

## 一、问题描述

用户把迅雷分享链接转存到自己网盘（pan.xunlei.com/?path=/我的转存，已登录），期望在扩展侧栏扫描出文件并直接下载。但实际：扫描产出 19 条素材却 xunlei dom scan result null，深度解析 hasDirectCount=0，无法下载。根因是扩展所有迅雷逻辑只支持「分享态」(pan.xunlei.com/s/ + drive/v1/share + pass_code_token)，完全不支持「自己网盘」(pan.xunlei.com/?path= + drive/v1/files + 登录 Authorization)。

## 二、相关代码模块（自动搜索）

| 文件 | 相关度 | 命中行示例 |
| --- | --- | --- |
| `scripts\test-xunlei-netdisk-e2e.mjs` | 12 | 9://   - 展开文件夹/拿直链须用 drive/v1/files 接口并带登录态 Authorization。 / 113:// 登录态用 drive/v1/files 展开文件夹 |
| `scripts\debug-agent.mjs` | 10 | 25:'用户把迅雷分享链接转存到自己网盘（pan.xunlei.com/?path=/我的转存，已登录），' + / 28:'完全不支持「自己网盘」(pan.xunlei.com/?path= + drive/v1/files + 登录 Aut |
| `extension\model-api-capture.js` | 8 | 1007:const topHeaders = { 'Content-Type': 'application/json', 'x- / 1021:const headersBase = { 'Content-Type': 'application/json', 'x |
| `scripts\xunlei-probe-mock.mjs` | 8 | 26:if (u.pathname === '/drive/v1/share') { / 39:if (u.pathname === '/drive/v1/share/file_info') { |
| `scripts\test-netdisk-scan.mjs` | 6 | 11:<p>迅雷：<a href="https://pan.xunlei.com/s/VOj-h8suAkW9oy_-90W8 / 14:<button data-download-url="https://pan.xunlei.com/s/OTHERXUN |
| `app\server\routes\netdisk.mjs` | 6 | 34:action: 'GET:/drive/v1/share', / 76:const listUrl = `https://api-pan.xunlei.com/drive/v1/share?s |
| `scripts\xunlei-fileinfo-dump.mjs` | 6 | 51:const fiUrl = `https://api-pan.xunlei.com/drive/v1/share/fil / 56:const dlUrl1 = `https://api-pan.xunlei.com/drive/v1/share/do |
| `scripts\xunlei-mock-server.mjs` | 6 | 46:if (u.pathname === '/drive/v1/share') { / 54:if (u.pathname === '/drive/v1/share/file_info') { |
| `scripts\test-netdisk-direct-link.mjs` | 4 | 49:const targetTabUrl = 'https://pan.xunlei.com/s/BACKUPTEST123 / 92:const assets = buildAssets(api.files, 'https://pan.xunlei.co |
| `scripts\test-xunlei-main-fetch.mjs` | 4 | 28:'Referer': 'https://pan.xunlei.com/s/S1?pwd=qkva', / 68:await page.goto('https://pan.xunlei.com/s/S1?pwd=qkva'); |

## 三、执行流追踪

- **调用该入口的位置**：
  - scripts\debug-agent.mjs:30
  - scripts\debug-agent.mjs:34
  - scripts\debug-agent.mjs:35
  - scripts\debug-agent.mjs:43
  - scripts\debug-agent.mjs:48

## 四、预期 vs 实际差异

| 检查项 | 期望 | 实际命中 | 差异 |
| --- | --- | --- | --- |
| scan.js 是否把 pan.xunlei.com/?path= 识别为网盘资产 | NETDISK_RE 含 pan.xunlei.com（不限 /s/） | ❌ 未命中（能力缺失） | 期望「NETDISK_RE 含 pan.xunlei.com（不限 /s/）」，但代码里未观察到对应实现（scan.js）。 |
| scan.js 是否对「自己网盘」页面做 BFS/DOM 扫描 | classifyNetdisk 区分 mydrive 并写 xunleiShare | ❌ 未命中（能力缺失） | 一致 |
| model-api-capture 是否实现自己网盘解析 | resolveXunleiMyDrive 走 drive/v1/files + download_url(file_id) | ❌ 未命中（能力缺失） | 一致 |
| 自己网盘 download_url?file_id 分支（无 share_id/pass_code）是否存在 | 存在 drive/v1/files/download_url?file_id=... 解析分支 | ❌ 未命中（能力缺失） | 一致 |

## 五、根因 / 优化点（自动归纳）

- scan.js 第16/777行 NETDISK_RE 只匹配 pan.xunlei.com/s/，自己网盘 ?path= 不被收录为 netdisk 资产。
- scan.js classifyNetdisk 仅识别分享态，自己网盘页面被 BFS/DOM 扫描跳过 → xunleiShare 为 null。
- model-api-capture.js 全量迅雷逻辑依赖 share_id + pass_code_token，自己网盘(登录 Authorization)无实现。
- 下载直链须走 drive/v1/files/download_url?file_id=<id>（无 share_id），当前代码无此分支。

## 六、改进方案

1) scan.js：NETDISK_RE 增加 pan.xunlei.com（不限 /s/）；classifyNetdisk 新增 xunlei-mydrive 分支（URL 含 pan.xunlei.com 且无 /s/ → mydrive），对 mydrive 同样做 BFS + DOM 扫描写入 xunleiShare(mode:"mydrive")。
2) model-api-capture.js：新增 resolveXunleiMyDrive(shareId/parentId/fileId)：列文件用 drive/v1/files?parent_id=<当前文件夹id>（从页面 window.__hmdao_captures 或迅雷全局拿 folder_id）；拿直链用 drive/v1/files/download_url?file_id=<id>（带登录 Authorization Cookie，经 xunleiBridgeFetch 代理）；写 out[fid].direct 与 store.fileInfo[fid]。无需 pass_code_token / captcha。
3) download.js：hasDirect=true 走 dlViaChrome；若直连 403（签名绑 IP），回退 downloadViaBackground（后台带登录 Cookie fetch → blob 下载）。
4) 侧栏提示：mydrive 场景不再误导"去转存/点下载按钮"，改为"已用你的登录态下载"。

## 七、可复用解决策略

- 把"扫描识别"与"解析下载"解耦：识别靠 DOM/URL 正则，解析靠登录态 API 或被动捕获。
- 网盘类功能按"分享态 vs 自己网盘"双路径实现，二者 API 与鉴权完全不同，不可混用。
- 凡是平台侧已关闭的主动请求接口（如 file_info 400/download_url 404），立即转为被动捕获或引导用户网页端操作，不要在死接口上重试。
- 排查"点了没反应"类问题，优先检查：①是否卡在长超时等待；②是否所有分支都返回空；③语法/括号不平衡导致整个文件不加载。

## 八、学习要点记录

- 迅雷「分享态」(pan.xunlei.com/s/ + drive/v1/share + pass_code_token) 与「自己网盘」(pan.xunlei.com/?path= + drive/v1/files + 登录 Authorization) 是两套完全不同的 API/鉴权，网盘类功能必须按这两种形态分别实现，不能混用同一套解析路径。
- 扫描识别（DOM/URL 正则）与解析下载（API/被动捕获）应解耦：识别层用宽松正则覆盖所有页面形态，解析层按分享态/自己网盘分派。
- 自己网盘的 download_url 用 file_id 而非 share_id，且依赖登录 Cookie；排查"扫描不到"先查 NETDISK_RE 是否覆盖该 URL 形态。

---
_本报告中所有"实际"结论均由工具静态读码自动得出，未要求用户手动验证。_