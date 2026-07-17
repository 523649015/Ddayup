import { type ComponentType } from 'react';
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

function withErrorBoundary<P extends NodeProps>(Component: ComponentType<P>, typeName: string): ComponentType<P> {
  return function WrappedNode(props: P) {
    return (
      <NodeErrorBoundary nodeId={props.id} onReset={() => console.log(`[${typeName}] Reset node ${props.id}`)}>
        <Component {...props} />
      </NodeErrorBoundary>
    );
  };
}


export const taggingContractNodeTypes = {
  image: withErrorBoundary(ImageNode as ComponentType<NodeProps>, 'ImageNode'),
  video: withErrorBoundary(VideoNode as ComponentType<NodeProps>, 'VideoNode'),
  dcc: withErrorBoundary(DCCCaptureNode as ComponentType<NodeProps>, 'DCCCaptureNode'),
  region: withErrorBoundary(RegionContractNode as ComponentType<NodeProps>, 'RegionContractNode'),
};
