# HMDAODAO Canvas Node System

这是给 `F:\Work\HMDAODAO` 准备的可迁移画布节点系统骨架。当前会先放在 `F:\Work\CinStudio\docs\HMDAODAO-canvas-system`，因为目标目录没有写入权限且当前为空。

## 已对齐的 Infinite Canvas 关键机制

- DOM 绝对定位节点 + SVG 贝塞尔连线。
- `viewport = { x, y, scale }` 统一控制画布平移和缩放。
- 鼠标位置为中心的滚轮缩放。
- 节点拖拽、多选、删除、右键创建节点。
- Port 拖拽连线，双击连线删除。
- Prompt / Image / LLM / API Generate / ComfyUI / Output 节点类型。
- 生成节点自动寻找或创建 Output 节点。
- 生成调用采用“创建任务 + 输出 pending + 轮询结果 + 追加输出”的闭环。
- `/api/config`、`/api/workflows`、`/api/canvas-image-tasks`、`/api/canvas-llm` 对接点保留。
- API 不可用时降级到本地 mock 输出，便于离线验证交互。
- 本地 `localStorage` 持久化，后端保存失败时显示 `Saved locally`。

## 使用

直接打开：

```text
F:\Work\CinStudio\docs\HMDAODAO-canvas-system\index.html
```

迁移到 `HMDAODAO` 时，将本目录内容复制到 `F:\Work\HMDAODAO` 即可作为静态版本运行。若 `HMDAODAO` 是 Vite/React 项目，可把 `src/app.js` 的状态模型、几何函数、任务轮询流程拆成 React hooks/store。

## 后续建议

- 若目标项目已有后端，补齐 `/api/canvases` 系列接口，实现多画布管理与冲突检测。
- 若目标项目已有模型网关，直接把 `createCanvasImageTask()` 改为项目内真实生成入口。
- 若要 1:1 迁移 Infinite Canvas 的 Smart Canvas，可继续加入撤销栈、级联执行路径、素材库和工作流导入导出。
