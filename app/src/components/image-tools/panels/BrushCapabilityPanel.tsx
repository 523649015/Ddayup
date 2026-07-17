import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ToolCapabilityPanelProps } from './capabilityPanelTypes';

/**
 * 局部编辑 CapabilityPanel：在独立面板中承载 BrushEditCanvas。
 * 保持与 BrushEditCanvas 相同的核心交互，但嵌入 CapabilityPanel 的样式语境。
 */
export default function BrushCapabilityPanel({ sourceImageUrl, onApply, onClose }: ToolCapabilityPanelProps) {
  const maskRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const [mode, setMode] = useState<'paint' | 'erase'>('paint');
  const [brushSize, setBrushSize] = useState(36);
  const [status, setStatus] = useState<string | null>(null);

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

  const handleApply = async () => {
    let mask = '';
    try {
      mask = maskRef.current?.toDataURL('image/png') ?? '';
    } catch {
      mask = '';
    }
    if (!mask) {
      setStatus('请先涂抹需要编辑的区域');
      return;
    }
    if (!sourceImageUrl) {
      setStatus('源图缺失');
      return;
    }
    setStatus('处理中…');
    try {
      await onApply?.({ mask, imageUrl: sourceImageUrl });
      setStatus(null);
    } catch {
      setStatus('应用失败');
    }
  };

  const handleClear = () => {
    const ctx = getCtx();
    if (!ctx || !maskRef.current) return;
    ctx.clearRect(0, 0, maskRef.current.width, maskRef.current.height);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="relative flex-1 overflow-hidden rounded-lg bg-[#0b0b0b]" style={{ aspectRatio: '1 / 1' }}>
        <img src={sourceImageUrl || ''} alt="" draggable={false} className="absolute inset-0 h-full w-full object-contain" />
        <canvas
          ref={maskRef}
          width={512}
          height={512}
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
          className={`rounded-md px-3 py-1.5 text-xs font-medium ${mode === 'paint' ? 'bg-[#2f6df6] text-white' : 'bg-[#2a2a2a] text-[#cfcfcf]'}`}
        >
          涂抹
        </button>
        <button
          type="button"
          data-testid="brush-mode-erase"
          onClick={() => setMode('erase')}
          className={`rounded-md px-3 py-1.5 text-xs font-medium ${mode === 'erase' ? 'bg-[#2f6df6] text-white' : 'bg-[#2a2a2a] text-[#cfcfcf]'}`}
        >
          擦除
        </button>
        <button
          type="button"
          data-testid="brush-clear"
          onClick={handleClear}
          className="rounded-md bg-[#2a2a2a] px-3 py-1.5 text-xs text-[#cfcfcf] hover:bg-[#343434]"
        >
          清空
        </button>
        <label className="flex items-center gap-1.5 text-xs text-[#bdbdbd]">
          <input
            type="range"
            min={6}
            max={120}
            value={brushSize}
            data-testid="brush-size"
            onChange={(event) => setBrushSize(Number(event.target.value))}
            className="nodrag nopan nowheel w-24"
          />
          {brushSize}px
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            data-testid="brush-cancel"
            onClick={onClose}
            className="rounded-md bg-[#2a2a2a] px-3 py-1.5 text-xs text-[#cfcfcf] hover:bg-[#343434]"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="brush-apply"
            onClick={() => void handleApply()}
            className="rounded-md bg-[#2f6df6] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#3f7df8]"
          >
            应用
          </button>
        </div>
      </div>

      {status ? <div data-testid="brush-status" className="rounded-lg bg-[#1a1a1a] px-3 py-2 text-xs text-[#b4b4b4]">{status}</div> : null}
    </div>
  );
}
