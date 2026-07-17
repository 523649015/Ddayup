# 代码生成规范 — HMDAODAO

## 质量要求
- 每次生成代码前，先检查项目中现有代码风格和命名约定，保持完全一致
- 优先使用项目已存在的工具函数和类，避免重复造轮子
  - 合并类名：`import { cn } from '@/lib/utils'`（clsx + twMerge）
  - 安全请求：`import { safeFetch } from '@/engine/safe-fetch'`
- 所有函数必须包含错误处理，禁止静默吞掉异常
- 变量命名必须具有语义化，禁止单字母命名（循环变量 `i`、`j`、`k` 除外）

## 项目核心技术栈
- **框架**: React 19 + TypeScript 5.9（strict 模式）
- **构建**: Vite 7，路径别名 `@/` → `src/`
- **样式**: Tailwind CSS 3.4 + shadcn/ui (New York 风格)
- **状态管理**: Zustand + immer 中间件
- **画布**: @xyflow/react (React Flow)
- **表单**: react-hook-form + zod 校验
- **图标**: lucide-react

## 代码风格约定

### 命名
| 类别 | 规范 | 示例 |
|------|------|------|
| 组件文件 | PascalCase | `CanvasBoard.tsx` |
| 工具/服务文件 | camelCase 或 kebab-case | `useCanvasStore.ts`, `safe-fetch.ts` |
| Store | `use[Name]Store` | `useCanvasStore`, `useAuthStore` |
| 类型/接口 | PascalCase | `CanvasNode`, `NodeData` |
| 函数/变量 | camelCase | `addNode`, `handleSubmit` |
| 常量 | UPPER_SNAKE_CASE | `DEFAULT_NODE_DATA` |

### 导入顺序
```typescript
// 1. React 核心
import { useCallback, useEffect, useState } from 'react';

// 2. 第三方库
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// 3. @/ 路径别名
import { nodeTypes } from '@/nodes';
import { useCanvasStore } from '@/store/useCanvasStore';
import type { CanvasNode, NodeType } from '@/types';

// 4. 相对路径
import { Toolbar } from './Toolbar';
```

### 组件规范
- 使用函数组件 + TypeScript，禁止 class 组件
- Props 通过泛型参数传递类型
- 使用 `useCallback` / `useMemo` 优化性能
- shadcn/ui 组件使用 `cn()` 合并类名，遵循 cva 变体模式
- 大组件拆分为子组件，保持单一职责

### 状态管理
- 使用 Zustand + immer 中间件：`create<T>()(immer((set, get) => ({...})))`
- Store 文件放在 `src/store/`，命名 `useXxxStore.ts`
- 不可直接修改状态，必须通过 set 操作

### TypeScript
- 已启用 `strict: true`、`noUnusedLocals`、`noUnusedParameters`
- 类型导入使用 `import type`（`verbatimModuleSyntax: true`）
- 禁止使用 `any`，必要时用 `unknown` + 类型守卫
- 启用 `erasableSyntaxOnly: true`，禁止仅用作类型的 enum/namespace

## 代码精炼原则
- 遵循 DRY 原则，发现重复逻辑立即提取为公共函数或 hook
- 优先使用标准库和现有依赖（见 package.json），不引入新依赖除非必要
- 删除死代码和未使用的导入，保持文件整洁
- 复杂逻辑必须添加注释说明"为什么"，而非"做什么"
- 中文注释为主，分区使用 `// ===== Section =====`

## 错误防护
- 所有异步操作必须带 try/catch 或 .catch()
- 用户输入和外部接口返回值必须做校验（优先使用 zod schema）
- 敏感操作必须有确认机制或幂等设计
- 禁止使用 `any` / `as` 强制类型断言弱化类型安全
- API 调用使用 `safeFetch` 包装器（已内置重试/超时/错误分类）

## 输出格式
- 只输出修改后的代码块，用 diff 格式标注变更位置
- 如果涉及多文件，按文件路径分组输出
- 每个代码块后简要说明修改原因和潜在风险
- 保持原有缩进（2空格）和换行风格
