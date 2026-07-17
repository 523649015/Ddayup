# OCIO Wrapper 运行示例

## 1. 使用仓库内示例 Runtime

```powershell
$env:HMDAO_POST_OCIO_PATH = "F:\Work\HMDAODAO\app\server\local_post_example_ocio.py"
node F:\Work\HMDAODAO\app\server\hmdao-api.mjs
```

说明：
- 后期节点调色面板里切到 `输出管理`
- 选择 `OCIO 配置 = 自定义 OCIO Config`
- 导入 `.ocio` 文件
- 执行模式保持 `自动：Wrapper 优先`
- 生成后会在节点结果区回写 `上次输出引擎 / 上次 OCIO 链路 / 上次配置落点`

## 2. 接入你自己的外部桥接脚本

```powershell
$env:HMDAO_POST_OCIO_COMMAND = "python D:\wrappers\ocio_bridge.py --payload {{payloadPath}}"
node F:\Work\HMDAODAO\app\server\hmdao-api.mjs
```

可用占位符：
- `{{payloadPath}}`
- `{{inputPath}}`
- `{{outputPath}}`
- `{{requestId}}`
- `{{mediaKind}}`
- `{{route}}`

## 3. Runtime 输入重点

OCIO wrapper 会收到这些关键字段：
- `colorConfig`
- `lutPath`
- `ocioConfigPath`
- `inputPath`
- `outputPath`

其中 `ocioConfigPath` 会在用户上传自定义 `.ocio` 文件后自动写入。

## 4. 推荐验证方式

```powershell
npm run verify:post-browser
node server/verify-post-browser-flow.mjs --visible
```

验证重点：
- 3000 页面里能看到 `OCIO Runtime 状态`
- 导入的 `.ocio` 文件名可见
- 生成后节点里可见 `上次 OCIO 链路`
- 结果节点正常生成
