import { Eraser, Maximize2, Move3d, Paintbrush2, RotateCcw, ScanLine } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ToolCapabilityPanelProps } from './capabilityPanelTypes';

const SIZE_PRESETS = [
  { label: '4K', value: '4K', width: 4096, height: 2048 },
  { label: '6K', value: '6K', width: 6144, height: 3072 },
  { label: '8K', value: '8K', width: 8192, height: 4096 },
];

type PanoramaDragState = {
  startX: number;
  startY: number;
  startYaw: number;
  startPitch: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeAngle(value: number) {
  const next = value % 360;
  return next < 0 ? next + 360 : next;
}

export default function PanoramaCapabilityPanel({ value, onChange }: ToolCapabilityPanelProps) {
  const configRef = useRef(value);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const maskRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<PanoramaDragState | null>(null);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [drawing, setDrawing] = useState(false);

  useEffect(() => {
    configRef.current = value;
  }, [value]);

  const fov = Number(value.fov ?? 120);
  const spatialFusion = Number(value.spatialFusion ?? 0.75);
  const resolution = String(value.panoramaResolution ?? '4K');
  const brushMode = String(value.brushMode ?? 'paint');
  const brushSize = Number(value.brushSize ?? 24);
  const maskStrength = Number(value.maskStrength ?? 0.8);
  const maskPoints = useMemo(() => Array.isArray(value.maskPoints) ? value.maskPoints : [], [value.maskPoints]);
  const panoramaYaw = Number(value.panoramaYaw ?? 0);
  const panoramaPitch = Number(value.panoramaPitch ?? 0);
  const panoramaZoom = Number(value.panoramaZoom ?? 1);
  const localAnchorX = Number(value.panoramaAnchorX ?? 0.5);
  const localAnchorY = Number(value.panoramaAnchorY ?? 0.5);
  const localEditEnabled = Boolean(value.panoramaLocalEditEnabled ?? true);

  function mergeConfig(next: Record<string, unknown>) {
    const merged = { ...configRef.current, ...next };
    configRef.current = merged;
    onChange(merged);
  }

  function recordMaskPoint(clientX: number, clientY: number) {
    const rect = maskRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = clamp((clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((clientY - rect.top) / rect.height, 0, 1);
    mergeConfig({
      maskPoints: [...maskPoints, { x, y, brushMode, brushSize }],
    });
  }

  function setPanoramaFocus(clientX: number, clientY: number) {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = clamp((clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((clientY - rect.top) / rect.height, 0, 1);
    mergeConfig({
      panoramaAnchorX: x,
      panoramaAnchorY: y,
      panoramaLocalEditEnabled: true,
    });
  }

  function startViewportDrag(clientX: number, clientY: number) {
    dragStateRef.current = {
      startX: clientX,
      startY: clientY,
      startYaw: panoramaYaw,
      startPitch: panoramaPitch,
    };
  }

  function moveViewportDrag(clientX: number, clientY: number) {
    const dragState = dragStateRef.current;
    if (!dragState) return;
    const nextYaw = normalizeAngle(dragState.startYaw + (clientX - dragState.startX) * 0.5);
    const nextPitch = clamp(dragState.startPitch - (clientY - dragState.startY) * 0.35, -75, 75);
    mergeConfig({
      panoramaYaw: Number(nextYaw.toFixed(2)),
      panoramaPitch: Number(nextPitch.toFixed(2)),
    });
  }

  function endViewportDrag() {
    dragStateRef.current = null;
  }

  function handleViewportPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    startViewportDrag(event.clientX, event.clientY);
    setPanoramaFocus(event.clientX, event.clientY);
  }

  function handleViewportPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStateRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    moveViewportDrag(event.clientX, event.clientY);
  }

  function handleViewportMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    startViewportDrag(event.clientX, event.clientY);
    setPanoramaFocus(event.clientX, event.clientY);
  }

  function handleViewportMouseMove(event: React.MouseEvent<HTMLDivElement>) {
    if (!dragStateRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    moveViewportDrag(event.clientX, event.clientY);
  }

  function handleViewportWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const direction = event.deltaY > 0 ? -1 : 1;
    mergeConfig({ fov: clamp(fov + direction * 4, 30, 180) });
  }

  function renderViewport(className = 'h-48') {
    return (
      <div
        ref={viewportRef}
        data-testid="panorama-immersive-viewport"
        className={`nodrag nopan nowheel relative overflow-hidden rounded-2xl border border-[#3f3f3f] bg-[#09111f] ${className}`}
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={endViewportDrag}
        onPointerLeave={endViewportDrag}
        onMouseDown={handleViewportMouseDown}
        onMouseMove={handleViewportMouseMove}
        onMouseUp={endViewportDrag}
        onMouseLeave={endViewportDrag}
        onWheel={handleViewportWheel}
        onClick={(event) => setPanoramaFocus(event.clientX, event.clientY)}
      >
        <div
          className="absolute inset-0 opacity-90"
          style={{
            backgroundImage: `radial-gradient(circle at ${50 + Math.cos((panoramaYaw / 180) * Math.PI) * 20}% ${48 - Math.sin((panoramaPitch / 180) * Math.PI) * 12}%, rgba(255,255,255,0.18), rgba(8,17,31,0.08) 28%, rgba(0,0,0,0.84) 100%)`,
            transform: `scale(${panoramaZoom})`,
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: 'linear-gradient(90deg, rgba(125,211,252,0.12) 1px, transparent 1px), linear-gradient(rgba(125,211,252,0.08) 1px, transparent 1px)',
            backgroundSize: '72px 72px',
            transform: `translateX(${(panoramaYaw / 360) * -72}px) translateY(${(panoramaPitch / 180) * 36}px) scale(${1 + (panoramaZoom - 1) * 0.12})`,
            opacity: 0.75,
          }}
        />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,transparent_34%,rgba(148,163,184,0.12)_35%,rgba(148,163,184,0.02)_52%,transparent_53%)]" />
        <div className="absolute inset-x-0 top-0 h-16 bg-[linear-gradient(180deg,rgba(255,255,255,0.1),transparent)]" />

        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="relative rounded-full border border-[#6b7280]/70 bg-[#020617]/70 shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_0_60px_rgba(56,189,248,0.12)]"
            style={{ width: '72%', height: '72%', transform: `scale(${panoramaZoom})` }}
          >
            <div className="absolute inset-0 rounded-full border border-dashed border-cyan-200/20" />
            <div className="absolute inset-1 rounded-full border border-white/5" />
            <div className="absolute left-1/2 top-1/2 h-44 w-[1px] -translate-x-1/2 -translate-y-1/2 bg-white/12" />
            <div className="absolute left-1/2 top-1/2 h-[1px] w-44 -translate-x-1/2 -translate-y-1/2 bg-white/12" />
            <div
              className="absolute rounded-full border border-cyan-200/90 bg-cyan-300/70 shadow-[0_0_18px_rgba(125,211,252,0.5)]"
              style={{
                left: `${localAnchorX * 100}%`,
                top: `${localAnchorY * 100}%`,
                width: localEditEnabled ? 18 : 12,
                height: localEditEnabled ? 18 : 12,
                transform: 'translate(-50%, -50%)',
              }}
            />
            <div className="absolute inset-x-8 top-8 rounded-full border border-white/10 px-3 py-1.5 text-center text-[11px] text-[#d7f3ff]">
              拖拽环视，滚轮切换视场角，点击区域即可定位局部重绘锚点
            </div>
          </div>
        </div>

        <div className="absolute inset-x-4 bottom-3 flex items-center justify-between text-xs text-[#c0d8e8]">
          <span>Yaw {Math.round(panoramaYaw)}° · Pitch {Math.round(panoramaPitch)}°</span>
          <span>FOV {fov}° · Zoom {panoramaZoom.toFixed(2)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="nodrag nopan nowheel mb-4 rounded-xl border border-[#353535] bg-[#242424] p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-[#ededed]"><ScanLine className="h-4 w-4" />全景控制台</div>
        <button
          type="button"
          onClick={() => setFullscreenOpen(true)}
          className="nodrag inline-flex items-center gap-2 rounded-lg border border-[#404040] px-3 py-1.5 text-xs text-[#cbcbcb] hover:bg-[#353535]"
          data-testid="panorama-fullscreen-open"
        >
          <Maximize2 className="h-3.5 w-3.5" /> 沉浸预览
        </button>
      </div>

      <div className="rounded-lg border border-[#404040] bg-[#1c1c1c] p-3">
        <div className="mb-2 flex items-center justify-between text-xs text-[#b4b4b4]">
          <span>视场角</span>
          <span>{fov}°</span>
        </div>
        <input
          type="range"
          min={30}
          max={180}
          step={1}
          value={fov}
          onChange={(event) => mergeConfig({ fov: Number(event.target.value) })}
          className="nodrag nopan nowheel w-full"
          data-testid="panorama-fov-slider"
        />

        <div className="mt-4 mb-2 flex items-center justify-between text-xs text-[#b4b4b4]">
          <span>空间融合强度</span>
          <span>{spatialFusion.toFixed(2)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={spatialFusion}
          onChange={(event) => mergeConfig({ spatialFusion: Number(event.target.value) })}
          className="nodrag nopan nowheel w-full"
          data-testid="panorama-fusion-slider"
        />

        <div className="mt-4 grid grid-cols-3 gap-2">
          {SIZE_PRESETS.map((preset) => {
            const active = resolution === preset.value;
            return (
              <button
                key={preset.value}
                type="button"
                onClick={() => mergeConfig({ panoramaResolution: preset.value })}
                className={`nodrag rounded-lg border px-3 py-2 text-left ${active ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}
                data-testid={`panorama-size-${preset.value.toLowerCase()}`}
              >
                <div className="text-sm font-medium">{preset.label}</div>
                <div className="mt-1 text-[11px] opacity-70">{preset.width} x {preset.height}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-[1.3fr_0.7fr]">
        {renderViewport()}

        <div className="space-y-3 rounded-lg border border-[#404040] bg-[#1c1c1c] p-3 text-xs text-[#c8c8c8]">
          <div className="flex items-center gap-2 text-sm text-[#f0f0f0]"><Move3d className="h-4 w-4" />全景视角</div>
          <div>水平环视：{Math.round(panoramaYaw)}°</div>
          <div>垂直俯仰：{Math.round(panoramaPitch)}°</div>
          <div>局部锚点：{Math.round(localAnchorX * 100)}% / {Math.round(localAnchorY * 100)}%</div>
          <div className="rounded-lg border border-[#353535] bg-[#131313] p-2 text-[11px] leading-5 text-[#9fcce0]">
            全景区域支持拖拽环视、滚轮缩放和点击定位局部重绘点，尽量贴近文档要求的沉浸式操作。
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="nodrag rounded-lg border border-[#404040] px-3 py-2 text-[#cbcbcb] hover:bg-[#353535]"
              onClick={() => mergeConfig({ panoramaYaw: 0, panoramaPitch: 0, panoramaZoom: 1 })}
              data-testid="panorama-preview-reset"
            >
              <RotateCcw className="mr-1 inline-block h-3.5 w-3.5" /> 复位
            </button>
            <button
              type="button"
              className={`nodrag rounded-lg border px-3 py-2 ${localEditEnabled ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}
              onClick={() => mergeConfig({ panoramaLocalEditEnabled: !localEditEnabled })}
              data-testid="panorama-local-edit-toggle"
            >
              <Paintbrush2 className="mr-1 inline-block h-3.5 w-3.5" /> 局部编辑
            </button>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between text-[11px] text-[#a9a9a9]"><span>沉浸缩放</span><span>{panoramaZoom.toFixed(2)}</span></div>
            <input
              type="range"
              min={0.7}
              max={1.6}
              step={0.01}
              value={panoramaZoom}
              onChange={(event) => mergeConfig({ panoramaZoom: Number(event.target.value) })}
              className="nodrag nopan nowheel w-full"
              data-testid="panorama-preview-zoom-slider"
            />
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-[#404040] bg-[#1c1c1c] p-3">
        <div className="mb-3 flex items-center justify-between text-xs text-[#b4b4b4]">
          <span>局部重绘蒙版</span>
          <span>{maskPoints.length} 笔</span>
        </div>

        <div className="mb-3 grid grid-cols-3 gap-2 text-sm">
          <button type="button" data-testid="panorama-brush-paint" onClick={() => mergeConfig({ brushMode: 'paint' })} className={`nodrag rounded-lg border px-3 py-2 ${brushMode === 'paint' ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}><Paintbrush2 className="inline-block h-4 w-4" /> 涂抹</button>
          <button type="button" data-testid="panorama-brush-erase" onClick={() => mergeConfig({ brushMode: 'erase' })} className={`nodrag rounded-lg border px-3 py-2 ${brushMode === 'erase' ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}><Eraser className="inline-block h-4 w-4" /> 擦除</button>
          <button type="button" data-testid="panorama-mask-clear" onClick={() => mergeConfig({ maskPoints: [] })} className="nodrag rounded-lg border border-[#404040] px-3 py-2 text-[#cbcbcb]"><RotateCcw className="inline-block h-4 w-4" /> 清空</button>
        </div>

        <div className="mb-3">
          <div className="mb-2 flex items-center justify-between text-xs text-[#b4b4b4]">
            <span>画笔大小</span>
            <span>{brushSize}px</span>
          </div>
          <input type="range" min={1} max={120} step={1} value={brushSize} onChange={(event) => mergeConfig({ brushSize: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="panorama-brush-size-slider" />
        </div>

        <div className="mb-3">
          <div className="mb-2 flex items-center justify-between text-xs text-[#b4b4b4]">
            <span>蒙版强度</span>
            <span>{maskStrength.toFixed(2)}</span>
          </div>
          <input type="range" min={0} max={1} step={0.01} value={maskStrength} onChange={(event) => mergeConfig({ maskStrength: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="panorama-mask-strength-slider" />
        </div>

        <div
          ref={maskRef}
          data-testid="panorama-mask-surface"
          className="nodrag nopan nowheel relative h-28 overflow-hidden rounded-lg border border-dashed border-[#5a5a5a] bg-[linear-gradient(135deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))]"
          onClick={(event) => recordMaskPoint(event.clientX, event.clientY)}
          onPointerDown={(event) => {
            setDrawing(true);
            recordMaskPoint(event.clientX, event.clientY);
          }}
          onPointerMove={(event) => {
            if (!drawing) return;
            recordMaskPoint(event.clientX, event.clientY);
          }}
          onPointerUp={() => setDrawing(false)}
          onPointerLeave={() => setDrawing(false)}
          onMouseDown={(event) => {
            setDrawing(true);
            recordMaskPoint(event.clientX, event.clientY);
          }}
          onMouseMove={(event) => {
            if (!drawing) return;
            recordMaskPoint(event.clientX, event.clientY);
          }}
          onMouseUp={() => setDrawing(false)}
        >
          {maskPoints.map((point, index) => {
            const item = point as Record<string, unknown>;
            return (
              <div
                key={`${index}-${String(item.x)}-${String(item.y)}`}
                className={`absolute rounded-full ${String(item.brushMode) === 'erase' ? 'bg-white/20 ring-1 ring-white/45' : 'bg-cyan-300/40 ring-1 ring-cyan-200/70'}`}
                style={{
                  left: `${Number(item.x || 0) * 100}%`,
                  top: `${Number(item.y || 0) * 100}%`,
                  width: Math.max(8, Number(item.brushSize || brushSize) * 0.45),
                  height: Math.max(8, Number(item.brushSize || brushSize) * 0.45),
                  transform: 'translate(-50%, -50%)',
                }}
              />
            );
          })}
          <div className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-[11px] text-[#bcbcbc]">拖拽即可绘制局部重绘蒙版</div>
        </div>
      </div>

      <Dialog open={fullscreenOpen} onOpenChange={setFullscreenOpen}>
        <DialogContent className="max-w-[min(96vw,1240px)] border-[#404040] bg-[#101010] text-white">
          <DialogHeader>
            <DialogTitle>全景沉浸预览</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 lg:grid-cols-[1.4fr_0.6fr]">
            {renderViewport('h-[72vh]')}
            <div className="space-y-3 rounded-2xl border border-[#313131] bg-[#171717] p-4 text-sm text-[#d9d9d9]">
              <div className="flex items-center gap-2 text-base font-medium"><Move3d className="h-4 w-4" /> 预览参数</div>
              <div>当前视场角：{fov}°</div>
              <div>当前锚点：{Math.round(localAnchorX * 100)}% / {Math.round(localAnchorY * 100)}%</div>
              <div className="rounded-xl border border-[#2f2f2f] bg-[#0d0d0d] p-3 text-xs leading-5 text-[#9fd7eb]">
                这里模拟文档里的“球内壁全景 + 点击局部重绘”工作台，拖拽和滚轮都不会穿透到画布。
              </div>
              <div className="space-y-2">
                <div className="mb-1 flex items-center justify-between text-xs text-[#afafaf]"><span>沉浸缩放</span><span>{panoramaZoom.toFixed(2)}</span></div>
                <input type="range" min={0.7} max={1.6} step={0.01} value={panoramaZoom} onChange={(event) => mergeConfig({ panoramaZoom: Number(event.target.value) })} className="nodrag nopan nowheel w-full" />
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
