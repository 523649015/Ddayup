import { Bookmark, Camera, Move3d, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolCapabilityPanelProps } from './capabilityPanelTypes';

const SHOT_SCALE_OPTIONS = [
  { label: '特写', value: 'close' },
  { label: '中景', value: 'medium' },
  { label: '远景', value: 'wide' },
];

const VIEW_PRESETS = [
  { key: 'front', label: '正面平视', yaw: 0, pitch: 0, shotScale: 'medium', framingZoom: 1 },
  { key: 'fish', label: '鱼眼贴近', yaw: 18, pitch: -6, shotScale: 'close', framingZoom: 1.28 },
  { key: 'tilt', label: '倾斜戏剧', yaw: 42, pitch: 22, shotScale: 'medium', framingZoom: 1.1 },
  { key: 'top', label: '正上俯拍', yaw: 0, pitch: 68, shotScale: 'wide', framingZoom: 0.92 },
  { key: 'low', label: '低机位仰拍', yaw: 0, pitch: -34, shotScale: 'wide', framingZoom: 0.98 },
  { key: 'orbit', label: '环绕侧后', yaw: 138, pitch: 14, shotScale: 'medium', framingZoom: 1.05 },
  { key: 'detail', label: '人物细节', yaw: 22, pitch: 8, shotScale: 'close', framingZoom: 1.35 },
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

export default function MultiAngleCapabilityPanel({ value, onChange }: ToolCapabilityPanelProps) {
  const configRef = useRef(value);
  const orbitRef = useRef<HTMLDivElement | null>(null);
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

  function mergeConfig(next: Record<string, unknown>) {
    const merged = { ...configRef.current, ...next };
    configRef.current = merged;
    onChange(merged);
  }

  function startOrbitDrag(clientX: number, clientY: number) {
    dragStateRef.current = {
      startX: clientX,
      startY: clientY,
      startYaw: yaw,
      startPitch: pitch,
    };
  }

  function moveOrbitDrag(clientX: number, clientY: number) {
    const dragState = dragStateRef.current;
    if (!dragState) return;
    const nextYaw = normalizeAngle(dragState.startYaw + (clientX - dragState.startX) * 0.58);
    const nextPitch = clamp(dragState.startPitch - (clientY - dragState.startY) * 0.4, -90, 90);
    mergeConfig({
      yaw: Number(nextYaw.toFixed(2)),
      pitch: Number(nextPitch.toFixed(2)),
    });
  }

  function endOrbitDrag() {
    dragStateRef.current = null;
  }

  function adjustZoom(deltaY: number) {
    const direction = deltaY > 0 ? -1 : 1;
    const nextZoom = clamp(framingZoom + direction * 0.05, 0.78, 1.5);
    mergeConfig({
      framingZoom: Number(nextZoom.toFixed(2)),
      shotScale: deriveShotScale(nextZoom),
    });
  }

  function addKeyframe() {
    const nextName = keyframeName.trim() || `关键帧 ${keyframes.length + 1}`;
    mergeConfig({
      keyframes: [...keyframes, { name: nextName, yaw, pitch, shotScale, framingZoom, consistency }],
    });
    setKeyframeName('');
  }

  function updateKeyframe(index: number) {
    const nextFrames = keyframes.map((frame, frameIndex) => frameIndex === index
      ? { ...(frame as Record<string, unknown>), yaw, pitch, shotScale, framingZoom, consistency }
      : frame);
    mergeConfig({ keyframes: nextFrames });
  }

  function removeKeyframe(index: number) {
    mergeConfig({ keyframes: keyframes.filter((_, frameIndex) => frameIndex !== index) });
  }

  function renderOrbitViewport() {
    const yawRadians = (yaw / 180) * Math.PI;
    const pitchRadians = (pitch / 180) * Math.PI;
    const cameraX = 50 + Math.sin(yawRadians) * 32;
    const cameraY = 50 - Math.sin(pitchRadians) * 24;
    const horizon = 52 + Math.sin(pitchRadians) * 10;

    return (
      <div
        ref={orbitRef}
        className="nodrag nopan nowheel relative h-52 overflow-hidden rounded-2xl border border-[#555] bg-[radial-gradient(circle_at_50%_25%,rgba(125,211,252,0.18),rgba(15,23,42,0.15)_32%,rgba(2,6,23,0.96)_100%)]"
        data-testid="multi-angle-orbit-pad"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          startOrbitDrag(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (!dragStateRef.current) return;
          event.preventDefault();
          event.stopPropagation();
          moveOrbitDrag(event.clientX, event.clientY);
        }}
        onPointerUp={endOrbitDrag}
        onPointerLeave={endOrbitDrag}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          startOrbitDrag(event.clientX, event.clientY);
        }}
        onMouseMove={(event) => {
          if (!dragStateRef.current) return;
          event.preventDefault();
          event.stopPropagation();
          moveOrbitDrag(event.clientX, event.clientY);
        }}
        onMouseUp={endOrbitDrag}
        onMouseLeave={endOrbitDrag}
        onWheel={(event) => {
          event.preventDefault();
          event.stopPropagation();
          adjustZoom(event.deltaY);
        }}
      >
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),transparent_30%,rgba(14,116,144,0.08)_60%,rgba(2,6,23,0.18))]" />
        <div className="absolute inset-x-0 border-t border-dashed border-white/10" style={{ top: `${horizon}%` }} />
        <div className="absolute left-1/2 top-[58%] h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/15 bg-white/5 shadow-[0_0_30px_rgba(56,189,248,0.12)]" />
        <div className="absolute left-1/2 top-[58%] h-28 w-28 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-cyan-300/20" />
        <div className="absolute left-1/2 top-[58%] h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-white/10" />
        <div className="absolute left-1/2 top-[58%] h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
        <div
          className="absolute h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-100/80 bg-cyan-300/85 text-[#05253a] shadow-[0_0_28px_rgba(125,211,252,0.45)]"
          style={{ left: `${cameraX}%`, top: `${cameraY}%` }}
        >
          <Camera className="m-auto mt-1.5 h-4 w-4" />
        </div>
        <div
          className="absolute h-[1px] origin-left bg-cyan-200/55"
          style={{
            left: '50%',
            top: '58%',
            width: `${Math.hypot(cameraX - 50, cameraY - 58) * 1.5}%`,
            transform: `rotate(${Math.atan2(cameraY - 58, cameraX - 50)}rad)`,
            transformOrigin: '0 0',
          }}
        />
        <div className="absolute inset-x-4 top-3 flex items-center justify-between text-xs text-[#d8edf7]">
          <span>拖拽调整机位</span>
          <span>滚轮缩放景别</span>
        </div>
        <div className="absolute inset-x-4 bottom-3 flex items-center justify-between text-xs text-[#d8edf7]">
          <span>Yaw {Math.round(yaw)}° · Pitch {Math.round(pitch)}°</span>
          <span>景别缩放 {framingZoom.toFixed(2)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="nodrag nopan nowheel mb-4 rounded-xl border border-[#353535] bg-[#242424] p-3">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-[#ededed]"><Move3d className="h-4 w-4" />多角度机位编辑</div>

      <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
        {VIEW_PRESETS.map((preset) => (
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
            className={`nodrag rounded-lg border px-3 py-2 text-left ${cameraPreset === preset.key ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb] hover:bg-[#353535]'}`}
          >
            <div className="font-medium">{preset.label}</div>
            <div className="mt-1 text-[11px] opacity-70">水平 {preset.yaw}° · 俯仰 {preset.pitch}°</div>
          </button>
        ))}
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-[1.15fr_0.85fr]">
        {renderOrbitViewport()}

        <div className="rounded-lg border border-[#404040] bg-[#1c1c1c] p-3">
          <div className="mb-3 flex items-center gap-2 text-sm text-[#ededed]"><Camera className="h-4 w-4" />机位参数</div>
          <RangeRow label="水平环绕" value={`${Math.round(yaw)}°`}>
            <input type="range" min={0} max={360} step={1} value={yaw} onChange={(event) => mergeConfig({ yaw: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="multi-angle-yaw-slider" />
          </RangeRow>
          <RangeRow label="垂直俯仰" value={`${Math.round(pitch)}°`}>
            <input type="range" min={-90} max={90} step={1} value={pitch} onChange={(event) => mergeConfig({ pitch: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="multi-angle-pitch-slider" />
          </RangeRow>
          <RangeRow label="一致性约束" value={consistency.toFixed(2)}>
            <input type="range" min={0} max={1} step={0.01} value={consistency} onChange={(event) => mergeConfig({ consistency: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="multi-angle-consistency-slider" />
          </RangeRow>
          <RangeRow label="景别缩放" value={framingZoom.toFixed(2)}>
            <input type="range" min={0.78} max={1.5} step={0.01} value={framingZoom} onChange={(event) => {
              const nextZoom = Number(event.target.value);
              mergeConfig({ framingZoom: nextZoom, shotScale: deriveShotScale(nextZoom) });
            }} className="nodrag nopan nowheel w-full" data-testid="multi-angle-zoom-slider" />
          </RangeRow>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {SHOT_SCALE_OPTIONS.map((option) => {
              const active = shotScale === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => mergeConfig({ shotScale: option.value, framingZoom: option.value === 'close' ? 1.28 : option.value === 'wide' ? 0.9 : 1 })}
                  data-testid={`multi-angle-shot-${option.value}`}
                  className={`nodrag rounded-lg border px-3 py-2 text-sm ${active ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-[#404040] bg-[#1c1c1c] p-3">
        <div className="mb-2 flex items-center justify-between text-xs text-[#b4b4b4]">
          <span>关键帧预设</span>
          <span>{keyframes.length} 帧</span>
        </div>
        <div className="mb-3 grid gap-2 md:grid-cols-[1fr_auto_auto]">
          <input
            value={keyframeName}
            onChange={(event) => setKeyframeName(event.target.value)}
            placeholder="为当前机位命名，例如：正面近景"
            className="nodrag nopan nowheel rounded-lg border border-[#303030] bg-[#111] px-3 py-2 text-sm text-[#e8e8e8] outline-none"
            data-testid="multi-angle-keyframe-name"
          />
          <button type="button" data-testid="multi-angle-keyframe-add" onClick={addKeyframe} className="nodrag flex items-center justify-center gap-2 rounded-lg border border-[#404040] px-3 py-2 text-[#cbcbcb]"><Plus className="h-4 w-4" />保存关键帧</button>
          <button type="button" data-testid="multi-angle-keyframe-reset" onClick={() => mergeConfig({ keyframes: [] })} className="nodrag flex items-center justify-center gap-2 rounded-lg border border-[#404040] px-3 py-2 text-[#cbcbcb]"><RotateCcw className="h-4 w-4" />清空</button>
        </div>
        <div className="space-y-2">
          {keyframes.length > 0 ? keyframes.map((frame, index) => {
            const item = frame as Record<string, unknown>;
            return (
              <div key={`${index}-${String(item.name ?? '')}`} className="rounded-lg border border-[#333] px-3 py-3 text-xs text-[#d7d7d7]">
                <div className="flex items-start justify-between gap-3">
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
                    className="nodrag flex-1 text-left"
                  >
                    <div className="flex items-center gap-2 font-medium text-[#f3f3f3]"><Bookmark className="h-3.5 w-3.5" />{String(item.name || `关键帧 ${index + 1}`)}</div>
                    <div className="mt-1 text-[11px] text-[#a8a8a8]">{String(item.yaw ?? yaw)}° / {String(item.pitch ?? pitch)}° · {String(item.shotScale ?? shotScale)} · 缩放 {Number(item.framingZoom ?? framingZoom).toFixed(2)}</div>
                  </button>
                  <div className="flex items-center gap-2">
                    <button type="button" data-testid={`multi-angle-keyframe-update-${index}`} onClick={() => updateKeyframe(index)} className="nodrag rounded-md border border-[#3c3c3c] px-2 py-1 text-[11px] text-[#cfcfcf] hover:bg-[#2f2f2f]">覆盖当前机位</button>
                    <button type="button" data-testid={`multi-angle-keyframe-remove-${index}`} onClick={() => removeKeyframe(index)} className="nodrag rounded-md border border-[#3c3c3c] px-2 py-1 text-[11px] text-[#cfcfcf] hover:bg-[#2f2f2f]"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
              </div>
            );
          }) : (
            <div className="text-xs text-[#8f8f8f]">还没有保存关键帧，可以把常用机位保存下来反复复用。</div>
          )}
        </div>
      </div>
    </div>
  );
}

function RangeRow({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-2 flex items-center justify-between text-xs text-[#b4b4b4]">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      {children}
    </div>
  );
}
