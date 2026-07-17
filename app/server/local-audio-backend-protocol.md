# 本地音频高质量后端接入协议

## 目标

HMDAO 主后端只负责统一协议与节点链路：

- `HMDAO_AUDIOLDM2_COMMAND`
- `HMDAO_VOXCPM_COMMAND`

如果没有显式设置以上命令，但设置了：

- `HMDAO_AUDIOLDM2_PATH`
- `HMDAO_VOXCPM_PATH`

后端会自动退化为项目内包装器：

- `node server/local_audioldm2_wrapper.mjs`
- `node server/local_voxcpm_wrapper.mjs`

这两个包装器再去调用你本地真实的 AudioLDM 2 / VoxCPM 运行时。

## 主后端 -> 包装器输入

主后端通过 `stdin` 传 JSON：

```json
{
  "requestId": "uuid",
  "mode": "bgm | sfx | voiceover",
  "prompt": "文本提示词",
  "duration": 8,
  "intensity": 0.6,
  "voicePreset": "narrator",
  "speechRate": 0,
  "language": "zh | en",
  "outputDir": "绝对目录"
}
```

## 包装器 -> 真实运行时

包装器会把上面的 JSON 写成请求文件，并用统一 CLI 调真实运行时：

```bash
your-runtime --hmdao-request <request.json> --hmdao-output <output.json>
```

支持这些运行时形式：

- `.py`：自动用 `python`
- `.ps1`：自动用 `powershell -File`
- `.js/.mjs/.cjs`：自动用 `node`
- `.exe` 或其他可执行文件：直接运行

## 真实运行时输出

真实运行时必须写出 `output.json`，字段至少包含：

```json
{
  "outputPath": "绝对音频文件路径",
  "mimeType": "audio/wav",
  "format": "wav",
  "duration": 8.2,
  "sampleRate": 44100,
  "channels": 2,
  "engine": "audioldm2 | voxcpm",
  "voiceName": "可选"
}
```

也可以不用 `outputPath`，直接写：

```json
{
  "outputBase64": "base64...",
  "mimeType": "audio/wav",
  "format": "wav"
}
```

## 推荐环境变量

### AudioLDM 2

```powershell
$env:HMDAO_AUDIOLDM2_PATH = "D:\\audio-runtimes\\audioldm2_infer.py"
```

如需自定义命令，也可以直接：

```powershell
$env:HMDAO_AUDIOLDM2_COMMAND = "node server/local_audioldm2_wrapper.mjs"
```

更推荐保持 `HMDAO_AUDIOLDM2_COMMAND` 为空，只设置 `HMDAO_AUDIOLDM2_PATH`，让主后端自动走项目包装器。

### VoxCPM

```powershell
$env:HMDAO_VOXCPM_PATH = "D:\\audio-runtimes\\voxcpm_infer.py"
```

或者显式：

```powershell
$env:HMDAO_VOXCPM_COMMAND = "node server/local_voxcpm_wrapper.mjs"
```

## 备注

- 当前仓库这轮已经把“协议、包装器发现、节点链路、视频混音落地”接通。
- 如果本机没有真实 AudioLDM 2 / VoxCPM 运行时，系统会明确报缺失，不会再伪装成高质量模型已启用。
