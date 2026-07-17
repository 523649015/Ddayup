import { Suspense, lazy } from 'react';
import { X } from 'lucide-react';
import { getImageToolSchema } from '@/config/imageToolSchemas';
import type { ImageGenerationTool } from '@/config/imageToolPresets';
import type { GuardedPanelInteractionProps } from '@/hooks/useGuardedFloatingPanelInteraction';

const ImageToolConfigForm = lazy(async () => ({
  default: (await import('@/components/image-tools/ImageToolConfigForm')).ImageToolConfigForm,
}));

const PanoramaCapabilityPanel = lazy(() => import('@/components/image-tools/panels/PanoramaCapabilityPanel'));
const MultiAngleCapabilityPanel = lazy(() => import('@/components/image-tools/panels/MultiAngleCapabilityPanel'));
const CameraCapabilityPanel = lazy(() => import('@/components/image-tools/panels/CameraCapabilityPanel'));
const LightingCapabilityPanel = lazy(() => import('@/components/image-tools/panels/LightingCapabilityPanel'));
const GridCapabilityPanel = lazy(() => import('@/components/image-tools/panels/GridCapabilityPanel'));
const HdCapabilityPanel = lazy(() => import('@/components/image-tools/panels/HdCapabilityPanel'));
const SplitCapabilityPanel = lazy(() => import('@/components/image-tools/panels/SplitCapabilityPanel'));
const BrushCapabilityPanel = lazy(() => import('@/components/image-tools/panels/BrushCapabilityPanel'));
const BgRemoveCapabilityPanel = lazy(() => import('@/components/image-tools/panels/BgRemoveCapabilityPanel'));

type PanelTool = ImageGenerationTool | 'brush' | 'bgRemove';

interface ImageToolPanelHostProps {
  tool: PanelTool;
  value: Record<string, unknown>;
  sourceImageUrl?: string;
  nodeLabel?: string;
  onChange: (value: Record<string, unknown>) => void;
  onApply?: (payload: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
  panelInteractionProps?: GuardedPanelInteractionProps;
  onInteract?: (event: { stopPropagation: () => void }) => void;
}

const REAL_PANEL_TOOLS = new Set<PanelTool>(['panorama', 'multiAngle', 'lighting', 'grid', 'split', 'camera', 'hd', 'brush', 'bgRemove']);

const FALLBACK_TITLES: Record<string, string> = {
  brush: '局部编辑',
  bgRemove: '智能去背',
};

function stopCanvasEvent(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

export function ImageToolPanelHost({
  tool,
  value,
  sourceImageUrl,
  nodeLabel,
  onChange,
  onApply,
  onClose,
  panelInteractionProps,
  onInteract,
}: ImageToolPanelHostProps) {
  const definition = getImageToolSchema(tool);
  const isCustomPanel = REAL_PANEL_TOOLS.has(tool);
  const showGenericForm = !isCustomPanel;

  const title = definition?.title || FALLBACK_TITLES[tool] || '';

  return (
    <div
      data-testid={`image-tool-panel-${tool}`}
      className="nodrag nopan nowheel z-40 w-[460px] shrink-0 self-start overflow-hidden rounded-2xl border border-[#424242] bg-[#1f1f1f] shadow-2xl"
      {...panelInteractionProps}
      onPointerDown={panelInteractionProps?.onPointerDown || onInteract || stopCanvasEvent}
      onMouseDown={panelInteractionProps?.onMouseDown || onInteract || stopCanvasEvent}
      onTouchStart={panelInteractionProps?.onTouchStart || onInteract || stopCanvasEvent}
      onWheel={panelInteractionProps?.onWheel || onInteract || stopCanvasEvent}
    >
      <div className="flex items-center justify-between gap-4 border-b border-[#343434] px-4 py-3">
        <div className="text-sm font-semibold text-[#f3f3f3]">{title}</div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-[#b9b9b9] hover:bg-[#313131] hover:text-white"
          title="\u5173\u95ed"
          data-testid={`image-tool-panel-close-${tool}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="max-h-[520px] overflow-y-auto px-4 py-4">
        <Suspense fallback={<PanelSkeleton />}>
          {renderCapabilityPanel(tool, value, onChange, sourceImageUrl, nodeLabel, onApply, onClose)}
        </Suspense>
        {showGenericForm && definition ? (
          <Suspense fallback={<PanelSkeleton />}>
            <ImageToolConfigForm definition={definition} value={value} onChange={onChange} />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}

function renderCapabilityPanel(
  tool: PanelTool,
  value: Record<string, unknown>,
  onChange: (value: Record<string, unknown>) => void,
  sourceImageUrl?: string,
  nodeLabel?: string,
  onApply?: (payload: Record<string, unknown>) => Promise<void>,
  onClose?: () => void,
) {
  if (tool === 'panorama') return <PanoramaCapabilityPanel tool={tool} value={value} onChange={onChange} sourceImageUrl={sourceImageUrl} nodeLabel={nodeLabel} />;
  if (tool === 'multiAngle') return <MultiAngleCapabilityPanel tool={tool} value={value} onChange={onChange} sourceImageUrl={sourceImageUrl} nodeLabel={nodeLabel} />;
  if (tool === 'camera') return <CameraCapabilityPanel tool={tool} value={value} onChange={onChange} sourceImageUrl={sourceImageUrl} nodeLabel={nodeLabel} />;
  if (tool === 'lighting') return <LightingCapabilityPanel tool={tool} value={value} onChange={onChange} sourceImageUrl={sourceImageUrl} nodeLabel={nodeLabel} />;
  if (tool === 'grid') return <GridCapabilityPanel tool={tool} value={value} onChange={onChange} sourceImageUrl={sourceImageUrl} nodeLabel={nodeLabel} />;
  if (tool === 'hd') return <HdCapabilityPanel tool={tool} value={value} onChange={onChange} sourceImageUrl={sourceImageUrl} nodeLabel={nodeLabel} />;
  if (tool === 'split') return <SplitCapabilityPanel tool={tool} value={value} onChange={onChange} sourceImageUrl={sourceImageUrl} nodeLabel={nodeLabel} />;
  if (tool === 'brush') return <BrushCapabilityPanel tool={tool} value={value} onChange={onChange} sourceImageUrl={sourceImageUrl} nodeLabel={nodeLabel} onApply={onApply} onClose={onClose} />;
  if (tool === 'bgRemove') return <BgRemoveCapabilityPanel tool={tool} value={value} onChange={onChange} sourceImageUrl={sourceImageUrl} nodeLabel={nodeLabel} onApply={onApply} onClose={onClose} />;
  return null;
}

function PanelSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="space-y-2">
          <div className="h-4 w-24 rounded bg-[#313131]" />
          <div className="h-9 w-full rounded-lg bg-[#2a2a2a]" />
        </div>
      ))}
    </div>
  );
}
