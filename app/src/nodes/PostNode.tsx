import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Activity, Aperture, BarChart3, ChevronDown, ChevronRight, Clapperboard, Layers3, Link2, Loader2, RotateCcw, Settings2, Sparkles } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import {
  POST_BLOOM_PRESETS,
  POST_COLOR_PRESETS,
  POST_EFFECT_DESCRIPTORS,
  POST_EFFECT_ORDER,
  POST_GRAIN_PRESETS,
  countEnabledPostEffects,
  createDefaultPostEffects,
  mergePostEffects,
  type PostEffectId,
  type PostCurvePoint,
  type PostEffectsState,
  type PostMediaKind,
} from '@/config/postEffectPresets';
import { ModelActivationPrompt } from '@/components/ModelActivationPrompt';
import { PostComparePreview } from '@/components/post/PostComparePreview';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useNodeFloatingPanel } from '@/hooks/useNodeFloatingPanel';
import { toRenderableAssetUrl } from '@/services/generation';
import {
  applyPostProcessingLocally,
  buildPostPreviewDescriptor,
  validateMattingSetup,
} from '@/services/localPostProcessing';
import { readLocalMediaBlob, registerLocalMedia } from '@/services/localMediaRegistry';
import { useAuthStore } from '@/store/useAuthStore';
import { useCanvasStore } from '@/store/useCanvasStore';
import { EditableNodeTitle } from './EditableNodeTitle';
import { ErrorDetailBlock, ProgressBadge, StatusBadge } from './NodeShellShared';

type PostPanelKind = 'post-panel';
type PostFieldTestId = string | undefined;
type CurveChannelKey = 'master' | 'red' | 'green' | 'blue';
type ColorPanelSectionId = 'console' | 'wheels' | 'workspace';

const CURVE_EDITOR_SIZE = { width: 176, height: 132 };
const CURVE_CHANNEL_COLORS: Record<CurveChannelKey, string> = {
  master: '#e7e7e7',
  red: '#f87171',
  green: '#4ade80',
  blue: '#60a5fa',
};

function stopCanvasPointer(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function preventCanvasPointer(event: { preventDefault: () => void; stopPropagation: () => void }) {
  event.preventDefault();
  event.stopPropagation();
}

function sliderTrackClass() {
  return 'nodrag nopan nowheel h-2 w-full cursor-ew-resize touch-none appearance-none rounded-full bg-[#20252b] accent-[#00d4aa]';
}

function workspaceTabClass(active: boolean) {
  return active
    ? 'border-[#5d827d] bg-[#17312b] text-[#d8fff7] shadow-[0_0_0_1px_rgba(0,212,170,0.12)]'
    : 'border-[#34383d] bg-[#1a1d21] text-[#cfd8e1] hover:border-[#46515d] hover:bg-[#23282d]';
}

function cloneCurvePoints(points: PostCurvePoint[]) {
  return points.map((point) => ({ x: point.x, y: point.y }));
}

function sanitizeCurvePoints(points: PostCurvePoint[] | undefined, fallback: PostCurvePoint[]) {
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

function presetCurvePoints(preset: string, channel: CurveChannelKey): PostCurvePoint[] {
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

function readSourceAssetFromNode(node: { type: string; data: Record<string, unknown> } | null) {
  if (!node) return null;

  const outputs = Array.isArray(node.data.outputs) ? node.data.outputs as Array<Record<string, unknown>> : [];
  const outputImage = outputs.find((item) => item?.type === 'image' && typeof item.url === 'string');
  const outputVideo = outputs.find((item) => item?.type === 'video' && typeof item.url === 'string');

  if (outputImage?.url) return { kind: 'image' as const, url: String(outputImage.url) };
  if (outputVideo?.url) return { kind: 'video' as const, url: String(outputVideo.url) };

  if (node.type === 'image' && typeof node.data.imageUrl === 'string' && node.data.imageUrl.trim()) {
    return { kind: 'image' as const, url: node.data.imageUrl.trim() };
  }
  if (node.type === 'video' && typeof node.data.videoUrl === 'string' && node.data.videoUrl.trim()) {
    return { kind: 'video' as const, url: node.data.videoUrl.trim() };
  }

  return null;
}

function normalizePostLabel(value: unknown, fallback = '后期节点') {
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

function useMediaNaturalSize(kind: PostMediaKind | null, url: string) {
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

function previewViewportSize(kind: PostMediaKind | null, meta: { width: number; height: number }) {
  const ratio = kind && meta.height > 0 ? meta.width / meta.height : 16 / 9;
  if (ratio >= 1) {
    const width = 504;
    return { width, height: Math.max(252, Math.round(width / ratio)) };
  }
  const height = 330;
  return { width: Math.max(220, Math.round(height * ratio)), height };
}

function FieldLabel({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mb-1 flex items-center justify-between gap-3 text-[11px] text-[#cfcfcf]">
      <span>{title}</span>
      {note ? null : null}
    </div>
  );
}

function PanelSection({
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

function CollapsiblePanelSection({
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
  return (
    <section className={`rounded-[24px] border border-[#2d3236] bg-[linear-gradient(180deg,#161a1e_0%,#0f1215_100%)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          className="nodrag flex flex-1 items-start gap-3 text-left"
          onPointerDown={stopCanvasPointer}
          onClick={onToggle}
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

function WheelCard({
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

function SliderField({
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
        className={sliderTrackClass()}
      />
    </label>
  );
}

function ToggleField({
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
  return (
    <label className="flex items-center justify-between rounded-2xl border border-[#2d3236] bg-[#121518] px-3 py-3 text-sm text-[#eef3f8]">
      <span>{title}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        onPointerDown={stopCanvasPointer}
        data-testid={testId}
        className="nodrag h-4 w-4 accent-[#00d4aa]"
      />
    </label>
  );
}

function SelectField({
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
  const selectedLabel = options.find((option) => option.value === value)?.label;
  return (
    <div className="block">
      <FieldLabel title={title} note={selectedLabel} />
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          onPointerDown={stopCanvasPointer}
          onClick={stopCanvasPointer}
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

function ColorSwatchField({
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

function CurveEditorField({
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

type ScopeStats = {
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

type ScopeSampleDensity = 'sparse' | 'standard' | 'dense';

type LocalPostBackendStatus = {
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

type RuntimeUpdateStatus = {
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

type LocalPostDoctorRuntime = {
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

type LocalPostDoctorReport = {
  checkedAt: string;
  runtimes: {
    ocio?: LocalPostDoctorRuntime;
    oiio?: LocalPostDoctorRuntime;
    gmic?: LocalPostDoctorRuntime;
  };
};

type PostHealthStatus = {
  ocio: LocalPostBackendStatus | null;
  oiio: LocalPostBackendStatus | null;
  gmic: LocalPostBackendStatus | null;
  upscale: Record<string, LocalPostBackendStatus>;
};

type OcioSetupValidation = {
  severity: 'ok' | 'warn' | 'error';
  title: string;
  details: string[];
};

type OcioConfigInspection = {
  status: 'idle' | 'loading' | 'ok' | 'warn' | 'error';
  title: string;
  details: string[];
  detectedSections: string[];
  profileVersion: string;
  formatLabel: string;
};

const SUPPORTED_OCIO_CONFIG_EXTENSIONS = ['.ocio', '.yaml', '.yml', '.json', '.cfg', '.txt'] as const;
const VECTORSCOPE_HUE_TARGET_PRESETS = {
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

function rgbToHsl(red: number, green: number, blue: number) {
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

function hueToRgb(partial1: number, partial2: number, hue: number) {
  let nextHue = hue;
  if (nextHue < 0) nextHue += 1;
  if (nextHue > 1) nextHue -= 1;
  if (nextHue < 1 / 6) return partial1 + (partial2 - partial1) * 6 * nextHue;
  if (nextHue < 1 / 2) return partial2;
  if (nextHue < 2 / 3) return partial1 + (partial2 - partial1) * (2 / 3 - nextHue) * 6;
  return partial1;
}

function hslToRgb(hue: number, saturation: number, lightness: number) {
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

function applyScopeLook(redByte: number, greenByte: number, blueByte: number, color: PostEffectsState['color']) {
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

function buildScopeStats(imageData: ImageData, color: PostEffectsState['color']): ScopeStats {
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

function mergeScopeStats(statsList: ScopeStats[], options: { sampleLabel: string; sampleMoments: number[]; sampleMode: 'image' | 'video' }): ScopeStats {
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

function formatScopeMoment(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0.0s';
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
}

function isSupportedOcioConfigName(name: string) {
  const normalized = String(name || '').trim().toLowerCase();
  return SUPPORTED_OCIO_CONFIG_EXTENSIONS.some((ext) => normalized.endsWith(ext));
}

function buildSampleMoments(duration: number, density: ScopeSampleDensity) {
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

function inspectOcioConfigText(fileName: string, source: string): OcioConfigInspection {
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

function ScopeWorkbench({
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

function PreviewOverlay({
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

function EmptySourceCard() {
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

export function PostNode({ id, data, selected }: NodeProps) {
  const canvas = useCanvasStore((state) => state.canvas);
  const addConnectedNode = useCanvasStore((state) => state.addConnectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const selectNode = useCanvasStore((state) => state.selectNode);

  const params = useMemo(
    () => (data.params && typeof data.params === 'object' ? data.params as Record<string, unknown> : {}),
    [data.params],
  );
  const nodePosition = useMemo(
    () => canvas?.nodes.find((node) => node.id === id)?.position || { x: 0, y: 0 },
    [canvas, id],
  );
  const effects = useMemo(
    () => mergePostEffects(params.postEffects as Partial<PostEffectsState> | null | undefined),
    [params.postEffects],
  );
  const enabledCount = useMemo(() => countEnabledPostEffects(effects), [effects]);
  const previewDescriptor = useMemo(() => buildPostPreviewDescriptor(effects), [effects]);
  const selectedEffectRef = useRef<PostEffectId>('color');

  const [activeEffect, setActiveEffect] = useState<PostEffectId>('color');
  const [colorWorkspaceTab, setColorWorkspaceTab] = useState<'curves' | 'scopes' | 'output'>('curves');
  const [curveChannelTab, setCurveChannelTab] = useState<CurveChannelKey>('master');
  const [colorSectionsCollapsed, setColorSectionsCollapsed] = useState<Record<ColorPanelSectionId, boolean>>({
    console: false,
    wheels: false,
    workspace: false,
  });
  const [compareEnabled, setCompareEnabled] = useState(true);
  const [isApplying, setIsApplying] = useState(false);
  const [localError, setLocalError] = useState('');
  const [activation, setActivation] = useState<{ mode: 'image' | 'video'; provider: string; reason: 'auth' } | null>(null);
  const [warnings, setWarnings] = useState<string[]>(
    Array.isArray(params.postWarnings) ? params.postWarnings.map((item) => String(item)) : [],
  );
  const [postHealth, setPostHealth] = useState<PostHealthStatus>({ ocio: null, oiio: null, gmic: null, upscale: {} });
  const [isRefreshingRuntimes, setIsRefreshingRuntimes] = useState(false);
  const [runtimeDoctor, setRuntimeDoctor] = useState<LocalPostDoctorReport>({ checkedAt: '', runtimes: {} });
  const [isRunningRuntimeDoctor, setIsRunningRuntimeDoctor] = useState(false);
  const [ocioConfigInspection, setOcioConfigInspection] = useState<OcioConfigInspection>({
    status: 'idle',
    title: '尚未检测自定义 OCIO Config。',
    details: ['切换到“自定义 OCIO Config”并导入文件后，这里会显示结构校验结果。'],
    detectedSections: [],
    profileVersion: '',
    formatLabel: 'OCIO Config',
  });

  const maskPickerRef = useRef<HTMLInputElement | null>(null);
  const backgroundPickerRef = useRef<HTMLInputElement | null>(null);
  const trackPickerRef = useRef<HTMLInputElement | null>(null);
  const lutPickerRef = useRef<HTMLInputElement | null>(null);
  const ocioConfigPickerRef = useRef<HTMLInputElement | null>(null);
  const depthMaskPickerRef = useRef<HTMLInputElement | null>(null);
  const bokehPickerRef = useRef<HTMLInputElement | null>(null);

  const { isOpen, open, close } = useNodeFloatingPanel<PostPanelKind>(id, () => selectNode(id));
  const panelOpen = isOpen('post-panel');
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  const connectedSource = useMemo(() => {
    if (!canvas) return null;
    const incomingEdges = canvas.edges.filter((edge) => edge.target === id);
    for (const edge of incomingEdges) {
      const sourceNode = canvas.nodes.find((node) => node.id === edge.source);
      const asset = readSourceAssetFromNode(
        sourceNode ? { type: sourceNode.type, data: sourceNode.data as unknown as Record<string, unknown> } : null,
      );
      if (asset) return asset;
    }
    return null;
  }, [canvas, id]);

  const legacySourceUrl = typeof params.sourceUrl === 'string' ? params.sourceUrl : '';
  const legacySourceType = params.sourceMediaType === 'video' ? 'video' : 'image';
  const sourceAsset = connectedSource || (legacySourceUrl ? { kind: legacySourceType as PostMediaKind, url: legacySourceUrl } : null);
  const sourceKind = sourceAsset?.kind || null;
  const sourceUrl = sourceAsset ? toRenderableAssetUrl(sourceAsset.url, sourceAsset.kind) : '';
  const sourceInherited = Boolean(connectedSource);

  const outputKind = params.lastResultKind === 'video' ? 'video' : 'image';
  const resultUrlRaw = typeof params.lastResultUrl === 'string' ? params.lastResultUrl : '';
  const resultUrl = resultUrlRaw ? toRenderableAssetUrl(resultUrlRaw, outputKind) : '';
  const lastResultMeta = params.lastResultMeta && typeof params.lastResultMeta === 'object'
    ? params.lastResultMeta as Record<string, unknown>
    : {};
  const lastProcessingMeta = lastResultMeta.processingMeta && typeof lastResultMeta.processingMeta === 'object'
    ? lastResultMeta.processingMeta as Record<string, unknown>
    : {};

  const mediaMeta = useMediaNaturalSize(sourceKind, sourceUrl || resultUrl);
  const viewport = useMemo(() => previewViewportSize(sourceKind, mediaMeta), [mediaMeta, sourceKind]);
  const previewStyle: CSSProperties = {
    width: viewport.width,
    height: viewport.height,
    maxWidth: '100%',
  };
  const stackSummary = useMemo(
    () => POST_EFFECT_ORDER.map((effectId) => `${effects[effectId].enabled ? '[开]' : '[关]'} ${POST_EFFECT_DESCRIPTORS[effectId].shortLabel}`).join('  '),
    [effects],
  );
  const ocioResultSummary = useMemo(() => {
    const executionMode = String(lastProcessingMeta.ocioExecutionMode || '').trim();
    const backendLabel = String(lastProcessingMeta.ocioBackendLabel || '').trim();
    const validationMessage = String(lastProcessingMeta.ocioConfigValidationMessage || '').trim();
    const wrapperApplied = lastProcessingMeta.ocioWrapperApplied === true || String(lastProcessingMeta.ocioWrapperApplied || '').trim() === 'true';
    const wrapperConfigured = lastProcessingMeta.ocioWrapperConfigured === true || String(lastProcessingMeta.ocioWrapperConfigured || '').trim() === 'true';
    const executable = lastProcessingMeta.ocioConfigExecutable === true || String(lastProcessingMeta.ocioConfigExecutable || '').trim() === 'true';
    const structurallyValid = lastProcessingMeta.ocioConfigStructurallyValid === true || String(lastProcessingMeta.ocioConfigStructurallyValid || '').trim() === 'true';
    if (!executionMode && !backendLabel && !validationMessage) return null;

    let toneClass = 'border-emerald-500/20 bg-emerald-500/8 text-emerald-100';
    let title = 'OCIO 已执行';
    if (executionMode === 'wrapper-only') {
      title = wrapperApplied ? '仅 Wrapper 成功执行' : '仅 Wrapper 未完成';
      toneClass = wrapperApplied ? toneClass : 'border-rose-500/30 bg-rose-500/10 text-rose-100';
    } else if (executionMode === 'fallback-only') {
      title = '仅本地回退执行';
      toneClass = 'border-amber-500/30 bg-amber-500/10 text-amber-100';
    } else if (wrapperApplied) {
      title = '自动模式：已走 Wrapper';
    } else {
      title = '自动模式：已回退到本地链路';
      toneClass = 'border-amber-500/30 bg-amber-500/10 text-amber-100';
    }

    const details = [
      `执行模式：${executionMode === 'wrapper-only' ? '仅 Wrapper' : executionMode === 'fallback-only' ? '仅本地回退' : '自动优先 Wrapper'}`,
      `实际链路：${backendLabel || (wrapperApplied ? '外部 Wrapper' : '本地回退')}`,
      validationMessage ? `配置校验：${validationMessage}` : '',
      `结构状态：${structurallyValid ? (executable ? '结构完整，可执行' : '基础结构通过，执行路由不完整') : '结构未通过'}`,
      wrapperConfigured ? '后端已检测到外部 Wrapper' : '后端未检测到外部 Wrapper',
    ].filter(Boolean);

    return { title, toneClass, details };
  }, [lastProcessingMeta]);
  const upscaleResultSummary = useMemo(() => {
    const executionMode = String(lastProcessingMeta.upscaleExecutionMode || '').trim();
    const backendLabel = String(lastProcessingMeta.upscaleBackendLabel || '').trim();
    const resolvedRoute = String(lastProcessingMeta.upscaleResolvedRoute || '').trim();
    const fallbackReason = String(lastProcessingMeta.upscaleFallbackReason || '').trim();
    const model = String(lastProcessingMeta.upscaleModel || '').trim();
    const scale = Number(lastProcessingMeta.upscaleScale || 0);
    const wrapperApplied = lastProcessingMeta.upscaleWrapperApplied === true || String(lastProcessingMeta.upscaleWrapperApplied || '').trim() === 'true';
    const wrapperConfigured = lastProcessingMeta.upscaleWrapperConfigured === true || String(lastProcessingMeta.upscaleWrapperConfigured || '').trim() === 'true';
    if (!executionMode && !backendLabel && !resolvedRoute) return null;

    let title = '高清增强已执行';
    let toneClass = 'border-emerald-500/20 bg-emerald-500/8 text-emerald-100';
    if (executionMode === 'wrapper-only') {
      title = wrapperApplied ? '仅 Wrapper 成功执行高清增强' : '仅 Wrapper 未完成执行';
      toneClass = wrapperApplied ? toneClass : 'border-rose-500/30 bg-rose-500/10 text-rose-100';
    } else if (executionMode === 'fallback-only') {
      title = '仅本地回退执行高清增强';
      toneClass = 'border-amber-500/30 bg-amber-500/10 text-amber-100';
    } else if (!wrapperApplied) {
      title = '自动模式：已回退到本地增强链';
      toneClass = 'border-amber-500/30 bg-amber-500/10 text-amber-100';
    }

    const details = [
      `执行模式：${executionMode === 'wrapper-only' ? '仅 Wrapper' : executionMode === 'fallback-only' ? '仅本地回退' : '自动优先 Wrapper'}`,
      `实际链路：${backendLabel || (wrapperApplied ? '外部 Wrapper' : 'ffmpeg-post-stack')}`,
      `路由落点：${resolvedRoute || '未记录'}${model ? ` / ${model}` : ''}`,
      scale > 0 ? `输出倍率：${scale}x` : '',
      wrapperConfigured ? '后端已检测到外部高清 Wrapper' : '后端未检测到外部高清 Wrapper',
      fallbackReason ? `回退原因：${fallbackReason}` : '',
    ].filter(Boolean);
    return { title, toneClass, details };
  }, [lastProcessingMeta]);
  const gmicResultSummary = useMemo(() => {
    const backendLabel = String(lastProcessingMeta.gmicBackendLabel || '').trim();
    const fallbackReason = String(lastProcessingMeta.gmicFallbackReason || '').trim();
    const wrapperApplied = lastProcessingMeta.gmicWrapperApplied === true || String(lastProcessingMeta.gmicWrapperApplied || '').trim() === 'true';
    const wrapperConfigured = lastProcessingMeta.gmicWrapperConfigured === true || String(lastProcessingMeta.gmicWrapperConfigured || '').trim() === 'true';
    const stagesApplied = Array.isArray(lastProcessingMeta.gmicStagesApplied)
      ? lastProcessingMeta.gmicStagesApplied.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    if (!backendLabel && !fallbackReason && !stagesApplied.length) return null;

    return {
      title: wrapperApplied ? 'G\'MIC 真实处理已执行' : 'G\'MIC 未接管，当前走本地回退',
      toneClass: wrapperApplied
        ? 'border-emerald-500/20 bg-emerald-500/8 text-emerald-100'
        : 'border-amber-500/30 bg-amber-500/10 text-amber-100',
      details: [
        `实际链路：${backendLabel || (wrapperApplied ? 'G\'MIC CLI' : 'ffmpeg-post-fallback')}`,
        `执行阶段：${stagesApplied.length ? stagesApplied.join(' / ') : '未记录'}`,
        wrapperConfigured ? '后端已检测到 G\'MIC Runtime' : '后端未检测到 G\'MIC Runtime',
        fallbackReason ? `回退原因：${fallbackReason}` : '',
      ].filter(Boolean),
    };
  }, [lastProcessingMeta]);
  const oiioResultSummary = useMemo(() => {
    const backendLabel = String(lastProcessingMeta.oiioBackendLabel || '').trim();
    const wrapperApplied = lastProcessingMeta.oiioWrapperApplied === true || String(lastProcessingMeta.oiioWrapperApplied || '').trim() === 'true';
    const detectedConfigPath = String(lastProcessingMeta.oiioDetectedConfigPath || '').trim();
    if (!backendLabel && !detectedConfigPath && !wrapperApplied) return null;
    return {
      title: wrapperApplied ? 'OIIO 严格图片调色已执行' : 'OIIO 当前未接管本次调色',
      toneClass: wrapperApplied
        ? 'border-emerald-500/20 bg-emerald-500/8 text-emerald-100'
        : 'border-[#2d3236] bg-[#0f1317] text-[#c9d1d9]',
      details: [
        `实际链路：${backendLabel || '未记录'}`,
        `默认 OCIO Config：${detectedConfigPath || '未记录'}`,
        wrapperApplied ? '本次图片调色优先走了 OIIO + OpenColorIO。' : '当前如果没有可用 OIIO / OCIO Config，会继续走已有 OCIO wrapper 或 FFmpeg 回退。',
      ],
    };
  }, [lastProcessingMeta]);
  const ocioValidation = useMemo<OcioSetupValidation>(() => {
    const modeLabel = effects.color.ocioExecutionMode === 'wrapper-only'
      ? '仅 Wrapper'
      : effects.color.ocioExecutionMode === 'fallback-only'
        ? '仅本地回退'
        : '自动优先 Wrapper';
    const details: string[] = [`当前执行模式：${modeLabel}`];
    const hasCustomConfig = effects.color.ocioConfig === 'custom-file';
    const hasConfigFile = Boolean(effects.color.ocioConfigAssetName);
    const fileSupported = !hasConfigFile || isSupportedOcioConfigName(effects.color.ocioConfigAssetName);
    if (effects.color.ocioExecutionMode === 'wrapper-only' && !postHealth.ocio?.configured) {
      return {
        severity: 'error',
        title: '当前设置为仅 Wrapper，但后端没有可用的 OCIO Runtime。',
        details: [
          ...details,
          '请先配置 HMDAO_POST_OCIO_PATH 或 HMDAO_POST_OCIO_COMMAND，或者切回“自动：Wrapper 优先”。',
        ],
      };
    }
    if (hasCustomConfig && !hasConfigFile) {
      return {
        severity: effects.color.ocioExecutionMode === 'wrapper-only' ? 'error' : 'warn',
        title: effects.color.ocioExecutionMode === 'wrapper-only'
          ? '当前要求走自定义 .ocio，但还没有挂载 config 文件。'
          : '当前已切到自定义 .ocio，但还没有挂载 config 文件。',
        details: [
          ...details,
          '导入 .ocio / .yaml / .json / .cfg 文件后，后端才能建立真实配置链路。',
        ],
      };
    }
    if (hasCustomConfig && hasConfigFile && !fileSupported) {
      return {
        severity: effects.color.ocioExecutionMode === 'wrapper-only' ? 'error' : 'warn',
        title: '当前自定义 OCIO Config 文件扩展名不在支持范围内。',
        details: [
          ...details,
          `支持的扩展名：${SUPPORTED_OCIO_CONFIG_EXTENSIONS.join(', ')}`,
        ],
      };
    }
    if (hasCustomConfig && hasConfigFile && ocioConfigInspection.status === 'error') {
      return {
        severity: effects.color.ocioExecutionMode === 'wrapper-only' ? 'error' : 'warn',
        title: ocioConfigInspection.title,
        details: [...details, ...ocioConfigInspection.details],
      };
    }
    if (hasCustomConfig && hasConfigFile && ocioConfigInspection.status === 'warn') {
      return {
        severity: 'warn',
        title: ocioConfigInspection.title,
        details: [...details, ...ocioConfigInspection.details],
      };
    }
    if (effects.color.ocioExecutionMode === 'fallback-only' && hasCustomConfig) {
      return {
        severity: 'warn',
        title: '当前设置为仅本地回退，自定义 .ocio 不会走外部 Wrapper。',
        details: [
          ...details,
          '这一模式会保留近似色彩风格，但不会执行真实工作室 OCIO Runtime。',
        ],
      };
    }
    if (hasCustomConfig && hasConfigFile && !postHealth.ocio?.configured) {
      return {
        severity: 'warn',
        title: '自定义 .ocio 已挂载，但当前未检测到外部 Wrapper。',
        details: [
          ...details,
          '生成时会回退到本地近似调色链；如果需要真实工作室 OCIO，请先配置 HMDAO_POST_OCIO_PATH 或 HMDAO_POST_OCIO_COMMAND。',
        ],
      };
    }
    if (hasCustomConfig && hasConfigFile && postHealth.ocio?.configured) {
      return {
        severity: 'ok',
        title: '自定义 .ocio 已就绪，可走外部 Wrapper 执行。',
        details: [
          ...details,
          `当前文件：${effects.color.ocioConfigAssetName}`,
          ...ocioConfigInspection.details,
        ],
      };
    }
    return {
      severity: 'ok',
      title: '当前 OCIO 配置可正常执行。',
      details,
    };
  }, [effects.color, ocioConfigInspection, postHealth.ocio]);

  useEffect(() => {
    if (!panelOpen) return;
    setActiveEffect(selectedEffectRef.current);
  }, [panelOpen]);

  const loadPostHealth = useCallback(async (options: { refresh?: boolean } = {}) => {
    const endpoint = options.refresh ? '/api/health/local-post/refresh' : '/api/health';
    const method = options.refresh ? 'POST' : 'GET';
    const response = await fetch(endpoint, {
      method,
      headers: options.refresh ? { 'Content-Type': 'application/json' } : undefined,
    });
    if (!response.ok) {
      throw new Error(`运行时状态请求失败：HTTP ${response.status}`);
    }
    const payload = await response.json().catch(() => null) as {
      capabilities?: {
        localPostBackends?: {
          ocio?: LocalPostBackendStatus;
          oiio?: LocalPostBackendStatus;
          gmic?: LocalPostBackendStatus;
          upscale?: Record<string, LocalPostBackendStatus>;
        };
      };
    } | null;
    setPostHealth({
      ocio: payload?.capabilities?.localPostBackends?.ocio || null,
      oiio: payload?.capabilities?.localPostBackends?.oiio || null,
      gmic: payload?.capabilities?.localPostBackends?.gmic || null,
      upscale: payload?.capabilities?.localPostBackends?.upscale || {},
    });
  }, []);

  const refreshLocalPostRuntimes = useCallback(async () => {
    setIsRefreshingRuntimes(true);
    try {
      await loadPostHealth({ refresh: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : '运行时探测失败。';
      setLocalError(message);
    } finally {
      setIsRefreshingRuntimes(false);
    }
  }, [loadPostHealth]);

  const runRuntimeDoctor = useCallback(async (options: { force?: boolean } = {}) => {
    setIsRunningRuntimeDoctor(true);
    try {
      const response = await fetch(`/api/health/local-post/doctor${options.force ? '?force=1' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceRelease: Boolean(options.force) }),
      });
      if (!response.ok) {
        throw new Error(`运行时自检失败：HTTP ${response.status}`);
      }
      const payload = await response.json().catch(() => null) as ({
        checkedAt?: string;
        runtimes?: LocalPostDoctorReport['runtimes'];
      } & Record<string, unknown>) | null;
      setRuntimeDoctor({
        checkedAt: String(payload?.checkedAt || ''),
        runtimes: payload?.runtimes || {},
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '运行时自检失败。';
      setLocalError(message);
    } finally {
      setIsRunningRuntimeDoctor(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    async function loadHealthOnMount() {
      try {
        await loadPostHealth();
        if (disposed) return;
      } catch {
        if (!disposed) {
          setPostHealth({ ocio: null, oiio: null, gmic: null, upscale: {} });
        }
      }
    }
    void loadHealthOnMount();
    return () => {
      disposed = true;
    };
  }, [loadPostHealth]);

  useEffect(() => {
    let disposed = false;
    async function inspectOcioConfig() {
      const assetUrl = String(effects.color.ocioConfigAssetUrl || '').trim();
      const assetName = String(effects.color.ocioConfigAssetName || '').trim();
      if (!assetUrl || !assetName) {
        setOcioConfigInspection({
          status: 'idle',
          title: '尚未检测自定义 OCIO Config。',
          details: ['切换到“自定义 OCIO Config”并导入文件后，这里会显示结构校验结果。'],
          detectedSections: [],
          profileVersion: '',
          formatLabel: 'OCIO Config',
        });
        return;
      }
      setOcioConfigInspection((current) => ({
        ...current,
        status: 'loading',
        title: '正在检查 OCIO Config 结构...',
        details: ['正在读取 profile 版本、colorspaces、roles / displays / views 结构。'],
      }));
      try {
        const blob = readLocalMediaBlob(assetUrl);
        if (!blob) {
          if (disposed) return;
          setOcioConfigInspection({
            status: 'warn',
            title: '当前 OCIO Config 已挂载，但本地结构内容暂时不可读。',
            details: ['文件句柄已存在，但当前页面无法直接读取内容；生成时后端仍会再次校验真实文件结构。'],
            detectedSections: [],
            profileVersion: '',
            formatLabel: 'OCIO Config',
          });
          return;
        }
        const text = await blob.text();
        if (disposed) return;
        setOcioConfigInspection(inspectOcioConfigText(assetName, text));
      } catch (error) {
        if (disposed) return;
        setOcioConfigInspection({
          status: 'error',
          title: '读取当前 OCIO Config 失败。',
          details: [error instanceof Error ? error.message : 'unknown-ocio-read-error'],
          detectedSections: [],
          profileVersion: '',
          formatLabel: 'OCIO Config',
        });
      }
    }
    void inspectOcioConfig();
    return () => {
      disposed = true;
    };
  }, [effects.color.ocioConfigAssetName, effects.color.ocioConfigAssetUrl]);

  const updateEffects = useCallback((nextEffects: PostEffectsState) => {
    updateNodeData(id, {
      params: {
        ...params,
        postEffects: nextEffects,
      },
      status: 'idle',
      error: '',
    });
  }, [id, params, updateNodeData]);

  const patchEffect = useCallback(<K extends PostEffectId>(effectId: K, patch: Partial<PostEffectsState[K]>) => {
    const nextEffects = mergePostEffects({
      ...effects,
      [effectId]: {
        ...effects[effectId],
        ...patch,
      },
    });
    updateEffects(nextEffects);
  }, [effects, updateEffects]);

  const patchFirstTrack = useCallback((patch: Partial<PostEffectsState['tracking']['tracks'][number]>) => {
    if (!effects.tracking.tracks[0]) return;
    patchEffect('tracking', {
      enabled: true,
      tracks: [{ ...effects.tracking.tracks[0], ...patch }, ...effects.tracking.tracks.slice(1)],
    });
  }, [effects.tracking.tracks, patchEffect]);

  const toggleColorSection = useCallback((sectionId: ColorPanelSectionId) => {
    setColorSectionsCollapsed((current) => ({
      ...current,
      [sectionId]: !current[sectionId],
    }));
  }, []);

  const handleResetEffect = useCallback((effectId: PostEffectId) => {
    const defaults = createDefaultPostEffects();
    const nextEffects = mergePostEffects({
      ...effects,
      [effectId]: defaults[effectId],
    });
    updateEffects(nextEffects);
    setWarnings([]);
    setLocalError('');
  }, [effects, updateEffects]);

  function handleOpenEffect(effectId: PostEffectId) {
    selectedEffectRef.current = effectId;
    setActiveEffect(effectId);
    open('post-panel');
  }

  function handleMediaUpload(event: ChangeEvent<HTMLInputElement>, role: 'mask' | 'background' | 'track' | 'lut' | 'ocioConfig' | 'depthMask' | 'bokeh') {
    const file = event.target.files?.[0];
    if (!file) return;
    if (role === 'ocioConfig' && !isSupportedOcioConfigName(file.name || '')) {
      setLocalError(`当前 OCIO Config 文件扩展名不在支持范围内。支持：${SUPPORTED_OCIO_CONFIG_EXTENSIONS.join(', ')}`);
      event.target.value = '';
      return;
    }
    const handle = registerLocalMedia(file);

    if (role === 'mask') {
      patchEffect('matting', { enabled: true, maskUrl: handle });
    } else if (role === 'background') {
      patchEffect('matting', { enabled: true, backgroundUrl: handle, mode: 'replace-background' });
    } else if (role === 'lut') {
      patchEffect('color', {
        enabled: true,
        preset: 'custom',
        lutAssetUrl: handle,
        lutAssetName: file.name || 'custom.cube',
      });
    } else if (role === 'ocioConfig') {
      patchEffect('color', {
        enabled: true,
        ocioConfig: 'custom-file',
        ocioConfigAssetUrl: handle,
        ocioConfigAssetName: file.name || 'config.ocio',
      });
    } else if (role === 'depthMask') {
      patchEffect('dof', {
        enabled: true,
        maskMode: 'paint-mask',
        depthMaskUrl: handle,
        depthMaskAssetName: file.name || 'depth-mask.png',
      });
    } else if (role === 'bokeh') {
      patchEffect('dof', {
        enabled: true,
        shape: 'custom',
        bokehAssetUrl: handle,
        bokehAssetName: file.name || 'bokeh.png',
      });
    } else {
      const existingTracks = effects.tracking.tracks.slice();
      const nextTrack = existingTracks[0] || {
        id: uuidv4(),
        label: '跟踪 1',
        overlayUrl: '',
        overlayKind: file.type.startsWith('video/') ? 'video' : 'image',
        x: 50,
        y: 50,
        scale: 1,
        rotation: 0,
        opacity: 1,
        startTime: 0,
        endTime: Math.max(5, mediaMeta.duration || 5),
        blendMode: 'normal' as const,
        tracker: 'manual' as const,
      };
      nextTrack.overlayUrl = handle;
      nextTrack.overlayKind = file.type.startsWith('video/') ? 'video' : 'image';
      const nextTracks = existingTracks.length > 0 ? [nextTrack, ...existingTracks.slice(1)] : [nextTrack];
      patchEffect('tracking', { enabled: true, tracks: nextTracks });
    }

    event.target.value = '';
  }

  async function handleApplyStack() {
    if (!isAuthenticated()) {
      window.location.href = '/login';
      return;
    }
    if (!sourceAsset) {
      setLocalError('请先连接图片或视频素材，再执行后期处理。');
      return;
    }

    const mattingError = validateMattingSetup(effects.matting);
    if (mattingError) {
      setLocalError(mattingError);
      setActiveEffect('matting');
      open('post-panel');
      return;
    }
    if (effects.color.enabled && ocioValidation.severity === 'error') {
      setLocalError(ocioValidation.title);
      setActiveEffect('color');
      setColorWorkspaceTab('output');
      open('post-panel');
      return;
    }

    setLocalError('');
    setWarnings([]);
    setIsApplying(true);
    updateNodeData(id, {
      status: 'generating',
      error: '',
      params: {
        ...params,
        postEffects: effects,
        generationProgress: [{ progress: 18, message: '正在应用后期效果栈', stage: 'local-post' }],
      },
    });

    try {
      const result = await applyPostProcessingLocally({
        sourceUrl: sourceAsset.url,
        mediaKind: sourceAsset.kind,
        effects,
      });

      const nextLabel = `${normalizePostLabel(data.label, '后期结果')} 输出`;

      if (sourceAsset.kind === 'image') {
        addConnectedNode({
          type: 'image',
          position: {
            x: nodePosition.x + 700,
            y: nodePosition.y + 20,
          },
          sourceId: id,
          sourceHandle: 'post-output',
          data: {
            label: nextLabel,
            imageUrl: result.url,
            status: 'completed',
            outputs: [{
              id: `post-output-${Date.now()}`,
              type: 'image',
              url: result.url,
              metadata: {
                managedUrl: true,
                originalUrl: result.url,
                width: result.width,
                height: result.height,
                processingEngine: result.processingEngine,
                postEffects: effects,
                outputAssetId: result.assetId,
              },
            }],
            params: {
              sourceNodeId: id,
              imageMeta: { width: result.width, height: result.height },
              sourceMediaType: 'image',
              postEffects: effects,
            },
          },
        });
      } else {
        addConnectedNode({
          type: 'video',
          position: {
            x: nodePosition.x + 700,
            y: nodePosition.y + 20,
          },
          sourceId: id,
          sourceHandle: 'post-output',
          data: {
            label: nextLabel,
            videoUrl: result.url,
            quality: `${result.width}x${result.height}`,
            duration: result.duration,
            status: 'completed',
            outputs: [{
              id: `post-output-${Date.now()}`,
              type: 'video',
              url: result.url,
              metadata: {
                managedUrl: true,
                originalUrl: result.url,
                width: result.width,
                height: result.height,
                duration: result.duration,
                processingEngine: result.processingEngine,
                postEffects: effects,
                outputAssetId: result.assetId,
              },
            }],
            params: {
              sourceNodeId: id,
              videoMeta: { width: result.width, height: result.height, duration: result.duration },
              sourceMediaType: 'video',
              postEffects: effects,
            },
          },
        });
      }

      setWarnings(result.warnings);

      updateNodeData(id, {
        status: 'completed',
        error: '',
        params: {
          ...params,
          postEffects: effects,
          lastResultUrl: result.url,
          lastResultKind: sourceAsset.kind,
          lastResultMeta: {
            width: result.width,
            height: result.height,
            duration: result.duration,
            processingEngine: result.processingEngine,
            assetId: result.assetId,
            processingMeta: result.processingMeta,
          },
          postWarnings: result.warnings,
          generationProgress: [],
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '本地后期处理失败。';
      setLocalError(message);
      updateNodeData(id, {
        status: 'error',
        error: message,
        params: {
          ...params,
          postEffects: effects,
          generationProgress: [],
          lastError: message,
          lastErrorCategory: 'render',
          lastErrorStage: 'local-post',
        },
      });
    } finally {
      setIsApplying(false);
    }
  }

  function renderColorPanelBroken() {
    return null;
  }

  function renderRuntimeLinks(status: LocalPostBackendStatus | null, testId: string) {
    if (!status?.downloadUrl && !status?.docsUrl) return null;
    return (
      <div className="mt-3 flex flex-wrap gap-2" data-testid={testId}>
        {status.downloadUrl ? (
          <a
            href={status.downloadUrl}
            target="_blank"
            rel="noreferrer"
            className="nodrag rounded-full border border-[#2d3236] bg-[#121518] px-3 py-1.5 text-[11px] text-[#e7e7e7] transition hover:border-[#46515d] hover:bg-[#1b2024]"
            onPointerDown={stopCanvasPointer}
          >
            下载 Runtime
          </a>
        ) : null}
        {status.docsUrl ? (
          <a
            href={status.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="nodrag rounded-full border border-[#2d3236] bg-[#121518] px-3 py-1.5 text-[11px] text-[#9f9f9f] transition hover:border-[#46515d] hover:bg-[#1b2024] hover:text-[#e7e7e7]"
            onPointerDown={stopCanvasPointer}
          >
            查看文档
          </a>
        ) : null}
      </div>
    );
  }

  function renderRuntimeCapability(status: LocalPostBackendStatus | null) {
    if (!status) return '图片 / 视频能力未上报';
    const supportImage = status.supportsImage !== false;
    const supportVideo = status.supportsVideo === true;
    if (supportImage && supportVideo) return '支持图片 / 视频';
    if (supportImage) return '仅支持图片';
    if (supportVideo) return '仅支持视频';
    return '能力未声明';
  }

  function renderCommonInstallPaths(status: LocalPostBackendStatus | null) {
    const paths = Array.isArray(status?.commonInstallPaths) ? status.commonInstallPaths.filter(Boolean).slice(0, 3) : [];
    if (!paths.length) return '常见安装路径未预置';
    return paths.join(' / ');
  }

  function renderRefreshRuntimeButton(testId: string) {
    return (
      <button
        type="button"
        className="nodrag rounded-full border border-[#2d3236] bg-[#121518] px-3 py-1.5 text-[11px] text-[#e7e7e7] transition hover:border-[#46515d] hover:bg-[#1b2024] disabled:cursor-not-allowed disabled:opacity-60"
        onPointerDown={stopCanvasPointer}
        onClick={() => void refreshLocalPostRuntimes()}
        disabled={isRefreshingRuntimes}
        data-testid={testId}
      >
        {isRefreshingRuntimes ? '探测中...' : '一键探测'}
      </button>
    );
  }

  function renderRuntimeDoctorButton(testId: string) {
    return (
      <button
        type="button"
        className="nodrag rounded-full border border-[#24564a] bg-[#102a23] px-3 py-1.5 text-[11px] text-[#d8fff7] transition hover:border-[#2d7b66] hover:bg-[#123429] disabled:cursor-not-allowed disabled:opacity-60"
        onPointerDown={stopCanvasPointer}
        onClick={() => void runRuntimeDoctor({ force: true })}
        disabled={isRunningRuntimeDoctor}
        data-testid={testId}
      >
        {isRunningRuntimeDoctor ? '自检中...' : '安装后一键自检'}
      </button>
    );
  }

  function renderRuntimeDoctorStatusLabel(status: LocalPostDoctorRuntime['status']) {
    if (status === 'ok') return '自检通过';
    if (status === 'warn') return '部分通过';
    return '自检失败';
  }

  function renderRuntimeDoctorStatusClass(status: LocalPostDoctorRuntime['status']) {
    if (status === 'ok') return 'bg-emerald-500/12 text-emerald-200';
    if (status === 'warn') return 'bg-amber-500/12 text-amber-100';
    return 'bg-rose-500/12 text-rose-100';
  }

  function renderRuntimeDoctorPanel(runtime: LocalPostDoctorRuntime | undefined, testId: string) {
    if (!runtime) {
      return (
        <div className="mt-3 rounded-2xl border border-dashed border-[#2d3236] bg-[#0c1013] px-3 py-3 text-[11px] leading-5 text-[#8d97a2]" data-testid={testId}>
          安装完成后点“安装后一键自检”，这里会校验 `gmic.exe`、`oiiotool.exe` 或当前 OCIO config 是否真的能跑通，并同步检查最新版。
        </div>
      );
    }

    return (
      <div className="mt-3 rounded-2xl border border-[#2d3236] bg-[#0c1013] px-3 py-3 text-[11px] leading-5 text-[#9f9f9f]" data-testid={testId}>
        <div className="flex items-center justify-between gap-3">
          <div className="font-medium text-[#e7e7e7]">安装后一键自检</div>
          <div className={`rounded-full px-2 py-0.5 text-[10px] ${renderRuntimeDoctorStatusClass(runtime.status)}`}>
            {renderRuntimeDoctorStatusLabel(runtime.status)}
          </div>
        </div>
        <div className="mt-2 space-y-1.5">
          <div>自检结论：{runtime.summary}</div>
          {runtime.installedVersion ? <div>本机版本：{runtime.installedVersion}</div> : null}
          {runtime.detectedConfigPath ? <div>当前 Config：{runtime.detectedConfigPath}</div> : null}
          {runtime.configSummary ? <div>Config 校验：{runtime.configSummary}</div> : null}
          {runtime.checkedCommand?.length ? <div>检查命令：{runtime.checkedCommand.join(' ')}</div> : null}
          {runtime.elapsedMs ? <div>耗时：{runtime.elapsedMs} ms</div> : null}
          {runtime.update?.summary ? <div>更新检查：{runtime.update.summary}</div> : null}
          {runtime.update?.releaseUrl ? (
            <div>
              最新发布页：
              <a
                href={runtime.update.releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-1 text-[#7cc4ff] transition hover:text-[#9ad1ff]"
                onPointerDown={stopCanvasPointer}
              >
                {runtime.update.sourceLabel || '打开'}
              </a>
            </div>
          ) : null}
          {runtime.suggestions?.length ? <div>处理建议：{runtime.suggestions.join(' / ')}</div> : null}
          {runtime.stderr ? <div>错误输出：{runtime.stderr}</div> : null}
          {!runtime.stderr && runtime.stdout ? <div>命令输出：{runtime.stdout}</div> : null}
          {runtimeDoctor.checkedAt ? <div>最近自检：{runtimeDoctor.checkedAt}</div> : null}
        </div>
      </div>
    );
  }

  function renderRuntimeInlineHint({
    enabled,
    message,
    testId,
  }: {
    enabled: boolean;
    message: string;
    testId: string;
  }) {
    if (!enabled) return null;
    return (
      <div
        className="rounded-2xl border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-[11px] leading-5 text-amber-100/90"
        data-testid={testId}
      >
        {message}
      </div>
    );
  }

  function renderColorPanel() {
    const curvePresetMap: Record<CurveChannelKey, Array<{ value: string; label: string }>> = {
      master: [
        { value: 'linear', label: '线性' },
        { value: 'soft-contrast', label: '柔和对比' },
        { value: 'film-s', label: '电影 S 曲线' },
        { value: 'lifted-matte', label: '哑光抬黑' },
      ],
      red: [
        { value: 'linear', label: '线性' },
        { value: 'film-warm', label: '暖高光' },
        { value: 'teal-shadows', label: '青影调' },
        { value: 'crisp-highlights', label: '高光提亮' },
      ],
      green: [
        { value: 'linear', label: '线性' },
        { value: 'film-balance', label: '胶片平衡' },
        { value: 'lift-shadows', label: '暗部抬升' },
        { value: 'crisp-highlights', label: '高光提亮' },
      ],
      blue: [
        { value: 'linear', label: '线性' },
        { value: 'teal-shadows', label: '青影调' },
        { value: 'cool-highlights', label: '冷高光' },
        { value: 'lift-shadows', label: '暗部抬升' },
      ],
    };

    const activeCurveConfig = curveChannelTab === 'master'
      ? {
          preset: effects.color.masterCurve,
          points: effects.color.masterCurvePoints,
          title: '主曲线编辑器',
          onPresetChange: (value: string) => patchEffect('color', { enabled: true, preset: 'custom', masterCurve: value as PostEffectsState['color']['masterCurve'], masterCurvePoints: presetCurvePoints(value, 'master') }),
          onPointsChange: (value: PostCurvePoint[]) => patchEffect('color', { enabled: true, preset: 'custom', masterCurvePoints: value }),
          onReset: () => patchEffect('color', { enabled: true, preset: 'custom', masterCurvePoints: presetCurvePoints(effects.color.masterCurve, 'master') }),
          selectTestId: `post-field-${id}-color-master-curve`,
          editorTestId: `post-field-${id}-color-master-curve-editor`,
        }
      : curveChannelTab === 'red'
        ? {
            preset: effects.color.redCurve,
            points: effects.color.redCurvePoints,
            title: '红通道编辑器',
            onPresetChange: (value: string) => patchEffect('color', { enabled: true, preset: 'custom', redCurve: value as PostEffectsState['color']['redCurve'], redCurvePoints: presetCurvePoints(value, 'red') }),
            onPointsChange: (value: PostCurvePoint[]) => patchEffect('color', { enabled: true, preset: 'custom', redCurvePoints: value }),
            onReset: () => patchEffect('color', { enabled: true, preset: 'custom', redCurvePoints: presetCurvePoints(effects.color.redCurve, 'red') }),
            selectTestId: `post-field-${id}-color-red-curve`,
            editorTestId: `post-field-${id}-color-red-curve-editor`,
          }
        : curveChannelTab === 'green'
          ? {
              preset: effects.color.greenCurve,
              points: effects.color.greenCurvePoints,
              title: '绿通道编辑器',
              onPresetChange: (value: string) => patchEffect('color', { enabled: true, preset: 'custom', greenCurve: value as PostEffectsState['color']['greenCurve'], greenCurvePoints: presetCurvePoints(value, 'green') }),
              onPointsChange: (value: PostCurvePoint[]) => patchEffect('color', { enabled: true, preset: 'custom', greenCurvePoints: value }),
              onReset: () => patchEffect('color', { enabled: true, preset: 'custom', greenCurvePoints: presetCurvePoints(effects.color.greenCurve, 'green') }),
              selectTestId: `post-field-${id}-color-green-curve`,
              editorTestId: `post-field-${id}-color-green-curve-editor`,
            }
          : {
              preset: effects.color.blueCurve,
              points: effects.color.blueCurvePoints,
              title: '蓝通道编辑器',
              onPresetChange: (value: string) => patchEffect('color', { enabled: true, preset: 'custom', blueCurve: value as PostEffectsState['color']['blueCurve'], blueCurvePoints: presetCurvePoints(value, 'blue') }),
              onPointsChange: (value: PostCurvePoint[]) => patchEffect('color', { enabled: true, preset: 'custom', blueCurvePoints: value }),
              onReset: () => patchEffect('color', { enabled: true, preset: 'custom', blueCurvePoints: presetCurvePoints(effects.color.blueCurve, 'blue') }),
              selectTestId: `post-field-${id}-color-blue-curve`,
              editorTestId: `post-field-${id}-color-blue-curve-editor`,
            };

    return (
      <div className="grid gap-5 2xl:grid-cols-[0.9fr_1.5fr]">
        <div className="space-y-4">
          <CollapsiblePanelSection
            title="主调色台"
            note="先确定整体曝光、反差和色温，再进入曲线与二级精调。"
            collapsed={colorSectionsCollapsed.console}
            onToggle={() => toggleColorSection('console')}
          >
            <div className="grid gap-3 lg:grid-cols-2">
              <SelectField
                title="色彩预设"
                value={effects.color.preset || 'neutral'}
                options={POST_COLOR_PRESETS.map((item) => ({ value: item.value, label: item.label }))}
                onChange={(value) => {
                  const preset = POST_COLOR_PRESETS.find((item) => item.value === value);
                  if (!preset) return;
                  patchEffect('color', {
                    enabled: true,
                    preset: value as PostEffectsState['color']['preset'],
                    ...preset.patch,
                  });
                }}
                testId={`post-field-${id}-color-preset`}
              />
              <ToggleField title="启用高级调色" checked={effects.color.enabled} onChange={(value) => patchEffect('color', { enabled: value })} testId={`post-field-${id}-color-enabled`} />
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <SliderField title="曝光" value={effects.color.exposure} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', exposure: value })} testId={`post-field-${id}-color-exposure`} />
              <SliderField title="对比度" value={effects.color.contrast} min={-0.5} max={0.8} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', contrast: value })} testId={`post-field-${id}-color-contrast`} />
              <SliderField title="饱和度" value={effects.color.saturation} min={0} max={2} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', saturation: value })} testId={`post-field-${id}-color-saturation`} />
              <SliderField title="自然饱和" value={effects.color.vibrance} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', vibrance: value })} testId={`post-field-${id}-color-vibrance`} />
              <SliderField title="色温" value={effects.color.temperature} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', temperature: value })} testId={`post-field-${id}-color-temperature`} />
              <SliderField title="色调偏移" value={effects.color.tint} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', tint: value })} testId={`post-field-${id}-color-tint`} />
              <SliderField title="色相偏移" value={effects.color.hue} min={-180} max={180} step={1} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', hue: value })} testId={`post-field-${id}-color-hue`} />
            </div>
          </CollapsiblePanelSection>

          <CollapsiblePanelSection
            title="四路色轮"
            note="参考达芬奇的 primaries 逻辑，把偏色和强度放在同一块处理。"
            collapsed={colorSectionsCollapsed.wheels}
            onToggle={() => toggleColorSection('wheels')}
          >
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
              <WheelCard title="Lift" color={effects.color.liftColor} onColorChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', liftColor: value })} amount={effects.color.liftAmount} onAmountChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', liftAmount: value })} colorTestId={`post-field-${id}-color-lift-color`} amountTestId={`post-field-${id}-color-lift-amount`} />
              <WheelCard title="Gamma" color={effects.color.gammaColor} onColorChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', gammaColor: value })} amount={effects.color.gammaAmount} onAmountChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', gammaAmount: value })} colorTestId={`post-field-${id}-color-gamma-color`} amountTestId={`post-field-${id}-color-gamma-amount`} />
              <WheelCard title="Gain" color={effects.color.gainColor} onColorChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', gainColor: value })} amount={effects.color.gainAmount} onAmountChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', gainAmount: value })} colorTestId={`post-field-${id}-color-gain-color`} amountTestId={`post-field-${id}-color-gain-amount`} />
              <WheelCard title="Offset" color={effects.color.offsetColor} onColorChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', offsetColor: value })} amount={effects.color.offsetAmount} onAmountChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', offsetAmount: value })} colorTestId={`post-field-${id}-color-offset-color`} amountTestId={`post-field-${id}-color-offset-amount`} />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <SliderField title="Lift 基准" value={effects.color.lift} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', lift: value })} testId={`post-field-${id}-color-lift`} />
              <SliderField title="Gamma 基准" value={effects.color.gamma} min={0.2} max={2} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', gamma: value })} testId={`post-field-${id}-color-gamma`} />
              <SliderField title="Gain 基准" value={effects.color.gain} min={0.2} max={2} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', gain: value })} testId={`post-field-${id}-color-gain`} />
              <SliderField title="Offset 基准" value={effects.color.offset} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', offset: value })} testId={`post-field-${id}-color-offset`} />
            </div>
          </CollapsiblePanelSection>
        </div>

        <CollapsiblePanelSection
          title="调色工作区"
          note="按曲线、示波器、输出管理分域展开，默认更像专业调色工作台。"
          collapsed={colorSectionsCollapsed.workspace}
          onToggle={() => toggleColorSection('workspace')}
        >
          {renderRuntimeInlineHint({
            enabled: !postHealth.oiio?.configured || !postHealth.ocio?.configured,
            message: '当前未检测到完整 OIIO / OCIO 运行时，严格调色功能会先保留参数编辑，但生成时可能回退到本地链路。可在“模型下载 > 后期运行时依赖”里安装后再点一键自检。',
            testId: `post-color-runtime-inline-hint-${id}`,
          })}
          <div className="mb-4 flex flex-wrap gap-2">
            {[
              { id: 'curves' as const, label: '曲线', icon: Aperture },
              { id: 'scopes' as const, label: '示波器', icon: BarChart3 },
              { id: 'output' as const, label: '输出管理', icon: Settings2 },
            ].map((item) => {
              const Icon = item.icon;
              const active = colorWorkspaceTab === item.id;
              return (
                <button key={item.id} type="button" onPointerDown={stopCanvasPointer} onClick={() => setColorWorkspaceTab(item.id)} data-testid={`post-color-workspace-tab-${item.id}-${id}`} className={`nodrag inline-flex items-center gap-2 rounded-2xl border px-3 py-2 text-xs font-medium transition ${workspaceTabClass(active)}`}>
                  <Icon className="h-4 w-4" />
                  {item.label}
                </button>
              );
            })}
          </div>

          {colorWorkspaceTab === 'curves' ? (
            <div className="grid gap-4 xl:grid-cols-[1.16fr_0.84fr]">
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {([
                    { id: 'master', label: '主曲线' },
                    { id: 'red', label: '红通道' },
                    { id: 'green', label: '绿通道' },
                    { id: 'blue', label: '蓝通道' },
                  ] as Array<{ id: CurveChannelKey; label: string }>).map((item) => (
                    <button key={item.id} type="button" onPointerDown={stopCanvasPointer} onClick={() => setCurveChannelTab(item.id)} data-testid={`post-color-curve-tab-${item.id}-${id}`} className={`nodrag rounded-2xl border px-3 py-2 text-xs font-medium transition ${workspaceTabClass(curveChannelTab === item.id)}`}>
                      {item.label}
                    </button>
                  ))}
                </div>
                <SelectField title="当前通道预设" value={activeCurveConfig.preset} options={curvePresetMap[curveChannelTab]} onChange={activeCurveConfig.onPresetChange} testId={activeCurveConfig.selectTestId} />
                <CurveEditorField title={activeCurveConfig.title} channel={curveChannelTab} points={activeCurveConfig.points} onChange={activeCurveConfig.onPointsChange} onReset={activeCurveConfig.onReset} testId={activeCurveConfig.editorTestId} />
              </div>
              <PanelSection title="二级 HSL 与打印" note="曲线旁保留二级 HSL 和胶片打印，用于风格收口。">
                <div className="grid gap-3 lg:grid-cols-2">
                  <SliderField title="二级 HSL 中心" value={effects.color.secondaryHueCenter} min={0} max={360} step={1} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', secondaryHueCenter: value })} testId={`post-field-${id}-color-secondary-center`} />
                  <SliderField title="二级 HSL 范围" value={effects.color.secondaryHueRange} min={5} max={180} step={1} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', secondaryHueRange: value })} testId={`post-field-${id}-color-secondary-range`} />
                  <SliderField title="二级饱和偏置" value={effects.color.secondarySaturationBias} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', secondarySaturationBias: value })} testId={`post-field-${id}-color-secondary-sat`} />
                  <SliderField title="二级亮度偏置" value={effects.color.secondaryLumaBias} min={-1} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', secondaryLumaBias: value })} testId={`post-field-${id}-color-secondary-luma`} />
                </div>
                <div className="mt-3">
                  <SelectField title="胶片打印模拟" value={effects.color.filmPrint} options={[{ value: 'none', label: '关闭' }, { value: 'kodak-2383', label: 'Kodak 2383' }, { value: 'kodak-5219', label: 'Kodak 5219' }, { value: 'fuji-3513', label: 'Fuji 3513' }]} onChange={(value) => patchEffect('color', { enabled: true, preset: 'custom', filmPrint: value as PostEffectsState['color']['filmPrint'] })} testId={`post-field-${id}-color-film-print`} />
                </div>
              </PanelSection>
            </div>
          ) : null}

          {colorWorkspaceTab === 'scopes' ? (
            <ScopeWorkbench
              sourceKind={sourceKind}
              sourceUrl={resultUrl || sourceUrl}
              color={effects.color}
              linkedChannel={curveChannelTab}
              onLinkedChannelChange={setCurveChannelTab}
              testId={`post-color-scopes-${id}`}
            />
          ) : null}

          {colorWorkspaceTab === 'output' ? (
            <div className="grid gap-4 xl:grid-cols-[1.04fr_0.96fr]">
              <PanelSection title="色彩空间与 OCIO" note="支持内置、ACES 与自定义 OCIO config，为后续真实工作室色彩管理留出执行位。">
                <div className="grid gap-3 lg:grid-cols-2">
                  <SelectField title="输入色彩空间" value={effects.color.colorSpaceIn} options={[{ value: 'sRGB', label: 'sRGB' }, { value: 'Rec.709', label: 'Rec.709' }, { value: 'ACEScg', label: 'ACEScg' }]} onChange={(value) => patchEffect('color', { enabled: true, colorSpaceIn: value as PostEffectsState['color']['colorSpaceIn'] })} testId={`post-field-${id}-color-space-in`} />
                  <SelectField title="输出色彩空间" value={effects.color.colorSpaceOut} options={[{ value: 'sRGB', label: 'sRGB' }, { value: 'Rec.709', label: 'Rec.709' }, { value: 'DCI-P3', label: 'DCI-P3' }]} onChange={(value) => patchEffect('color', { enabled: true, colorSpaceOut: value as PostEffectsState['color']['colorSpaceOut'] })} testId={`post-field-${id}-color-space-out`} />
                  <SelectField title="OCIO 配置" value={effects.color.ocioConfig} options={[{ value: 'builtin', label: '内置基础配置' }, { value: 'aces-1.3', label: 'ACES 1.3' }, { value: 'custom-file', label: '自定义 OCIO Config' }]} onChange={(value) => patchEffect('color', { enabled: true, ocioConfig: value as PostEffectsState['color']['ocioConfig'] })} testId={`post-field-${id}-color-ocio-config`} />
                  <SelectField title="OCIO 输出视口" value={effects.color.ocioDisplay} options={[{ value: 'web-srgb', label: 'Web sRGB' }, { value: 'rec709-monitor', label: 'Rec.709 监看' }, { value: 'p3-cinema', label: 'P3 Cinema' }]} onChange={(value) => patchEffect('color', { enabled: true, ocioDisplay: value as PostEffectsState['color']['ocioDisplay'] })} testId={`post-field-${id}-color-ocio-display`} />
                  <SelectField title="OCIO 视图" value={effects.color.ocioView} options={[{ value: 'default', label: '默认视图' }, { value: 'filmic', label: 'Filmic' }, { value: 'aces', label: 'ACES' }]} onChange={(value) => patchEffect('color', { enabled: true, ocioView: value as PostEffectsState['color']['ocioView'] })} testId={`post-field-${id}-color-ocio-view`} />
                  <SelectField title="OCIO 执行" value={effects.color.ocioExecutionMode} options={[{ value: 'auto', label: '自动：Wrapper 优先' }, { value: 'wrapper-only', label: '仅 Wrapper' }, { value: 'fallback-only', label: '仅本地回退' }]} onChange={(value) => patchEffect('color', { enabled: true, ocioExecutionMode: value as PostEffectsState['color']['ocioExecutionMode'] })} testId={`post-field-${id}-color-ocio-execution-mode`} />
                </div>
                <div className="mt-3">
                  <SliderField title="OCIO 强度" value={effects.color.ocioLookStrength} min={0} max={1} step={0.01} onChange={(value) => patchEffect('color', { enabled: true, ocioLookStrength: value })} testId={`post-field-${id}-color-ocio-strength`} />
                </div>
              </PanelSection>
              <PanelSection title="LUT 与配置文件" note="LUT 与 OCIO config 拆分展示，便于确认当前真正挂载的文件。">
                <div className="grid gap-3">
                  <button type="button" className="nodrag rounded-2xl border border-[#2d3236] bg-[#121518] px-3 py-3 text-sm text-[#eef3f8] transition hover:border-[#46515d] hover:bg-[#1b2024]" onPointerDown={stopCanvasPointer} onClick={() => lutPickerRef.current?.click()} data-testid={`post-lut-button-${id}`}>导入 LUT</button>
                  <div className="rounded-2xl border border-dashed border-[#2d3236] bg-[#121518] px-3 py-3 text-xs text-[#9f9f9f]" data-testid={`post-lut-status-${id}`}>
                    <div className="font-medium text-[#e7e7e7]">{effects.color.lutAssetName ? `已接入 LUT：${effects.color.lutAssetName}` : '尚未接入 LUT 文件'}</div>
                    <div className="mt-1 leading-5">{effects.color.lutAssetName ? '当前会随本地后期请求一并上传，可继续叠加曲线、二级 HSL 和 OCIO 视图设置。' : '支持导入 .cube / .3dl LUT 文件；适合做胶片风格和品牌 Look 套版。'}</div>
                  </div>
                  <button type="button" className="nodrag rounded-2xl border border-[#2d3236] bg-[#121518] px-3 py-3 text-sm text-[#eef3f8] transition hover:border-[#46515d] hover:bg-[#1b2024]" onPointerDown={stopCanvasPointer} onClick={() => ocioConfigPickerRef.current?.click()}>导入 OCIO Config</button>
                  <div className="rounded-2xl border border-dashed border-[#2d3236] bg-[#121518] px-3 py-3 text-xs text-[#9f9f9f]">
                    <div className="font-medium text-[#e7e7e7]">{effects.color.ocioConfigAssetName ? `已接入 OCIO Config：${effects.color.ocioConfigAssetName}` : '尚未接入自定义 OCIO Config'}</div>
                    <div className="mt-1 leading-5">{effects.color.ocioConfig === 'custom-file' ? '当前会优先把自定义 config 路由到 OCIO wrapper；若 wrapper 不可用，结果区会明确显示回退原因。' : '如果需要走工作室自定义色彩管理，可切换到“自定义 OCIO Config”后导入 .ocio 文件。'}</div>
                  </div>
                  <div
                    className={`rounded-2xl border px-3 py-3 text-xs leading-5 ${
                      ocioValidation.severity === 'error'
                        ? 'border-rose-500/30 bg-rose-500/10 text-rose-100'
                        : ocioValidation.severity === 'warn'
                          ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
                          : 'border-emerald-500/20 bg-emerald-500/8 text-emerald-100'
                    }`}
                    data-testid={`post-ocio-validation-${id}`}
                    >
                    <div className="font-medium">{ocioValidation.title}</div>
                    <div className="mt-2 space-y-1">
                      {ocioValidation.details.map((detail, index) => (
                        <div key={`${detail}-${index}`}>{detail}</div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-[#2d3236] bg-[#0f1317] px-3 py-3 text-xs text-[#9f9f9f]" data-testid={`post-oiio-runtime-status-${id}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-medium text-[#e7e7e7]">OIIO 严格图片调色</div>
                      <div className={`rounded-full px-2 py-0.5 text-[10px] ${postHealth.oiio?.configured ? 'bg-emerald-500/12 text-emerald-200' : 'bg-amber-500/12 text-amber-100'}`}>
                        {postHealth.oiio?.configured ? '已可接管图片调色' : '当前未接管'}
                      </div>
                    </div>
                    <div className="mt-2 space-y-1.5 leading-5">
                      <div>接管范围：图片色彩空间转换 / LUT / 自定义 OCIO Config</div>
                      <div>运行时：{postHealth.oiio?.runtimeName || 'OpenImageIO oiiotool'}</div>
                      <div>能力：{renderRuntimeCapability(postHealth.oiio)}</div>
                      <div>后端探测路径：{postHealth.oiio?.detectedPath || '未检测到 oiiotool.exe'}</div>
                      <div>默认 OCIO Config：{postHealth.oiio?.detectedConfigPath || '未检测到 HMDAO_POST_OIIO_OCIO_CONFIG / HMDAO_POST_OCIO_CONFIG / OCIO'}</div>
                      <div>环境变量：{postHealth.oiio?.envPath || 'HMDAO_POST_OIIO_PATH'}{postHealth.oiio?.envCommand ? ` / ${postHealth.oiio.envCommand}` : ''}</div>
                      <div>常见安装路径：{renderCommonInstallPaths(postHealth.oiio)}</div>
                      <div>安装提示：{postHealth.oiio?.installHint || '安装 oiiotool 后写入 HMDAO_POST_OIIO_PATH，并提供可用的 OCIO Config。'}</div>
                      <div>成功提示：{postHealth.oiio?.successHint || '探测成功后会自动接管图片严格调色。'}</div>
                      <div>上次 OIIO 链路：{String(lastProcessingMeta.oiioBackendLabel || '未记录')}</div>
                      <div>上次默认 Config：{String(lastProcessingMeta.oiioDetectedConfigPath || '未记录')}</div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {renderRefreshRuntimeButton(`post-oiio-runtime-refresh-${id}`)}
                      {renderRuntimeDoctorButton(`post-oiio-runtime-doctor-${id}`)}
                    </div>
                    {renderRuntimeDoctorPanel(runtimeDoctor.runtimes.oiio, `post-oiio-runtime-doctor-panel-${id}`)}
                    {renderRuntimeLinks(postHealth.oiio, `post-oiio-runtime-links-${id}`)}
                  </div>
                  <div className="rounded-2xl border border-[#2d3236] bg-[#0f1317] px-3 py-3 text-xs text-[#9f9f9f]" data-testid={`post-ocio-runtime-status-${id}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-medium text-[#e7e7e7]">OCIO Runtime 状态</div>
                      <div className={`rounded-full px-2 py-0.5 text-[10px] ${postHealth.ocio?.configured ? 'bg-emerald-500/12 text-emerald-200' : 'bg-amber-500/12 text-amber-100'}`}>
                        {postHealth.ocio?.configured ? '外部 Wrapper 已配置' : '当前走本地回退 / 示例链'}
                      </div>
                    </div>
                    <div className="mt-2 space-y-1.5 leading-5">
                      <div>当前配置模式：{effects.color.ocioConfig === 'custom-file' ? '自定义 .ocio' : effects.color.ocioConfig === 'aces-1.3' ? 'ACES 1.3' : '内置基础配置'}</div>
                      <div>当前文件状态：{effects.color.ocioConfigAssetName || '未挂载自定义 config 文件'}</div>
                      <div>执行模式：{effects.color.ocioExecutionMode === 'wrapper-only' ? '仅 Wrapper' : effects.color.ocioExecutionMode === 'fallback-only' ? '仅本地回退' : '自动优先 Wrapper'}</div>
                      <div>配置校验：{effects.color.ocioConfigAssetName ? (isSupportedOcioConfigName(effects.color.ocioConfigAssetName) ? '文件扩展名通过' : '文件扩展名不在支持范围') : '尚未挂载文件'}</div>
                      <div>结构校验：{ocioConfigInspection.status === 'loading' ? '正在检查内容结构' : ocioConfigInspection.title}</div>
                      <div>文件格式：{ocioConfigInspection.formatLabel}</div>
                      <div>Profile 版本：{ocioConfigInspection.profileVersion || '未检测到'}</div>
                      <div>检测到的结构：{ocioConfigInspection.detectedSections.length ? ocioConfigInspection.detectedSections.join(' / ') : '尚未识别'}</div>
                      <div>运行时：{postHealth.ocio?.runtimeName || 'OpenColorIO Runtime'}</div>
                      <div>能力：{renderRuntimeCapability(postHealth.ocio)}</div>
                      <div>后端探测路径：{postHealth.ocio?.detectedPath || '未检测到外部 runtime 路径'}</div>
                      <div>环境变量：{postHealth.ocio?.envPath || 'HMDAO_POST_OCIO_PATH'}{postHealth.ocio?.envCommand ? ` / ${postHealth.ocio.envCommand}` : ''}</div>
                      <div>常见安装路径：{renderCommonInstallPaths(postHealth.ocio)}</div>
                      <div>示例脚本：{postHealth.ocio?.exampleRuntimePath || 'server/local_post_example_ocio.py'}</div>
                      <div>安装提示：{postHealth.ocio?.installHint || '安装 OCIO Runtime 后把路径写入 HMDAO_POST_OCIO_PATH。'}</div>
                      <div>成功提示：{postHealth.ocio?.successHint || '探测成功后会优先走外部 OCIO 链路。'}</div>
                      <div>上次输出引擎：{String(lastResultMeta.processingEngine || '尚未生成')}</div>
                      <div>上次 OCIO 链路：{String(lastProcessingMeta.ocioBackendLabel || '未记录')}</div>
                      <div>上次执行模式：{String(lastProcessingMeta.ocioExecutionMode || '未记录')}</div>
                      <div>上次配置落点：{String(lastProcessingMeta.ocioConfigName || lastProcessingMeta.ocioConfigPath || '未记录')}</div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {renderRefreshRuntimeButton(`post-ocio-runtime-refresh-${id}`)}
                      {renderRuntimeDoctorButton(`post-ocio-runtime-doctor-${id}`)}
                    </div>
                    {renderRuntimeDoctorPanel(runtimeDoctor.runtimes.ocio, `post-ocio-runtime-doctor-panel-${id}`)}
                    {renderRuntimeLinks(postHealth.ocio, `post-ocio-runtime-links-${id}`)}
                  </div>
                </div>
              </PanelSection>
            </div>
          ) : null}
        </CollapsiblePanelSection>
      </div>
    );
  }

  function renderUpscalePanel() {
    const resolvedRoute = effects.upscale.routePolicy !== 'auto'
      ? effects.upscale.routePolicy
      : effects.upscale.model === 'supir-detail'
        ? 'supir'
        : effects.upscale.model === 'fsr-fast'
          ? 'fsr-preview'
          : 'realbasicvsr';
    const backendStatus = postHealth.upscale[resolvedRoute] || null;
    const executionModeLabel = effects.upscale.executionMode === 'wrapper-only'
      ? '仅 Wrapper'
      : effects.upscale.executionMode === 'fallback-only'
        ? '仅本地回退'
        : '自动优先 Wrapper';
    return (
      <div className="grid gap-4 xl:grid-cols-[1.06fr_0.94fr]">
        <PanelSection title="增强策略" note="把倍率、模型和调度并排展开，避免所有选项挤在一列。">
          {renderRuntimeInlineHint({
            enabled: !backendStatus?.configured,
            message: '当前未检测到所选高清运行时，参数仍可编辑，但生成会回退到本地预览链路。安装完成后刷新状态即可同步到节点。',
            testId: `post-upscale-runtime-inline-hint-${id}`,
          })}
          <div className="grid gap-3 lg:grid-cols-2">
            <ToggleField title="启用高清放大" checked={effects.upscale.enabled} onChange={(value) => patchEffect('upscale', { enabled: value })} testId={`post-field-${id}-upscale-enabled`} />
            <SelectField title="放大倍率" value={String(effects.upscale.scale)} options={[{ value: '1', label: '1x' }, { value: '2', label: '2x' }, { value: '4', label: '4x' }, { value: '8', label: '8x' }]} onChange={(value) => patchEffect('upscale', { enabled: true, scale: Number(value) as 1 | 2 | 4 | 8 })} testId={`post-field-${id}-upscale-scale`} />
            <SelectField title="质量模式" value={effects.upscale.mode} options={[{ value: 'preview', label: '快速预览' }, { value: 'balanced', label: '均衡输出' }, { value: 'detail', label: '细节优先' }]} onChange={(value) => patchEffect('upscale', { enabled: true, mode: value as PostEffectsState['upscale']['mode'] })} testId={`post-field-${id}-upscale-mode`} />
            <SelectField title="算法路线" value={effects.upscale.model} options={[{ value: 'fsr-fast', label: 'FSR 快速预览' }, { value: 'realesrgan-balanced', label: 'Real-ESRGAN 均衡' }, { value: 'realbasicvsr-video', label: 'RealBasicVSR 视频' }, { value: 'supir-detail', label: 'SUPIR 细节强化' }]} onChange={(value) => patchEffect('upscale', { enabled: true, model: value as PostEffectsState['upscale']['model'] })} testId={`post-field-${id}-upscale-model`} />
            <SelectField title="调度策略" value={effects.upscale.routePolicy} options={[{ value: 'auto', label: '自动推荐' }, { value: 'fsr-preview', label: 'FSR 预览' }, { value: 'realbasicvsr', label: 'RealBasicVSR' }, { value: 'supir', label: 'SUPIR 细节' }]} onChange={(value) => patchEffect('upscale', { enabled: true, routePolicy: value as PostEffectsState['upscale']['routePolicy'] })} testId={`post-field-${id}-upscale-route-policy`} />
            <SelectField title="执行模式" value={effects.upscale.executionMode} options={[{ value: 'auto', label: '自动：Wrapper 优先' }, { value: 'wrapper-only', label: '仅 Wrapper' }, { value: 'fallback-only', label: '仅本地回退' }]} onChange={(value) => patchEffect('upscale', { enabled: true, executionMode: value as PostEffectsState['upscale']['executionMode'] })} testId={`post-field-${id}-upscale-execution-mode`} />
          </div>
        </PanelSection>
        <PanelSection title="细节修复" note="把 Tile、显存档位和去噪锐化单独放右侧，适合边看预览边微调。">
          <div className="grid gap-3 lg:grid-cols-2">
            <SelectField title="Tile 分块" value={String(effects.upscale.tileSize)} options={[{ value: '512', label: '512' }, { value: '768', label: '768' }, { value: '1024', label: '1024' }]} onChange={(value) => patchEffect('upscale', { enabled: true, tileSize: Number(value) as PostEffectsState['upscale']['tileSize'] })} testId={`post-field-${id}-upscale-tile-size`} />
            <SelectField title="显存档位" value={effects.upscale.gpuTier} options={[{ value: 'auto', label: '自动' }, { value: '8g-safe', label: '8G 安全档' }, { value: 'max-quality', label: '极致画质' }]} onChange={(value) => patchEffect('upscale', { enabled: true, gpuTier: value as PostEffectsState['upscale']['gpuTier'] })} testId={`post-field-${id}-upscale-gpu-tier`} />
            <ToggleField title="接缝修复" checked={effects.upscale.seamFix} onChange={(value) => patchEffect('upscale', { enabled: true, seamFix: value })} testId={`post-field-${id}-upscale-seam-fix`} />
          </div>
          <div className="mt-3 grid gap-3">
            <SliderField title="去噪" value={effects.upscale.denoise} min={0} max={1} step={0.01} onChange={(value) => patchEffect('upscale', { enabled: true, denoise: value })} testId={`post-field-${id}-upscale-denoise`} />
            <SliderField title="锐化" value={effects.upscale.sharpen} min={0} max={1} step={0.01} onChange={(value) => patchEffect('upscale', { enabled: true, sharpen: value })} testId={`post-field-${id}-upscale-sharpen`} />
            <SliderField title="时序稳定" value={effects.upscale.temporalStability} min={0} max={1} step={0.01} onChange={(value) => patchEffect('upscale', { enabled: true, temporalStability: value })} testId={`post-field-${id}-upscale-temporal-stability`} />
          </div>
          <div className="mt-3 rounded-2xl border border-[#2d3236] bg-[#0f1317] px-3 py-3 text-xs text-[#9f9f9f]" data-testid={`post-upscale-runtime-status-${id}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium text-[#e7e7e7]">高清 Runtime 状态</div>
              <div className={`rounded-full px-2 py-0.5 text-[10px] ${backendStatus?.configured ? 'bg-emerald-500/12 text-emerald-200' : 'bg-amber-500/12 text-amber-100'}`}>
                {backendStatus?.configured ? '外部 Wrapper 已配置' : '当前走本地回退 / 示例链'}
              </div>
            </div>
            <div className="mt-2 space-y-1.5 leading-5">
              <div>当前路由：{resolvedRoute}</div>
              <div>执行模式：{executionModeLabel}</div>
              <div>当前模型：{effects.upscale.model}</div>
              <div>倍率 / Tile：{effects.upscale.scale}x / {effects.upscale.tileSize}</div>
              <div>运行时：{backendStatus?.runtimeName || '高清 Wrapper'}</div>
              <div>能力：{renderRuntimeCapability(backendStatus)}</div>
              <div>后端探测路径：{backendStatus?.detectedPath || '未检测到外部 runtime 路径'}</div>
              <div>环境变量：{backendStatus?.envPath || '未记录'}{backendStatus?.envCommand ? ` / ${backendStatus.envCommand}` : ''}</div>
              <div>常见安装路径：{renderCommonInstallPaths(backendStatus)}</div>
              <div>Wrapper 脚本：{backendStatus?.wrapperScript || '未记录'}</div>
              <div>示例脚本：{backendStatus?.exampleRuntimePath || 'server/local_post_example_realbasicvsr.py'}</div>
              <div>安装提示：{backendStatus?.installHint || '请把外部高清运行入口写入对应 HMDAO_POST_*_PATH。'}</div>
              <div>成功提示：{backendStatus?.successHint || '探测成功后会优先走外部高清链路。'}</div>
              <div>上次输出引擎：{String(lastResultMeta.processingEngine || '尚未生成')}</div>
              <div>上次高清链路：{String(lastProcessingMeta.upscaleBackendLabel || '未记录')}</div>
              <div>上次回退原因：{String(lastProcessingMeta.upscaleFallbackReason || '未记录')}</div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {renderRefreshRuntimeButton(`post-upscale-runtime-refresh-${id}`)}
            </div>
            {renderRuntimeLinks(backendStatus, `post-upscale-runtime-links-${id}`)}
          </div>
        </PanelSection>
      </div>
    );
  }

  function renderBloomPanel() {
    return (
      <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <PanelSection title="辉光风格" note="先选预设和混合模式，再处理扩散参数。">
          {renderRuntimeInlineHint({
            enabled: !postHealth.gmic?.configured,
            message: '当前未检测到 G\'MIC CLI，Bloom / Grain 会临时走本地回退链路。安装 G\'MIC 后点一键自检，节点会自动切到真实处理。',
            testId: `post-gmic-runtime-inline-hint-${id}`,
          })}
          <div className="grid gap-3 lg:grid-cols-2">
            <ToggleField title="启用氛围辉光" checked={effects.bloom.enabled} onChange={(value) => patchEffect('bloom', { enabled: value })} testId={`post-field-${id}-bloom-enabled`} />
            <SelectField
              title="辉光预设"
              value={effects.bloom.preset}
              options={POST_BLOOM_PRESETS.map((item) => ({ value: item.value, label: item.label }))}
              onChange={(value) => {
                const preset = POST_BLOOM_PRESETS.find((item) => item.value === value);
                if (!preset) return;
                patchEffect('bloom', {
                  enabled: true,
                  preset: value as PostEffectsState['bloom']['preset'],
                  ...preset.patch,
                });
              }}
              testId={`post-field-${id}-bloom-preset`}
            />
            <SelectField title="混合模式" value={effects.bloom.blendMode} options={[{ value: 'screen', label: '滤色 Screen' }, { value: 'add', label: '叠加 Add' }, { value: 'softlight', label: '柔光 Soft Light' }]} onChange={(value) => patchEffect('bloom', { enabled: true, blendMode: value as PostEffectsState['bloom']['blendMode'] })} testId={`post-field-${id}-bloom-blend-mode`} />
          </div>
        </PanelSection>
        <PanelSection title="扩散参数" note="右侧保持宽松排版，避免半径和强度滑杆挤在一起。">
          <div className="grid gap-3">
            <SliderField title="阈值" value={effects.bloom.threshold} min={0.1} max={1} step={0.01} onChange={(value) => patchEffect('bloom', { enabled: true, threshold: value })} testId={`post-field-${id}-bloom-threshold`} />
            <SliderField title="辉光强度" value={effects.bloom.intensity} min={0} max={1.2} step={0.01} onChange={(value) => patchEffect('bloom', { enabled: true, intensity: value })} testId={`post-field-${id}-bloom-intensity`} />
            <SliderField title="扩散半径" value={effects.bloom.radius} min={1} max={48} step={1} onChange={(value) => patchEffect('bloom', { enabled: true, radius: value })} testId={`post-field-${id}-bloom-radius`} />
            <SliderField title="RGB 分离" value={effects.bloom.rgbSplit} min={0} max={0.2} step={0.01} onChange={(value) => patchEffect('bloom', { enabled: true, rgbSplit: value })} testId={`post-field-${id}-bloom-rgb-split`} />
            <SliderField title="镜头脏污强度" value={effects.bloom.dirtStrength} min={0} max={1} step={0.01} onChange={(value) => patchEffect('bloom', { enabled: true, dirtStrength: value })} testId={`post-field-${id}-bloom-dirt-strength`} />
          </div>
          <div className="mt-3 rounded-2xl border border-[#2d3236] bg-[#0f1317] px-3 py-3 text-xs text-[#9f9f9f]" data-testid={`post-gmic-runtime-status-${id}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium text-[#e7e7e7]">G&apos;MIC Runtime 状态</div>
              <div className={`rounded-full px-2 py-0.5 text-[10px] ${postHealth.gmic?.configured ? 'bg-emerald-500/12 text-emerald-200' : 'bg-amber-500/12 text-amber-100'}`}>
                {postHealth.gmic?.configured ? '图片真实处理已接入' : '当前走 FFmpeg 回退'}
              </div>
            </div>
            <div className="mt-2 space-y-1.5 leading-5">
              <div>接管范围：Bloom / Grain / 细节修复</div>
              <div>运行时：{postHealth.gmic?.runtimeName || 'G\'MIC CLI'}</div>
              <div>能力：{renderRuntimeCapability(postHealth.gmic)}</div>
              <div>后端探测路径：{postHealth.gmic?.detectedPath || '未检测到 gmic.exe'}</div>
              <div>环境变量：{postHealth.gmic?.envPath || 'HMDAO_POST_GMIC_PATH'}{postHealth.gmic?.envCommand ? ` / ${postHealth.gmic.envCommand}` : ''}</div>
              <div>常见安装路径：{renderCommonInstallPaths(postHealth.gmic)}</div>
              <div>安装提示：{postHealth.gmic?.installHint || '安装 G\'MIC CLI 后把 gmic.exe 路径写入 HMDAO_POST_GMIC_PATH。'}</div>
              <div>成功提示：{postHealth.gmic?.successHint || '探测成功后 Bloom / Grain 会优先走 G\'MIC。'}</div>
              <div>上次 G&apos;MIC 链路：{String(lastProcessingMeta.gmicBackendLabel || '未记录')}</div>
              <div>上次执行阶段：{Array.isArray(lastProcessingMeta.gmicStagesApplied) && lastProcessingMeta.gmicStagesApplied.length ? (lastProcessingMeta.gmicStagesApplied as string[]).join(' / ') : '未记录'}</div>
              <div>上次回退原因：{String(lastProcessingMeta.gmicFallbackReason || '未记录')}</div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {renderRefreshRuntimeButton(`post-gmic-runtime-refresh-${id}`)}
              {renderRuntimeDoctorButton(`post-gmic-runtime-doctor-${id}`)}
            </div>
            {renderRuntimeDoctorPanel(runtimeDoctor.runtimes.gmic, `post-gmic-runtime-doctor-panel-${id}`)}
            {renderRuntimeLinks(postHealth.gmic, `post-gmic-runtime-links-${id}`)}
          </div>
        </PanelSection>
      </div>
    );
  }

  function renderDofPanel() {
    return (
      <div className="grid gap-4 xl:grid-cols-[1.02fr_0.98fr]">
        <PanelSection title="焦区与深度" note="左侧放焦区、深度引擎和过渡逻辑，便于先定清晰区域。">
          <div className="grid gap-3 lg:grid-cols-2">
            <ToggleField title="启用景深" checked={effects.dof.enabled} onChange={(value) => patchEffect('dof', { enabled: value })} testId={`post-field-${id}-dof-enabled`} />
            <SelectField title="景深模式" value={effects.dof.engine} options={[{ value: 'manual-focus-box', label: '手动焦区' }, { value: 'depth-anything-v2-small', label: 'Depth Anything V2 自动深度' }]} onChange={(value) => patchEffect('dof', { enabled: true, engine: value as PostEffectsState['dof']['engine'] })} testId={`post-field-${id}-dof-engine`} />
            <SelectField
              title="蒙版模式"
              value={effects.dof.maskMode}
              options={[{ value: 'focus-box', label: '焦区框' }, { value: 'paint-mask', label: '手绘蒙版（预留）' }]}
              onChange={(value) => patchEffect('dof', { enabled: true, maskMode: value as PostEffectsState['dof']['maskMode'] })}
              testId={`post-field-${id}-dof-mask-mode`}
            />
            <SelectField
              title="散景形状"
              value={effects.dof.shape}
              options={[{ value: 'round', label: '圆形' }, { value: 'hex', label: '六边形' }, { value: 'custom', label: '自定义（预留）' }]}
              onChange={(value) => patchEffect('dof', { enabled: true, shape: value as PostEffectsState['dof']['shape'] })}
              testId={`post-field-${id}-dof-shape`}
            />
            <ToggleField title="深度预览" checked={effects.dof.depthPreview} onChange={(value) => patchEffect('dof', { enabled: true, depthPreview: value })} testId={`post-field-${id}-dof-depth-preview`} />
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <SelectField
              title="过渡风格"
              value={effects.dof.transitionPreset}
              options={[{ value: 'hard', label: '硬切' }, { value: 'soft', label: '柔和' }, { value: 'cinematic', label: '电影感' }]}
              onChange={(value) => patchEffect('dof', { enabled: true, transitionPreset: value as PostEffectsState['dof']['transitionPreset'] })}
              testId={`post-field-${id}-dof-transition-preset`}
            />
            <SliderField title="自动深度权重" value={effects.dof.autoDepthStrength} min={0} max={1} step={0.01} onChange={(value) => patchEffect('dof', { enabled: true, autoDepthStrength: value })} testId={`post-field-${id}-dof-auto-depth-strength`} />
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <SliderField title="焦点 X" value={effects.dof.focusX} min={0} max={100} step={1} onChange={(value) => patchEffect('dof', { enabled: true, focusX: value })} testId={`post-field-${id}-dof-focus-x`} />
            <SliderField title="焦点 Y" value={effects.dof.focusY} min={0} max={100} step={1} onChange={(value) => patchEffect('dof', { enabled: true, focusY: value })} testId={`post-field-${id}-dof-focus-y`} />
            <SliderField title="焦区宽度" value={effects.dof.focusWidth} min={4} max={100} step={1} onChange={(value) => patchEffect('dof', { enabled: true, focusWidth: value })} testId={`post-field-${id}-dof-focus-width`} />
            <SliderField title="焦区高度" value={effects.dof.focusHeight} min={4} max={100} step={1} onChange={(value) => patchEffect('dof', { enabled: true, focusHeight: value })} testId={`post-field-${id}-dof-focus-height`} />
          </div>
        </PanelSection>
        <PanelSection title="模糊与素材" note="上传蒙版和 Bokeh 保持独立，不会和数值调节区互相遮挡。">
          <div className="grid gap-3">
            <SliderField title="虚化强度" value={effects.dof.blurStrength} min={0} max={1.2} step={0.01} onChange={(value) => patchEffect('dof', { enabled: true, blurStrength: value })} testId={`post-field-${id}-dof-blur-strength`} />
            <SliderField title="边缘羽化" value={effects.dof.feather} min={0} max={50} step={1} onChange={(value) => patchEffect('dof', { enabled: true, feather: value })} testId={`post-field-${id}-dof-feather`} />
            <SliderField title="自动深度融合" value={effects.dof.depthBlend} min={0} max={1} step={0.01} onChange={(value) => patchEffect('dof', { enabled: true, depthBlend: value })} testId={`post-field-${id}-dof-depth-blend`} />
            <SliderField title="手绘笔刷" value={effects.dof.brushSize} min={4} max={120} step={1} onChange={(value) => patchEffect('dof', { enabled: true, brushSize: value })} testId={`post-field-${id}-dof-brush-size`} />
            <ToggleField title="启用移轴效果" checked={effects.dof.tiltShift} onChange={(value) => patchEffect('dof', { enabled: true, tiltShift: value })} testId={`post-field-${id}-dof-tilt-shift`} />
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            className="nodrag rounded-xl border border-white/8 bg-[#111] px-3 py-2 text-sm text-[#ececec] hover:bg-[#181818]"
            onPointerDown={stopCanvasPointer}
            onClick={() => depthMaskPickerRef.current?.click()}
            data-testid={`post-depth-mask-button-${id}`}
          >
            导入深度蒙版
          </button>
          <button
            type="button"
            className="nodrag rounded-xl border border-white/8 bg-[#111] px-3 py-2 text-sm text-[#ececec] hover:bg-[#181818]"
            onPointerDown={stopCanvasPointer}
            onClick={() => bokehPickerRef.current?.click()}
            data-testid={`post-bokeh-button-${id}`}
          >
            导入自定义 Bokeh
          </button>
          </div>
          <div className="rounded-xl border border-dashed border-white/10 bg-[#111] px-3 py-3 text-xs text-[#9f9f9f]">
            <div className="font-medium text-[#e7e7e7]">
              {effects.dof.depthMaskAssetName ? `已接入深度蒙版：${effects.dof.depthMaskAssetName}` : '尚未接入手绘深度蒙版'}
            </div>
            <div className="mt-1">
              {effects.dof.bokehAssetName ? `自定义散景贴图：${effects.dof.bokehAssetName}` : '可上传 PNG 作为自定义散景贴图；未配置时默认使用圆形或六边形散景。'}
            </div>
          </div>
        </PanelSection>
      </div>
    );
  }

  function renderGrainPanel() {
    return (
      <div className="grid gap-4 xl:grid-cols-[0.88fr_1.12fr]">
        <PanelSection title="颗粒胶片感" note="预设和 ISO 放左侧，参数滑杆放右侧，观察会更直观。">
          <div className="grid gap-3 lg:grid-cols-2">
            <ToggleField title="启用电影颗粒" checked={effects.grain.enabled} onChange={(value) => patchEffect('grain', { enabled: value })} testId={`post-field-${id}-grain-enabled`} />
            <SelectField title="ISO 模拟" value={String(effects.grain.iso)} options={['100', '400', '800', '1600', '3200', '6400'].map((value) => ({ value, label: value }))} onChange={(value) => patchEffect('grain', { enabled: true, iso: Number(value) as PostEffectsState['grain']['iso'] })} testId={`post-field-${id}-grain-iso`} />
            <SelectField
              title="颗粒预设"
              value={effects.grain.preset}
              options={POST_GRAIN_PRESETS.map((item) => ({ value: item.value, label: item.label }))}
              onChange={(value) => {
                const preset = POST_GRAIN_PRESETS.find((item) => item.value === value);
                if (!preset) return;
                patchEffect('grain', {
                  enabled: true,
                  preset: value as PostEffectsState['grain']['preset'],
                  ...preset.patch,
                });
              }}
              testId={`post-field-${id}-grain-preset`}
            />
            <SelectField title="分布模型" value={effects.grain.distribution} options={[{ value: 'gaussian', label: '高斯' }, { value: 'poisson', label: '泊松' }, { value: 'lognormal', label: '对数正态' }]} onChange={(value) => patchEffect('grain', { enabled: true, distribution: value as PostEffectsState['grain']['distribution'] })} testId={`post-field-${id}-grain-distribution`} />
          </div>
        </PanelSection>
        <PanelSection title="颗粒控制" note="四条核心滑杆铺开显示，不再挤成竖排长列表。">
          <div className="grid gap-3">
            <SliderField title="颗粒强度" value={effects.grain.amount} min={0} max={1} step={0.01} onChange={(value) => patchEffect('grain', { enabled: true, amount: value })} testId={`post-field-${id}-grain-amount`} />
            <SliderField title="颗粒尺寸" value={effects.grain.size} min={0.5} max={4} step={0.1} onChange={(value) => patchEffect('grain', { enabled: true, size: value })} testId={`post-field-${id}-grain-size`} />
            <SliderField title="彩色颗粒" value={effects.grain.chroma} min={0} max={1} step={0.01} onChange={(value) => patchEffect('grain', { enabled: true, chroma: value })} testId={`post-field-${id}-grain-chroma`} />
            <SliderField title="暗部加重" value={effects.grain.shadowBoost} min={0} max={1} step={0.01} onChange={(value) => patchEffect('grain', { enabled: true, shadowBoost: value })} testId={`post-field-${id}-grain-shadow-boost`} />
          </div>
        </PanelSection>
      </div>
    );
  }

  function renderMattingPanel() {
    return (
      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <PanelSection title="抠像逻辑" note="主体模式与执行路径独立展开，减少面板拥挤。">
          <div className="grid gap-3 lg:grid-cols-2">
            <ToggleField title="启用抠像 / 背景合成" checked={effects.matting.enabled} onChange={(value) => patchEffect('matting', { enabled: value })} testId={`post-field-${id}-matting-enabled`} />
            <ToggleField title="标签式分层" checked={effects.matting.tagLayering} onChange={(value) => patchEffect('matting', { enabled: true, tagLayering: value })} testId={`post-field-${id}-matting-tag-layering`} />
            <SelectField title="执行路径" value={effects.matting.engine} options={[{ value: 'upload-mask', label: '上传蒙版直通' }, { value: 'sam2-wrapper', label: 'SAM2 Wrapper（预留）' }, { value: 'rvm-wrapper', label: 'RVM Wrapper（预留）' }]} onChange={(value) => patchEffect('matting', { enabled: true, engine: value as PostEffectsState['matting']['engine'] })} testId={`post-field-${id}-matting-engine`} />
            <SelectField title="输出模式" value={effects.matting.mode} options={[{ value: 'keep-foreground', label: '保留前景' }, { value: 'replace-background', label: '替换背景' }, { value: 'remove-background', label: '移除背景' }]} onChange={(value) => patchEffect('matting', { enabled: true, mode: value as PostEffectsState['matting']['mode'] })} testId={`post-field-${id}-matting-mode`} />
          </div>
          <label className="mt-3 block">
            <FieldLabel title="主体提示" note="后续可复用到 SAM2 / RVM 执行链" />
            <input type="text" value={effects.matting.subjectPrompt} onChange={(event) => patchEffect('matting', { enabled: true, subjectPrompt: event.target.value })} onPointerDown={stopCanvasPointer} data-testid={`post-field-${id}-matting-subject-prompt`} className="nodrag w-full rounded-xl border border-white/8 bg-[#111] px-3 py-2 text-sm text-[#ececec] outline-none" placeholder="例如：人物主体、手持产品、车身主体" />
          </label>
        </PanelSection>
        <PanelSection title="蒙版与边缘" note="素材按钮放右侧，上方操作、下方精修，观察更方便。">
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" className="nodrag rounded-xl border border-white/8 bg-[#111] px-3 py-2 text-sm text-[#ececec] hover:bg-[#181818]" onPointerDown={stopCanvasPointer} onClick={() => maskPickerRef.current?.click()} data-testid={`post-mask-button-${id}`}>上传蒙版</button>
            <button type="button" className="nodrag rounded-xl border border-white/8 bg-[#111] px-3 py-2 text-sm text-[#ececec] hover:bg-[#181818]" onPointerDown={stopCanvasPointer} onClick={() => backgroundPickerRef.current?.click()} data-testid={`post-background-button-${id}`}>选择背景</button>
          </div>
          <div className="mt-3 grid gap-3">
            <SliderField title="边缘羽化" value={effects.matting.edgeFeather} min={0} max={32} step={1} onChange={(value) => patchEffect('matting', { enabled: true, edgeFeather: value })} testId={`post-field-${id}-matting-edge-feather`} />
            <SliderField title="去溢色" value={effects.matting.despill} min={0} max={1} step={0.01} onChange={(value) => patchEffect('matting', { enabled: true, despill: value })} testId={`post-field-${id}-matting-despill`} />
            <ToggleField title="填充透明背景" checked={effects.matting.fillBackground} onChange={(value) => patchEffect('matting', { enabled: true, fillBackground: value })} testId={`post-field-${id}-matting-fill-background`} />
          </div>
        </PanelSection>
      </div>
    );
  }

  function renderTrackingPanel() {
    return (
      <div className="grid gap-4 xl:grid-cols-[0.96fr_1.04fr]">
        <PanelSection title="跟踪模式" note="引擎、模式和叠加入口在左侧，先定执行路径。">
          <div className="grid gap-3 lg:grid-cols-2">
            <ToggleField title="启用运动跟踪 / 素材叠加" checked={effects.tracking.enabled} onChange={(value) => patchEffect('tracking', { enabled: value })} testId={`post-field-${id}-tracking-enabled`} />
            <SelectField title="跟踪引擎" value={effects.tracking.trackerEngine} options={[{ value: 'manual', label: '手动叠加' }, { value: 'cotracker3-wrapper', label: 'CoTracker3 Wrapper（预留）' }]} onChange={(value) => patchEffect('tracking', { enabled: true, trackerEngine: value as PostEffectsState['tracking']['trackerEngine'] })} testId={`post-field-${id}-tracking-engine`} />
            <SelectField
              title="跟踪模式"
              value={effects.tracking.trackMode}
              options={[
                { value: 'point', label: '点跟踪' },
                { value: 'box', label: '框选跟踪' },
                { value: 'region', label: '区域跟踪' },
              ]}
              onChange={(value) => patchEffect('tracking', { enabled: true, trackMode: value as PostEffectsState['tracking']['trackMode'] })}
              testId={`post-field-${id}-tracking-mode`}
            />
            <ToggleField title="透视变换" checked={effects.tracking.perspectiveWarp} onChange={(value) => patchEffect('tracking', { enabled: true, perspectiveWarp: value })} testId={`post-field-${id}-tracking-perspective`} />
          </div>
          <button type="button" className="mt-3 nodrag rounded-xl border border-white/8 bg-[#111] px-3 py-2 text-sm text-[#ececec] hover:bg-[#181818]" onPointerDown={stopCanvasPointer} onClick={() => trackPickerRef.current?.click()} data-testid={`post-track-button-${id}`}>上传叠加素材</button>
        </PanelSection>
        <PanelSection title="叠加参数" note="位置、缩放和混合模式单独成区，避免与模式区互相遮挡。">
          <div className="grid gap-3 sm:grid-cols-2">
            <ToggleField title="锁定缩放" checked={effects.tracking.lockScale} onChange={(value) => patchEffect('tracking', { enabled: true, lockScale: value })} testId={`post-field-${id}-tracking-lock-scale`} />
            <ToggleField title="锁定旋转" checked={effects.tracking.lockRotation} onChange={(value) => patchEffect('tracking', { enabled: true, lockRotation: value })} testId={`post-field-${id}-tracking-lock-rotation`} />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <ToggleField title="运动模糊匹配" checked={effects.tracking.motionBlur} onChange={(value) => patchEffect('tracking', { enabled: true, motionBlur: value })} testId={`post-field-${id}-tracking-motion-blur`} />
            <ToggleField title="遮挡感知" checked={effects.tracking.occlusionAware} onChange={(value) => patchEffect('tracking', { enabled: true, occlusionAware: value })} testId={`post-field-${id}-tracking-occlusion-aware`} />
          </div>
          {effects.tracking.tracks[0] ? (
            <>
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <SliderField title="X 位置" value={effects.tracking.tracks[0].x} min={0} max={100} step={1} onChange={(value) => patchFirstTrack({ x: value })} testId={`post-field-${id}-tracking-x`} />
                <SliderField title="Y 位置" value={effects.tracking.tracks[0].y} min={0} max={100} step={1} onChange={(value) => patchFirstTrack({ y: value })} testId={`post-field-${id}-tracking-y`} />
                <SliderField title="缩放" value={effects.tracking.tracks[0].scale} min={0.1} max={3} step={0.01} onChange={(value) => patchFirstTrack({ scale: value })} testId={`post-field-${id}-tracking-scale`} />
                <SliderField title="旋转" value={effects.tracking.tracks[0].rotation} min={-180} max={180} step={1} onChange={(value) => patchFirstTrack({ rotation: value })} testId={`post-field-${id}-tracking-rotation`} />
                <SliderField title="透明度" value={effects.tracking.tracks[0].opacity} min={0} max={1} step={0.01} onChange={(value) => patchFirstTrack({ opacity: value })} testId={`post-field-${id}-tracking-opacity`} />
              </div>
              <SelectField
                title="混合模式"
                value={effects.tracking.tracks[0].blendMode}
                options={[
                  { value: 'normal', label: '正常' },
                  { value: 'screen', label: '滤色' },
                  { value: 'add', label: '叠加' },
                ]}
                onChange={(value) => patchFirstTrack({ blendMode: value as PostEffectsState['tracking']['tracks'][number]['blendMode'] })}
                testId={`post-field-${id}-tracking-blend-mode`}
              />
            </>
          ) : (
            <div className="rounded-xl border border-dashed border-white/10 px-3 py-4 text-sm text-[#8f8f8f]" data-testid={`post-tracking-empty-${id}`}>
              先上传一份 PNG、JPG 或 MP4 叠加素材，再继续调整位置、缩放和透明度。
            </div>
          )}
        </PanelSection>
      </div>
    );
  }

  function renderActivePanel() {
    switch (activeEffect) {
      case 'color':
        return renderColorPanel();
      case 'upscale':
        return renderUpscalePanel();
      case 'bloom':
        return renderBloomPanel();
      case 'dof':
        return renderDofPanel();
      case 'grain':
        return renderGrainPanel();
      case 'matting':
        return renderMattingPanel();
      case 'tracking':
        return renderTrackingPanel();
      default:
        return null;
    }
  }

  const headerStyle: CSSProperties = {
    width: 560,
    minHeight: 432,
  };

  const activeDescriptor = POST_EFFECT_DESCRIPTORS[activeEffect];
  const nodeStatus =
    data.status === 'generating'
    || data.status === 'completed'
    || data.status === 'error'
      ? data.status
      : 'idle';

  return (
    <div className="relative overflow-visible" data-testid={`post-node-wrap-${id}`}>
      <div
        className={`group relative rounded-[28px] border border-white/10 bg-[#161616] shadow-[0_20px_60px_rgba(0,0,0,0.36)] transition-all ${selected ? 'ring-1 ring-[#00d4aa]/40' : ''}`}
        style={headerStyle}
        data-testid={`post-node-${id}`}
      >
        <Handle id="post-input" type="target" position={Position.Left} style={{ left: -18 }} className="!h-4 !w-4 !border-2 !border-white/80 !bg-[#111]" />
        <Handle id="post-output" type="source" position={Position.Right} style={{ right: -18 }} className="!h-4 !w-4 !border-2 !border-white/80 !bg-[#00d4aa]" />

        <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#ff7a1a]/15 text-[#ff9f52]">
            <Clapperboard className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <EditableNodeTitle
              nodeId={id}
              icon={Clapperboard}
              label={normalizePostLabel(data.label)}
              fallback="后期节点"
              className="truncate text-sm font-semibold text-white [&>svg]:hidden"
            />
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[#9c9c9c]">
              <span>{sourceKind === 'video' ? '视频后期' : sourceKind === 'image' ? '图片后期' : '等待输入素材'}</span>
              <span>|</span>
              <span>{enabledCount > 0 ? `已启用 ${enabledCount} 个效果` : '尚未启用效果'}</span>
              <span>|</span>
              <span>{sourceInherited ? '输入端继承' : legacySourceUrl ? '兼容历史素材' : '未连接源节点'}</span>
            </div>
          </div>
        </div>
        <StatusBadge status={nodeStatus} />
        </div>

        <div className="px-4 py-4">
        {sourceUrl ? (
          <div className="mx-auto" style={previewStyle}>
            <PostComparePreview
              mediaKind={sourceKind || 'image'}
              beforeUrl={sourceUrl}
              afterUrl={compareEnabled && resultUrl ? resultUrl : undefined}
              afterStyle={compareEnabled && !resultUrl ? previewDescriptor.mediaStyle : undefined}
              afterLabel={resultUrl ? '真实结果' : '实时预览'}
              className="h-full w-full"
              containerTestId={`post-preview-${id}`}
              dividerTestId={`post-compare-divider-${id}`}
              beforeOverlay={null}
              afterOverlay={<PreviewOverlay descriptor={previewDescriptor} mediaKind={sourceKind} />}
            />
          </div>
        ) : (
          <EmptySourceCard />
        )}

        <div className="mt-3 flex items-center justify-between gap-2 rounded-2xl border border-white/8 bg-[#111] px-3 py-2 text-[11px] text-[#bdbdbd]">
          <span className="truncate">{stackSummary}</span>
          <button
            type="button"
            className={`nodrag rounded-full px-2.5 py-1 transition ${compareEnabled ? 'bg-[#00d4aa]/14 text-[#d5fff5]' : 'bg-white/6 text-[#b6b6b6]'}`}
            onPointerDown={stopCanvasPointer}
            onClick={() => setCompareEnabled((value) => !value)}
            data-testid={`post-compare-toggle-${id}`}
          >
            {compareEnabled ? '对比已开' : '开启对比'}
          </button>
        </div>

        {ocioResultSummary ? (
          <div className={`mt-3 rounded-2xl border px-3 py-3 text-xs leading-5 ${ocioResultSummary.toneClass}`} data-testid={`post-ocio-result-summary-${id}`}>
            <div className="font-medium">{ocioResultSummary.title}</div>
            <div className="mt-2 space-y-1">
              {ocioResultSummary.details.map((detail, index) => (
                <div key={`${detail}-${index}`}>{detail}</div>
              ))}
            </div>
          </div>
        ) : null}
        {upscaleResultSummary ? (
          <div className={`mt-3 rounded-2xl border px-3 py-3 text-xs leading-5 ${upscaleResultSummary.toneClass}`} data-testid={`post-upscale-result-summary-${id}`}>
            <div className="font-medium">{upscaleResultSummary.title}</div>
            <div className="mt-2 space-y-1">
              {upscaleResultSummary.details.map((detail, index) => (
                <div key={`${detail}-${index}`}>{detail}</div>
              ))}
            </div>
          </div>
        ) : null}
        {oiioResultSummary ? (
          <div className={`mt-3 rounded-2xl border px-3 py-3 text-xs leading-5 ${oiioResultSummary.toneClass}`} data-testid={`post-oiio-result-summary-${id}`}>
            <div className="font-medium">{oiioResultSummary.title}</div>
            <div className="mt-2 space-y-1">
              {oiioResultSummary.details.map((detail, index) => (
                <div key={`${detail}-${index}`}>{detail}</div>
              ))}
            </div>
          </div>
        ) : null}
        {gmicResultSummary ? (
          <div className={`mt-3 rounded-2xl border px-3 py-3 text-xs leading-5 ${gmicResultSummary.toneClass}`} data-testid={`post-gmic-result-summary-${id}`}>
            <div className="font-medium">{gmicResultSummary.title}</div>
            <div className="mt-2 space-y-1">
              {gmicResultSummary.details.map((detail, index) => (
                <div key={`${detail}-${index}`}>{detail}</div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2">
          {POST_EFFECT_ORDER.map((effectId) => {
            const descriptor = POST_EFFECT_DESCRIPTORS[effectId];
            const enabled = effects[effectId].enabled;
            const active = panelOpen && activeEffect === effectId;
            return (
              <button
                key={effectId}
                type="button"
                onPointerDown={stopCanvasPointer}
                onClick={() => handleOpenEffect(effectId)}
                data-testid={`post-tool-${id}-${effectId}`}
                className={`nodrag rounded-2xl border px-3 py-2 text-xs transition ${
                  active
                    ? 'border-[#00d4aa]/45 bg-[#0e2f2a] text-[#e5fff8]'
                    : enabled
                      ? 'border-[#ff9f52]/22 bg-[#271b11] text-[#ffe6d1]'
                      : 'border-white/8 bg-[#121212] text-[#d4d4d4] hover:bg-[#181818]'
                }`}
              >
                {descriptor.label}
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="nodrag inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-[#111] px-3 py-2 text-sm text-[#ececec] hover:bg-[#1a1a1a]"
            onPointerDown={stopCanvasPointer}
            onClick={() => handleOpenEffect('matting')}
            data-testid={`post-matting-open-${id}`}
          >
            <Layers3 className="h-4 w-4" />
            抠像 / 合成
          </button>
          <button
            type="button"
            className="nodrag inline-flex items-center gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-[#d8fff4] hover:bg-emerald-500/16"
            disabled={isApplying || !sourceAsset}
            onPointerDown={stopCanvasPointer}
            onClick={() => void handleApplyStack()}
            data-testid={`post-generate-${id}`}
          >
            {isApplying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            生成结果节点
          </button>
        </div>

        {Array.isArray(params.generationProgress) && params.generationProgress.length > 0 ? (
          <div className="mt-3">
            <ProgressBadge
              label={String((params.generationProgress as Array<Record<string, unknown>>).slice(-1)[0]?.message || '正在处理')}
              progress={Number((params.generationProgress as Array<Record<string, unknown>>).slice(-1)[0]?.progress || 0)}
            />
          </div>
        ) : null}

        {warnings.length > 0 ? (
          <div className="mt-3 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            {warnings.map((item, index) => (
              <div key={`${item}-${index}`}>{item}</div>
            ))}
          </div>
        ) : null}

        {(localError || data.error) ? (
          <div className="mt-3">
            <ErrorDetailBlock category="render" message={localError || data.error} />
          </div>
        ) : null}

        </div>
      </div>

      {panelOpen ? (
        <div
          className="absolute left-full top-0 z-50 ml-4 w-[720px] overflow-hidden rounded-[28px] border border-white/10 bg-[#0e0f11] shadow-[0_24px_80px_rgba(0,0,0,0.42)]"
          style={{ maxHeight: '82vh', maxWidth: 'min(720px, calc(100vw - 120px))' }}
          data-testid={`post-panel-${activeEffect}`}
          onPointerDown={stopCanvasPointer}
        >
          <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
            <div className="text-sm font-semibold text-white">{activeDescriptor.label}</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="nodrag inline-flex items-center gap-1.5 rounded-xl border border-white/8 bg-[#111] px-2.5 py-1.5 text-xs text-[#d0d0d0] hover:bg-[#171717]"
                onPointerDown={stopCanvasPointer}
                onClick={() => handleResetEffect(activeEffect)}
                data-testid={`post-reset-${activeEffect}-${id}`}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                重置
              </button>
              <button
                type="button"
                className="nodrag rounded-xl border border-white/8 bg-[#111] px-2.5 py-1.5 text-xs text-[#d0d0d0] hover:bg-[#171717]"
                onPointerDown={stopCanvasPointer}
                onClick={() => close('post-panel')}
              >
                关闭
              </button>
            </div>
          </div>
          <div className="max-h-[calc(82vh-60px)] overflow-y-auto p-4">
            <div className="space-y-4">
              {renderActivePanel()}
            </div>
          </div>
        </div>
      ) : null}

      <input
        ref={maskPickerRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid={`post-mask-input-${id}`}
        onChange={(event) => handleMediaUpload(event, 'mask')}
      />
      <input
        ref={backgroundPickerRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid={`post-background-input-${id}`}
        onChange={(event) => handleMediaUpload(event, 'background')}
      />
      <input
        ref={trackPickerRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        data-testid={`post-track-input-${id}`}
        onChange={(event) => handleMediaUpload(event, 'track')}
      />
      <input
        ref={lutPickerRef}
        type="file"
        accept=".cube,.3dl,text/plain,application/octet-stream"
        className="hidden"
        data-testid={`post-lut-input-${id}`}
        onChange={(event) => handleMediaUpload(event, 'lut')}
      />
      <input
        ref={ocioConfigPickerRef}
        type="file"
        accept=".ocio,.yaml,.yml,.json,.cfg,.txt,application/octet-stream,text/plain"
        className="hidden"
        data-testid={`post-ocio-config-input-${id}`}
        onChange={(event) => handleMediaUpload(event, 'ocioConfig')}
      />
      <input
        ref={depthMaskPickerRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid={`post-depth-mask-input-${id}`}
        onChange={(event) => handleMediaUpload(event, 'depthMask')}
      />
      <input
        ref={bokehPickerRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid={`post-bokeh-input-${id}`}
        onChange={(event) => handleMediaUpload(event, 'bokeh')}
      />

      <ModelActivationPrompt
        open={Boolean(activation)}
        mode={activation?.mode || (sourceKind === 'image' ? 'image' : 'video')}
        provider={activation?.provider || 'DDUp 后期处理'}
        reason={activation?.reason || 'auth'}
        onClose={() => setActivation(null)}
      />
    </div>
  );
}

export default PostNode;




