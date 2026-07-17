# HMDao Unreal 一步一图启动清单

本文专门回答两个问题：

1. `Additional Launch Parameters` 应该填在哪个具体面板。
2. `Standalone Game` 应该怎么开，才能让 Unreal 真正作为 Pixel Streaming streamer 接入 HMDao。

这份清单按你在 Unreal Editor 里实际点击的顺序写，建议严格按顺序执行。

## 执行前先确认

- HMDao 后端目标地址：`http://127.0.0.1:8787`
- Pixel Streaming 播放页：`http://127.0.0.1:1025/player.html`
- Pixel Streaming streamer 地址：`ws://127.0.0.1:8888`
- Remote Control API：`http://127.0.0.1:30010`

如果这几个地址里，`8787` 或 `1025` 打不开，先不要回 Unreal 面板里反复试按钮，优先把服务启动起来。

## 图 1: 打开插件面板

1. 打开 Unreal Editor。
2. 顶部菜单点击 `Edit`。
3. 点击 `Plugins`。
4. 在插件搜索框里分别搜索并启用：
   - `Pixel Streaming` 或 `Pixel Streaming 2`
   - `Remote Control API`
5. 如果插件状态刚改过，按提示重启 Unreal Editor。

通过标准：

- 两个插件都显示 `Enabled`
- 重启后仍保持启用状态

## 图 2: 找到 Additional Launch Parameters 面板

`Additional Launch Parameters` 不在 Python 控制台里，也不是在 Output Log 里输入。

正确入口：

1. 顶部菜单点击 `Edit`。
2. 点击 `Editor Preferences`。
3. 左侧搜索：`launch parameters`
4. 打开这一组设置：
   - `Level Editor`
   - `Play`
   - `Play in Standalone Game`
5. 在右侧找到输入框：`Additional Launch Parameters`

你需要把下面这整段填进去：

```text
-PixelStreamingSignallingURL=ws://127.0.0.1:8888 -RenderOffScreen -Windowed -ResX=1920 -ResY=1080 -ForceRes -Unattended -AudioMixer -AllowPixelStreamingCommands
```

说明：

- 这是一整行启动参数。
- 必须填在 `Play in Standalone Game > Additional Launch Parameters` 输入框。
- 不要填进 Python 控制台，不要填进 Blueprint，不要填进 Remote Control 面板。

## 图 3: 设置 Standalone Game 为播放模式

1. 回到编辑器主界面。
2. 顶部工具栏找到 `Play` 按钮旁边的小下拉箭头。
3. 点击下拉箭头。
4. 在 `Play Mode` 里选择 `Standalone Game`。

通过标准：

- `Play` 按钮旁当前模式显示的是 `Standalone Game`
- 不是 `Selected Viewport`
- 不是 `New Editor Window`

## 图 4: 启动 Standalone Game

1. 保持当前关卡已经加载到你要预览的摄像机内容。
2. 直接点击顶部 `Play`。
3. Unreal 会启动一个独立的 Standalone Game 进程。

这一步的关键不是“游戏窗口弹出来了”，而是“这个新进程有没有带着 Pixel Streaming 参数真正连接出去”。

## 图 5: 验证 Pixel Streaming Infrastructure 在线

在浏览器里依次打开：

1. `http://127.0.0.1:1025/player.html`
2. `http://127.0.0.1:1025/api/status`
3. `http://127.0.0.1:1025/api/streamers`

通过标准：

- `player.html` 能打开
- `api/status` 返回 JSON
- `api/streamers` 里不再是空数组

如果 `api/streamers` 还是 `[]`，说明 Unreal 虽然开着，但 streamer 还没有真正接入 `ws://127.0.0.1:8888`。

## 图 6: 验证 HMDao 后端识别到 Unreal streamer

在浏览器里打开：

```text
http://127.0.0.1:8787/api/dcc/unreal/status?pixelUrl=http://127.0.0.1:1025/player.html&remoteUrl=http://127.0.0.1:30010
```

通过标准：

- `pixelReachable = true`
- `pixelRestApiReachable = true`
- `pixelStreamerConnected = true`
- `pixelStreamerCount >= 1`

只要 `pixelStreamerConnected` 还是 `false`，HMDao 画布里的 Unreal DCC 节点就一定连不上真实画面。

## 图 7: 回到 HMDao DCC 节点连接 Unreal

1. 打开 HMDao 画布。
2. 新建或选中 DCC 节点。
3. 引擎选择 `虚幻引擎`。
4. `Pixel Streaming` 填：`http://127.0.0.1:1025/player.html`
5. `Remote Control` 填：`http://127.0.0.1:30010`
6. 点击 `连接`

理想结果：

- 节点显示 Unreal 实时预览
- 状态文字不再提示“未检测到 Pixel Streaming 前端”
- 状态里能看到 streamer 数量大于 0

## 图 8: 捕捉与录制闭环验证

连接成功后按这个顺序测：

1. 切换相机
2. 看预览画面是否同步变化
3. 点击 `捕捉`
4. 画布里是否生成图片节点
5. 点击 `录制`
6. 停止录制后画布里是否生成视频节点

只有这 6 步全都成立，才算 Unreal DCC 真闭环。

## 最常见的错误点

### 错误 1: 把参数输进 Python 控制台

错误示例：

```text
-AllowPixelStreamingCommands
```

这会报语法错误，因为它不是 Python 命令。

正确做法：

- 填到 `Editor Preferences > Level Editor > Play > Play in Standalone Game > Additional Launch Parameters`

### 错误 2: 只开了 Unreal Editor，没有开 Standalone Game

只开编辑器本体，不会自动变成 streamer。

正确做法：

- 必须切到 `Standalone Game`
- 再点击顶部 `Play`

### 错误 3: 在 HMDao 里把 Pixel Streaming 填成 ws 地址

错误填写：

```text
ws://127.0.0.1:8888
```

正确填写：

```text
http://127.0.0.1:1025/player.html
```

因为 HMDao 节点要的是浏览器播放器页面，不是 streamer 信令地址。

## 当前这台机器的执行顺序建议

1. 先启动 HMDao API
2. 再启动 Pixel Streaming Infrastructure
3. 再回 Unreal 按图 2 到图 4 启动 Standalone Game
4. 等 `api/streamers` 不为空后，再回 HMDao DCC 节点点连接

如果你照着清单完成后，`api/streamers` 仍为空，那就不是面板点错了，而是 Unreal 启动进程没有真正带上 Pixel Streaming 参数，或者 Standalone 进程根本没起来。
