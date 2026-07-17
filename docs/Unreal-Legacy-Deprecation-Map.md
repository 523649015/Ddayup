# HMDao Unreal 旧链路废弃清单

本文档用于明确哪些 Unreal 相关代码已经被判定为 legacy，后续不再继续作为主路径演进。

## 判定原则

以下特征的代码统一判定为旧链路：

1. 依赖 Pixel Streaming player.html
2. 依赖 iframe 承载 Unreal 预览
3. 依赖 Remote Control 充当主相机控制链路
4. 依赖浏览器跨源抓帧/录制
5. 依赖 Standalone Game 与额外启动参数

## 需冻结的文件

### 前端

- app/src/nodes/DCCCaptureNode.tsx
  - 冻结原因：Unreal 预览内嵌 iframe
  - 后续动作：拆为 provider 层 + 新预览层

- app/src/services/dcc/connection.ts
  - 冻结原因：Unreal 特判逻辑过多，且绑定 Pixel Streaming
  - 后续动作：拆分 provider 实现

- app/src/services/dcc/types.ts
  - 冻结原因：Unreal integration 仍指向 pixel-streaming
  - 后续动作：改为 editor-direct 默认配置

### 后端

- app/server/hmdao-api.mjs
  - 冻结原因：包含 pixel-proxy、player.html 改写、Pixel Streaming 启动与探测逻辑
  - 后续动作：拆出 legacy adapter，主服务迁移到 /ws/dcc/unreal

### 脚本 / 文档

- scripts/dcc/start-unreal-pixel-streaming.cmd
- scripts/dcc/start-unreal-pixel-streaming.ps1
- scripts/dcc/install-pixel-streaming-infrastructure.ps1
- docs/Unreal-Launch-Checklist.md
- docs/Unreal-Pixel-Streaming-Closure-Guide.md

以上内容后续统一降级为：

- legacy 参考资料
- 旧环境兼容入口
- 非主流程文档

## 暂不直接删除的原因

1. 当前仓库仍存在旧 Unreal 调试路径
2. 新 Unreal 插件未完全接入前，直接删除会让现有排查能力归零
3. 正确做法是先冻结，再迁移，再删除

## 删除前置条件

满足以下条件后，可执行物理删除：

1. 新 Unreal Editor Direct 方案已落地
2. DCC 节点连接、预览、截图、录制、回填节点已全部验证通过
3. 浏览器与终端双重验证完成
