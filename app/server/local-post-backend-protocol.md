# 本地后期 Wrapper 接入协议

## 目标

HMDAO 后端已经统一支持以下本地后期能力通过 wrapper 接入：

- `HMDAO_POST_FSR_COMMAND`
- `HMDAO_POST_REALBASICVSR_COMMAND`
- `HMDAO_POST_SUPIR_COMMAND`
- `HMDAO_POST_OCIO_COMMAND`
- `HMDAO_POST_DEPTH_ANYTHING_COMMAND`

如果没有显式配置 `*_COMMAND`，但配置了对应的 `*_PATH`，后端会自动回退到项目内 wrapper：

- `node server/local_post_fsr_wrapper.mjs`
- `node server/local_post_realbasicvsr_wrapper.mjs`
- `node server/local_post_supir_wrapper.mjs`
- `node server/local_post_ocio_wrapper.mjs`
- `node server/local_post_depth_anything_wrapper.mjs`

## 后端传给 wrapper 的输入

后端会通过 `stdin` 传入 JSON，同时也会把同一份 payload 写入临时文件，并注入这些环境变量：

- `HMDAO_WRAPPER_PAYLOAD`
- `HMDAO_WRAPPER_INPUT`
- `HMDAO_WRAPPER_OUTPUT`
- `HMDAO_WRAPPER_REQUEST_ID`
- `HMDAO_WRAPPER_MEDIA_KIND`
- `HMDAO_WRAPPER_ROUTE`

典型输入示例：

```json
{
  "requestId": "uuid",
  "route": "realbasicvsr",
  "mediaKind": "video",
  "inputPath": "F:/.../input.webm",
  "outputPath": "F:/.../output.webm",
  "scale": 2,
  "denoise": 0.18,
  "sharpen": 0.34,
  "tileSize": 768,
  "seamFix": true,
  "temporalStability": 0.65,
  "gpuTier": "8g-safe"
}
```

OCIO 会额外带：

```json
{
  "lutPath": "F:/.../look.cube",
  "colorConfig": {
    "ocioConfig": "aces-1.3",
    "ocioDisplay": "rec709-monitor",
    "ocioView": "filmic",
    "ocioLookStrength": 0.72
  }
}
```

Depth Anything 会额外带：

```json
{
  "strength": 0.68
}
```

## wrapper 调真实 runtime 的统一方式

项目内 wrapper 会把 JSON 写成请求文件，再按统一命令行协议调用真实 runtime：

```bash
your-runtime --hmdao-request <request.json> --hmdao-output <output.json>
```

支持这些 runtime 形式：

- `.py`：自动用 `python`
- `.ps1`：自动用 `powershell -File`
- `.js/.mjs/.cjs`：自动用 `node`
- `.exe` 或其他可执行文件：直接运行

## runtime 输出格式

真实 runtime 需要写出 `output.json`，至少包含：

```json
{
  "outputPath": "F:/.../result.png",
  "engine": "supir",
  "meta": {
    "scale": 2
  }
}
```

也可以直接返回 Base64：

```json
{
  "outputBase64": "base64...",
  "engine": "ocio"
}
```

如果返回 `outputBase64`，HMDAO 会自动落盘到请求里的 `outputPath`。

## 开箱可测的示例 runtime

仓库里已经补了 5 份可直接运行的示例 runtime，先用 `ffmpeg` 做真实本地处理，方便你不改协议就先联调整条链路：

- `server/local_post_example_fsr.py`
- `server/local_post_example_realbasicvsr.py`
- `server/local_post_example_supir.py`
- `server/local_post_example_ocio.py`
- `server/local_post_example_depth_anything.py`

这些脚本适合作为：

- 本地联调样例
- 外部推理脚本的最小协议模板
- 真模型接入前的稳定占位 runtime

它们依赖：

- `python`
- `ffmpeg` 在系统 `PATH` 中可用

## 推荐环境变量

如果你想直接用仓库内示例 runtime，可以这样配置：

```powershell
$env:HMDAO_POST_FSR_PATH = "F:\\Work\\HMDAODAO\\app\\server\\local_post_example_fsr.py"
$env:HMDAO_POST_REALBASICVSR_PATH = "F:\\Work\\HMDAODAO\\app\\server\\local_post_example_realbasicvsr.py"
$env:HMDAO_POST_SUPIR_PATH = "F:\\Work\\HMDAODAO\\app\\server\\local_post_example_supir.py"
$env:HMDAO_POST_OCIO_PATH = "F:\\Work\\HMDAODAO\\app\\server\\local_post_example_ocio.py"
$env:HMDAO_POST_DEPTH_ANYTHING_PATH = "F:\\Work\\HMDAODAO\\app\\server\\local_post_example_depth_anything.py"
```

如果你已经有自己的推理脚本，也可以只替换其中一个：

```powershell
$env:HMDAO_POST_SUPIR_PATH = "D:\\post-runtimes\\supir_infer.py"
$env:HMDAO_POST_OCIO_COMMAND = "python D:\\wrappers\\custom_ocio_bridge.py"
```

更推荐优先配置 `*_PATH`，让 HMDAO 自动发现并走项目内 wrapper。

## `*_COMMAND` 占位符

如果你的外部命令不想读 `stdin`，可以在 `*_COMMAND` 里使用这些占位符：

- `{{payloadPath}}`
- `{{inputPath}}`
- `{{outputPath}}`
- `{{requestId}}`
- `{{mediaKind}}`
- `{{route}}`

例如：

```powershell
$env:HMDAO_POST_OCIO_COMMAND = "python D:\\wrappers\\ocio_bridge.py --payload {{payloadPath}}"
```

## 备注

- 目前仓库已经把后期节点的曲线点阵、OCIO 执行模式和 HD 路由一起打通。
- 没有真实 runtime 时，系统会明确提示 wrapper 未配置或执行失败，然后按策略回退，不会伪装成已接好真实后端。
