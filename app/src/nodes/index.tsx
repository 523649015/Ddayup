import { Suspense, type ComponentType } from 'react';
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

function withErrorBoundary<P extends NodeProps>(Component: ComponentType<P>, typeName: string): ComponentType<P> {
  return function WrappedNode(props: P) {
    return (
      <NodeErrorBoundary nodeId={props.id} onReset={() => console.log(`[${typeName}] Reset node ${props.id}`)}>
        <Suspense fallback={<NodeLoadingFallback nodeId={props.id} />}>
          <Component {...props} />
        </Suspense>
      </NodeErrorBoundary>
    );
  };
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
