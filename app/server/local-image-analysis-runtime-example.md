# 本地图像提示词反推 Runtime 示例

## 1. 仓库内已提供的示例 runtime

- `server/local_image_example_florence2.py`
- `server/local_image_example_qwen35_vl.py`

它们都可以直接被仓库内 wrapper 调起：

- `server/local_image_florence2_wrapper.mjs`
- `server/local_image_qwen35_vl_wrapper.mjs`

## 2. 推荐安装方式

### 通用依赖

```powershell
py -3 -m venv .venv-image-analysis
.\.venv-image-analysis\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install pillow torch torchvision transformers accelerate
```

### Florence-2 依赖

```powershell
pip install sentencepiece timm einops
```

### Qwen 视觉链依赖

```powershell
pip install qwen-vl-utils
```

## 3. 直接启用 Florence-2

```powershell
$env:HMDAO_FLORENCE2_PATH = "F:\Work\HMDAODAO\app\server\local_image_example_florence2.py"
node F:\Work\HMDAODAO\app\server\hmdao-api.mjs
```

可选模型覆盖：

```powershell
$env:HMDAO_FLORENCE2_MODEL = "microsoft/Florence-2-large"
```

## 4. 直接启用 Qwen 视觉链

```powershell
$env:HMDAO_QWEN35_VL_PATH = "F:\Work\HMDAODAO\app\server\local_image_example_qwen35_vl.py"
node F:\Work\HMDAODAO\app\server\hmdao-api.mjs
```

可选模型覆盖：

```powershell
$env:HMDAO_QWEN35_VL_MODEL = "Qwen/Qwen2.5-VL-7B-Instruct"
```

如果你本地显存更充足、希望提示词反推更强调复杂语义和镜头组织，可以改成：

```powershell
$env:HMDAO_QWEN35_VL_MODEL = "Qwen/Qwen2.5-Omni-7B"
```

说明：

- 当前仓库里的 `qwen35-vl` 是“Qwen 视觉链兼容槽位”
- 默认示例先用当前更稳、官方公开可取的免费 Qwen 视觉模型
- 后续如果你换到新的官方 `Qwen3.x-VL` 免费权重，只需要改 `HMDAO_QWEN35_VL_MODEL`

## 5. 和 CLIP Interrogator 组合成融合反推

```powershell
$env:HMDAO_CLIP_INTERROGATOR_PATH = "F:\Work\HMDAODAO\app\server\local_image_clip_interrogator_wrapper.py"
$env:HMDAO_FLORENCE2_PATH = "F:\Work\HMDAODAO\app\server\local_image_example_florence2.py"
$env:HMDAO_QWEN35_VL_PATH = "F:\Work\HMDAODAO\app\server\local_image_example_qwen35_vl.py"
node F:\Work\HMDAODAO\app\server\hmdao-api.mjs
```

前台资产库里：

- `图片解析` 引擎切到 `融合反推`
- 点击 `解析图片`
- 反推结果会写回资产卡片 prompt
- 再点 `添加到画布并写入节点`，图片/视频节点 prompt 会继承这份结果

## 6. 更建议的组合方式

### 轻量稳定

- `CLIP Interrogator + Florence-2`
- 更适合单图、海报、产品图、风格反推

### 中文语义更强

- `CLIP Interrogator + Florence-2 + Qwen 视觉链`
- 更适合复杂场景、多主体、镜头语义和中文提示词整理

## 7. 推荐验证

```powershell
npm run build
node server/verify-browser-flow.mjs --asset-library-only --ui-only
```

验证重点：

- 资产库里图片解析可见
- 反推提示词文本更新
- 添加到画布后，图片/视频节点 prompt 自动写回
- `summary.json` 里 `imagePromptWritebackVisible/videoPromptWritebackVisible = true`
