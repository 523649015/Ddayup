import { memo, Suspense, type ComponentType } from 'react';
import { type NodeProps } from '@xyflow/react';
import { NodeErrorBoundary } from '@/components/NodeErrorBoundary';
import { lazyNodeComponents } from './lazyLoad';

function NodeLoadingFallback({ nodeId }: { nodeId: string }) {
  return (
    <div
      data-testid={`node-lazy-loading-${nodeId}`}
      className="min-h-[160px] min-w-[220px] rounded-[24px] border border-white/10 bg-[#141414] px-4 py-4 text-sm text-[#b8b8b8] shadow-[0_18px_48px_rgba(0,0,0,0.28)]"
    >
      正在加载节点面板...
    </div>
  );
}

// 拖拽节点时 ReactFlow 每帧更新 positionAbsolute（对象）/positionAbsoluteX/Y 并传入节点组件。
// 节点内部渲染不依赖这些位置 props——定位由 ReactFlow 的 wrapper transform 处理，视频预览等
// 内容更不应每帧重建。若浅比较包含它们，任一节点每帧都会重渲染（positionAbsolute 是每帧新建
// 的对象，引用永远不同），这就是「只有几个节点也卡」的真正根因。自定义比较器忽略全部位置字段，
// 使拖拽期间节点内部组件保持静止，只由 wrapper 移动。这是 ReactFlow 官方推荐的拖拽性能优化。
const NODE_POSITION_PROP_KEYS = new Set(['positionAbsolute', 'positionAbsoluteX', 'positionAbsoluteY']);

function nodePropsAreEqual<P extends NodeProps>(prev: Readonly<P>, next: Readonly<P>): boolean {
  const prevKeys = Object.keys(prev) as Array<keyof P>;
  const nextKeys = Object.keys(next) as Array<keyof P>;
  if (prevKeys.length !== nextKeys.length) return false;
  for (const key of nextKeys) {
    if (NODE_POSITION_PROP_KEYS.has(key as string)) continue;
    if (prev[key] !== next[key]) return false;
  }
  return true;
}

function withErrorBoundary<P extends NodeProps>(Component: ComponentType<P>, typeName: string): ComponentType<P> {
  const WrappedNode = memo(function WrappedNodeImpl(props: P) {
    return (
      <NodeErrorBoundary nodeId={props.id} onReset={() => console.log(`[${typeName}] Reset node ${props.id}`)}>
        <Suspense fallback={<NodeLoadingFallback nodeId={props.id} />}>
          <Component {...props} />
        </Suspense>
      </NodeErrorBoundary>
    );
  }, nodePropsAreEqual);
  WrappedNode.displayName = `Node(${typeName})`;
  return WrappedNode;
}

export const nodeTypes = {
  text: withErrorBoundary(lazyNodeComponents.text as ComponentType<NodeProps>, 'TextNode'),
  image: withErrorBoundary(lazyNodeComponents.image as ComponentType<NodeProps>, 'ImageNode'),
  video: withErrorBoundary(lazyNodeComponents.video as ComponentType<NodeProps>, 'VideoNode'),
  audio: withErrorBoundary(lazyNodeComponents.audio as ComponentType<NodeProps>, 'AudioNode'),
  post: withErrorBoundary(lazyNodeComponents.post as ComponentType<NodeProps>, 'PostNode'),
  storyboard: withErrorBoundary(lazyNodeComponents.storyboard as ComponentType<NodeProps>, 'StoryboardNode'),
  aiapp: withErrorBoundary(lazyNodeComponents.aiapp as ComponentType<NodeProps>, 'AIAppNode'),
  script: withErrorBoundary(lazyNodeComponents.script as ComponentType<NodeProps>, 'ScriptNode'),
  threed: withErrorBoundary(lazyNodeComponents.threed as ComponentType<NodeProps>, 'ThreeDNode'),
  dcc: withErrorBoundary(lazyNodeComponents.dcc as ComponentType<NodeProps>, 'DCCCaptureNode'),
  region: withErrorBoundary(lazyNodeComponents.region as ComponentType<NodeProps>, 'RegionContractNode'),
};
