# HMDao Seedance V2 管线验证报告

测试时间: 2026-07-15 16:30 (UTC+8)
测试环境: Windows / PowerShell, Node.js, 后端 http://127.0.0.1:8792

---

## 一、测试概览

| 阶段 | 结果 | 备注 |
|------|------|------|
| T1. Preview（image_urls/video_urls 直接格式） | 部分通过 | **发现 Bug #1**：该格式被静默丢弃 |
| T2. Preview（primary_assets/reference_assets 格式） | 通过 | 请求体构造正确 |
| T3. 真实调用 seedance-v2 | 失败 | 环境问题：`api.apimart.ai` 不可达 |
| T4. 真实调用（用 Comfly 通道） | 端到端失败 | endpoint 路径不匹配 |
| T5. 真实调用（用 wan2.2-i2v-plus） | 端到端失败 | Comfly 不支持 `/videos/generations` |

---

## 二、Seedance V2 管线结构（验证通过）

### 2.1 模型映射
```
请求 model    : seedance-v2
上游 model    : doubao-seedance-2.0
provider      : fal (在 MODEL_CATALOG 中)
实际 endpoint : https://api.apimart.ai/v1 (APIMart 中转)
激活的 API    : sk-w****xMgD (BYOK, 通过 /api/byok/activate 存储)
```

### 2.2 构造的 upstreamBody（T2 测试输出）
```json
{
  "model": "doubao-seedance-2.0",
  "prompt": "...",
  "duration": 5,
  "resolution": "720p",
  "size": "16:9",
  "seed": 42,
  "negative_prompt": "...",
  "image_urls": ["http://127.0.0.1:8792/api/assets/content/941fb91b-..."],
  "video_urls": ["http://127.0.0.1:8792/api/local-video/result/rec.mp4"]
}
```

**结论**：使用 `primary_assets`/`reference_assets` + `source_url` + `first_frame_url` 时，请求体结构与 Seedance V2 上游 API 合约一致。

---

## 三、发现的 Bug 与优化空间

### 🐛 Bug #1：`image_urls`/`video_urls` 直接格式被静默丢弃（关键）

**位置**：`app/server/hmdao-api.mjs` `buildApimartImageRoleEntries` / `buildApimartVideoRoleEntries`

**症状**：当用户/前端直接发送 `image_urls: [{url, role}]` 时，这些条目不会被 `buildApimartImageRoleEntries` 识别。函数只识别：
- `first_frame_url` (string)
- `source_url` (string)
- `last_frame_url` (string)
- `primary_assets[]` (array)
- `reference_assets[]` (array)

**复现**：T1 测试中，`image_urls: [{url, role:'subject'}]` 被构造为 `imageUrls=[]`（空数组），最终 `image_urls: imageUrls.length ? imageUrls : undefined` 计算为 `undefined`，被 `compactObject` 过滤掉。

**影响**：直接调用 `/api/proxy-preview/fal` 并提供 `image_urls` 时，所有图片参考都丢失。视频参考同理。

**建议修复**：`buildApimartImageRoleEntries` 和 `buildApimartVideoRoleEntries` 应同时支持解析 `image_urls` / `video_urls` 数组。

---

### 🐛 Bug #2：角色信息在归一化时丢失

**位置**：`app/server/hmdao-api.mjs:6121-6122` 与 `:6198-6213` 的 seedance-v2 分支

**症状**：所有图片在归一化后变成纯 URL 字符串数组（`imageUrls: string[]`），丢失了 `role` 信息（subject / style / composition / lighting / first_frame / motion）。

**复现**：T2 测试中，`primary_assets` + `reference_assets` 共 3 个条目都指向同一 URL，经过 `uniqueStrings` 后只剩 1 个 URL，role 全部被丢弃。

**影响**：Seedance V2 上游 API 收到的是"无角色信息的图片列表"，无法区分"参考主体"与"风格图"，导致：
- 角色一致性差
- 风格可能污染主体

**建议修复**：
1. 上游 Seedance V2 API 应支持 per-image role（需要查询 APIMart 是否提供）；
2. 短期：按 role 顺序拼接到 `prompt` 里作为引导（"参考主体：URL，参考风格：URL"），或使用 `first_frame_image`/`last_frame_image` 等显式字段区分。

---

### 🐛 Bug #3：video mode 时 `first_frame_image` 被强制清除

**位置**：`app/server/hmdao-api.mjs:6211-6212`

```js
first_frame_image: sourceMediaType === 'video' ? undefined : firstFrameImage || undefined,
last_frame_image:  sourceMediaType === 'video' ? undefined : lastFrameImage  || undefined,
```

**症状**：当 `source_media_type === 'video'` 时，`first_frame_image` 和 `last_frame_image` 都被设为 `undefined`。

**问题**：Seedance V2 实际是支持"视频参考 + 首帧"组合的，强制清除 `first_frame_image` 会导致：
- 用户不能控制"视频用作运镜参考 + 图片用作主体锚定"的双重输入
- 角色一致性降低

**建议修复**：是否同时支持 `first_frame_image` 应由模型能力决定，而非 `source_media_type` 简单判断。

---

### 🐛 Bug #4：`connectivityProbe` URL 永远失败

**位置**：`app/server/hmdao-api.mjs:4849` 与 `probeRelayConnectivity` 调用点

**症状**：probe 使用 `GET {baseUrl}/models`（如 `https://api.apimart.ai/v1/models`）作为连通性探针，但此 URL 在所有 relay 中**根本不存在**（OpenAI 兼容接口是 `/models` 但通常不挂在 `/v1/models`）。

**复现**：T2 preview 输出：
```json
"connectivityProbe": { "ok": false, "url": "https://api.apimart.ai/v1/models", "code": "请求超时" }
```

**影响**：
- 预览时永远显示"不可达"警告，但实际请求可能成功
- 误导用户/开发者认为服务挂了
- 不会真正阻止请求

**建议修复**：
- probe URL 改为 `GET {baseUrl}/`（根路径）或 `GET {baseUrl}/healthz`（如果存在）；
- 或直接 POST 一个最小 payload 到 `/videos/generations` 做 dry-run。

---

### 🐛 Bug #5：`aspect_ratio` ↔ `size` 字段混淆

**位置**：`app/server/hmdao-api.mjs:6158`（common 分支）vs `:6204`（seedance-v2 分支）

**症状**：
- `common` 分支使用 `aspect_ratio: aspectRatio`
- seedance-v2 分支使用 `size: aspectRatio`
- `normalizeProviderPayload` 又会把 `size` 转回 `aspect_ratio`（line 14049）

**流程**：
1. 用户发 `size: "16:9"`
2. `normalizeProviderPayload` 转成 `aspect_ratio: "16:9"`
3. `normalizeApimartAsyncGenerationPayload` 走 seedance-v2 分支，又转回 `size: "16:9"`
4. 最终发出 `size: "16:9"`

**影响**：当前实际工作，但字段在中间状态被反复改写，对调试和日志可读性不利，且如果 seedance 上游对字段名敏感（部分 API 严格校验字段名集合），多余字段可能被拒绝。

**建议修复**：在 `normalizeProviderPayload` 中明确 `seedance-v2` 不做 `size↔aspect_ratio` 转换。

---

### ⚠️ 优化 #1：缺省 `size` 兜底

`apimartVideoAspectRatio` 依赖用户输入的 `size`/`width`+`height`/`aspect_ratio`，缺省时可能返回空字符串，导致 seedance-v2 的 `size: ""` 经过 `compactObject` 后丢失。

**建议**：兜底为 `16:9` 或从节点默认设置读取。

---

### ⚠️ 优化 #2：`reference_strength` 未在 seedance-v2 分支传递

**位置**：`app/server/hmdao-api.mjs:6198-6213`（seedance-v2 分支未使用 `common` 变量）

**症状**：`common` 中有 `reference_strength` 字段（line 6165），但 seedance-v2 分支没用，导致用户调主体参考强度时无效。

**建议**：把 `reference_strength` 加到 seedance-v2 分支的输出中。

---

## 四、环境层阻断（与代码无关）

| 端点 | 状态 | 备注 |
|------|------|------|
| `https://api.apimart.ai/v1` | ❌ 不可达 | TCP 108.160.167.156:443 超时 |
| `https://fal.run` | ✅ 可达 | 直接调用需要 FAL_KEY |
| `https://ai.comfly.org/v1` | ✅ 可达 | 但只支持 `/v1/videos` 不支持 `/v1/videos/generations` |

**结论**：seedance-v2 当前激活的 endpoint `api.apimart.ai` 在当前环境不可达，导致真实生成请求会进入 PowerShell fallback，最终失败返回 `"使用 0 个参数调用 'GetResult' 时发生异常: 连接超时, 响应超时"`。

**绕过方案**：
1. 等待网络访问 apimart.ai 恢复；
2. 将 seedance-v2 的激活 endpoint 切换到 `https://fal.run`（需要 FAL_KEY）；
3. 在前端配置中允许用户手动选择 provider + endpoint。

---

## 五、最终建议

1. **修复 Bug #1**（高优先级）：`buildApimartImageRoleEntries` 支持 `image_urls` 直传格式。
2. **修复 Bug #4**（中优先级）：probe URL 改为更合理的端点。
3. **修复 Bug #3**（中优先级）：`first_frame_image` 在 video 模式下保留（前提是 seedance 文档支持）。
4. **优化 #2**（低优先级）：seedance-v2 分支加入 `reference_strength`。
5. **环境**：在 `activated-providers.json` 中把 seedance-v2 的 endpoint 切到可达的 relay（如 `fal.run` 或重新配置 apimart）。

---

## 六、相关文件

- 服务端请求体构造：`app/server/hmdao-api.mjs:6076-6214`（normalizeApimartAsyncGenerationPayload）
- Seedance 模型注册：`app/server/hmdao-api.mjs:459-489`（MODEL_CATALOG）
- 真实代理调用：`app/server/hmdao-api.mjs:13609-13884`（realProxy）
- PowerShell 兜底：`app/server/hmdao-api.mjs:4619-4696`（shouldUsePowerShellRelayFallback / executePowerShellRelayRequest）
- 端点探测：`app/server/hmdao-api.mjs:4849`（probeRelayConnectivity）
- 前端请求构造：`app/src/services/generation.ts:1592, 1717-1733, 2241-2242`（primary_assets / reference_assets）
- 视频节点 UI：`app/src/nodes/VideoNode.tsx:1610-1700`（conditioning summary / preflight）
- 测试脚本：
  - `tmp/seedance-pipeline-test.mjs`（T1：image_urls 直传，发现 Bug #1）
  - `tmp/seedance-pipeline-test-v2.mjs`（T2：primary_assets 格式，通过）
  - `tmp/seedance-real-test.mjs`（T3：真实调用，环境阻断）
  - `tmp/proxy-pipeline-end2end.mjs`（T4：Comfly 通道，模型名变体）
  - `tmp/wan22-real-test.mjs`（T5：同链路视频，路由不匹配）
- 上传的 juese 资源：`app/.hmdao-data/image/941fb91b-e3ec-4282-a25e-6f096fc19150-juese-test.png`（asset URL `/api/assets/content/941fb91b-e3ec-4282-a25e-6f096fc19150`）
- 上传的视频资源：`app/.hmdao-data/video/0deab1e5-abca-40b1-913e-dd7781d5fa0e-rec.mp4`（asset URL `/api/assets/content/0deab1e5-abca-40b1-913e-dd7781d5fa0e`）
