# AI 多模态无限画布创作平台 — 技术落地方案

> 基于您的5张设计图（文本/图片/视频/音频节点 + 无限画布），结合市场主流开源方案，提供从功能对齐到稳定运行的全链路闭环实施方案。

---

## 一、需求分析：从设计图提取功能矩阵

### 1.1 设计图功能拆解

| 功能模块 | 文本节点 | 图片节点 | 视频节点 | 音频节点 | 全局画布 |
|---------|---------|---------|---------|---------|---------|
| **左侧导航** | + | + | + | + | 资产/工作流/历史/导演台/剪辑 |
| **节点添加面板** | + | + | + | + | 文本/图片/视频/3D世界/音频 + 功能节点 + 资源上传 |
| **AI生成面板** | G3语言模型 | G2图片模型 | Seedance 2.0 | MiniMax语音 | 模型选择/参数调节/价格显示 |
| **节点操作** | 编写/上传/生视频 | 图生图/图生视频 | 全能参考/图生视频 | 文生音频/音频生音频 | 拖拽/缩放/连线/复制/删除 |
| **顶部工具栏** | - | - | - | - | 高清/剪辑/捕捉帧/解析/音频分离/视频修复/下载 |
| **连线系统** | + | + | + | + | 节点间输入输出连接 |

### 1.2 核心系统特征

- **无限画布**：深色主题，支持平移/缩放/网格吸附，类似 Figma 体验
- **节点编辑器**：拖拽创建、自定义类型、输入输出端口、节点间连线
- **多模态AI集成**：文本(GPT/Gemini)、图片(Flux/DALL-E)、视频(Seedance/Kling)、音频(MiniMax)
- **左侧边栏系统**：添加节点面板 + 导航切换（资产/工作流/历史/导演台/剪辑）
- **AI生成面板**：底部浮动，根据选中节点类型动态切换模型和参数
- **顶部工具栏**：高清处理、剪辑、帧提取、音频分离、视频修复等后期功能

---

## 二、开源方案调研与对比

### 2.1 调研范围

经过对市场上20+个开源节点编辑器/无限画布项目的调研，筛选出6个最相关方案：

| 方案 | Stars | 协议 | 定位 | 匹配度 |
|------|-------|------|------|--------|
| **@xyflow/react** | 35K+ | MIT | React节点编辑器库 | 95% |
| **tldraw SDK** | 20K+ | tldraw License | 无限画布SDK | 80% |
| **Loomic** | 1.5K+ | MIT | AI画布设计Agent | 90% |
| **Infinite-Canvas-AI-Omnigen** | 500+ | MIT | AI画布生成器 | 75% |
| **@vue-flow/core** | 4K+ | MIT | Vue节点编辑器 | 70% |
| **Rete.js** | 6K+ | MIT | 可视化编程框架 | 65% |

### 2.2 方案对比（详细）

#### 方案A：@xyflow/react（React Flow）—— 推荐主引擎

```
GitHub: https://github.com/xyflow/xyflow
npm: @xyflow/react
官网: https://xyflow.com
```

**优势**：
- 最成熟的React节点编辑器库，35K+ Stars，xyflow团队持续维护
- 原生React组件，与您的React技术栈完美契合
- 支持自定义节点/边/手柄，完全匹配设计图中的节点样式
- 内置无限画布（pan/zoom）、小地图、选择框、网格
- 丰富的插件生态：自动布局（ELK/Dagre）、撤销重做、多选
- MIT协议，可商用无限制

**局限**：
- 是底层库而非完整应用，需自行构建上层业务逻辑
- AI生成、资产管理等需自行集成
- 生产级功能（边缘路由、执行可视化）需额外开发

**适配场景**：作为核心画布引擎，负责节点渲染、交互、连线系统

---

#### 方案B：tldraw SDK —— 备选画布引擎

```
GitHub: https://github.com/tldraw/tldraw
官网: https://tldraw.dev
```

**优势**：
- 真正的Figma级无限画布体验，手绘风格支持
- 提供Workflow Kit和Image Pipeline Kit，与AI管线天然匹配
- 内置实时协作（@tldraw/sync）
- 优秀的绘图工具和交互体验

**局限**：
- 生产环境需要license key（开发免费）
- 节点连线系统不如React Flow成熟
- 架构理念不同（自由画布 vs 节点编辑器）

**适配场景**：如需更强绘图/批注能力，可考虑作为替代画布引擎

---

#### 方案C：Loomic —— 参考架构（最相似开源产品）

```
GitHub: https://github.com/fancyboi999/Loomic
定位：Lovart / CapCut Video Studio / Canva AI 的开源替代
```

**优势**：
- 与您的产品需求**几乎完全一致**：无限画布 + 多模态AI生成
- 已实现的节点类型：图片生成、视频生成、文本处理
- 完整的AI Provider路由系统（Google/OpenAI/Replicate）
- 内置积分和付费系统（LemonSqueezy集成）
- LangGraph驱动的Agent系统

**技术架构**：
```
Frontend: Next.js 15 + React 19 + Tailwind CSS 4 + Excalidraw（画布）
Backend:  Fastify 5 + LangGraph + LangChain
Database: Supabase (PostgreSQL)
Queue:    PGMQ (PostgreSQL原生)
AI:       OpenAI / Google Gemini / Replicate / Vertex AI
```

**参考要点**：
- AI Provider抽象层设计
- 多模态生成队列管理
- 画布与AI面板的交互模式
- 积分计费系统架构

---

#### 方案D：Infinite-Canvas-AI-Omnigen —— 轻量参考

```
GitHub: https://github.com/SparkSylva/Infinite-Canvas-AI-Omnigen
```

**优势**：
- 极简架构：Next.js + React Konva + fal.ai SDK
- 客户端直接调用AI API，无需复杂后端
- ffmpeg.wasm实现浏览器端视频处理
- 支持图片/视频生成，自动放置到画布

**参考要点**：
- 轻量级AI集成模式
- Konva vs React Flow的对比选择
- 客户端AI调用的安全处理

---

### 2.3 最终推荐组合

```
核心画布引擎：@xyflow/react v12（React Flow）
UI组件系统：  shadcn/ui + Tailwind CSS v4
状态管理：    Zustand + Immer
后端服务：    Hono.js / Fastify + Drizzle ORM
数据库：      PostgreSQL (Supabase) + Redis
AI服务：      Fal.ai / Replicate / OpenAI / Google（Provider模式）
媒体处理：    ffmpeg.wasm（前端）+ Sharp（后端）
队列系统：    BullMQ / PGMQ
参考架构：    Loomic（AI集成模式）
```

---

## 三、技术架构设计

### 3.1 五层架构

参见 `tech-architecture.png` 架构图，系统分为五层：

#### Layer 1 — 表现层（Presentation）

| 模块 | 技术选型 | 职责 |
|------|---------|------|
| 画布引擎 | @xyflow/react v12 | 无限画布、节点渲染、拖拽、连线、缩放 |
| UI组件 | shadcn/ui + Tailwind CSS v4 | 侧边栏、对话框、表单、下拉菜单 |
| 状态管理 | Zustand 5 + Immer | 全局状态、历史记录、持久化 |
| 路由 | React Router v7 | 页面路由、导航状态 |

#### Layer 2 — 应用核心层（Application Core）

| 模块 | 职责 |
|------|------|
| Node Registry | 节点类型注册、自定义渲染器、端口定义、验证规则 |
| AI Generation Engine | Provider抽象、多模型路由、流式输出、进度回调 |
| Interaction Manager | 画布交互、快捷键、上下文菜单、复制粘贴 |
| Canvas Manager | 视图控制、缩放适配、小地图同步、网格控制 |

#### Layer 3 — 数据层（Data）

| 模块 | 技术选型 | 职责 |
|------|---------|------|
| 持久化 | localStorage + IndexedDB + Y.js | 草稿保存、自动保存、离线支持 |
| 资产管理 | 自定义 + S3/Supabase Storage | 上传、缩略图、懒加载、CDN |
| 实时协作（可选） | Y.js + WebSocket | CRDT同步、光标呈现、冲突解决 |

#### Layer 4 — 后端服务层（Backend）

| 模块 | 技术选型 | 职责 |
|------|---------|------|
| API网关 | Hono.js / Fastify | REST API、tRPC、认证中间件、限流 |
| AI路由 | 自定义 | 多Provider统一接口、熔断降级、用量追踪 |
| 媒体处理 | ffmpeg.wasm + Sharp | 视频处理、缩略图、格式转换 |
| 队列 | BullMQ / PGMQ | 异步任务、优先级队列、重试机制 |

#### Layer 5 — 基础设施层（Infrastructure）

| 模块 | 技术选型 | 职责 |
|------|---------|------|
| 前端部署 | Vercel / Netlify | CI/CD、预览部署、Edge CDN |
| 后端部署 | Railway / Fly.io | Docker容器、自动扩缩容 |
| 数据库 | Supabase (PostgreSQL) | 数据持久化、认证、实时订阅 |
| 监控 | Sentry + LogRocket | 错误追踪、会话回放、性能监控 |

### 3.2 数据流设计

参见 `data-flow-pipeline.png`，核心数据流如下：

```
用户操作 → 节点创建/配置 → AI Provider Router → 具体AI服务
                                              ↓
                        队列系统(BullMQ) → 异步生成 → 结果回调
                                              ↓
                        资产存储(S3/IndexedDB) → 缩略图 → 画布渲染新节点
```

---

## 四、核心实现方案

### 4.1 项目初始化

```bash
# 1. 创建 Vite + React 项目
npm create vite@latest ai-canvas-platform -- --template react-ts
cd ai-canvas-platform

# 2. 安装核心依赖
npm install @xyflow/react zustand immer tailwindcss @tailwindcss/vite

# 3. 安装 shadcn/ui
npx shadcn@latest init

# 4. 安装 React Flow
npm install @xyflow/react

# 5. 安装 AI SDK
npm install @fal-ai/client openai @google/generative-ai

# 6. 安装工具库
npm install lodash-es uuid zod react-hotkeys-hook
npm install -D @types/lodash-es @types/uuid
```

### 4.2 画布引擎集成（React Flow）

```typescript
// Canvas.tsx - 核心画布组件
import { ReactFlow, Background, Controls, MiniMap, 
         useNodesState, useEdgesState, addEdge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { TextNode } from './nodes/TextNode';
import { ImageNode } from './nodes/ImageNode';
import { VideoNode } from './nodes/VideoNode';
import { AudioNode } from './nodes/AudioNode';
import { StoryboardNode } from './nodes/StoryboardNode';
import { AIAppNode } from './nodes/AIAppNode';

const nodeTypes = {
  text: TextNode,
  image: ImageNode,
  video: VideoNode,
  audio: AudioNode,
  storyboard: StoryboardNode,
  aiapp: AIAppNode,
};

export function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge(params, eds)),
    [setEdges],
  );

  return (
    <div className="w-full h-screen bg-[#0a0a0a]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{ type: 'smoothstep', animated: true }}
      >
        <Background color="#1a1a1a" gap={20} size={1} />
        <Controls className="bg-[#161b22] border-[#30363d]" />
        <MiniMap 
          className="bg-[#161b22] border-[#30363d]"
          nodeColor={(node) => {
            switch(node.type) {
              case 'text': return '#00d4aa';
              case 'image': return '#1a8cff';
              case 'video': return '#ff6b35';
              case 'audio': return '#a855f7';
              default: return '#8b949e';
            }
          }}
        />
      </ReactFlow>
    </div>
  );
}
```

### 4.3 自定义节点实现

```typescript
// nodes/TextNode.tsx - 文本节点（匹配设计图）
import { Handle, Position } from '@xyflow/react';

export function TextNode({ data, selected }) {
  return (
    <div className={`
      w-[320px] rounded-lg bg-[#161b22] border-2 
      ${selected ? 'border-[#00d4aa]' : 'border-[#30363d]'}
      shadow-lg transition-all
    `}>
      {/* 节点头部 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#30363d]">
        <div className="w-6 h-6 rounded bg-[#00d4aa]/20 flex items-center justify-center text-[#00d4aa] text-sm font-bold">
          T
        </div>
        <span className="text-white text-sm font-medium">Text</span>
        <span className="text-[#8b949e] text-xs ml-auto">脚本、广告词、品牌文案</span>
      </div>

      {/* 尝试选项 */}
      <div className="p-3 space-y-2">
        <div className="text-[#8b949e] text-xs mb-2">尝试:</div>
        <button className="w-full flex items-center gap-2 px-3 py-2 rounded bg-[#0d1117] hover:bg-[#1a2332] text-[#e6edf3] text-sm transition-colors">
          <EditIcon className="w-4 h-4" />
          自己编写内容
        </button>
        <button className="w-full flex items-center gap-2 px-3 py-2 rounded bg-[#0d1117] hover:bg-[#1a2332] text-[#e6edf3] text-sm transition-colors">
          <UploadIcon className="w-4 h-4" />
          上传文档解析文本
        </button>
        <button className="w-full flex items-center gap-2 px-3 py-2 rounded bg-[#0d1117] hover:bg-[#1a2332] text-[#e6edf3] text-sm transition-colors">
          <VideoIcon className="w-4 h-4" />
          文字生视频
        </button>
        <button className="w-full flex items-center gap-2 px-3 py-2 rounded bg-[#0d1117] hover:bg-[#1a2332] text-[#e6edf3] text-sm transition-colors">
          <ImageIcon className="w-4 h-4" />
          图片反推提示词
        </button>
      </div>

      {/* 连接端口 */}
      <Handle type="target" position={Position.Left} className="!bg-[#00d4aa]" />
      <Handle type="source" position={Position.Right} className="!bg-[#00d4aa]" />
    </div>
  );
}
```

### 4.4 AI生成面板（浮动底部面板）

```typescript
// AIGenerationPanel.tsx - 根据选中节点动态切换
export function AIGenerationPanel() {
  const selectedNodes = useFlowStore((s) => s.selectedNodes);
  const selectedNode = selectedNodes[0];

  if (!selectedNode) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 w-[640px] bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl z-50">
      {/* 面板头部 - 根据节点类型变化 */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[#30363d]">
        <ModelSelector nodeType={selectedNode.type} />
        <ParameterControls nodeType={selectedNode.type} />
        <PriceTag nodeType={selectedNode.type} />
        <GenerateButton nodeId={selectedNode.id} />
      </div>

      {/* 输入区域 */}
      <div className="p-3">
        <textarea 
          className="w-full bg-[#0d1117] text-[#e6edf3] rounded-lg p-3 text-sm resize-none border border-[#30363d] focus:border-[#00d4aa] focus:outline-none"
          placeholder={getPlaceholder(selectedNode.type)}
          rows={3}
        />
      </div>

      {/* 底部选项 */}
      <div className="flex items-center gap-2 px-4 py-2 border-t border-[#30363d]">
        <FormatSelector nodeType={selectedNode.type} />
        <QualitySelector />
        <AspectRatioSelector />
      </div>
    </div>
  );
}

function ModelSelector({ nodeType }) {
  const models = {
    text: [
      { id: 'gpt4o', name: '全能语言模型 G3', icon: 'OpenAI' },
      { id: 'gemini', name: 'Gemini 2.5 Pro', icon: 'Google' },
    ],
    image: [
      { id: 'flux', name: '全能图片 G2-官方稳定版', icon: 'Fal' },
      { id: 'dalle3', name: 'DALL-E 3', icon: 'OpenAI' },
    ],
    video: [
      { id: 'seedance', name: 'Seedance 2.0', icon: 'Replicate' },
      { id: 'kling', name: 'Kling Pro', icon: 'Fal' },
    ],
    audio: [
      { id: 'minimax', name: 'Minimax-Speech-2.8-Turbo', icon: 'MiniMax' },
      { id: 'elevenlabs', name: 'ElevenLabs v3', icon: 'ElevenLabs' },
    ],
  };

  return (
    <select className="bg-[#0d1117] text-[#e6edf3] text-sm rounded-lg px-3 py-1.5 border border-[#30363d]">
      {models[nodeType]?.map((m) => (
        <option key={m.id} value={m.id}>{m.name}</option>
      ))}
    </select>
  );
}
```

### 4.5 AI Provider路由系统

```typescript
// services/ai/ProviderRouter.ts
export interface AIProvider {
  name: string;
  generateText(prompt: string, options: TextOptions): Promise<string>;
  generateImage(prompt: string, options: ImageOptions): Promise<string>;
  generateVideo(prompt: string, options: VideoOptions): Promise<string>;
  generateAudio(text: string, options: AudioOptions): Promise<string>;
}

export class ProviderRouter {
  private providers: Map<string, AIProvider> = new Map();
  private fallbackChain: string[] = ['fal', 'replicate', 'openai', 'google'];

  register(name: string, provider: AIProvider) {
    this.providers.set(name, provider);
  }

  async generate(type: 'text' | 'image' | 'video' | 'audio', prompt: string, options: any) {
    for (const providerName of this.fallbackChain) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      try {
        const result = await this.executeWithTimeout(
          () => provider[`generate${type.charAt(0).toUpperCase() + type.slice(1)}`](prompt, options),
          30000 // 30s timeout
        );
        return { success: true, provider: providerName, result };
      } catch (error) {
        console.warn(`Provider ${providerName} failed:`, error);
        continue;
      }
    }
    throw new Error('All AI providers failed');
  }

  private async executeWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<T>((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), ms)
      ),
    ]);
  }
}

// 具体Provider实现示例（Fal.ai图片生成）
export class FalProvider implements AIProvider {
  constructor(private apiKey: string) {}

  async generateImage(prompt: string, options: ImageOptions): Promise<string> {
    const result = await fetch('https://fal.run/fal-ai/flux-pro', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        image_size: options.aspectRatio || 'landscape_4_3',
        num_images: 1,
      }),
    });
    const data = await result.json();
    return data.images[0].url;
  }
}
```

### 4.6 状态管理（Zustand）

```typescript
// stores/useCanvasStore.ts
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

interface CanvasState {
  // 画布状态
  nodes: Node[];
  edges: Edge[];
  selectedNodes: string[];
  viewport: { x: number; y: number; zoom: number };

  // 历史记录（用于撤销重做）
  history: HistoryEntry[];
  historyIndex: number;

  // 操作
  addNode: (type: string, position: { x: number; y: number }) => void;
  updateNodeData: (id: string, data: any) => void;
  removeNode: (id: string) => void;
  connectNodes: (source: string, target: string) => void;
  setSelected: (ids: string[]) => void;
  undo: () => void;
  redo: () => void;

  // AI生成状态
  generatingNodes: Set<string>;
  setGenerating: (nodeId: string, isGenerating: boolean) => void;
}

export const useCanvasStore = create<CanvasState>()(
  immer((set, get) => ({
    nodes: [],
    edges: [],
    selectedNodes: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    history: [],
    historyIndex: -1,
    generatingNodes: new Set(),

    addNode: (type, position) => {
      set((state) => {
        const newNode = createDefaultNode(type, position);
        state.nodes.push(newNode);
        state.history.push({ type: 'add', node: newNode });
        state.historyIndex++;
      });
    },

    undo: () => {
      set((state) => {
        if (state.historyIndex < 0) return;
        const entry = state.history[state.historyIndex];
        if (entry.type === 'add') {
          state.nodes = state.nodes.filter((n) => n.id !== entry.node.id);
        }
        state.historyIndex--;
      });
    },

    setGenerating: (nodeId, isGenerating) => {
      set((state) => {
        if (isGenerating) {
          state.generatingNodes.add(nodeId);
        } else {
          state.generatingNodes.delete(nodeId);
        }
      });
    },
  }))
);
```

---

## 五、实施路线图

### 5.1 阶段规划（12周）

```
Phase 1: 基础架构（Week 1-3）
├── Week 1: 项目初始化 + React Flow集成 + 基础画布
├── Week 2: 自定义节点系统（Text/Image/Video/Audio）
└── Week 3: 拖拽添加 + 连线系统 + 左侧边栏

Phase 2: AI集成（Week 4-6）
├── Week 4: AI Provider路由 + Fal.ai图片生成集成
├── Week 5: 视频生成(Seedance) + 音频生成(MiniMax)
└── Week 6: 文本生成(GPT/Gemini) + 生成面板UI

Phase 3: 高级功能（Week 7-9）
├── Week 7: 顶部工具栏 + 视频处理(ffmpeg.wasm)
├── Week 8: 音频分离 + 帧提取 + 高清处理
└── Week 9: 导入导出 + 历史记录 + 撤销重做

Phase 4: 优化上线（Week 10-12）
├── Week 10: 性能优化 + 大数据量测试
├── Week 11: 部署配置 + CI/CD + 监控
└── Week 12: Bug修复 + 文档 + 正式上线
```

### 5.2 关键里程碑

| 里程碑 | 时间 | 验收标准 |
|--------|------|---------|
| M1 - 基础画布 | Week 2 | 可拖拽创建节点、无限画布、基本连线 |
| M2 - AI生成 | Week 6 | 四种节点均可触发AI生成并展示结果 |
| M3 - 完整功能 | Week 9 | 顶部工具栏全部功能可用 |
| M4 - 上线 | Week 12 | 生产环境部署、监控就绪 |

---

## 六、关键开源项目参考

| 项目 | 用途 | 链接 |
|------|------|------|
| @xyflow/react | 画布引擎 | https://github.com/xyflow/xyflow |
| Loomic | 架构参考 | https://github.com/fancyboi999/Loomic |
| Infinite-Canvas-AI-Omnigen | 轻量参考 | https://github.com/SparkSylva/Infinite-Canvas-AI-Omnigen |
| tldraw | 画布SDK | https://github.com/tldraw/tldraw |
| fal-ai | AI API | https://github.com/fal-ai/fal-js |
| ffmpeg.wasm | 视频处理 | https://github.com/ffmpegwasm/ffmpeg.wasm |
| shadcn/ui | UI组件 | https://github.com/shadcn-ui/ui |
| zustand | 状态管理 | https://github.com/pmndrs/zustand |

---

## 七、文件说明

| 文件 | 说明 |
|------|------|
| `tech-architecture.png` | 五层技术架构图 |
| `solution-comparison.png` | 6个开源方案对比 |
| `data-flow-pipeline.png` | 节点数据流与AI生成管线 |
| `README.md` | 完整技术方案文档 |

---

*本文档基于2024-2025年最新开源生态调研，所有推荐方案均为活跃维护项目。*
