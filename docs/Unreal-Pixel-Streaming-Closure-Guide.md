# HMDao Unreal Pixel Streaming 闭环指南

本文档用于把 HMDao 的 Unreal DCC 节点真正闭环到 UE 摄像机实时画面，目标是让以下链路可重复跑通：

1. Unreal 启动 Pixel Streaming 推流
2. SignallingWebServer 稳定监听 `1025/8888`
3. HMDao DCC 节点连接后显示真实 UE 画面
4. 相机切换后预览画面同步切换
5. 捕捉生成图片节点
6. 录制生成视频节点

## 一、先说结论

如果 HMDao 画布里 Unreal 节点仍然显示“未检测到 Pixel Streaming 播放器前端”或“未检测到 Unreal Streamer 连接”，通常不是 HMDao 节点 UI 本身有问题，而是下面两个条件至少有一个没有满足：

- `SignallingWebServer` 没有真正稳定运行在 `http://127.0.0.1:1025/player.html`
- Unreal 没有真正作为 streamer 连接到 `ws://127.0.0.1:8888`

只打开 Unreal 编辑器、只启用 Remote Control API、或者只看到 1025 页面能打开，都还不算闭环成功。

## 二、当前机器的环境问题

当前机器存在一个和项目代码无关的宿主环境问题：当前进程环境同时带有 `PATH` 和 `Path` 两个键，且值相同。PowerShell 在枚举 `Env:` 或调用 `Start-Process` 构造环境块时会因此抛错。

已确认：

- 注册表中的 `HKCU\Environment` 和 `HKLM\...\Environment` 只有正常的 `Path`
- 问题出在当前宿主进程注入的运行时环境，而不是 HMDao 或 Unreal 项目把系统环境写坏了

因此，不建议第一时间全局修改注册表环境变量。更稳妥的做法是使用 HMDao 提供的“净化 PATH”启动器：

- `scripts/dcc/start-hmdao-api.cmd`
- `scripts/dcc/start-unreal-pixel-streaming.cmd`

这两个脚本会显式重建一份最小可用的 `Path/PATH`，避免 PowerShell 的环境块冲突影响服务驻留。

## 三、HMDao 侧正确启动方式

### 1. 启动 HMDao API

直接运行：

```cmd
F:\Work\HMDAODAO\scripts\dcc\start-hmdao-api.cmd
```

期望看到：

```text
[HMDao] Starting backend API on http://127.0.0.1:8787
```

### 2. 启动 Pixel Streaming Infrastructure

直接运行：

```cmd
F:\Work\HMDAODAO\scripts\dcc\start-unreal-pixel-streaming.cmd
```

期望看到：

```text
[HMDao] Player   : http://127.0.0.1:1025/player.html
[HMDao] Streamer : ws://127.0.0.1:8888
[HMDao] REST API : http://127.0.0.1:1025/api/status
```

如果这个窗口启动后马上自己关闭，说明不是 HMDao 前端问题，而是 Pixel Streaming 服务没有真正驻留成功，需要先解决服务进程退出原因。

## 四、Unreal 侧必须满足的条件

### 1. 插件

在 Unreal Editor 中启用：

- `Pixel Streaming` 或 `Pixel Streaming 2`
- `Remote Control API`

重启编辑器。

### 2. 推流地址

Unreal 必须真正把 streamer 连到：

```text
ws://127.0.0.1:8888
```

对 UE 5.7，优先使用新的参数名：

```text
-PixelStreamingSignallingURL=ws://127.0.0.1:8888
```

兼容写法通常也可见于资料中：

```text
-PixelStreamingURL=ws://127.0.0.1:8888
```

但 5.7 更推荐 `PixelStreamingSignallingURL`。

### 3. 推荐启动参数

为了做稳定预览和录制，建议 Unreal 额外带上：

```text
-PixelStreamingSignallingURL=ws://127.0.0.1:8888 -RenderOffScreen -Windowed -ResX=1920 -ResY=1080 -ForceRes -Unattended -AudioMixer
```

如果需要前端向 UE 发控制台命令，可再加：

```text
-AllowPixelStreamingCommands
```

### 4. 编辑器内验证口径

不是只看插件启用，而是要看到：

- Pixel Streaming 已开始推流
- SignallingWebServer 显示已有 streamer 连接
- HMDao 状态里 `pixelStreamerCount > 0`

## 五、如何判断 streamer 真正进来了

### 1. HMDao 后端状态接口

访问：

```text
http://127.0.0.1:8787/api/dcc/unreal/status?pixelUrl=http://127.0.0.1:1025/player.html&remoteUrl=http://127.0.0.1:30010
```

关键字段：

- `pixelReachable`
- `pixelRestApiReachable`
- `pixelStreamerConnected`
- `pixelStreamerCount`
- `pixelPlayerCount`

闭环判断标准：

```text
pixelReachable = true
pixelRestApiReachable = true
pixelStreamerConnected = true
pixelStreamerCount >= 1
```

### 2. 日志判断

日志目录：

```text
%TEMP%\hmdao-pixelstreaming-logs
```

如果只有：

```text
Listening for streamer connections on port 8888
```

但没有持续 streamer 在线信息，就说明 UE 还没有真正接入。

## 六、相机切换为什么还不算闭环

即便 UE 真推流成功，如果 `HMDAO_UNREAL_CONTROL_OBJECT_PATH` 配错，HMDao 只能显示真实画面，但不能驱动 UE 切换到正确相机。

当前 HMDao 需要的是：

- Remote Control 可调用的真实对象路径
- 函数名默认 `SetHMDaoCamera`

详细说明见：

- `docs/Unreal-Control-Object-Path.md`

## 七、最终闭环判定标准

只有同时满足下面全部条件，才算真正闭环：

1. `start-hmdao-api.cmd` 稳定运行
2. `start-unreal-pixel-streaming.cmd` 稳定运行
3. `1025/player.html` 可访问
4. `1025/api/status` 可访问
5. `pixelStreamerCount >= 1`
6. DCC 节点连接后显示真实 UE 画面
7. 切换摄像机时 HMDao 画面与 UE 实际视角同步
8. 点击捕捉后在画布生成图片节点
9. 点击录制后在画布生成视频节点

## 八、当前项目的真实状态

截至当前验证：

- HMDao 前后端 Unreal 适配层已补齐
- HMDao 已能识别 Pixel Streaming 前端可达性、REST API 可达性、streamer 在线数
- HMDao 已支持保存 Unreal 控制对象路径
- 当前剩余主阻塞仍是 UE streamer 没有稳定接入 `ws://127.0.0.1:8888`，以及 Pixel Streaming 服务后台驻留方式需要用新的 `.cmd` 启动器规避当前宿主环境冲突