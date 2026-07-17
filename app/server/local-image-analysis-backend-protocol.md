# 本地图像解析 Wrapper 接入协议

## 目标

HMDAO 资产库和图片/视频提示词反推，已经统一支持这些本地图像解析入口：

- `HMDAO_CLIP_INTERROGATOR_COMMAND`
- `HMDAO_CLIP_INTERROGATOR_PATH`
- `HMDAO_FLORENCE2_COMMAND`
- `HMDAO_FLORENCE2_PATH`
- `HMDAO_QWEN35_VL_COMMAND`
- `HMDAO_QWEN35_VL_PATH`
- `HMDAO_QWEN25_VL_COMMAND`
- `HMDAO_QWEN25_VL_PATH`
- `HMDAO_IMAGE_ANALYSIS_API_COMMAND`
- `HMDAO_IMAGE_ANALYSIS_API_PATH`

其中：

- `qwen35-vl` 是新的通用“Qwen 视觉链”槽位，优先给未来的 `Qwen3.x-VL` 或更强的免费 Qwen 视觉模型使用。
- `qwen25-vl` 作为旧工程兼容入口保留。
- 如果只配了 `HMDAO_QWEN25_VL_PATH`，前端新的 `Qwen 视觉链` 选项也会自动复用它。

## 仓库内已提供的 wrapper

- `server/local_image_florence2_wrapper.mjs`
- `server/local_image_qwen35_vl_wrapper.mjs`
- `server/local_image_clip_interrogator_wrapper.py`

其中：

- `Florence-2` 和 `Qwen 视觉链` 走统一 wrapper-runtime 协议
- `CLIP Interrogator` 当前直接就是可执行解析脚本

## 后端传给 wrapper 的输入

后端会通过 `stdin` 传入 JSON，同时也会把同一份 payload 写入临时文件，并注入这些环境变量：

- `HMDAO_WRAPPER_PAYLOAD`
- `HMDAO_WRAPPER_INPUT`
- `HMDAO_IMAGE_ANALYSIS_INPUT`
- `HMDAO_IMAGE_ANALYSIS_ENGINE`

典型输入示例：

```json
{
  "requestId": "uuid",
  "inputPath": "F:/.../input.png",
  "inputMimeType": "image/png",
  "width": 1280,
  "height": 720,
  "engine": "prompt-fusion",
  "tags": ["汽车", "夜景"],
  "smartCategories": ["车辆", "城市", "海报"]
}
```

## `*_PATH` 的工作方式

### 1. 直接脚本模式

适用于 `CLIP Interrogator` 这种脚本本身就能直接返回 JSON 的情况。

后端会自动把路径拼成可执行命令：

- `.py` -> `py -3 "<path>" --payload {{payloadPath}}`
- `.ps1` -> `powershell -File "<path>" --payload {{payloadPath}}`
- `.js/.mjs/.cjs` -> `node "<path>" --payload {{payloadPath}}`

### 2. wrapper + runtime 模式

适用于 Florence-2、Qwen 视觉链这类需要稳定 runtime 协议的场景。

如果设置了：

- `HMDAO_FLORENCE2_PATH`
- `HMDAO_QWEN35_VL_PATH`

后端会自动改走：

- `node server/local_image_florence2_wrapper.mjs`
- `node server/local_image_qwen35_vl_wrapper.mjs`

wrapper 会再把请求转换成：

```bash
your-runtime --hmdao-request <request.json> --hmdao-output <output.json>
```

支持这些 runtime 形式：

- `.py`
- `.ps1`
- `.js/.mjs/.cjs`
- `.exe` 或其他可执行文件

## runtime 输出格式

runtime 需要写出一个 JSON 文件，至少包含：

```json
{
  "engine": "Florence-2 Example Runtime",
  "summary": "主体、场景、风格、光影总结",
  "subject": "主体",
  "scene": "场景",
  "style": "风格",
  "lighting": "光影",
  "composition": "构图",
  "camera": "镜头",
  "mood": "氛围",
  "keywords": ["主体", "风格", "镜头"],
  "promptZh": "适合图像生成的中文提示词",
  "promptEn": "English prompt",
  "palette": ["蓝色", "橙色"]
}
```

建议额外补充：

- `warnings`
- `runtime`
- `metadata`

## 推荐策略

- `CLIP Interrogator`：优先负责审美标签、风格词、构图氛围词
- `Florence-2`：优先负责稳定的主体/场景描述
- `Qwen 视觉链`：优先负责中文语义组织、镜头语言、复杂多主体信息
- `prompt-fusion`：自动融合三者结果，优先写回图片/视频节点提示词
