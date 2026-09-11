# 项目健康追踪（Health Tracker）

> 规则：把**验证 / 测试 / 构建**过程中发现的错误都记录到这里；每修复一条就更新状态为 `已修复` 并删除待办项，
> 确保整个项目健康、能流畅运行，不残留调试代码。
>
> 当前门禁（`npm run typecheck` = `tsc -b` 零错误；`npm test` = vitest 全绿）已固化进 `.github/workflows/ci-cd.yml`。

## ✅ 已修复（本轮）

- [已修复] **85 个 TS 错误根因**：中央类型定义漂移（`post-fx` 分类、`AIDeepAnalysis` 字段、onnxruntime-web `Tensor.dims` 改 `readonly`、WebGPU `getContext('webgpu')` 类型、重复导出 `LocalModelPlugin` 等）。已从中央类型修起，并把 `*.test.ts(x)` 排除出部署构建。→ `npx tsc -b` 零错误。
- [已修复] **CI 类型检查是 no-op**：原 `npx tsc --noEmit` 在 project references 下不检查任何文件。改为 `npm run typecheck`（`tsc -b`），真正执行零错误门禁。
- [已修复] **CI 引用了未安装的 `@playwright/test`**：在 `app/package.json` 的 devDependencies 补上 `@playwright/test` 并加 `test:e2e` 脚本。
- [已修复] **CI e2e 端口错位**：原 e2e job 起 vite 在 5173，但 spec 目标 3000。改为由 `playwright.config.ts` 的 `webServer` 在 3000 拉起（与发布 `serve:3000` 一致）。
- [已修复] **NLLB-200 双注册表漂移**：翻译模型只在 `MODEL_PLUGINS`（从未被任何 UI 渲染），而 `promptAssist.ts` 却提示用户去面板安装。已将 NLLB 作为单一数据源纳入 `PRESET_MODELS`（`browserRuntime:'nllb'`），`MODEL_PLUGINS` 改为由其派生；面板用同一数据源渲染，支持一键安装。
- [已修复] **`LocalModelPanel` / `ModelDownloadPanel` 会因 NLLB 的 `url:''` 渲染出坏卡片 / 重复卡片**：两处均已跳过 `browserRuntime:'nllb'`，由专用 `NllbModelCard` 渲染。
- [已修复] **缺少「依赖归集」防回归测试**：新增 `app/src/config/__tests__/modelRegistryConsolidation.test.ts`，断言各节点功能声明的 model id 全部登记在统一数据源，直接防止再次出现漂移。
- [已修复] **缺少真实 WebGPU 出片 e2e**：新增 `app/playwright.config.ts` + `app/e2e/webgpu-cinematic.spec.ts`，并在 DEV 构建注入测试桩 `window.HMDAO_TEST`（生产构建被 tree-shake 剔除，无残留）。headless CI 自动 skip，真机 Chrome/Edge 跑 RAFT+WebGPU+WebCodecs 真实出片。

## ✅ 已修复（本轮测试/验证发现的残留错误）

> 以下为「固化零错误门禁」后，`vitest run` / `tsc -b` 仍暴露的 **预存测试与逻辑错误**（非新功能），已全部修复，全量 223 测试通过、tsc -b 0 错误。

- [已修复] **`storage.ts` 的 `closeDB()` 未清空 `globalThis.__hmdaoDBInstance` 缓存**：旧代码只置空模块级 `dbInstance`/`dbInitPromise`，但 `getDB()` 仍会返回已关闭的连接，导致 `presetInstallState` 等测试在重开 DB 时抛 `InvalidStateError: db.transaction`。已让 `closeDB()` 一并清空全局缓存（`_g.__hmdaoDBInstance = null; _g.__hmdaoDBInit = null`），同时让 `presetInstallState` 测试复用 `closeDB()` 而非裸 `indexedDB.deleteDatabase`。（也惠及生产）
- [已修复] **`translateCore.test.ts` 的 numThreads 断言错误**：原断言 `numThreads = min(4, 硬件并发)`，但 `translateCore.ts` 为规避 Vite 拦截 jsep/jspi PThread 子 Worker，**强制 `numThreads = 1`**（NLLB 串行解码多线程收益有限）。已修正断言为 `toBe(1)`，并同步更新测试标题/注释。
- [已修复] **`HdCapabilityPanel.test.tsx`「无源图时提示而不调用」失败**：`handleApplyByMode` 是异步函数，失败分支的 `setHdStatus('失败：请先选择素材图')` 在 microtask 后才落地；原测试同步 `getByTestId('hd-apply-status')` 时状态栏尚未渲染 → `Unable to find`。已用 `await waitFor(...)` 包裹断言（同时消除 `act(...)` 警告）。
- [已修复] **`ModelDownloadPanel` 的 `NllbModelCard` 不随翻译状态自刷新**：原测试靠父组件 `forceTranslateTick` 重渲染卡片，重构后父组件不再驱动该卡，导致「安装后状态变『已安装』」用例超时 / `getByText(/已安装/)` 重复匹配。已让 `NllbModelCard` 自订阅 `onLocalTranslateStateChange`，并对状态文案/按钮做 `within(card)` 作用域隔离。
- [已修复] **`imageBgRemove.test.tsx` / `imageBrushNode.test.tsx` 指向已重构 UI 的失效断言**：工具按钮不再直接调用 `removeImageBackground` / 打开 `brush-edit-canvas`，改为懒加载能力面板（`ImageToolPanelHost` → `BgRemoveCapabilityPanel`/`BrushCapabilityPanel`）。已按新面板流驱动（`bgremove-apply`、`brush-mask-canvas`、`brush-apply`）。

## ✅ 已修复（运行时缺陷：本地推理跨域隔离）

> 真机运行时暴露：一键抠图 / 一键电影感（景深 / RAFT 光流）全部失败，控制台报
> `ort-wasm-simd-threaded.jsep.mjs … failed to allocate a buffer of size 972666916` 与
> `Incorrect response MIME type. Expected 'application/wasm'`。

- [已修复] **ORT WebGPU 后端触发 threaded wasm 却无跨域隔离**：`ortEnv.ts` 之前无条件优先 `webgpu` EP，而 WebGPU 后端会预加载 threaded wasm，threaded wasm 依赖 `SharedArrayBuffer`；但 `ui-static-proxy`(3000) 未下发 COOP/COEP 头 → `crossOriginIsolated === false` → SAB 分配失败 → 创建会话直接抛 `failed to allocate a buffer`（972MB 实为 SAB，非真 OOM）。已让 `buildEpCandidates()` 仅当 `crossOriginIsolated === true` 时启用 `webgpu/webgl`，否则退回纯 `wasm`（`numThreads=1`，非 threaded，不需 SAB）。
- [已修复] **静态服务未启用跨域隔离**：`ui-static-proxy.mjs` 的静态响应与 `/api` 代理响应现已统一下发 `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless`。`credentialless` 在 Chrome/Edge 下既能让 `crossOriginIsolated === true`（启用 SharedArrayBuffer / WebGPU），又不会阻断无 CORS 的外部子资源。改后 3000 首页实测已返回上述两响应头。
- [已修复] **连带消除 threaded wasm 的 MIME 警告**：此前因 WebGPU 后端拉起 threaded wasm，浏览器用 `instantiateStreaming` 加载 `.wasm` 时若 MIME 不对会回退 ArrayBuffer；统一使用非 threaded wasm（未隔离时）或隔离后 SAB 可用（隔离时），该 `Incorrect response MIME type` 警告不再出现。
- [已修复] **视频素材被误判导致一键电影感（视频）被拦截**：`PostNode.tsx` 的 `readSourceAssetFromNode` 原先先扫 `outputs` 里的 image 再扫 video，视频节点若附带 image 缩略输出会被误判成图片。已改为优先按节点类型判定（`type==='video'` → 视频），确保「一键电影感 / 一键抠像」对视频素材正确放行。

## 🧹 残留代码清理

- 删除 `localTranslate.ts` 中合并后不再使用的 `MODEL_DESC` 常量。
- 测试桩 `testHarness.ts` 仅在 `import.meta.env.DEV` 下动态加载，生产 `npm run build` 不打包（零残留）。
- 过程性临时日志文件（`tscheck.txt` / `vitest_run*.txt` 等）已删除，不进仓库。

## ✅ 验证结果

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck`（`tsc -b`） | 0 错误 |
| 单元/回归测试 | `npm test` | 全绿（含 `modelRegistryConsolidation` 4/4、`oneClickWorkflows` 4/4） |
| 生产构建 | `npm run build` → `serve:3000` | 产物进 `app/dist`，由 `ui-static-proxy.mjs` 在 3000 提供（见 Task 5） |

## 📌 已知限制（非阻塞）

- 真实 WebGPU 出片仅在**真机 Chrome/Edge** 验证（headless/CI 无 GPU，自动 skip）。发布前请在真机走一遍「下载→安装→一键电影感/一键抠图」全链路。
- `PostNode` 的 `postHealth.upscale` 是后端 realesrgan 运行时状态，面板暂无独立安装卡片（浏览器端放大由 `real-esrgan-x4` 覆盖）；若需用户自装，建议补一张 `upscale` 运行时卡片。
