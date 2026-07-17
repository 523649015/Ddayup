# HMDao Blender Capture 插件

插件名称：`HMDao Blender Capture`

用途：在 Blender 内启动本地 WebSocket 捕获服务，把当前场景摄像机列表、当前激活摄像机视角预览帧、截图和录制结果同步给 HMDao 画布的 DCC 捕获节点。

## 端口说明

HMDao Blender Capture 使用：

```text
ws://127.0.0.1:8766/ws/dcc-capture
```

不要使用 `8765`。本机 `8765` 已被 CineStudio Blender Remote 占用，它不是 WebSocket 协议，会导致 HMDao 浏览器端显示握手失败。

## 一键安装或更新

在 HMDao 项目根目录运行：

```powershell
cd F:\Work\HMDAODAO
.\scripts\dcc\install-blender-plugin.ps1 -BlenderVersion 5.0
```

不传 `-BlenderVersion` 时，脚本会安装到本机检测到的最高 Blender 版本目录。

安装后必须重启 Blender，或者在 `编辑 > 偏好设置 > 插件` 里禁用再启用 `HMDao Blender Capture`，否则 Blender 可能仍在运行旧代码。

## 手动启用

1. 打开 Blender。
2. 进入 `编辑 > 偏好设置 > 插件`。
3. 搜索并勾选 `HMDao Blender Capture`。
4. 在 3D 视图右侧 Sidebar 打开 `HMDao` 面板。
5. 点击 `启动 HMDao 捕获服务`。
6. 面板应显示：`已启动：127.0.0.1:8766 / v1.1.2`。

## HMDao 连接方式

1. 启动 HMDao 后端和前端。
2. 在 HMDao 画布添加 `DCC捕获` 节点。
3. 选择 `Blender`。
4. 点击 `连接`。

连接成功后，节点应显示真实插件状态，预览帧来自当前 Blender 摄像机。如果节点显示“本地测试预览，非实际摄像机”，说明 HMDao 网关没有完成插件握手，请先运行下方诊断。

## 诊断

```powershell
cd F:\Work\HMDAODAO\app
npm.cmd run dcc:diagnose -- --engine=blender
```

期望看到：

```text
端口 8766：已监听
真实插件握手：成功，返回 type=connected mode=real
HMDao 网关握手：成功，返回 type=connected mode=real
```

如果 Blender 面板显示已启动但握手失败：

1. 确认面板显示的是 `8766`，不是 `8765`。
2. 重新运行安装脚本。
3. 重启 Blender 或重新启用插件。
4. 重新点击 `启动 HMDao 捕获服务`。
5. 查看日志：`%TEMP%\hmdao_blender_capture.log`。

## 视角同步

插件收到 `set_camera` 或 `start_preview` 时，会把 Blender `scene.camera` 切换到同名 Camera，再渲染预览帧。因此 HMDao 节点中的相机下拉框、实时预览、截图和录制都会使用同一个摄像机视角。
