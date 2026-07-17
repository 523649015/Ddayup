import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export interface BrushEditCanvasProps {
  imageUrl: string;
  onApply: (payload: { mask: string; imageUrl: string }) => void;
  onCancel: () => void;
  /** 画布内部分辨率，默认 512 */
  resolution?: number;
  containerTestId?: string;
}

/**
 * 局部编辑笔刷画布：在源图上叠加可涂抹的蒙版层。
 * - 涂抹模式：白色画笔标记待修复区域
 * - 擦除模式：destination-out 擦除蒙版
 * 应用后把蒙版导出为 dataURL 交给路由层处理。
 */
export function BrushEditCanvas({
  imageUrl,
  onApply,
  onCancel,
  resolution = 512,
  containerTestId,
}: BrushEditCanvasProps) {
  const maskRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const [mode, setMode] = useState<'paint' | 'erase'>('paint');
  const [brushSize, setBrushSize] = useState(36);

  const getCtx = useCallback(() => maskRef.current?.getContext('2d') ?? null, []);

  const applyAt = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = maskRef.current;
      if (!canvas) return;
      const ctx = getCtx();
      if (!ctx) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = (clientX - rect.left) * scaleX;
      const y = (clientY - rect.top) * scaleY;
      ctx.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';
      ctx.fillStyle = 'rgba(255,255,255,1)';
      ctx.beginPath();
      ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
      ctx.fill();
    },
    [brushSize, getCtx, mode],
  );

  const handleDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    drawingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    applyAt(event.clientX, event.clientY);
  };

  const handleMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    applyAt(event.clientX, event.clientY);
  };

  const handleUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleApply = () => {
    let mask = '';
    try {
      mask = maskRef.current?.toDataURL('image/png') ?? '';
    } catch {
      mask = '';
    }
    if (!mask) return;
    onApply({ mask, imageUrl });
  };

  return (
    <div data-testid={containerTestId} className="flex h-full w-full flex-col gap-3">
      <div className="relative flex-1 overflow-hidden rounded-lg bg-[#0b0b0b]" style={{ aspectRatio: '1 / 1' }}>
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-contain"
        />
        <canvas
          ref={maskRef}
          width={resolution}
          height={resolution}
          data-testid="brush-mask-canvas"
          className="absolute inset-0 h-full w-full cursor-crosshair touch-none [mix-blend-mode:screen]"
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
          onPointerCancel={handleUp}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="brush-mode-paint"
          onClick={() => setMode('paint')}
          className={`rounded-md px-3 py-1.5 text-xs font-medium ${
            mode === 'paint' ? 'bg-[#2f6df6] text-white' : 'bg-[#2a2a2a] text-[#cfcfcf]'
          }`}
        >
          涂抹
        </button>
        <button
          type="button"
          data-testid="brush-mode-erase"
          onClick={() => setMode('erase')}
          className={`rounded-md px-3 py-1.5 text-xs font-medium ${
            mode === 'erase' ? 'bg-[#2f6df6] text-white' : 'bg-[#2a2a2a] text-[#cfcfcf]'
          }`}
        >
          擦除
        </button>
        <label className="flex items-center gap-1.5 text-xs text-[#bdbdbd]">
          笔刷
          <input
            type="range"
            min={6}
            max={120}
            value={brushSize}
            data-testid="brush-size"
            onChange={(event) => setBrushSize(Number(event.target.value))}
            className="w-24"
          />
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            data-testid="brush-cancel"
            onClick={onCancel}
            className="rounded-md bg-[#2a2a2a] px-3 py-1.5 text-xs text-[#cfcfcf] hover:bg-[#343434]"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="brush-apply"
            onClick={handleApply}
            className="rounded-md bg-[#2f6df6] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#3f7df8]"
          >
            应用
          </button>
        </div>
      </div>
    </div>
  );
}
