// Shared types, constants, helpers and leaf sub-components extracted from PostNode.tsx.
// Moved verbatim — no behavior change.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Link2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { PostCurvePoint, PostEffectsState, PostMediaKind } from '@/config/postEffectPresets';
import { toRenderableAssetUrl } from '@/services/generation';
import { buildPostPreviewDescriptor } from '@/services/localPostProcessing';

export type PostPanelKind = 'post-panel';
export type PostFieldTestId = string | undefined;
export type CurveChannelKey = 'master' | 'red' | 'green' | 'blue';
export type ColorPanelSectionId = 'console' | 'wheels' | 'workspace';

export const CURVE_EDITOR_SIZE = { width: 176, height: 132 };
export const CURVE_CHANNEL_COLORS: Record<CurveChannelKey, string> = {
  master: '#e7e7e7',
  red: '#f87171',
  green: '#4ade80',
  blue: '#60a5fa',
};

export function stopCanvasPointer(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

export function preventCanvasPointer(event: { preventDefault: () => void; stopPropagation: () => void }) {
  event.preventDefault();
  event.stopPropagation();
}

export function sliderTrackClass() {
  return 'nodrag nopan nowheel h-2 w-full cursor-ew-resize touch-none appearance-none rounded-full bg-[#20252b] accent-[#00d4aa]';
}

export function workspaceTabClass(active: boolean) {
  return active
    ? 'border-[#5d827d] bg-[#17312b] text-[#d8fff7] shadow-[0_0_0_1px_rgba(0,212,170,0.12)]'
    : 'border-[#34383d] bg-[#1a1d21] text-[#cfd8e1] hover:border-[#46515d] hover:bg-[#23282d]';
}

export function cloneCurvePoints(points: PostCurvePoint[]) {
  return points.map((point) => ({ x: point.x, y: point.y }));
}

export function sanitizeCurvePoints(points: PostCurvePoint[] | undefined, fallback: PostCurvePoint[]) {
  if (!Array.isArray(points) || points.length < 2) {
    return cloneCurvePoints(fallback);
  }
  const normalized = points
    .map((point, index) => ({
      x: index === 0 ? 0 : index === points.length - 1 ? 1 : Math.min(1, Math.max(0, Number(point?.x ?? 0))),
      y: index === 0 ? 0 : index === points.length - 1 ? 1 : Math.min(1, Math.max(0, Number(point?.y ?? 0))),
    }))
    .sort((left, right) => left.x - right.x);
  normalized[0] = { x: 0, y: 0 };
  normalized[normalized.length - 1] = { x: 1, y: 1 };
  for (let index = 1; index < normalized.length - 1; index += 1) {
    const prev = normalized[index - 1];
    const next = normalized[index + 1];
    normalized[index].x = Math.min(next.x - 0.04, Math.max(prev.x + 0.04, normalized[index].x));
  }
  return normalized;
}

export function presetCurvePoints(preset: string, channel: CurveChannelKey): PostCurvePoint[] {
  if (preset === 'soft-contrast') return [{ x: 0, y: 0 }, { x: 0.2, y: 0.14 }, { x: 0.5, y: 0.54 }, { x: 0.76, y: 0.88 }, { x: 1, y: 1 }];
  if (preset === 'film-s') return [{ x: 0, y: 0 }, { x: 0.18, y: 0.1 }, { x: 0.4, y: 0.44 }, { x: 0.74, y: 0.88 }, { x: 1, y: 1 }];
  if (preset === 'lifted-matte') return [{ x: 0, y: 0.06 }, { x: 0.22, y: 0.2 }, { x: 0.55, y: 0.58 }, { x: 0.78, y: 0.84 }, { x: 1, y: 0.97 }];
  if (preset === 'film-warm' && channel === 'red') return [{ x: 0, y: 0.01 }, { x: 0.45, y: 0.48 }, { x: 0.82, y: 0.9 }, { x: 1, y: 1 }];
  if (preset === 'teal-shadows') {
    if (channel === 'blue') return [{ x: 0, y: 0.07 }, { x: 0.3, y: 0.34 }, { x: 0.72, y: 0.8 }, { x: 1, y: 1 }];
    if (channel === 'red') return [{ x: 0, y: 0 }, { x: 0.28, y: 0.22 }, { x: 0.68, y: 0.66 }, { x: 1, y: 1 }];
  }
  if (preset === 'crisp-highlights') return [{ x: 0, y: 0 }, { x: 0.6, y: 0.62 }, { x: 0.86, y: 0.92 }, { x: 1, y: 1 }];
  if (preset === 'film-balance' && channel === 'green') return [{ x: 0, y: 0 }, { x: 0.22, y: 0.2 }, { x: 0.7, y: 0.74 }, { x: 1, y: 1 }];
  if (preset === 'lift-shadows') return [{ x: 0, y: 0.05 }, { x: 0.16, y: 0.18 }, { x: 0.62, y: 0.66 }, { x: 1, y: 1 }];
  if (preset === 'cool-highlights' && channel === 'blue') return [{ x: 0, y: 0 }, { x: 0.66, y: 0.72 }, { x: 1, y: 1 }];
  return [{ x: 0, y: 0 }, { x: 0.25, y: 0.25 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.75 }, { x: 1, y: 1 }];
}

export function readSourceAssetFromNode(node: { type: string; data: Record<string, unknown> } | null) {
  if (!node) return null;
  const data = node.data || {};

  // 优先按节点类型判定：视频节点即便附带 image 缩略输出，也应识别为视频，
  // 否则「一键电影感 / 一键抠像」会把视频素材误判成图片而被拦截。
  if (node.type === 'video' && typeof data.videoUrl === 'string' && data.videoUrl.trim()) {
    return { kind: 'video' as const, url: data.videoUrl.trim() };
  }
  if (node.type === 'image' && typeof data.imageUrl === 'string' && data.imageUrl.trim()) {
    return { kind: 'image' as const, url: data.imageUrl.trim() };
  }

  const outputs = Array.isArray(data.outputs) ? data.outputs as Array<Record<string, unknown>> : [];
  const outputVideo = outputs.find((item) => item?.type === 'video' && typeof item.url === 'string');
  if (outputVideo?.url) return { kind: 'video' as const, url: String(outputVideo.url) };
  const outputImage = outputs.find((item) => item?.type === 'image' && typeof item.url === 'string');
  if (outputImage?.url) return { kind: 'image' as const, url: String(outputImage.url) };

  return null;
}

export function normalizePostLabel(value: unknown, fallback = '后期节点') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  const normalized = text.toLowerCase();
  if (
    normalized === 'post'
    || normalized === 'post node'
    || normalized === 'post-production'
    || normalized === 'post production'
    || normalized === '后期'
    || normalized === '后期节点'
  ) {
    return fallback;
  }
  return text;
}

export function useMediaNaturalSize(kind: PostMediaKind | null, url: string) {
  const [meta, setMeta] = useState<{ width: number; height: number; duration: number }>({
    width: 1280,
    height: 720,
    duration: 0,
  });

  useEffect(() => {
    let disposed = false;
    const nextUrl = String(url || '').trim();
    if (!kind || !nextUrl) return;

    if (kind === 'image') {
      const image = new window.Image();
      image.onload = () => {
        if (disposed) return;
        setMeta({
          width: image.naturalWidth || image.width || 1280,
          height: image.naturalHeight || image.height || 720,
          duration: 0,
        });
      };
      image.src = nextUrl;
      return () => {
        disposed = true;
      };
    }

    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      if (disposed) return;
      setMeta({
        width: video.videoWidth || 1280,
        height: video.videoHeight || 720,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
      });
      video.removeAttribute('src');
      video.load();
    };
    video.src = nextUrl;
    return () => {
      disposed = true;
      video.removeAttribute('src');
      video.load();
    };
  }, [kind, url]);

  return meta;
}

export function previewViewportSize(kind: PostMediaKind | null, meta: { width: number; height: number }) {
  const ratio = kind && meta.height > 0 ? meta.width / meta.height : 16 / 9;
  if (ratio >= 1) {
    const width = 504;
    return { width, height: Math.max(252, Math.round(width / ratio)) };
  }
  const height = 330;
  return { width: Math.max(220, Math.round(height * ratio)), height };
}

export function FieldLabel({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mb-1 flex items-center justify-between gap-3 text-[11px] text-[#cfcfcf]">
      <span>{title}</span>
      {note ? null : null}
    </div>
  );
}

export const ControlsDisabledContext = createContext(false);

export function PanelSection({
  title,
  note,
  children,
  className = '',
}: {
  title: string;
  note?: string;
  children: any;
  className?: string;
}) {
  return (
    <section className={`rounded-[24px] border border-[#2d3236] bg-[linear-gradient(180deg,#161a1e_0%,#0f1215_100%)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] ${className}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-[#eef3f8]">{title}</div>
          {note ? null : null}
        </div>
      </div>
      {children}
    </section>
  );
}

export function CollapsiblePanelSection({
  title,
  note,
  collapsed,
  onToggle,
  children,
  className = '',
  actions,
}: {
  title: string;
  note?: string;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}) {
  const disabled = useContext(ControlsDisabledContext);
  return (
    <section className={`rounded-[24px] border border-[#2d3236] bg-[linear-gradient(180deg,#161a1e_0%,#0f1215_100%)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          className="nodrag flex flex-1 items-start gap-3 text-left"
          onPointerDown={stopCanvasPointer}
          onClick={disabled ? undefined : onToggle}
          disabled={disabled}
        >
          <span className="mt-0.5 rounded-full border border-[#2d3236] bg-[#11161a] p-1 text-[#c7d2da]">
            {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </span>
          <span>
            <span className="block text-sm font-medium text-[#eef3f8]">{title}</span>
            {note ? null : null}
          </span>
        </button>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      {!collapsed ? <div className="mt-3">{children}</div> : null}
    </section>
  );
}

export function WheelCard({
  title,
  color,
  onColorChange,
  amount,
  onAmountChange,
  colorTestId,
  amountTestId,
}: {
  title: string;
  color: string;
  onColorChange: (value: string) => void;
  amount: number;
  onAmountChange: (value: number) => void;
  colorTestId?: PostFieldTestId;
  amountTestId?: PostFieldTestId;
}) {
  return (
    <div className="rounded-[18px] border border-[#2d3236] bg-[#121518] p-3">
      <ColorSwatchField title={title} value={color} onChange={onColorChange} testId={colorTestId} />
      <div className="mt-3">
        <SliderField title={`${title}权重`} value={amount} min={0} max={1} step={0.01} onChange={onAmountChange} testId={amountTestId} />
      </div>
    </div>
  );
}

export function SliderField({
  title,
  value,
  min,
  max,
  step = 0.01,
  format,
  onChange,
  testId,
}: {
  title: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  testId?: PostFieldTestId;
}) {
  const disabled = useContext(ControlsDisabledContext);
  const [draftValue, setDraftValue] = useState(value);
  const draggingRef = useRef(false);
  const syncDraftValue = useCallback((nextRawValue: string | number) => {
    const nextValue = Number(nextRawValue);
    if (!Number.isFinite(nextValue)) return;
    setDraftValue(nextValue);
    if (!draggingRef.current) {
      onChange(nextValue);
    }
  }, [onChange]);

  useEffect(() => {
    if (!draggingRef.current) {
      setDraftValue(value);
    }
  }, [value]);

  const note = format ? format(draftValue) : draftValue.toFixed(step >= 1 ? 0 : 2);
  const commitDraft = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    onChange(draftValue);
  }, [draftValue, onChange]);

  return (
    <label className="block rounded-2xl border border-[#2d3236] bg-[#121518] px-3 py-3 text-xs text-[#c9d2db]">
      <FieldLabel title={title} note={note} />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(draftValue) ? draftValue : min}
        onPointerDown={(event) => {
          stopCanvasPointer(event);
          draggingRef.current = true;
        }}
        onMouseDown={stopCanvasPointer}
        onTouchStart={stopCanvasPointer}
        onInput={(event) => syncDraftValue((event.target as HTMLInputElement).value)}
        onChange={(event) => syncDraftValue(event.target.value)}
        onPointerUp={() => commitDraft()}
        onMouseUp={() => commitDraft()}
        onTouchEnd={() => commitDraft()}
        onBlur={() => commitDraft()}
        aria-valuetext={note}
        data-testid={testId}
        disabled={disabled}
        className={sliderTrackClass()}
      />
    </label>
  );
}

export function ToggleField({
  title,
  checked,
  onChange,
  testId,
}: {
  title: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  testId?: PostFieldTestId;
}) {
  const disabled = useContext(ControlsDisabledContext);
  return (
    <label className={`flex items-center justify-between rounded-2xl border border-[#2d3236] bg-[#121518] px-3 py-3 text-sm text-[#eef3f8] ${disabled ? 'opacity-60' : ''}`}>
      <span>{title}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        onPointerDown={stopCanvasPointer}
        data-testid={testId}
        className="nodrag h-4 w-4 accent-[#00d4aa]"
      />
    </label>
  );
}

export function SelectField({
  title,
  value,
  options,
  onChange,
  testId,
}: {
  title: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  testId?: PostFieldTestId;
}) {
  const disabled = useContext(ControlsDisabledContext);
  const selectedLabel = options.find((option) => option.value === value)?.label;
  return (
    <div className="block">
      <FieldLabel title={title} note={selectedLabel} />
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          onPointerDown={stopCanvasPointer}
          onClick={stopCanvasPointer}
          disabled={disabled}
          data-testid={testId}
          className="nodrag nopan nowheel h-11 w-full rounded-2xl border border-[#2d3236] bg-[#121518] px-3 text-sm text-[#eef3f8] shadow-none hover:border-[#46515d] hover:bg-[#1b2024] focus:border-[#00d4aa]/45 focus:ring-0"
        >
          <SelectValue placeholder="请选择" />
        </SelectTrigger>
        <SelectContent
          position="popper"
          align="start"
          onPointerDown={stopCanvasPointer}
          className="nodrag nopan nowheel z-[1200] min-w-[var(--radix-select-trigger-width)] rounded-2xl border border-[#2d3236] bg-[#15191d] text-[#eef3f8]"
        >
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            onPointerDown={stopCanvasPointer}
            data-option-value={option.value}
            className="nodrag text-[#eef3f8] focus:bg-[#1d2427] focus:text-white data-[state=checked]:bg-[#163730] data-[state=checked]:text-[#dffff5]"
          >
            {option.label}
          </SelectItem>
        ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ColorSwatchField({
  title,
  value,
  onChange,
  testId,
}: {
  title: string;
  value: string;
  onChange: (value: string) => void;
  testId?: PostFieldTestId;
}) {
  const normalized = String(value || '#ffffff');
  const hex = normalized.startsWith('#') ? normalized : `#${normalized}`;
  return (
    <label className="block">
      <FieldLabel title={title} note={hex.toUpperCase()} />
      <div className="flex items-center gap-4 rounded-2xl border border-[#2d3236] bg-[#121518] px-3 py-3">
        <div className="relative h-24 w-24 shrink-0">
          <div className="absolute inset-0 rounded-full bg-[conic-gradient(from_180deg,rgba(255,0,0,1),rgba(255,255,0,1),rgba(0,255,0,1),rgba(0,255,255,1),rgba(0,0,255,1),rgba(255,0,255,1),rgba(255,0,0,1))]" />
          <div className="absolute inset-[12%] rounded-full bg-[radial-gradient(circle_at_center,rgba(255,255,255,1)_0%,rgba(255,255,255,0.96)_20%,rgba(255,255,255,0)_72%)]" />
          <div className="absolute inset-[28%] rounded-full border border-white/12 shadow-[inset_0_0_24px_rgba(255,255,255,0.18)]" style={{ backgroundColor: hex }} />
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/90 shadow-[0_0_0_2px_rgba(0,0,0,0.35)]" style={{ backgroundColor: hex }} />
          <input
            type="color"
            value={hex}
            onChange={(event) => onChange(event.target.value)}
            onPointerDown={stopCanvasPointer}
            data-testid={testId}
            className="nodrag absolute inset-0 cursor-pointer rounded-full opacity-0"
          />
        </div>
        <div className="space-y-2 text-xs leading-5 text-[#95a1ac]">
          <div>点击圆盘挑色，色轮偏色会参与 lift / gamma / gain / offset 的实际调色矩阵。</div>
          <div className="inline-flex rounded-full border border-[#2d3236] bg-[#0f1317] px-2.5 py-1 font-medium tracking-[0.12em] text-[#dfe7ee]">
            {hex.toUpperCase()}
          </div>
        </div>
      </div>
    </label>
  );
}

export function CurveEditorField({
  title,
  channel,
  points,
  onChange,
  onReset,
  testId,
}: {
  title: string;
  channel: CurveChannelKey;
  points: PostCurvePoint[];
  onChange: (value: PostCurvePoint[]) => void;
  onReset: () => void;
  testId?: PostFieldTestId;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const safePoints = useMemo(() => sanitizeCurvePoints(points, presetCurvePoints('linear', channel)), [points, channel]);
  const stroke = CURVE_CHANNEL_COLORS[channel];
  const chartWidth = CURVE_EDITOR_SIZE.width;
  const chartHeight = CURVE_EDITOR_SIZE.height;

  const commitPoint = useCallback((clientX: number, clientY: number) => {
    const dragIndex = dragIndexRef.current;
    const svg = svgRef.current;
    if (dragIndex === null || !svg) return;
    const rect = svg.getBoundingClientRect();
    const nextX = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const nextY = Math.min(1, Math.max(0, 1 - (clientY - rect.top) / rect.height));
    const nextPoints = safePoints.map((point, index) => {
      if (index !== dragIndex) return { ...point };
      if (index === 0) return { x: 0, y: 0 };
      if (index === safePoints.length - 1) return { x: 1, y: 1 };
      const prev = safePoints[index - 1];
      const next = safePoints[index + 1];
      return {
        x: Math.min(next.x - 0.04, Math.max(prev.x + 0.04, nextX)),
        y: nextY,
      };
    });
    onChange(sanitizeCurvePoints(nextPoints, presetCurvePoints('linear', channel)));
  }, [channel, onChange, safePoints]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (dragIndexRef.current === null) return;
      commitPoint(event.clientX, event.clientY);
    }
    function handlePointerUp() {
      dragIndexRef.current = null;
    }
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [commitPoint]);

  const pathD = safePoints
    .map((point, index) => {
      const x = point.x * chartWidth;
      const y = (1 - point.y) * chartHeight;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <div className="rounded-xl border border-white/8 bg-[#0f0f10] p-3" data-testid={testId}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-[#ececec]">{title}</div>
          <div className="text-[11px] text-[#8f8f8f]">拖动控制点会直接写入真实曲线，不再只靠预设名称。</div>
        </div>
        <button
          type="button"
          className="rounded-lg border border-white/10 px-2 py-1 text-[11px] text-[#d8d8d8] hover:bg-white/8"
          onPointerDown={stopCanvasPointer}
          onClick={onReset}
        >
          重置
        </button>
      </div>
      <svg
        ref={svgRef}
        width={chartWidth}
        height={chartHeight}
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        onPointerDown={stopCanvasPointer}
        className="nodrag block w-full overflow-visible rounded-lg border border-white/8 bg-[#090909]"
      >
        {[0.25, 0.5, 0.75].map((mark) => (
          <g key={mark}>
            <line x1={mark * chartWidth} y1={0} x2={mark * chartWidth} y2={chartHeight} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
            <line x1={0} y1={mark * chartHeight} x2={chartWidth} y2={mark * chartHeight} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
          </g>
        ))}
        <line x1={0} y1={chartHeight} x2={chartWidth} y2={0} stroke="rgba(255,255,255,0.18)" strokeWidth="1" strokeDasharray="4 4" />
        <path d={pathD} fill="none" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        {safePoints.map((point, index) => {
          const x = point.x * chartWidth;
          const y = (1 - point.y) * chartHeight;
          const locked = index === 0 || index === safePoints.length - 1;
          return (
            <g key={`${channel}-${index}`} transform={`translate(${x}, ${y})`}>
              <circle r="7" fill="rgba(0,0,0,0.72)" stroke={stroke} strokeWidth="1.5" />
              <circle
                r="11"
                fill="transparent"
                className={locked ? 'cursor-default' : 'cursor-grab'}
                onPointerDown={(event) => {
                  stopCanvasPointer(event);
                  if (locked) return;
                  dragIndexRef.current = index;
                  commitPoint(event.clientX, event.clientY);
                }}
              />
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex items-center justify-between text-[11px] text-[#8f8f8f]">
        <span>阴影</span>
        <span>中间调</span>
        <span>高光</span>
      </div>
    </div>
  );
}

export type ScopeStats = {
  histR: number[];
  histG: number[];
  histB: number[];
  histLuma: number[];
  waveformMin: number[];
  waveformMax: number[];
  waveformAvg: number[];
  paradeR: number[];
  paradeG: number[];
  paradeB: number[];
  vectorscopePoints: Array<{ x: number; y: number; color: string; alpha: number }>;
  sampleLabel: string;
  sampleMoments: number[];
  sampleMode: 'image' | 'video';
};

export type ScopeSampleDensity = 'sparse' | 'standard' | 'dense';

export type LocalPostBackendStatus = {
  configured: boolean;
  commandConfigured: boolean;
  detectedPath: string;
  detectedConfigPath?: string;
  wrapperScript: string;
  exampleRuntimePath: string;
  runtimeName?: string;
  envPath?: string;
  envCommand?: string;
  docsUrl?: string;
  downloadUrl?: string;
  installHint?: string;
  successHint?: string;
  commonInstallPaths?: string[];
  supportsImage?: boolean;
  supportsVideo?: boolean;
};

export type RuntimeUpdateStatus = {
  supported: boolean;
  checkedAt: string;
  sourceLabel: string;
  releaseUrl: string;
  latestVersion: string;
  installedVersion: string;
  updateAvailable: boolean;
  status: 'error' | 'unknown' | 'latest-known' | 'up-to-date' | 'update-available';
  summary: string;
  error: string;
};

export type LocalPostDoctorRuntime = {
  runtimeKey: string;
  runtimeName: string;
  status: 'ok' | 'warn' | 'error';
  summary: string;
  detectedPath?: string;
  detectedConfigPath?: string;
  executableVerified?: boolean;
  runtimeConfigured?: boolean;
  commandConfigured?: boolean;
  installedVersion?: string;
  checkedCommand?: string[];
  stdout?: string;
  stderr?: string;
  elapsedMs?: number;
  configVerified?: boolean;
  configReadable?: boolean;
  configSummary?: string;
  configStdout?: string;
  configStderr?: string;
  suggestions?: string[];
  update?: RuntimeUpdateStatus;
};

export type LocalPostDoctorReport = {
  checkedAt: string;
  runtimes: {
    ocio?: LocalPostDoctorRuntime;
    oiio?: LocalPostDoctorRuntime;
    gmic?: LocalPostDoctorRuntime;
  };
};

export type PostHealthStatus = {
  ocio: LocalPostBackendStatus | null;
  oiio: LocalPostBackendStatus | null;
  gmic: LocalPostBackendStatus | null;
  upscale: Record<string, LocalPostBackendStatus>;
};

export type OcioSetupValidation = {
  severity: 'ok' | 'warn' | 'error';
  title: string;
  details: string[];
};

export type OcioConfigInspection = {
  status: 'idle' | 'loading' | 'ok' | 'warn' | 'error';
  title: string;
  details: string[];
  detectedSections: string[];
  profileVersion: string;
  formatLabel: string;
};

export const SUPPORTED_OCIO_CONFIG_EXTENSIONS = ['.ocio', '.yaml', '.yml', '.json', '.cfg', '.txt'] as const;
export const VECTORSCOPE_HUE_TARGET_PRESETS = {
  'rec709': [
    { label: 'R', degrees: 0, color: 'rgba(248,113,113,0.92)' },
    { label: 'Mg', degrees: 58, color: 'rgba(217,70,239,0.92)' },
    { label: 'B', degrees: 122, color: 'rgba(96,165,250,0.92)' },
    { label: 'Cy', degrees: 180, color: 'rgba(34,211,238,0.92)' },
    { label: 'G', degrees: 238, color: 'rgba(74,222,128,0.92)' },
    { label: 'Yl', degrees: 302, color: 'rgba(250,204,21,0.92)' },
  ],
  'ebu': [
    { label: 'R', degrees: 0, color: 'rgba(248,113,113,0.92)' },
    { label: 'Mg', degrees: 63, color: 'rgba(217,70,239,0.92)' },
    { label: 'B', degrees: 128, color: 'rgba(96,165,250,0.92)' },
    { label: 'Cy', degrees: 186, color: 'rgba(34,211,238,0.92)' },
    { label: 'G', degrees: 246, color: 'rgba(74,222,128,0.92)' },
    { label: 'Yl', degrees: 309, color: 'rgba(250,204,21,0.92)' },
  ],
  'smpte-c': [
    { label: 'R', degrees: 0, color: 'rgba(248,113,113,0.92)' },
    { label: 'Mg', degrees: 54, color: 'rgba(217,70,239,0.92)' },
    { label: 'B', degrees: 117, color: 'rgba(96,165,250,0.92)' },
    { label: 'Cy', degrees: 175, color: 'rgba(34,211,238,0.92)' },
    { label: 'G', degrees: 233, color: 'rgba(74,222,128,0.92)' },
    { label: 'Yl', degrees: 296, color: 'rgba(250,204,21,0.92)' },
  ],
} as const;

export function rgbToHsl(red: number, green: number, blue: number) {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  let hue = 0;
  let saturation = 0;
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta > 0.00001) {
    saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    switch (max) {
      case red:
        hue = ((green - blue) / delta + (green < blue ? 6 : 0)) / 6;
        break;
      case green:
        hue = ((blue - red) / delta + 2) / 6;
        break;
      default:
        hue = ((red - green) / delta + 4) / 6;
        break;
    }
  }
  return { hue, saturation, lightness };
}

export function hueToRgb(partial1: number, partial2: number, hue: number) {
  let nextHue = hue;
  if (nextHue < 0) nextHue += 1;
  if (nextHue > 1) nextHue -= 1;
  if (nextHue < 1 / 6) return partial1 + (partial2 - partial1) * 6 * nextHue;
  if (nextHue < 1 / 2) return partial2;
  if (nextHue < 2 / 3) return partial1 + (partial2 - partial1) * (2 / 3 - nextHue) * 6;
  return partial1;
}

export function hslToRgb(hue: number, saturation: number, lightness: number) {
  if (saturation <= 0.00001) {
    return { red: lightness, green: lightness, blue: lightness };
  }
  const partial2 = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const partial1 = 2 * lightness - partial2;
  return {
    red: hueToRgb(partial1, partial2, hue + 1 / 3),
    green: hueToRgb(partial1, partial2, hue),
    blue: hueToRgb(partial1, partial2, hue - 1 / 3),
  };
}

export function applyScopeLook(redByte: number, greenByte: number, blueByte: number, color: PostEffectsState['color']) {
  let red = redByte / 255;
  let green = greenByte / 255;
  let blue = blueByte / 255;
  const exposure = 1 + color.exposure * 0.7;
  red *= exposure;
  green *= exposure;
  blue *= exposure;
  const contrast = 1 + color.contrast * 0.85;
  red = (red - 0.5) * contrast + 0.5;
  green = (green - 0.5) * contrast + 0.5;
  blue = (blue - 0.5) * contrast + 0.5;

  const { hue, saturation, lightness } = rgbToHsl(red, green, blue);
  const shiftedHue = (hue + color.hue / 360 + 1) % 1;
  const nextSaturation = Math.max(0, Math.min(1.8, saturation * color.saturation + color.vibrance * 0.16));
  const nextLightness = Math.max(0, Math.min(1, lightness));
  const hslRgb = hslToRgb(shiftedHue, nextSaturation, nextLightness);
  red = hslRgb.red;
  green = hslRgb.green;
  blue = hslRgb.blue;

  red += color.temperature * 0.08 + color.tint * 0.02;
  green += color.tint < 0 ? -color.tint * 0.03 : -color.tint * 0.015;
  blue += -color.temperature * 0.08 - color.tint * 0.02;
  red = Math.pow(Math.max(0, red + color.lift * 0.08), 1 / Math.max(0.2, color.gamma)) * color.gain;
  green = Math.pow(Math.max(0, green + color.lift * 0.05), 1 / Math.max(0.2, color.gamma)) * color.gain;
  blue = Math.pow(Math.max(0, blue + color.lift * 0.08), 1 / Math.max(0.2, color.gamma)) * color.gain;
  red += color.offset * 0.06;
  green += color.offset * 0.04;
  blue += color.offset * 0.06;

  return {
    red: Math.max(0, Math.min(1, red)),
    green: Math.max(0, Math.min(1, green)),
    blue: Math.max(0, Math.min(1, blue)),
  };
}

export function buildScopeStats(imageData: ImageData, color: PostEffectsState['color']): ScopeStats {
  const bins = 64;
  const columns = 96;
  const histR = Array.from({ length: bins }, () => 0);
  const histG = Array.from({ length: bins }, () => 0);
  const histB = Array.from({ length: bins }, () => 0);
  const histLuma = Array.from({ length: bins }, () => 0);
  const waveformMin = Array.from({ length: columns }, () => 1);
  const waveformMax = Array.from({ length: columns }, () => 0);
  const waveformSum = Array.from({ length: columns }, () => 0);
  const waveformCount = Array.from({ length: columns }, () => 0);
  const paradeR = Array.from({ length: columns }, () => 0);
  const paradeG = Array.from({ length: columns }, () => 0);
  const paradeB = Array.from({ length: columns }, () => 0);
  const paradeCount = Array.from({ length: columns }, () => 0);
  const vectorscopePoints: Array<{ x: number; y: number; color: string; alpha: number }> = [];
  const { data, width, height } = imageData;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const adjusted = applyScopeLook(data[index], data[index + 1], data[index + 2], color);
      const luma = adjusted.red * 0.2126 + adjusted.green * 0.7152 + adjusted.blue * 0.0722;
      histR[Math.min(bins - 1, Math.floor(adjusted.red * bins))] += 1;
      histG[Math.min(bins - 1, Math.floor(adjusted.green * bins))] += 1;
      histB[Math.min(bins - 1, Math.floor(adjusted.blue * bins))] += 1;
      histLuma[Math.min(bins - 1, Math.floor(luma * bins))] += 1;
      const column = Math.min(columns - 1, Math.floor((x / Math.max(1, width - 1)) * columns));
      waveformMin[column] = Math.min(waveformMin[column], luma);
      waveformMax[column] = Math.max(waveformMax[column], luma);
      waveformSum[column] += luma;
      waveformCount[column] += 1;
      paradeR[column] += adjusted.red;
      paradeG[column] += adjusted.green;
      paradeB[column] += adjusted.blue;
      paradeCount[column] += 1;

      if (x % 6 === 0 && y % 6 === 0) {
        const u = (adjusted.blue - luma) * 0.492;
        const v = (adjusted.red - luma) * 0.877;
        vectorscopePoints.push({
          x: Math.max(0.06, Math.min(0.94, 0.5 + v * 0.62)),
          y: Math.max(0.06, Math.min(0.94, 0.5 - u * 0.62)),
          color: `rgb(${Math.round(adjusted.red * 255)}, ${Math.round(adjusted.green * 255)}, ${Math.round(adjusted.blue * 255)})`,
          alpha: Math.max(0.16, Math.min(0.72, 0.22 + (Math.max(adjusted.red, adjusted.green, adjusted.blue) - Math.min(adjusted.red, adjusted.green, adjusted.blue)) * 0.4)),
        });
      }
    }
  }

  const normalize = (values: number[]) => {
    const max = Math.max(1, ...values);
    return values.map((value) => value / max);
  };

  return {
    histR: normalize(histR),
    histG: normalize(histG),
    histB: normalize(histB),
    histLuma: normalize(histLuma),
    waveformMin,
    waveformMax,
    waveformAvg: waveformSum.map((value, index) => waveformCount[index] > 0 ? value / waveformCount[index] : 0),
    paradeR: paradeR.map((value, index) => paradeCount[index] > 0 ? value / paradeCount[index] : 0),
    paradeG: paradeG.map((value, index) => paradeCount[index] > 0 ? value / paradeCount[index] : 0),
    paradeB: paradeB.map((value, index) => paradeCount[index] > 0 ? value / paradeCount[index] : 0),
    vectorscopePoints,
    sampleLabel: `${width} x ${height}`,
    sampleMoments: [0],
    sampleMode: 'image',
  };
}

export function mergeScopeStats(statsList: ScopeStats[], options: { sampleLabel: string; sampleMoments: number[]; sampleMode: 'image' | 'video' }): ScopeStats {
  const fallback = statsList[0];
  if (!fallback) {
    return {
      histR: [],
      histG: [],
      histB: [],
      histLuma: [],
      waveformMin: [],
      waveformMax: [],
      waveformAvg: [],
      paradeR: [],
      paradeG: [],
      paradeB: [],
      vectorscopePoints: [],
      sampleLabel: options.sampleLabel,
      sampleMoments: options.sampleMoments,
      sampleMode: options.sampleMode,
    };
  }
  const mean = (key: keyof ScopeStats) => {
    const source = fallback[key] as unknown as number[];
    return source.map((_, index) => statsList.reduce((sum, item) => sum + (((item[key] as unknown as number[])[index]) || 0), 0) / Math.max(1, statsList.length));
  };
  const waveformMin = fallback.waveformMin.map((_, index) => Math.min(...statsList.map((item) => item.waveformMin[index] ?? 1)));
  const waveformMax = fallback.waveformMax.map((_, index) => Math.max(...statsList.map((item) => item.waveformMax[index] ?? 0)));
  const vectorscopePoints = statsList.flatMap((item, frameIndex) =>
    item.vectorscopePoints.filter((_, index) => (index + frameIndex) % 2 === 0),
  ).slice(0, 2600);
  return {
    histR: mean('histR'),
    histG: mean('histG'),
    histB: mean('histB'),
    histLuma: mean('histLuma'),
    waveformMin,
    waveformMax,
    waveformAvg: mean('waveformAvg'),
    paradeR: mean('paradeR'),
    paradeG: mean('paradeG'),
    paradeB: mean('paradeB'),
    vectorscopePoints,
    sampleLabel: options.sampleLabel,
    sampleMoments: options.sampleMoments,
    sampleMode: options.sampleMode,
  };
}

export function formatScopeMoment(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0.0s';
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
}

export function isSupportedOcioConfigName(name: string) {
  const normalized = String(name || '').trim().toLowerCase();
  return SUPPORTED_OCIO_CONFIG_EXTENSIONS.some((ext) => normalized.endsWith(ext));
}

export function buildSampleMoments(duration: number, density: ScopeSampleDensity) {
  if (!(duration > 0)) return [0];
  const ratios = density === 'sparse'
    ? [0, 0.5, 0.999]
    : density === 'dense'
      ? [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 0.999]
      : [0, 0.25, 0.5, 0.75, 0.999];
  return Array.from(new Set(
    ratios.map((ratio) => Number((ratio >= 0.999 ? Math.max(0, duration - 0.04) : duration * ratio).toFixed(3))),
  )).sort((left, right) => left - right);
}

export function inspectOcioConfigText(fileName: string, source: string): OcioConfigInspection {
  const text = String(source || '');
  const normalizedName = String(fileName || '').trim();
  const lowerName = normalizedName.toLowerCase();
  const formatLabel = lowerName.endsWith('.json')
    ? 'JSON Config'
    : lowerName.endsWith('.yaml') || lowerName.endsWith('.yml')
      ? 'YAML Config'
      : lowerName.endsWith('.cfg') || lowerName.endsWith('.txt')
        ? '文本 Config'
        : 'OCIO Config';
  if (!text.trim()) {
    return {
      status: 'error',
      title: '当前 OCIO Config 文件为空，无法建立可执行结构。',
      details: ['请导入包含 ocio_profile_version、colorspaces 等结构的有效配置文件。'],
      detectedSections: [],
      profileVersion: '',
      formatLabel,
    };
  }

  const sectionLabels = [
    { key: 'roles', label: 'roles' },
    { key: 'displays', label: 'displays' },
    { key: 'views', label: 'views' },
    { key: 'looks', label: 'looks' },
    { key: 'colorspaces', label: 'colorspaces' },
  ] as const;

  let profileVersion = '';
  let detectedSections: string[] = [];
  let parseError = '';

  if (lowerName.endsWith('.json')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const readField = (value: unknown) => {
        if (typeof value === 'string' || typeof value === 'number') return String(value);
        return '';
      };
      profileVersion = readField(parsed.ocio_profile_version ?? parsed.ocioProfileVersion);
      detectedSections = sectionLabels
        .filter(({ key }) => {
          const value = parsed[key];
          if (Array.isArray(value)) return value.length > 0;
          if (value && typeof value === 'object') return Object.keys(value).length > 0;
          return false;
        })
        .map(({ label }) => label);
    } catch (error) {
      parseError = error instanceof Error ? error.message : 'json-parse-failed';
    }
  } else {
    const sectionRegex = {
      roles: /^\s*roles\s*:/im,
      displays: /^\s*displays\s*:/im,
      views: /^\s*views\s*:/im,
      looks: /^\s*looks\s*:/im,
      colorspaces: /^\s*colorspaces\s*:/im,
    } as const;
    const versionMatch = text.match(/^\s*ocio_profile_version\s*:\s*("?)([0-9A-Za-z._-]+)\1/im);
    profileVersion = versionMatch?.[2] || '';
    detectedSections = sectionLabels.filter(({ key }) => sectionRegex[key].test(text)).map(({ label }) => label);
  }

  if (parseError) {
    return {
      status: 'error',
      title: '当前 JSON 版 OCIO Config 解析失败。',
      details: [
        `解析错误：${parseError}`,
        '请确认文件是可读的 JSON，并包含 ocio_profile_version、colorspaces 等必要字段。',
      ],
      detectedSections: [],
      profileVersion: '',
      formatLabel,
    };
  }

  const hasProfile = Boolean(profileVersion);
  const hasColorspaces = detectedSections.includes('colorspaces');
  const hasExecutionRouting = detectedSections.some((item) => item === 'roles' || item === 'displays' || item === 'views');
  if (!hasProfile || !hasColorspaces) {
    return {
      status: 'error',
      title: '当前 OCIO Config 缺少可执行的基础结构。',
      details: [
        hasProfile ? `已检测到 profile 版本：${profileVersion}` : '未检测到 ocio_profile_version。',
        hasColorspaces ? '已检测到 colorspaces。' : '未检测到 colorspaces，外部 Wrapper 无法建立颜色空间映射。',
        detectedSections.length ? `已识别结构：${detectedSections.join(' / ')}` : '尚未识别到 roles / displays / colorspaces / views 等核心结构。',
      ],
      detectedSections,
      profileVersion,
      formatLabel,
    };
  }
  if (!hasExecutionRouting) {
    return {
      status: 'warn',
      title: '当前 OCIO Config 具备基础色彩空间定义，但执行路由信息不完整。',
      details: [
        `已检测到 profile 版本：${profileVersion}`,
        '已识别 colorspaces，但缺少 roles / displays / views 之一；可用于基础转换，不利于完整工作室视图链路。',
        `已识别结构：${detectedSections.join(' / ')}`,
      ],
      detectedSections,
      profileVersion,
      formatLabel,
    };
  }
  return {
    status: 'ok',
    title: '当前 OCIO Config 结构完整，可进入真实执行链路。',
    details: [
      `已检测到 profile 版本：${profileVersion}`,
      `已识别结构：${detectedSections.join(' / ')}`,
    ],
    detectedSections,
    profileVersion,
    formatLabel,
  };
}

export function ScopeWorkbench({
  sourceKind,
  sourceUrl,
  color,
  linkedChannel = 'master',
  onLinkedChannelChange,
  testId,
}: {
  sourceKind: PostMediaKind | null;
  sourceUrl: string;
  color: PostEffectsState['color'];
  linkedChannel?: CurveChannelKey;
  onLinkedChannelChange?: (channel: CurveChannelKey) => void;
  testId?: string;
}) {
  const [scopeStats, setScopeStats] = useState<ScopeStats | null>(null);
  const [frozenScopeStats, setFrozenScopeStats] = useState<ScopeStats | null>(null);
  const [scopeError, setScopeError] = useState('');
  const [sampleDensity, setSampleDensity] = useState<ScopeSampleDensity>('standard');
  const [scopeDuration, setScopeDuration] = useState(0);
  const [liveFrameMoment, setLiveFrameMoment] = useState(0);
  const [frozenFrameMoment, setFrozenFrameMoment] = useState<number | null>(null);
  const [scopeViewMode, setScopeViewMode] = useState<'aggregate' | 'freeze'>('aggregate');
  const [vectorscopeTargetPreset, setVectorscopeTargetPreset] = useState<'rec709' | 'ebu' | 'smpte-c'>('rec709');

  useEffect(() => {
    if (sourceKind !== 'video' || !sourceUrl) {
      setScopeDuration(0);
      setLiveFrameMoment(0);
      setFrozenFrameMoment(null);
      setFrozenScopeStats(null);
      setScopeViewMode('aggregate');
      return;
    }
    let disposed = false;
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    const handleTime = () => {
      if (disposed) return;
      const nextMoment = Number((video.currentTime || 0).toFixed(3));
      setLiveFrameMoment((current) => Math.abs(current - nextMoment) >= 0.08 ? nextMoment : current);
    };
    video.addEventListener('timeupdate', handleTime);
    video.addEventListener('loadeddata', () => {
      void video.play().catch(() => undefined);
    }, { once: true });
    video.src = sourceUrl;
    return () => {
      disposed = true;
      video.pause();
      video.removeEventListener('timeupdate', handleTime);
      video.removeAttribute('src');
      video.load();
    };
  }, [sourceKind, sourceUrl]);

  useEffect(() => {
    if (!frozenScopeStats && scopeViewMode === 'freeze') {
      setScopeViewMode('aggregate');
    }
  }, [frozenScopeStats, scopeViewMode]);

  useEffect(() => {
    let disposed = false;
    async function collectScope() {
      if (!sourceKind || !sourceUrl) {
        setScopeStats(null);
        setScopeError('');
        setScopeDuration(0);
        return;
      }
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 144;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('canvas-context-missing');

        if (sourceKind === 'image') {
          const image = new window.Image();
          image.crossOrigin = 'anonymous';
          await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('scope-image-load-failed'));
            image.src = sourceUrl;
          });
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const stats = buildScopeStats(context.getImageData(0, 0, canvas.width, canvas.height), color);
          if (disposed) return;
          setScopeDuration(0);
          setScopeStats({
            ...stats,
            sampleMode: 'image',
            sampleMoments: [0],
          });
        } else {
          const video = document.createElement('video');
          video.crossOrigin = 'anonymous';
          video.muted = true;
          video.preload = 'auto';
          await new Promise<void>((resolve, reject) => {
            video.onloadeddata = () => resolve();
            video.onerror = () => reject(new Error('scope-video-load-failed'));
            video.src = sourceUrl;
          });
          const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
          setScopeDuration(duration);
          const sampleMoments = buildSampleMoments(duration, sampleDensity);
          const frameStats: ScopeStats[] = [];
          const frameStatsByMoment = new Map<number, ScopeStats>();
          for (const moment of sampleMoments) {
            await new Promise<void>((resolve, reject) => {
              const targetTime = Math.max(0, Math.min(duration || 0, moment));
              if (Math.abs((video.currentTime || 0) - targetTime) < 0.02) {
                resolve();
                return;
              }
              const handleSeeked = () => {
                video.removeEventListener('seeked', handleSeeked);
                video.removeEventListener('error', handleError);
                resolve();
              };
              const handleError = () => {
                video.removeEventListener('seeked', handleSeeked);
                video.removeEventListener('error', handleError);
                reject(new Error('scope-video-seek-failed'));
              };
              video.addEventListener('seeked', handleSeeked, { once: true });
              video.addEventListener('error', handleError, { once: true });
              try {
                video.currentTime = targetTime;
              } catch {
                video.removeEventListener('seeked', handleSeeked);
                video.removeEventListener('error', handleError);
                resolve();
              }
            });
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const stats = buildScopeStats(context.getImageData(0, 0, canvas.width, canvas.height), color);
            frameStats.push(stats);
            frameStatsByMoment.set(moment, stats);
          }
          let frozenStats: ScopeStats | null = null;
          if (frozenFrameMoment !== null) {
            const frozenMoment = Number(Math.max(0, Math.min(duration || 0, frozenFrameMoment)).toFixed(3));
            frozenStats = frameStatsByMoment.get(frozenMoment) || null;
            if (!frozenStats) {
              await new Promise<void>((resolve, reject) => {
                if (Math.abs((video.currentTime || 0) - frozenMoment) < 0.02) {
                  resolve();
                  return;
                }
                const handleSeeked = () => {
                  video.removeEventListener('seeked', handleSeeked);
                  video.removeEventListener('error', handleError);
                  resolve();
                };
                const handleError = () => {
                  video.removeEventListener('seeked', handleSeeked);
                  video.removeEventListener('error', handleError);
                  reject(new Error('scope-video-freeze-seek-failed'));
                };
                video.addEventListener('seeked', handleSeeked, { once: true });
                video.addEventListener('error', handleError, { once: true });
                try {
                  video.currentTime = frozenMoment;
                } catch {
                  video.removeEventListener('seeked', handleSeeked);
                  video.removeEventListener('error', handleError);
                  resolve();
                }
              });
              context.clearRect(0, 0, canvas.width, canvas.height);
              context.drawImage(video, 0, 0, canvas.width, canvas.height);
              frozenStats = buildScopeStats(context.getImageData(0, 0, canvas.width, canvas.height), color);
            }
          }
          video.removeAttribute('src');
          video.load();
          if (disposed) return;
          setFrozenScopeStats(frozenStats ? {
            ...frozenStats,
            sampleLabel: `${canvas.width} x ${canvas.height} · 冻结帧 ${formatScopeMoment(frozenFrameMoment ?? 0)}`,
            sampleMoments: frozenFrameMoment === null ? [] : [Number(frozenFrameMoment.toFixed(3))],
            sampleMode: 'video',
          } : null);
          setScopeStats(mergeScopeStats(frameStats, {
            sampleLabel: `${canvas.width} x ${canvas.height} · ${frameStats.length} 帧`,
            sampleMoments,
            sampleMode: 'video',
          }));
        }
        setScopeError('');
      } catch (error) {
        if (disposed) return;
        setScopeStats(null);
        setScopeError(error instanceof Error ? error.message : 'scope-unavailable');
      }
    }
    void collectScope();
    return () => {
      disposed = true;
    };
  }, [color, frozenFrameMoment, sampleDensity, sourceKind, sourceUrl]);

  const histogramPath = useCallback((values: number[]) => values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * 320;
    const y = 120 - value * 112;
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' '), []);

  const waveformPath = useCallback((values: number[]) => values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * 320;
    const y = 120 - value * 112;
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' '), []);
  const skinToneAngle = -33 * Math.PI / 180;
  const skinToneX = 160 + Math.cos(skinToneAngle) * 58;
  const skinToneY = 60 + Math.sin(skinToneAngle) * 42;
  const displayedScopeStats = scopeViewMode === 'freeze' && frozenScopeStats ? frozenScopeStats : scopeStats;
  const vectorscopeTargets = VECTORSCOPE_HUE_TARGET_PRESETS[vectorscopeTargetPreset];
  const linkedChannelLabel = linkedChannel === 'red'
    ? '红通道'
    : linkedChannel === 'green'
      ? '绿通道'
      : linkedChannel === 'blue'
        ? '蓝通道'
        : '主曲线';
  const channelTone = {
    master: {
      hist: ['rgba(255,255,255,0.72)', 'rgba(248,113,113,0.95)', 'rgba(74,222,128,0.95)', 'rgba(96,165,250,0.95)'],
      paradeOpacity: [1, 1, 1],
      paradeStrokeWidth: [1.6, 1.6, 1.6],
    },
    red: {
      hist: ['rgba(255,255,255,0.18)', 'rgba(248,113,113,0.98)', 'rgba(74,222,128,0.22)', 'rgba(96,165,250,0.22)'],
      paradeOpacity: [1, 0.16, 0.16],
      paradeStrokeWidth: [2.4, 1, 1],
    },
    green: {
      hist: ['rgba(255,255,255,0.18)', 'rgba(248,113,113,0.22)', 'rgba(74,222,128,0.98)', 'rgba(96,165,250,0.22)'],
      paradeOpacity: [0.16, 1, 0.16],
      paradeStrokeWidth: [1, 2.4, 1],
    },
    blue: {
      hist: ['rgba(255,255,255,0.18)', 'rgba(248,113,113,0.22)', 'rgba(74,222,128,0.22)', 'rgba(96,165,250,0.98)'],
      paradeOpacity: [0.16, 0.16, 1],
      paradeStrokeWidth: [1, 1, 2.4],
    },
  }[linkedChannel];

  return (
    <div className="rounded-[22px] border border-[#2d3236] bg-[#121518] p-4" data-testid={testId}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-[#eef3f8]">专业示波器</div>
          <div className="mt-1 text-[11px] text-[#94a0aa]">
            {displayedScopeStats ? `基于 ${displayedScopeStats.sampleLabel} 采样，按当前调色参数实时重算。` : '正在采样当前素材首帧。'}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-full border border-[#325a63] bg-[#112026] px-2.5 py-1 text-[#a9e9dc]">当前联动：{linkedChannelLabel}</span>
            {([
              { id: 'master' as const, label: '主曲线' },
              { id: 'red' as const, label: 'R' },
              { id: 'green' as const, label: 'G' },
              { id: 'blue' as const, label: 'B' },
            ]).map((item) => (
              <button
                key={item.id}
                type="button"
                className={`rounded-full border px-2.5 py-1 transition ${linkedChannel === item.id ? 'border-[#4e8477] bg-[#17312b] text-[#d8fff7]' : 'border-[#2d3236] bg-[#11161a] text-[#bac6cf] hover:border-[#46515d] hover:bg-[#151a1f]'}`}
                onPointerDown={stopCanvasPointer}
                onClick={() => onLinkedChannelChange?.(item.id)}
                data-testid={testId ? `${testId}-linked-channel-${item.id}` : undefined}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="rounded-full border border-[#2d3236] bg-[#0f1317] px-2.5 py-1 text-[11px] text-[#8fdcca]">
            {displayedScopeStats?.sampleMode === 'video' ? (scopeViewMode === 'freeze' && frozenScopeStats ? '冻结帧对比' : '视频时间轴抽样') : '图片单帧采样'}
          </div>
          {sourceKind === 'video' ? (
            <>
              <div className="flex items-center gap-1 rounded-full border border-[#2d3236] bg-[#0f1317] p-1 text-[11px] text-[#b9c5ce]" data-testid={testId ? `${testId}-sample-density` : undefined}>
                {[
                  { value: 'sparse' as const, label: '稀疏' },
                  { value: 'standard' as const, label: '标准' },
                  { value: 'dense' as const, label: '精细' },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`rounded-full px-2.5 py-1 transition ${sampleDensity === option.value ? 'bg-[#17312b] text-[#d8fff7]' : 'text-[#b9c5ce] hover:bg-[#161c21] hover:text-[#eef3f8]'}`}
                    onPointerDown={stopCanvasPointer}
                    onClick={() => setSampleDensity(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {frozenScopeStats ? (
                <button
                  type="button"
                  className="rounded-full border border-[#2d3236] bg-[#0f1317] px-2.5 py-1 text-[11px] text-[#d3e4ef] transition hover:border-[#46515d] hover:bg-[#151a1f]"
                  onPointerDown={stopCanvasPointer}
                  onClick={() => setScopeViewMode((current) => current === 'freeze' ? 'aggregate' : 'freeze')}
                  data-testid={testId ? `${testId}-freeze-toggle` : undefined}
                >
                  {scopeViewMode === 'freeze' ? '查看时间轴汇总' : '查看冻结帧'}
                </button>
              ) : null}
              {frozenFrameMoment !== null ? (
                <button
                  type="button"
                  className="rounded-full border border-[#2d3236] bg-[#0f1317] px-2.5 py-1 text-[11px] text-[#9fb0bc] transition hover:border-[#46515d] hover:bg-[#151a1f] hover:text-[#eef3f8]"
                  onPointerDown={stopCanvasPointer}
                  onClick={() => {
                    setFrozenFrameMoment(null);
                    setFrozenScopeStats(null);
                    setScopeViewMode('aggregate');
                  }}
                >
                  清除冻结
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {displayedScopeStats ? (
        <div className="space-y-4">
          {scopeStats?.sampleMode === 'video' ? (
            <div className="rounded-2xl border border-[#2d3236] bg-[#0f1317] px-3 py-3 text-xs text-[#9fb0bc]">
              <div className="mb-2 flex items-center justify-between gap-3 text-[#e6edf3]">
                <span>时间轴抽样</span>
                <span>{scopeStats.sampleMoments.length} 个采样点</span>
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-full border border-[#2d3236] bg-[#11161a] px-2.5 py-1 text-[11px] text-[#d3e4ef] transition hover:border-[#46515d] hover:bg-[#151a1f]"
                  onPointerDown={stopCanvasPointer}
                  onClick={() => {
                    setFrozenFrameMoment(Number(liveFrameMoment.toFixed(3)));
                    setScopeViewMode('freeze');
                  }}
                  data-testid={testId ? `${testId}-freeze-frame` : undefined}
                >
                  冻结当前帧 {formatScopeMoment(liveFrameMoment)}
                </button>
                <span className="rounded-full border border-[#2d3236] bg-[#11161a] px-2.5 py-1 text-[11px] text-[#c8d2da]">
                  当前播放位置 {formatScopeMoment(liveFrameMoment)}
                </span>
              </div>
              <div className="relative mb-3 rounded-2xl border border-[#2d3236] bg-[#0d1013] px-3 py-3" data-testid={testId ? `${testId}-freeze-timeline` : undefined}>
                <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-[#dce5ec]">
                  <span>冻结帧时间条</span>
                  <span>{scopeDuration > 0 ? `总时长 ${formatScopeMoment(scopeDuration)}` : '等待时长元数据'}</span>
                </div>
                <div
                  className="relative h-8 rounded-full border border-[#23282d] bg-[#12171b]"
                  onPointerDown={(event) => {
                    stopCanvasPointer(event);
                    const rect = event.currentTarget.getBoundingClientRect();
                    if (!rect.width || scopeDuration <= 0) return;
                    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
                    setFrozenFrameMoment(Number((scopeDuration * ratio).toFixed(3)));
                    setScopeViewMode('freeze');
                  }}
                >
                  <div className="absolute inset-y-0 left-0 rounded-full bg-[linear-gradient(90deg,rgba(0,212,170,0.08),rgba(0,212,170,0.22))]" style={{ width: `${Math.max(4, Math.min(100, scopeDuration > 0 ? (liveFrameMoment / scopeDuration) * 100 : 0))}%` }} />
                  {scopeStats.sampleMoments.map((moment, index) => {
                    const ratio = scopeDuration > 0 ? moment / scopeDuration : 0;
                    return (
                      <button
                        key={`${moment}-${index}`}
                        type="button"
                        className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border transition ${frozenFrameMoment !== null && Math.abs(frozenFrameMoment - moment) < 0.03 ? 'border-[#d8fff7] bg-[#00d4aa]' : 'border-[#6f7a83] bg-[#12171b] hover:border-[#8fdcca] hover:bg-[#17312b]'}`}
                        style={{ left: `${ratio * 100}%` }}
                        onPointerDown={stopCanvasPointer}
                        onClick={() => {
                          setFrozenFrameMoment(moment);
                          setScopeViewMode('freeze');
                        }}
                        title={`冻结到 ${formatScopeMoment(moment)}`}
                        data-testid={testId ? `${testId}-freeze-sample-${index}` : undefined}
                      />
                    );
                  })}
                  <div className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#8fdcca] bg-[#0f1317]" style={{ left: `${Math.max(0, Math.min(100, scopeDuration > 0 ? (liveFrameMoment / scopeDuration) * 100 : 0))}%` }} />
                  {frozenFrameMoment !== null ? (
                    <div className="pointer-events-none absolute top-1/2 h-5 w-[2px] -translate-x-1/2 -translate-y-1/2 bg-[#ffd479]" style={{ left: `${Math.max(0, Math.min(100, scopeDuration > 0 ? (frozenFrameMoment / scopeDuration) * 100 : 0))}%` }} />
                  ) : null}
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] text-[#7f8c96]">
                  <span>起点</span>
                  <span>点采样点或时间条即可冻结对应帧</span>
                  <span>终点</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {scopeStats.sampleMoments.map((moment, index) => (
                  <span key={`${moment}-${index}`} className="rounded-full border border-[#2d3236] bg-[#11161a] px-2.5 py-1 text-[11px] text-[#c8d2da]">
                    {formatScopeMoment(moment)}
                  </span>
                ))}
              </div>
              {frozenFrameMoment !== null ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="rounded-full border border-[#325a63] bg-[#112026] px-2.5 py-1 text-[#a9e9dc]">冻结帧：{formatScopeMoment(frozenFrameMoment)}</span>
                  <span className="rounded-full border border-[#2d3236] bg-[#11161a] px-2.5 py-1 text-[#d1dae2]">{scopeViewMode === 'freeze' ? '当前示波器显示冻结帧' : '当前示波器显示时间轴汇总'}</span>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="grid gap-4 2xl:grid-cols-2">
          <div className="rounded-2xl border border-[#2d3236] bg-[#0d1013] p-3">
            <div className="mb-2 flex items-center justify-between text-[11px] text-[#aab5bf]">
              <span>RGB 直方图</span>
              <span>亮度 + 通道分布</span>
            </div>
            <svg viewBox="0 0 320 120" className="block w-full rounded-xl bg-[#080a0d]">
              {[0.25, 0.5, 0.75].map((mark) => (
                <line key={mark} x1="0" y1={120 - mark * 120} x2="320" y2={120 - mark * 120} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
              ))}
              <path d={histogramPath(displayedScopeStats.histLuma)} fill="none" stroke={channelTone.hist[0]} strokeWidth={linkedChannel === 'master' ? '1.8' : '1.1'} />
              <path d={histogramPath(displayedScopeStats.histR)} fill="none" stroke={channelTone.hist[1]} strokeWidth={linkedChannel === 'red' ? '2.2' : '1.4'} />
              <path d={histogramPath(displayedScopeStats.histG)} fill="none" stroke={channelTone.hist[2]} strokeWidth={linkedChannel === 'green' ? '2.2' : '1.4'} />
              <path d={histogramPath(displayedScopeStats.histB)} fill="none" stroke={channelTone.hist[3]} strokeWidth={linkedChannel === 'blue' ? '2.2' : '1.4'} />
            </svg>
          </div>
          <div className="rounded-2xl border border-[#2d3236] bg-[#0d1013] p-3">
            <div className="mb-2 flex items-center justify-between text-[11px] text-[#aab5bf]">
              <span>Vectorscope</span>
              <span>色相 / 饱和 + 肤色线 + 广播参考点</span>
            </div>
            <div className="mb-2 flex flex-wrap items-center gap-1 rounded-2xl border border-[#23282d] bg-[#101418] p-1 text-[11px] text-[#b9c5ce]" data-testid={testId ? `${testId}-vectorscope-standard` : undefined}>
              {[
                { value: 'rec709' as const, label: 'Rec.709' },
                { value: 'ebu' as const, label: 'EBU' },
                { value: 'smpte-c' as const, label: 'SMPTE-C' },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`rounded-full px-2.5 py-1 transition ${vectorscopeTargetPreset === option.value ? 'bg-[#17312b] text-[#d8fff7]' : 'text-[#b9c5ce] hover:bg-[#161c21] hover:text-[#eef3f8]'}`}
                  onPointerDown={stopCanvasPointer}
                  onClick={() => setVectorscopeTargetPreset(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <svg viewBox="0 0 320 120" className="block w-full rounded-xl bg-[#080a0d]">
              {[18, 32, 46].map((radius) => (
                <ellipse key={radius} cx="160" cy="60" rx={radius} ry={radius * 0.92} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
              ))}
              <line x1="160" y1="8" x2="160" y2="112" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
              <line x1="52" y1="60" x2="268" y2="60" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
              <line x1="160" y1="60" x2={skinToneX.toFixed(1)} y2={skinToneY.toFixed(1)} stroke="rgba(255,184,108,0.78)" strokeWidth="1.2" strokeDasharray="4 4" />
              <text x={(skinToneX + 8).toFixed(1)} y={(skinToneY - 4).toFixed(1)} fill="rgba(255,184,108,0.92)" fontSize="10">Skin tone</text>
              {vectorscopeTargets.map((target) => {
                const angle = target.degrees * Math.PI / 180;
                const x = 160 + Math.cos(angle) * 46;
                const y = 60 - Math.sin(angle) * 42;
                const labelX = 160 + Math.cos(angle) * 58;
                const labelY = 60 - Math.sin(angle) * 54;
                return (
                  <g key={target.label}>
                    <circle cx={x.toFixed(1)} cy={y.toFixed(1)} r="2.2" fill="none" stroke={target.color} strokeWidth="1.1" />
                    <line x1={(x - 5).toFixed(1)} y1={y.toFixed(1)} x2={(x + 5).toFixed(1)} y2={y.toFixed(1)} stroke={target.color} strokeWidth="0.8" />
                    <line x1={x.toFixed(1)} y1={(y - 5).toFixed(1)} x2={x.toFixed(1)} y2={(y + 5).toFixed(1)} stroke={target.color} strokeWidth="0.8" />
                    <text x={labelX.toFixed(1)} y={labelY.toFixed(1)} fill={target.color} fontSize="9">{target.label}</text>
                  </g>
                );
              })}
              {displayedScopeStats.vectorscopePoints.map((point, index) => (
                <circle key={`vector-${index}`} cx={(point.x * 320).toFixed(1)} cy={(point.y * 120).toFixed(1)} r="1.15" fill={point.color} fillOpacity={point.alpha} />
              ))}
            </svg>
          </div>
          <div className="rounded-2xl border border-[#2d3236] bg-[#0d1013] p-3">
            <div className="mb-2 flex items-center justify-between text-[11px] text-[#aab5bf]">
              <span>RGB Parade</span>
              <span>通道波形 + IRE 标尺</span>
            </div>
            <svg viewBox="0 0 320 120" className="block w-full rounded-xl bg-[#080a0d]" data-testid={testId ? `${testId}-parade` : undefined}>
              {[0.25, 0.5, 0.75].map((mark) => (
                <line key={mark} x1="0" y1={120 - mark * 120} x2="320" y2={120 - mark * 120} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
              ))}
              {[0, 25, 50, 75, 100].map((ire) => (
                <text key={ire} x="2" y={(120 - ire * 1.12 + 3).toFixed(1)} fill="rgba(255,255,255,0.42)" fontSize="8">{ire}</text>
              ))}
              {[106.6, 213.3].map((divider) => (
                <line key={divider} x1={divider} y1="0" x2={divider} y2="120" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
              ))}
              <path d={waveformPath(displayedScopeStats.paradeR)} fill="none" stroke="rgba(248,113,113,0.95)" strokeOpacity={channelTone.paradeOpacity[0]} strokeWidth={channelTone.paradeStrokeWidth[0]} transform="scale(0.3333 1)" />
              <path d={waveformPath(displayedScopeStats.paradeG)} fill="none" stroke="rgba(74,222,128,0.95)" strokeOpacity={channelTone.paradeOpacity[1]} strokeWidth={channelTone.paradeStrokeWidth[1]} transform="translate(106.6 0) scale(0.3333 1)" />
              <path d={waveformPath(displayedScopeStats.paradeB)} fill="none" stroke="rgba(96,165,250,0.95)" strokeOpacity={channelTone.paradeOpacity[2]} strokeWidth={channelTone.paradeStrokeWidth[2]} transform="translate(213.3 0) scale(0.3333 1)" />
              <text x="18" y="16" fill="rgba(248,113,113,0.95)" fillOpacity={channelTone.paradeOpacity[0]} fontSize="10">R</text>
              <text x="125" y="16" fill="rgba(74,222,128,0.95)" fillOpacity={channelTone.paradeOpacity[1]} fontSize="10">G</text>
              <text x="232" y="16" fill="rgba(96,165,250,0.95)" fillOpacity={channelTone.paradeOpacity[2]} fontSize="10">B</text>
            </svg>
          </div>
          <div className="rounded-2xl border border-[#2d3236] bg-[#0d1013] p-3">
            <div className="mb-2 flex items-center justify-between text-[11px] text-[#aab5bf]">
              <span>亮度波形</span>
              <span>0-100 IRE 标尺</span>
            </div>
            <svg viewBox="0 0 320 120" className="block w-full rounded-xl bg-[#080a0d]">
              {[0.25, 0.5, 0.75].map((mark) => (
                <line key={mark} x1="0" y1={120 - mark * 120} x2="320" y2={120 - mark * 120} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
              ))}
              {[0, 25, 50, 75, 100].map((ire) => (
                <text key={ire} x="2" y={(120 - ire * 1.12 + 3).toFixed(1)} fill="rgba(255,255,255,0.42)" fontSize="8">{ire}</text>
              ))}
              {displayedScopeStats.waveformAvg.map((value, index) => {
                const x = (index / Math.max(1, displayedScopeStats.waveformAvg.length - 1)) * 320;
                const minY = 120 - displayedScopeStats.waveformMin[index] * 120;
                const maxY = 120 - displayedScopeStats.waveformMax[index] * 120;
                const avgY = 120 - value * 120;
                return (
                  <g key={`wave-${index}`}>
                    <line x1={x} y1={minY} x2={x} y2={maxY} stroke="rgba(0,212,170,0.22)" strokeWidth="2" />
                    <circle cx={x} cy={avgY} r="1.2" fill="rgba(141,220,202,0.95)" />
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-[#2d3236] bg-[#0f1317] px-4 py-8 text-sm text-[#95a1ac]">
          {scopeError ? `示波器暂时无法读取当前素材：${scopeError}` : '正在建立示波器抽样...'}
        </div>
      )}
    </div>
  );
}

export function PreviewOverlay({
  descriptor,
  mediaKind,
}: {
  descriptor: ReturnType<typeof buildPostPreviewDescriptor>;
  mediaKind: PostMediaKind | null;
}) {
  return (
    <>
      {descriptor.bloomOpacity > 0 ? (
        <div
          className="pointer-events-none absolute inset-0"
          style={{ boxShadow: `inset 0 0 120px rgba(255,245,220,${descriptor.bloomOpacity})` }}
        />
      ) : null}

      {descriptor.focusBox ? (
        <div
          className="pointer-events-none absolute rounded-[20px] border border-cyan-200/60 bg-cyan-200/6 shadow-[0_0_0_1px_rgba(125,211,252,0.18),0_0_24px_rgba(34,211,238,0.18)]"
          style={{
            left: descriptor.focusBox.left,
            top: descriptor.focusBox.top,
            width: descriptor.focusBox.width,
            height: descriptor.focusBox.height,
          }}
        />
      ) : null}

      {descriptor.grainOpacity > 0 ? (
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            opacity: descriptor.grainOpacity,
            mixBlendMode: descriptor.grainBlendMode,
            backgroundImage: `url("${descriptor.grainTexture}")`,
            backgroundSize: descriptor.grainScale,
            backgroundPosition: 'center center',
          }}
        />
      ) : null}

      {descriptor.tracks.map((track) => (
        <div
          key={track.id}
          className="pointer-events-none absolute"
          style={{
            left: `${track.x}%`,
            top: `${track.y}%`,
            transform: `translate(-50%, -50%) rotate(${track.rotation}deg) scale(${track.scale})`,
            opacity: track.opacity,
          }}
        >
          {track.overlayKind === 'video' ? (
            <video
              src={toRenderableAssetUrl(track.overlayUrl, 'video')}
              className="max-h-32 max-w-32 rounded-lg shadow-xl"
              muted
              playsInline
              autoPlay
              loop
              preload="metadata"
            />
          ) : (
            <img
              src={toRenderableAssetUrl(track.overlayUrl, 'image')}
              alt={track.label}
              className="max-h-32 max-w-32 rounded-lg shadow-xl"
            />
          )}
        </div>
      ))}

      {mediaKind === 'image' && descriptor.matteMaskUrl ? (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white">
          蒙版预览已接入
        </div>
      ) : null}
    </>
  );
}

export function EmptySourceCard() {
  return (
    <div
      className="flex h-[280px] w-full items-center justify-center rounded-[24px] border border-dashed border-white/12 bg-[#101010] text-[#b8b8b8]"
      data-testid="post-empty-source"
    >
      <div className="max-w-[340px] text-center">
        <Link2 className="mx-auto mb-3 h-8 w-8 text-[#00d4aa]" />
        <div className="text-sm font-medium text-white">请先把图片节点或视频节点连接到后期节点</div>
        <div className="mt-2 text-xs leading-6 text-[#8c8c8c]">
          后期节点不再单独上传主素材，当前会直接从左侧输入端继承图片或视频素材。
      </div>
    </div>
    </div>
  );
}

