# HMDao Unreal 新接入方案落地设计

## 目标

把 HMDao 当前 Unreal 侧的 `Pixel Streaming + iframe + Remote Control` 链路，迁移为以 `HMDao Unreal Capture` 原生插件为核心的编辑器直连方案。

目标很明确：
- 不要求用户开 Standalone Game
- 不要求用户配 Additional Launch Parameters
- 不再依赖 iframe 嵌入 UE 播放页
- 在 Unreal Editor 内直接完成连接、预览、截图、录制、回填
- 为 NDI / Spout / WebRTC 升级预留扩展位

## 结论先说

主路线选 `路线 A：UE 编辑器 C++ 插件直推 WebSocket`。

`Pixel Streaming + iframe` 只保留为 legacy 兼容支路，不再作为主路继续投入。

## 方案对比

### 路线 A

- Unreal Editor 内安装 `HMDao Unreal Capture`
- 插件直接采集编辑器视口或 CineCamera 画面
- 通过 WebSocket 与 HMDao 网关通信
- 预览、控制、截图、录制、上传统一走同一会话

优点：
- 不需要 Standalone
- 不需要 Pixel Streaming 前端
- 不吃 iframe / X-Frame-Options / CSP 坑
- 最适合做“连接 -> 预览 -> 捕捉 -> 录制 -> 生成节点”闭环

### 路线 B

- Unreal 输出到 Spout2 / NDI
- HMDao 本地桥接器转成浏览器可消费流
- 控制与素材回填仍由 HMDao Unreal 插件负责

优点：
- 预览更流畅
- 画质和延迟更容易做高

缺点：
- 依赖更多外部组件
- 集成复杂度高于路线 A

## HMDao Unreal 插件模块划分

### 1. Session

职责：
- 建立 WebSocket 会话
- 维持心跳、重连、状态同步
- 输出统一连接状态

建议类：
- `FHMDaoCaptureSession`
- `FHMDaoWebSocketClient`

### 2. Camera Registry

职责：
- 枚举当前关卡所有摄像机
- 维护当前选中相机
- 切换后立即刷新采样源

建议类：
- `FHMDaoCameraRegistry`
- `FHMDaoCameraDescriptor`

### 3. Frame Capture

职责：
- 从编辑器视口或目标相机抓帧
- 输出预览帧和截图帧
- 支持横竖屏自动适配

建议类：
- `FHMDaoFrameCaptureService`
- `FHMDaoFrameEncoder`

第一阶段建议用 JPEG 预览帧流，先追求闭环，再追求编码极致。

### 4. Recording

职责：
- 按帧范围录制
- 录制期间持续推送实时预览帧
- 录制结束后导出视频并回传 HMDao

建议类：
- `FHMDaoRecordingService`
- `FHMDaoTimelineResolver`

### 5. Asset Export / Upload

职责：
- 将截图或录制结果保存为临时素材
- 通过 HMDao 接口回传图片/视频
- 附带相机、分辨率、帧率、时间、引擎来源

### 6. Editor UI

职责：
- 在 Unreal Editor 插件面板中展示连接状态
- 提供连接、截图、录制、停止按钮
- 展示相机列表与录制参数

### 7. Bridge Adapter

职责：
- 预留 Spout2 / NDI 适配位
- 后续升级预览通道时不推翻主架构

## WebSocket 协议

建议地址：

```text
ws://127.0.0.1:8787/ws/dcc/unreal
```

### 握手

插件 -> HMDao：
```json
{
  "type": "hello",
  "engine": "unreal",
  "plugin": "HMDao Unreal Capture",
  "pluginVersion": "1.0.0",
  "protocolVersion": 1,
  "editor": true,
  "previewProvider": "editor-direct"
}
```

HMDao -> 插件：
```json
{
  "type": "hello_ack",
  "sessionId": "dcc-unreal-001",
  "accepted": true,
  "heartbeatIntervalMs": 5000,
  "uploadBaseUrl": "http://127.0.0.1:8787/api/dcc/assets/upload"
}
```

### 状态

```json
{
  "type": "state",
  "status": "connected",
  "previewProvider": "editor-direct",
  "recording": false,
  "selectedCameraId": "cam_main",
  "selectedCameraName": "CineCameraActor_01"
}
```

### 相机列表

```json
{
  "type": "camera_list",
  "cameras": [
    { "id": "cam_main", "name": "CineCameraActor_01", "active": true },
    { "id": "cam_close", "name": "CineCameraActor_02", "active": false }
  ]
}
```

### 切换相机

HMDao -> 插件：
```json
{ "type": "set_camera", "cameraId": "cam_close" }
```

### 预览帧

```json
{
  "type": "preview_frame",
  "frameId": "f-1002",
  "mimeType": "image/jpeg",
  "width": 1280,
  "height": 720,
  "cameraId": "cam_close",
  "cameraName": "CineCameraActor_02",
  "timestamp": 1710000000000,
  "payload": "<base64>"
}
```

### 截图

HMDao -> 插件：
```json
{
  "type": "capture",
  "requestId": "cap-001",
  "width": 1920,
  "height": 1080,
  "format": "png"
}
```

插件 -> HMDao：
```json
{
  "type": "capture_done",
  "requestId": "cap-001",
  "asset": {
    "kind": "image",
    "mimeType": "image/png",
    "width": 1920,
    "height": 1080,
    "cameraName": "CineCameraActor_02",
    "fileName": "hmdao_capture_001.png",
    "payload": "<base64>"
  }
}
```

### 录制

HMDao -> 插件：
```json
{
  "type": "start_recording",
  "requestId": "rec-001",
  "startFrame": 1,
  "endFrame": 120,
  "fps": 30,
  "width": 1920,
  "height": 1080,
  "cameraId": "cam_main"
}
```

完成：
```json
{
  "type": "recording_done",
  "requestId": "rec-001",
  "asset": {
    "kind": "video",
    "mimeType": "video/mp4",
    "width": 1920,
    "height": 1080,
    "durationMs": 4000,
    "cameraName": "CineCameraActor_01",
    "fileName": "hmdao_record_001.mp4"
  }
}
```

### 心跳

```json
{ "type": "ping", "ts": 1710000000000 }
{ "type": "pong", "ts": 1710000000000 }
```

## 前端节点改造点

### 现状问题

- DCC 节点把 Unreal 逻辑绑死在 iframe 上
- 预览、控制、截图、录制混在一套状态里
- 浏览器跨源抓帧本身不稳

### 改造方向

1. 引入 provider 概念
   - `editor-direct`
   - `ndi-bridge`
   - `spout-bridge`
   - `pixel-streaming-legacy`

2. Unreal 默认走 `editor-direct`

3. 预览层拆成独立组件
   - 不再直接渲染 iframe
   - 改成 `<img>` / `<canvas>` / 原生帧流容器

4. 节点面板只保留必要项
   - 当前相机
   - 分辨率
   - 帧率
   - 起止帧
   - 捕捉 / 录制

5. 资源回填统一由 Unreal 插件输出结果驱动
   - 截图 -> 图片节点
   - 录制 -> 视频节点

## 实施顺序

### 第一批，最快闭环

1. 新建 `HMDao Unreal Capture` 插件骨架
2. 新建 `/ws/dcc/unreal`
3. 新建 `UnrealEditorDirectProvider`
4. 新建原生预览层
5. 在节点里切掉 iframe 主路径

### 第二批，稳定化

1. 心跳与重连
2. 录制互斥锁
3. 相机缓存与切换同步
4. 截图 / 录制上传
5. 资源节点回填

### 第三批，增强

1. NDI / Spout bridge
2. 更高帧率预览
3. legacy 代码物理删除

## 旧代码处理

以下内容统一降级为 legacy，不再作为主路继续演进：

- `app/src/nodes/DCCCaptureNode.tsx`
- `app/src/services/dcc/connection.ts`
- `app/src/services/dcc/types.ts`
- `app/server/hmdao-api.mjs`
- `scripts/dcc/start-unreal-pixel-streaming.cmd`
- `scripts/dcc/start-unreal-pixel-streaming.ps1`
- `scripts/dcc/install-pixel-streaming-infrastructure.ps1`
- `docs/Unreal-Launch-Checklist.md`
- `docs/Unreal-Pixel-Streaming-Closure-Guide.md`

## 最终建议

- 主路线：路线 A
- 增强路线：路线 B
- 旧路线：Pixel Streaming Legacy，冻结

对于 HMDao 来说，最省时间、最容易闭环的就是先做路线 A 的最小版本。
