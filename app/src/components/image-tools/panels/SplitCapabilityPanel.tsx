import { Grid3x3, Scissors } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { exportSplitZip } from '@/lib/imageToolExports';
import { splitImageToLibrary } from '@/services/imageTiling';
import type { ToolCapabilityPanelProps } from './capabilityPanelTypes';

const GRID_PRESETS = [
  { rows: 2, cols: 2, label: '4 宫格' },
  { rows: 3, cols: 3, label: '9 宫格' },
  { rows: 4, cols: 4, label: '16 宫格' },
  { rows: 5, cols: 5, label: '25 宫格' },
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value: unknown, fallback: number) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export default function SplitCapabilityPanel({ value, onChange, sourceImageUrl }: ToolCapabilityPanelProps) {
  const rows = clamp(Math.round(safeNumber(value.rows, 3)), 1, 10);
  const cols = clamp(Math.round(safeNumber(value.cols, 3)), 1, 10);
  const mode = String(value.mode || 'subject_aware');
  const avoidFaces = Boolean(value.avoidFaces ?? true);
  const exportZip = Boolean(value.exportZip ?? true);
  const safeMargin = clamp(safeNumber(value.safeMargin, 0.04), 0, 0.12);
  const namingPattern = String(value.namingPattern ?? 'tile-r{row}-c{col}');
  const subjectAware = mode === 'subject_aware';
  const previewRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [libraryStatus, setLibraryStatus] = useState<string | null>(null);

  function updateValue(next: Record<string, unknown>) {
    onChange({ ...value, ...next });
  }

  async function handleSplitToLibrary() {
    if (typeof sourceImageUrl !== 'string' || !sourceImageUrl) {
      setLibraryStatus('请先上传或选择切分源图');
      return;
    }
    try {
      const { count } = await splitImageToLibrary({
        sourceImageUrl,
        rows,
        cols,
        folderId: 'img-grid',
      });
      setLibraryStatus(`已入库 ${count} 张到「宫格切分」`);
    } catch (err) {
      setLibraryStatus('切分入库失败：' + (err instanceof Error ? err.message : String(err)));
    }
  }

  function updateFromPointer(clientX: number, clientY: number) {
    const rect = previewRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    const relativeX = clamp((clientX - rect.left) / rect.width, 0.001, 0.999);
    const relativeY = clamp((clientY - rect.top) / rect.height, 0.001, 0.999);
    const nextCols = clamp(Math.round(relativeX * 10), 1, 10);
    const nextRows = clamp(Math.round(relativeY * 10), 1, 10);
    updateValue({ cols: nextCols, rows: nextRows });
  }

  useEffect(() => {
    if (!dragging) return undefined;

    const handleMove = (event: MouseEvent | PointerEvent) => {
      if (!draggingRef.current) return;
      event.preventDefault();
      updateFromPointer(event.clientX, event.clientY);
    };

    const handleUp = () => {
      draggingRef.current = false;
      setDragging(false);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('mouseup', handleUp);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [dragging]);

  async function runZipExport() {
    await exportSplitZip(`split-${rows}x${cols}.zip`, rows, cols, {
      subjectAware,
      avoidFaces,
      safeMargin,
      namingPattern,
      sourceImageUrl: typeof sourceImageUrl === 'string' ? sourceImageUrl : undefined,
    });
    updateValue({
      lastExportAt: Date.now(),
      exportZip: true,
      exportedRows: rows,
      exportedCols: cols,
    });
  }

  return (
    <div className="mb-4 rounded-xl border border-[#353535] bg-[#242424] p-3">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-[#ededed]"><Grid3x3 className="h-4 w-4" />宫格切分</div>

      <div className="mb-3 grid grid-cols-4 gap-2 text-xs">
        {GRID_PRESETS.map((preset) => {
          const active = preset.rows === rows && preset.cols === cols;
          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => updateValue({ rows: preset.rows, cols: preset.cols })}
              className={`rounded-lg border px-3 py-2 ${active ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div
        ref={previewRef}
        data-testid="split-preview-surface"
        className="nodrag nopan nowheel relative aspect-square rounded-lg bg-[#2b2b2b] p-2"
        style={{ touchAction: 'none', cursor: 'crosshair' }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          draggingRef.current = true;
          setDragging(true);
          event.currentTarget.setPointerCapture?.(event.pointerId);
          updateFromPointer(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current) return;
          event.preventDefault();
          event.stopPropagation();
          updateFromPointer(event.clientX, event.clientY);
        }}
        onPointerUp={() => {
          draggingRef.current = false;
          setDragging(false);
        }}
        onPointerLeave={() => {
          draggingRef.current = false;
          setDragging(false);
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          draggingRef.current = true;
          setDragging(true);
          updateFromPointer(event.clientX, event.clientY);
        }}
        onMouseMove={(event) => {
          if (!draggingRef.current) return;
          event.preventDefault();
          event.stopPropagation();
          updateFromPointer(event.clientX, event.clientY);
        }}
        onMouseUp={() => {
          draggingRef.current = false;
          setDragging(false);
        }}
      >
        <div
          className="absolute inset-2 rounded-md border border-dashed border-[#565656]"
          style={{
            backgroundImage: typeof sourceImageUrl === 'string'
              ? `linear-gradient(rgba(10,10,10,0.18), rgba(10,10,10,0.18)), url(${sourceImageUrl})`
              : 'linear-gradient(to right, rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.06) 1px, transparent 1px)',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            backgroundSize: typeof sourceImageUrl === 'string'
              ? 'cover, cover'
              : `${100 / Math.max(1, cols)}% ${100 / Math.max(1, rows)}%`,
          }}
        />
        <div
          className="pointer-events-none absolute inset-2 rounded-md"
          style={{
            backgroundImage: 'linear-gradient(to right, rgba(255,255,255,0.14) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.14) 1px, transparent 1px)',
            backgroundSize: `${100 / Math.max(1, cols)}% ${100 / Math.max(1, rows)}%`,
          }}
        />
        {subjectAware ? (
          <div
            className="pointer-events-none absolute inset-[12%] rounded-[28%] border border-emerald-300/70"
            style={{ boxShadow: `0 0 0 ${Math.max(6, safeMargin * 120)}px rgba(16,185,129,0.08)` }}
          />
        ) : null}
        <div className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-[11px] text-[#bcbcbc]">
          拖拽预览面板可直接写回行列 {rows} x {cols}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between rounded-lg border border-[#404040] bg-[#1c1c1c] px-3 py-2 text-xs text-[#b4b4b4]">
        <span>主体避让</span>
        <span data-testid="split-subject-aware-state">{subjectAware ? '开启' : '关闭'}</span>
      </div>

      <div className="mt-3 flex items-center justify-between rounded-lg border border-[#404040] bg-[#161616] px-3 py-2 text-xs text-[#b4b4b4]">
        <span>切分摘要</span>
        <span data-testid="split-summary">{rows}x{cols} / {mode === 'subject_aware' ? '主体避让' : '均匀切分'} / 边距 {safeMargin.toFixed(2)}</span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <label className="space-y-2 text-[#8b949e]">
          <span>行数</span>
          <input type="range" min={1} max={10} step={1} value={rows} onChange={(event) => updateValue({ rows: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="split-rows-slider" />
        </label>
        <label className="space-y-2 text-[#8b949e]">
          <span>列数</span>
          <input type="range" min={1} max={10} step={1} value={cols} onChange={(event) => updateValue({ cols: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="split-cols-slider" />
        </label>
        <label className="space-y-2 text-[#8b949e] md:col-span-2">
          <span>切分模式</span>
          <select value={mode} onChange={(event) => updateValue({ mode: event.target.value })} className="nodrag nopan nowheel w-full rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[#e6edf3] outline-none" data-testid="split-mode-select">
            <option value="subject_aware">主体避让</option>
            <option value="uniform">均匀切分</option>
          </select>
        </label>
        <label className="space-y-2 text-[#8b949e] md:col-span-2">
          <span>安全边距</span>
          <input type="range" min={0} max={0.12} step={0.01} value={safeMargin} onChange={(event) => updateValue({ safeMargin: Number(event.target.value) })} className="nodrag nopan nowheel w-full" />
        </label>
        <label className="space-y-2 text-[#8b949e] md:col-span-2">
          <span>命名模板</span>
          <input value={namingPattern} onChange={(event) => updateValue({ namingPattern: event.target.value })} className="nodrag nopan nowheel w-full rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[#e6edf3] outline-none" placeholder="tile-r{row}-c{col}" />
        </label>
        <Toggle active={avoidFaces} label="避让人脸" testId="split-avoid-faces-toggle" onClick={() => updateValue({ avoidFaces: !avoidFaces })} />
        <Toggle active={exportZip} label="导出 ZIP" testId="split-export-zip-toggle" onClick={() => updateValue({ exportZip: !exportZip })} />
        <button type="button" data-testid="split-export-run" onClick={() => void runZipExport()} className="col-span-2 rounded-lg border border-[#404040] px-3 py-2 text-sm text-[#cbcbcb] hover:bg-[#353535]"><Scissors className="mr-2 inline-block h-4 w-4" />导出真实切片 ZIP</button>
        <button type="button" data-testid="split-to-library" onClick={() => void handleSplitToLibrary()} className="col-span-2 rounded-lg border border-[#7b7b7b] bg-[#363636] px-3 py-2 text-sm text-white hover:bg-[#424242]">切分并入库</button>
        {libraryStatus ? (
          <div data-testid="split-library-status" className="col-span-2 rounded-lg border border-[#404040] bg-[#161616] px-3 py-2 text-xs text-[#b4b4b4]">{libraryStatus}</div>
        ) : null}
      </div>
    </div>
  );
}

function Toggle({ active, label, onClick, testId }: { active: boolean; label: string; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`rounded-lg border px-3 py-2 text-sm ${active ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}
    >
      {label}：{active ? '开启' : '关闭'}
    </button>
  );
}

