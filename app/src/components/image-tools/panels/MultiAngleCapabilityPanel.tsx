import { Bookmark, Camera, Move3d, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolCapabilityPanelProps } from './capabilityPanelTypes';
import { InteractiveImageStage } from './InteractiveImageStage';

const SHOT_SCALE_OPTIONS = [
  { label: '特写', value: 'close' },
  { label: '中景', value: 'medium' },
  { label: '远景', value: 'wide' },
];

const VIEW_PRESETS = [
  { key: 'front', label: '正面', yaw: 0, pitch: 0, shotScale: 'medium', framingZoom: 1 },
  { key: 'fish', label: '鱼眼', yaw: 18, pitch: -6, shotScale: 'close', framingZoom: 1.28 },
  { key: 'tilt', label: '戏剧', yaw: 42, pitch: 22, shotScale: 'medium', framingZoom: 1.1 },
  { key: 'top', label: '俯拍', yaw: 0, pitch: 68, shotScale: 'wide', framingZoom: 0.92 },
  { key: 'low', label: '仰拍', yaw: 0, pitch: -34, shotScale: 'wide', framingZoom: 0.98 },
  { key: 'orbit', label: '环绕', yaw: 138, pitch: 14, shotScale: 'medium', framingZoom: 1.05 },
  { key: 'detail', label: '细节', yaw: 22, pitch: 8, shotScale: 'close', framingZoom: 1.35 },
];

type OrbitDragState = {
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

function deriveShotScale(zoom: number) {
  if (zoom >= 1.22) return 'close';
  if (zoom <= 0.95) return 'wide';
  return 'medium';
}

export default function MultiAngleCapabilityPanel({ value, onChange, sourceImageUrl }: ToolCapabilityPanelProps) {
  const configRef = useRef(value);
  const dragStateRef = useRef<OrbitDragState | null>(null);
  const [keyframeName, setKeyframeName] = useState('');

  useEffect(() => {
    configRef.current = value;
  }, [value]);

  const yaw = Number(value.yaw ?? 45);
  const pitch = Number(value.pitch ?? 15);
  const consistency = Number(value.consistency ?? 0.85);
  const shotScale = String(value.shotScale ?? 'medium');
  const framingZoom = Number(value.framingZoom ?? 1);
  const cameraPreset = String(value.cameraPreset ?? 'front');
  const keyframes = useMemo(() => Array.isArray(value.keyframes) ? value.keyframes : [], [value.keyframes]);

  const imageStyle = useMemo<React.CSSProperties>(() => ({
    transform: `perspective(900px) rotateY(${(yaw * 0.5).toFixed(1)}deg) rotateX(${(-pitch * 0.4).toFixed(1)}deg) scale(${framingZoom.toFixed(2)})`,
    transition: 'transform 60ms linear',
    transformOrigin: '50% 50%',
  }), [yaw, pitch, framingZoom]);

  const cameraX = 50 + Math.sin((yaw / 180) * Math.PI) * 32;
  const cameraY = 50 - Math.sin((pitch / 180) * Math.PI) * 24;

  function mergeConfig(next: Record<string, unknown>) {
    const merged = { ...configRef.current, ...next };
    configRef.current = merged;
    onChange(merged);
  }

  function startOrbitDrag(clientX: number, clientY: number) {
    dragStateRef.current = { startX: clientX, startY: clientY, startYaw: yaw, startPitch: pitch };
  }

  function moveOrbitDrag(clientX: number, clientY: number) {
    const dragState = dragStateRef.current;
    if (!dragState) return;
    const nextYaw = normalizeAngle(dragState.startYaw + (clientX - dragState.startX) * 0.58);
    const nextPitch = clamp(dragState.startPitch - (clientY - dragState.startY) * 0.4, -90, 90);
    mergeConfig({ yaw: Number(nextYaw.toFixed(2)), pitch: Number(nextPitch.toFixed(2)) });
  }

  function endOrbitDrag() {
    dragStateRef.current = null;
  }

  function adjustZoom(deltaY: number) {
    const nextZoom = clamp(framingZoom + (deltaY > 0 ? -1 : 1) * 0.05, 0.78, 1.5);
    mergeConfig({ framingZoom: Number(nextZoom.toFixed(2)), shotScale: deriveShotScale(nextZoom) });
  }

  function addKeyframe() {
    const nextName = keyframeName.trim() || `关键帧 ${keyframes.length + 1}`;
    mergeConfig({ keyframes: [...keyframes, { name: nextName, yaw, pitch, shotScale, framingZoom, consistency }] });
    setKeyframeName('');
  }

  function updateKeyframe(index: number) {
    mergeConfig({
      keyframes: keyframes.map((frame, frameIndex) => frameIndex === index
        ? { ...(frame as Record<string, unknown>), yaw, pitch, shotScale, framingZoom, consistency }
        : frame),
    });
  }

  function removeKeyframe(index: number) {
    mergeConfig({ keyframes: keyframes.filter((_, frameIndex) => frameIndex !== index) });
  }

  const orbitPointerHandlers = {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      startOrbitDrag(event.clientX, event.clientY);
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStateRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      moveOrbitDrag(event.clientX, event.clientY);
    },
    onPointerUp: endOrbitDrag,
    onPointerLeave: endOrbitDrag,
    onWheel: (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      adjustZoom(event.deltaY);
    },
  };

  return (
    <div className="nodrag nopan nowheel mb-4 rounded-xl border border-[#353535] bg-[#242424] p-3">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-[#ededed]">
        <Move3d className="h-4 w-4" />多角度机位
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {VIEW_PRESETS.map((preset) => {
          const active = cameraPreset === preset.key;
          return (
            <button
              key={preset.key}
              type="button"
              data-testid={`multi-angle-preset-${preset.key}`}
              onClick={() => mergeConfig({
                cameraPreset: preset.key,
                yaw: preset.yaw,
                pitch: preset.pitch,
                shotScale: preset.shotScale,
                framingZoom: preset.framingZoom,
              })}
              className={`nodrag rounded-full border px-2.5 py-1 text-xs ${active ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb] hover:bg-[#353535]'}`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <InteractiveImageStage sourceImageUrl={sourceImageUrl} imageStyle={imageStyle} {...orbitPointerHandlers}>
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-44 w-44 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-white/15" />
        <div className="pointer-events-none absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-100/80 bg-cyan-300/85 shadow-[0_0_24px_rgba(125,211,252,0.45)]" style={{ left: `${cameraX}%`, top: `${cameraY}%` }}>
          <Camera className="m-auto mt-1 h-3.5 w-3.5 text-[#05253a]" />
        </div>
        <div className="pointer-events-none absolute left-2 right-2 top-2 flex justify-between text-[11px] text-white/85">
          <span>拖拽旋转机位</span>
          <span>滚轮缩放</span>
        </div>
        <div className="pointer-events-none absolute left-2 right-2 bottom-2 flex justify-between text-[11px] text-white/85">
          <span>Yaw {Math.round(yaw)}° · Pitch {Math.round(pitch)}°</span>
          <span>{framingZoom.toFixed(2)}x</span>
        </div>
      </InteractiveImageStage>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <CompactRange label="水平" value={`${Math.round(yaw)}°`} min={0} max={360} step={1} testId="multi-angle-yaw-slider" onChange={(v) => mergeConfig({ yaw: v })} />
        <CompactRange label="俯仰" value={`${Math.round(pitch)}°`} min={-90} max={90} step={1} testId="multi-angle-pitch-slider" onChange={(v) => mergeConfig({ pitch: v })} />
        <CompactRange label="一致性" value={consistency.toFixed(2)} min={0} max={1} step={0.01} testId="multi-angle-consistency-slider" onChange={(v) => mergeConfig({ consistency: v })} />
        <CompactRange label="景别" value={framingZoom.toFixed(2)} min={0.78} max={1.5} step={0.01} testId="multi-angle-zoom-slider" onChange={(v) => mergeConfig({ framingZoom: v, shotScale: deriveShotScale(v) })} />
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {SHOT_SCALE_OPTIONS.map((option) => {
          const active = shotScale === option.value;
          return (
            <button
              key={option.value}
              type="button"
              data-testid={`multi-angle-shot-${option.value}`}
              onClick={() => mergeConfig({ shotScale: option.value, framingZoom: option.value === 'close' ? 1.28 : option.value === 'wide' ? 0.9 : 1 })}
              className={`nodrag rounded-full border px-2.5 py-1 text-xs ${active ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4 rounded-lg border border-[#404040] bg-[#1c1c1c] p-3">
        <div className="mb-2 flex items-center justify-between text-xs text-[#b4b4b4]">
          <span>关键帧</span>
          <span>{keyframes.length} 帧</span>
        </div>
        <div className="mb-2 flex gap-2">
          <input
            value={keyframeName}
            onChange={(event) => setKeyframeName(event.target.value)}
            placeholder="命名当前机位，如：正面近景"
            className="nodrag nopan nowheel min-w-0 flex-1 rounded-lg border border-[#303030] bg-[#111] px-3 py-1.5 text-sm text-[#e8e8e8] outline-none"
            data-testid="multi-angle-keyframe-name"
          />
          <button type="button" data-testid="multi-angle-keyframe-add" onClick={addKeyframe} className="nodrag flex items-center gap-1 rounded-lg border border-[#404040] px-2.5 py-1.5 text-xs text-[#cbcbcb]"><Plus className="h-3.5 w-3.5" />保存</button>
          <button type="button" data-testid="multi-angle-keyframe-reset" onClick={() => mergeConfig({ keyframes: [] })} className="nodrag flex items-center justify-center rounded-lg border border-[#404040] px-2.5 py-1.5 text-xs text-[#cbcbcb]"><RotateCcw className="h-3.5 w-3.5" /></button>
        </div>
        <div className="space-y-1.5">
          {keyframes.length > 0 ? keyframes.map((frame, index) => {
            const item = frame as Record<string, unknown>;
            return (
              <div key={`${index}-${String(item.name ?? '')}`} className="flex items-center gap-2 rounded-lg border border-[#333] px-2.5 py-2 text-xs">
                <button
                  type="button"
                  data-testid={`multi-angle-keyframe-${index}`}
                  onClick={() => mergeConfig({
                    yaw: Number(item.yaw ?? yaw),
                    pitch: Number(item.pitch ?? pitch),
                    shotScale: String(item.shotScale ?? shotScale),
                    framingZoom: Number(item.framingZoom ?? framingZoom),
                    consistency: Number(item.consistency ?? consistency),
                  })}
                  className="nodrag flex flex-1 items-center gap-2 text-left"
                >
                  <Bookmark className="h-3.5 w-3.5 shrink-0 text-[#cbcbcb]" />
                  <span className="min-w-0 flex-1 truncate font-medium text-[#f3f3f3]">{String(item.name || `关键帧 ${index + 1}`)}</span>
                  <span className="shrink-0 text-[11px] text-[#a8a8a8]">{String(item.yaw ?? yaw)}° · {String(item.framingZoom ?? framingZoom).slice(0, 4)}x</span>
                </button>
                <button type="button" data-testid={`multi-angle-keyframe-update-${index}`} onClick={() => updateKeyframe(index)} className="nodrag rounded-md border border-[#3c3c3c] px-2 py-1 text-[11px] text-[#cfcfcf] hover:bg-[#2f2f2f]">覆盖</button>
                <button type="button" data-testid={`multi-angle-keyframe-remove-${index}`} onClick={() => removeKeyframe(index)} className="nodrag rounded-md border border-[#3c3c3c] p-1 text-[#cfcfcf] hover:bg-[#2f2f2f]"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            );
          }) : (
            <div className="text-xs text-[#8f8f8f]">常用机位可保存到此处复用。</div>
          )}
        </div>
      </div>
    </div>
  );
}

function CompactRange({ label, value, min, max, step, testId, onChange }: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  testId: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] text-[#b4b4b4]">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number(value)}
        onChange={(event) => onChange(Number(event.target.value))}
        className="nodrag nopan nowheel w-full"
        data-testid={testId}
      />
    </div>
  );
}
