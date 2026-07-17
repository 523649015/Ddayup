import type { CSSProperties, ReactNode } from 'react';
import { toRenderableAssetUrl } from '@/services/generation';

interface InteractiveImageStageProps {
  sourceImageUrl?: string;
  children?: ReactNode;
  imageStyle?: CSSProperties;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerLeave?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onWheel?: (event: React.WheelEvent<HTMLDivElement>) => void;
}

export function InteractiveImageStage({
  sourceImageUrl,
  children,
  imageStyle,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerLeave,
  onWheel,
}: InteractiveImageStageProps) {
  const url = toRenderableAssetUrl(sourceImageUrl || '', 'image');
  return (
    <div
      className="nodrag nopan nowheel relative w-full overflow-hidden rounded-xl border border-[#555] bg-[#0c0c0c]"
      style={{ touchAction: 'none', aspectRatio: '4 / 3', cursor: onPointerDown ? 'grab' : 'default' }}
      data-testid="interactive-image-stage"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onWheel={onWheel}
    >
      {url ? (
        <img
          src={url}
          alt=""
          className="absolute inset-0 h-full w-full select-none object-contain"
          style={imageStyle}
          draggable={false}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-center text-sm text-[#b7c2c8]">
          <div>
            <div className="font-medium text-white">预览台</div>
            <div className="mt-1 text-xs text-[#9aa6ad]">选择素材图后可直接在图上拖拽调整</div>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
