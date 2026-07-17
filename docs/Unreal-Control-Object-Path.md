# HMDao Unreal 控制对象路径对接说明

本文档说明 HMDao 的 `HMDAO_UNREAL_CONTROL_OBJECT_PATH` 在 Unreal Remote Control 中应该填写什么，避免把蓝图类路径、资产路径、实例路径混淆，导致 HMDao 提示已配置但 Unreal 返回 `Object does not exist`。

## 结论先说

HMDao 需要的是 Remote Control **可调用对象路径**。

一般不要直接填：
- 蓝图类路径
- 仅资源资产路径
- 你自己猜出来但场景里没有实例的对象路径

优先使用：
- 已放置在当前关卡中的 Actor 实例路径
- 或者已确认可被 `/remote/object/call` 调用的 Editor Utility Actor / C++ UObject 路径

## 三种常见路径的区别

### 1. 蓝图类路径

示例：

```text
/Game/HMDao/BP_HMDaoRemote.BP_HMDaoRemote_C
```

这通常表示蓝图生成类，不等于场景里已经存在一个可调用对象。

如果 HMDao 调用后返回：

```text
Object: /Game/HMDao/BP_HMDaoRemote.BP_HMDaoRemote_C does not exist.
```

说明当前 Remote Control 侧并没有把它当成可调用对象实例。

### 2. 蓝图资产路径

示例：

```text
/Game/HMDao/BP_HMDaoRemote
```

这通常只是内容浏览器里的资源路径，依然不代表关卡里有一个活着的对象实例。

### 3. Actor / 对象实例路径

这才是 HMDao 最需要的目标。

典型做法是：
1. 在关卡里放置一个专门用于接收 HMDao 指令的 Actor，例如 `BP_HMDaoRemote`。
2. 这个 Actor 暴露函数：

```text
SetHMDaoCamera(CameraName)
```

3. 然后把 **这个实例的对象路径** 配给 HMDao。

## 推荐实现方式

### 方案 A：关卡中放一个专用 Actor

最稳妥，推荐优先使用。

步骤：
1. 创建蓝图 Actor：`BP_HMDaoRemote`
2. 在蓝图里实现一个公开函数：

```text
SetHMDaoCamera(CameraName)
```

3. 在函数内部根据 `CameraName`：
- 查找目标摄像机 Actor
- 切换当前视角或 Sequencer 驱动摄像机
- 如有需要同步更新时间轴/渲染参数

4. 把 `BP_HMDaoRemote` 放到当前关卡中
5. 获取该实例真实对象路径
6. 在 HMDao 的 DCC Unreal 节点中填入：
- 控制对象路径
- 切换函数名 `SetHMDaoCamera`

### 方案 B：C++ UObject / Editor Utility Actor

也可以，但前提仍然是它必须是 Remote Control 能找到的实际对象，而不是只有类定义。

## HMDao 当前需要的配置项

HMDao 现在支持直接在节点面板或后端配置接口中保存：

```text
GET  /api/dcc/unreal/config
POST /api/dcc/unreal/config
```

保存示例：

```json
{
  "controlObjectPath": "/Game/HMDao/BP_HMDaoRemote",
  "cameraFunction": "SetHMDaoCamera",
  "signalUrl": "ws://127.0.0.1:8888"
}
```

说明：
- `controlObjectPath` 应填真实可调用对象路径
- `cameraFunction` 默认推荐 `SetHMDaoCamera`
- `signalUrl` 一般保持 `ws://127.0.0.1:8888`

## 如何判断路径填错了

如果调用相机切换时返回：

```json
{
  "remoteCalled": false,
  "status": 400,
  "data": {
    "errorMessage": "Object: xxx does not exist."
  }
}
```

通常说明：
1. 对象根本不存在
2. 填的是类路径，不是实例路径
3. 当前关卡里没有放这个 Actor
4. Remote Control 可见对象和你填的路径不是同一个

## 推荐排查顺序

1. 先确认 HMDao 后端状态：
- `http://127.0.0.1:8787/api/health`
- `http://127.0.0.1:8787/api/dcc/unreal/status?...`

2. 确认 Remote Control 可达：

```text
http://127.0.0.1:30010/remote/info
```

3. 确认 HMDao 已保存控制配置：

```text
GET /api/dcc/unreal/config
```

4. 再调用相机切换：

```text
POST /api/dcc/unreal/camera
```

5. 如果返回 `Object does not exist`：
- 不要继续改 HMDao
- 回到 Unreal 里确认真实对象路径

## 当前项目的实际结论

截至当前验证：
- HMDao 已支持保存 Unreal 控制对象路径
- HMDao 已把配置真实带入 `/remote/object/call`
- 当前失败原因不是 HMDao 配置链路断了
- 当前失败原因是 Unreal 里配置的对象路径还不是有效可调用对象

## 建议的最终落地方式

推荐你在关卡里放一个专用 Actor，例如：
- `BP_HMDaoRemote`

然后：
- 对它暴露 `SetHMDaoCamera(CameraName)`
- 确认它在当前关卡中真实存在
- 再把该对象的真实路径填回 HMDao

这样 HMDao 的相机下拉才会从“只改节点状态”升级为“真实驱动 Unreal 相机切换”。
