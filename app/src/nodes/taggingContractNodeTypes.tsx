import { memo, type ComponentType } from 'react';
import { type NodeProps } from '@xyflow/react';
import { NodeErrorBoundary } from '@/components/NodeErrorBoundary';
import { ImageNode } from '@/nodes/ImageNode';
import { VideoNode } from '@/nodes/VideoNode';
import { DCCCaptureNode } from '@/nodes/DCCCaptureNode';
import { RegionContractNode } from '@/nodes/RegionContractNode';

function NodeLoadingFallback({ nodeId }: { nodeId: string }) {
  return (
    <div
      data-testid={`node-lazy-loading-${nodeId}`}
      className="min-h-[160px] min-w-[220px] rounded-[24px] border border-white/10 bg-[#141414] px-4 py-4 text-sm text-[#b8b8b8] shadow-[0_18px_48px_rgba(0,0,0,0.28)]"
    >
      正在载入验证节点...
    </div>
  );
}

// 拖拽时 positionAbsolute（对象）/positionAbsoluteX/Y 每帧变化，节点内部渲染不依赖这些位置
// props（定位由 ReactFlow wrapper transform 处理），忽略它们可避免重型节点组件每帧重渲染
// （详见 nodes/index.tsx 的同名比较器；positionAbsolute 是每帧新建对象，引用比较必不相等）。
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
        <Component {...props} />
      </NodeErrorBoundary>
    );
  }, nodePropsAreEqual);
  WrappedNode.displayName = `ContractNode(${typeName})`;
  return WrappedNode;
}


export const taggingContractNodeTypes = {
  image: withErrorBoundary(ImageNode as ComponentType<NodeProps>, 'ImageNode'),
  video: withErrorBoundary(VideoNode as ComponentType<NodeProps>, 'VideoNode'),
  dcc: withErrorBoundary(DCCCaptureNode as ComponentType<NodeProps>, 'DCCCaptureNode'),
  region: withErrorBoundary(RegionContractNode as ComponentType<NodeProps>, 'RegionContractNode'),
};
