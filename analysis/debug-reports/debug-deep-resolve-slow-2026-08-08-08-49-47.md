# 自动排查报告：深度解析速度很慢 / 卡住无响应

> 生成时间：2026-08-08 08:49:47  |  工具：debug-agent（自动静态分析，无需人工验证）

## 一、问题描述

点击深度解析后长时间无反馈，疑似卡在长超时等待或所有分支返回空。

## 二、相关代码模块（自动搜索）

| 文件 | 相关度 | 命中行示例 |
| --- | --- | --- |
| `app\scripts\verify-browser-flow.mjs` | 848 | 179:async function waitForHttp(url, timeoutMs = 30000) { / 247:await waitForHttp(url, 45000); |
| `app\server\verify-dcc-browser-flow.mjs` | 139 | 151:async function waitForHttp(url, timeoutMs = 30000) { / 183:await waitForHttp(url); |
| `app\server\verify-dcc-video-tagging-flow.mjs` | 120 | 328:async function waitForHttp(url, timeoutMs = 30000) { / 356:await waitForHttp(url, 30000); |
| `app\server\verify-post-browser-flow.mjs` | 87 | 136:async function waitForHttp(url, timeoutMs = 30000) { / 168:await waitForHttp(url, 60000); |
| `app\server\verify-dcc-environment-panel.mjs` | 56 | 107:async function waitForHttp(url, timeoutMs = 30000) { / 131:await waitForHttp(`http://127.0.0.1:${port}/json/version`, 3 |
| `app\server\hmdao-api.mjs` | 41 | 546:socket.setTimeout(timeoutMs); / 854:const timeout = setTimeout(() => controller.abort(new Error( |
| `extension\sidepanel.js` | 40 | 244:if (text) statusTimer = setTimeout(() => { const e2 = docume / 458:function blink() { elf.classList.add('blinking'); setTimeout |
| `app\server\verify-tagging-contract-preview.mjs` | 35 | 59:async function waitForHttp(url, timeoutMs = 30000) { / 91:await waitForHttp(url, 30000); |
| `app\server\verify-dcc-tagging-flow.mjs` | 33 | 34:async function waitForHttp(url, timeoutMs = 30000) { / 62:await waitForHttp(url, 30000); |
| `app\e2e\hmdao.spec.ts` | 30 | 36:await page.waitForSelector('.react-flow', { timeout: TEST_TI / 73:await page.waitForTimeout(300); |

## 三、执行流追踪

- **入口定义**：extension\background.js:617 — `async function handleNetdiskResolve(url) {`
- **该入口内部调用的关键符号**：
  - extension\background.js:551 — `const result = await handleNetdiskResolve(msg.url);`
- **调用该入口的位置**：
  - extension\download.js:119
  - extension\router.js:60
  - extension\router.js:64
  - extension\router.js:68
  - scripts\debug-agent.mjs:84
  - scripts\debug-agent.mjs:85
  - scripts\debug-agent.mjs:87
  - scripts\test-netdisk-timeout-math.mjs:1
  - scripts\test-netdisk-timeout-math.mjs:4

## 四、预期 vs 实际差异

| 检查项 | 期望 | 实际命中 | 差异 |
| --- | --- | --- | --- |
| handleNetdiskResolve 是否有过长 DEADLINE | DEADLINE 控制在合理范围（如 8s 而非 70s） | ❌ 未命中（能力缺失） | 一致 |
| 是否存在 bridge-invalidated 导致整轮失败 | bridge 失效时有明确重试/提示而非静默空结果 | ✅ 命中: // 不应计入 bridgeFailed，否则会把「参数错 404」误判成 ne | 一致 |

## 五、根因 / 优化点（自动归纳）

- 文件夹分享 + captcha 场景，主动请求链全 400/404，且可能卡在长 DEADLINE。
- bridge 上下文易失效（扩展重载）导致 resolveError=bridge-invalidated，整轮解析无直链。

## 六、改进方案

将分享态解析的 DEADLINE 缩短；bridge 失效时明确提示"刷新分享页后重试"；文件夹/captcha 场景优先引导用户进入子文件夹再解析。

## 七、可复用解决策略

- 把"扫描识别"与"解析下载"解耦：识别靠 DOM/URL 正则，解析靠登录态 API 或被动捕获。
- 网盘类功能按"分享态 vs 自己网盘"双路径实现，二者 API 与鉴权完全不同，不可混用。
- 凡是平台侧已关闭的主动请求接口（如 file_info 400/download_url 404），立即转为被动捕获或引导用户网页端操作，不要在死接口上重试。
- 排查"点了没反应"类问题，优先检查：①是否卡在长超时等待；②是否所有分支都返回空；③语法/括号不平衡导致整个文件不加载。

## 八、学习要点记录

- 排查"点了没反应"类问题：优先检查①是否卡在长超时等待；②是否所有分支返回空；③语法/括号不平衡导致整个文件不加载（参考 netdiskResolve 缺闭合 } 致 node --check 失败）。

---
_本报告中所有"实际"结论均由工具静态读码自动得出，未要求用户手动验证。_