import { CloudUpload, Lightbulb, Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildEnvironmentThumbnail } from '@/lib/assetThumbs';
import { toRenderableAssetUrl } from '@/services/generation';
import { useAssetStore } from '@/store/useAssetStore';
import type { ToolCapabilityPanelProps } from './capabilityPanelTypes';
import { InteractiveImageStage } from './InteractiveImageStage';
import { applyLighting } from '@/services/imageToolApply';

const LIGHTING_PRESETS = [
  { key: 'rembrandt', label: '伦勃朗', azimuth: 45, elevation: 30, intensity: 0.82, temperature: 5200 },
  { key: 'butterfly', label: '蝴蝶光', azimuth: 0, elevation: 52, intensity: 0.76, temperature: 5600 },
  { key: 'side_rim', label: '侧逆光', azimuth: -60, elevation: 18, intensity: 0.6, temperature: 4800 },
  { key: 'studio_soft', label: '柔光棚', azimuth: 25, elevation: 38, intensity: 0.7, temperature: 5400 },
  { key: 'golden_hour', label: '金色', azimuth: 105, elevation: 22, intensity: 0.88, temperature: 6100 },
  { key: 'noir', label: '黑色', azimuth: -30, elevation: 8, intensity: 0.58, temperature: 4300 },
  { key: 'commercial', label: '硬光', azimuth: 15, elevation: 45, intensity: 0.95, temperature: 5800 },
  { key: 'product', label: '产品', azimuth: 70, elevation: 35, intensity: 0.78, temperature: 5600 },
];

const ACTIVE_LIGHTS = [
  { key: 'key', label: '主光' },
  { key: 'fill', label: '辅光' },
  { key: 'rim', label: '轮廓' },
  { key: 'env', label: '环境' },
] as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function parseTags(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => normalizeText(item));
  return normalizeText(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeAngle(value: number) {
  const next = value % 360;
  return next < 0 ? next + 360 : next;
}

function temperatureToRgb(kelvin: number) {
  const t = kelvin / 100;
  let r = 255;
  let g = 255;
  let b = 255;
  if (t <= 66) {
    g = clamp(99.47 * Math.log(t) - 161.12, 0, 255);
    b = t <= 19 ? 0 : clamp(138.52 * Math.log(t - 10) - 305.04, 0, 255);
  } else {
    r = clamp(329.7 * Math.pow(t - 60, -0.1332) - 0.02, 0, 255);
    g = clamp(288.12 * Math.pow(t - 60, -0.0755) - 0.03, 0, 255);
  }
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

export default function LightingCapabilityPanel({ value, onChange, sourceImageUrl, onApply }: ToolCapabilityPanelProps) {
  const addAssetItem = useAssetStore((state) => state.addItem);
  const assetItems = useAssetStore((state) => state.items);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const configRef = useRef(value);
  const directionDraggingRef = useRef(false);
  const globalDragCleanupRef = useRef<(() => void) | null>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const activeLightRef = useRef(String(value.activeLight ?? 'key'));
  const [assetQuery, setAssetQuery] = useState('');
  const [applyStatus, setApplyStatus] = useState<string | null>(null);

  async function handleApply() {
    if (typeof sourceImageUrl !== 'string' || !sourceImageUrl) {
      setApplyStatus('请先选择素材图');
      return;
    }
    setApplyStatus('烘焙中…');
    try {
      const result = await applyLighting(sourceImageUrl, value);
      await onApply?.({ appliedImageUrl: result.url, imageUrl: sourceImageUrl, engine: result.engine, ...value });
      setApplyStatus('已应用打光并写回素材图');
    } catch (err) {
      setApplyStatus(err instanceof Error ? err.message : '应用失败');
    }
  }

  useEffect(() => {
    configRef.current = value;
    activeLightRef.current = String(value.activeLight ?? 'key');
  }, [value]);

  const preset = LIGHTING_PRESETS.find((item) => item.key === String(value.preset)) || LIGHTING_PRESETS[0];
  const activeLight = String(value.activeLight ?? 'key');
  const azimuth = Number(value.keyLightAzimuth ?? preset.azimuth);
  const elevation = Number(value.keyLightElevation ?? preset.elevation);
  const intensity = Number(value.keyLightIntensity ?? preset.intensity);
  const temperature = Number(value.keyLightTemperature ?? preset.temperature);
  const fillIntensity = Number(value.fillLightIntensity ?? 0.35);
  const fillAzimuth = Number(value.fillLightAzimuth ?? -35);
  const fillElevation = Number(value.fillLightElevation ?? 15);
  const fillTemperature = Number(value.fillLightTemperature ?? 5600);
  const rimEnabled = Boolean(value.rimLightEnabled ?? true);
  const rimIntensity = Number(value.rimLightIntensity ?? 0.45);
  const rimAzimuth = Number(value.rimLightAzimuth ?? 140);
  const rimElevation = Number(value.rimLightElevation ?? 10);
  const envIntensity = Number(value.envLightIntensity ?? 0.35);
  const envRotation = Number(value.envLightRotation ?? 0);
  const hdri = Boolean(value.hdri ?? false);
  const hdriUrl = String(value.hdriUrl ?? '');
  const hdriAssets = useMemo(() => {
    const query = assetQuery.trim().toLowerCase();
    return assetItems.filter((item) => {
      const tags = parseTags(item.tags);
      const isHdri = /\.(hdr|exr)$/i.test(item.name) || tags.includes('hdri') || tags.includes('environment');
      if (!isHdri) return false;
      if (!query) return true;
      return item.name.toLowerCase().includes(query) || tags.some((tag) => tag.includes(query));
    });
  }, [assetItems, assetQuery]);

  const gizmoAzimuth = activeLight === 'fill' ? fillAzimuth : activeLight === 'rim' ? rimAzimuth : activeLight === 'env' ? envRotation : azimuth;
  const gizmoElevation = activeLight === 'fill' ? fillElevation : activeLight === 'rim' ? rimElevation : activeLight === 'env' ? 0 : elevation;
  const gizmoIntensity = activeLight === 'fill' ? fillIntensity : activeLight === 'rim' ? rimIntensity : activeLight === 'env' ? envIntensity : intensity;
  const gizmoColor = activeLight === 'fill' ? temperatureToRgb(fillTemperature) : temperatureToRgb(temperature);

  function attachGlobalDragListeners() {
    globalDragCleanupRef.current?.();
    const handleMove = (event: MouseEvent) => {
      if (!directionDraggingRef.current || !rectRef.current) return;
      event.preventDefault();
      handleDirectionMove(event.clientX, event.clientY, rectRef.current);
    };
    const handleUp = () => endDirectionDrag();
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    globalDragCleanupRef.current = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      globalDragCleanupRef.current = null;
    };
  }

  function mergeConfig(next: Record<string, unknown>) {
    const merged = { ...configRef.current, ...next };
    configRef.current = merged;
    onChange(merged);
  }

  async function handleHdriUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    addAssetItem({
      name: file.name,
      type: 'image',
      url,
      thumbnail: buildEnvironmentThumbnail(file.name),
      folderId: 'root',
      size: file.size,
      tags: ['hdri', 'environment'],
      smartCategories: ['lighting', 'environment'],
      source: 'upload',
    });
    mergeConfig({ hdri: true, hdriUrl: url, hdriAssetName: file.name });
    event.target.value = '';
  }

  function handleDirectionMove(clientX: number, clientY: number, rect: DOMRect) {
    const relativeX = clamp((clientX - rect.left) / rect.width, 0, 1);
    const relativeY = clamp((clientY - rect.top) / rect.height, 0, 1);
    const nextAzimuth = Math.round(relativeX * 360) - 180;
    const nextElevation = Math.round(90 - relativeY * 90);
    const nextEnvIntensity = Number((1.9 - relativeY * 1.9).toFixed(2));
    const lightMode = activeLightRef.current;

    if (lightMode === 'fill') {
      mergeConfig({ fillLightAzimuth: clamp(nextAzimuth, -180, 180), fillLightElevation: clamp(nextElevation, -90, 90) });
      return;
    }
    if (lightMode === 'rim') {
      mergeConfig({ rimLightAzimuth: clamp(nextAzimuth, -180, 180), rimLightElevation: clamp(nextElevation, -90, 90) });
      return;
    }
    if (lightMode === 'env') {
      mergeConfig({ envLightRotation: normalizeAngle(nextAzimuth), envLightIntensity: clamp(nextEnvIntensity, 0, 2) });
      return;
    }
    mergeConfig({ keyLightAzimuth: clamp(nextAzimuth, -180, 180), keyLightElevation: clamp(nextElevation, -90, 90) });
  }

  function beginDirectionDrag(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    rectRef.current = rect;
    directionDraggingRef.current = true;
    attachGlobalDragListeners();
    handleDirectionMove(event.clientX, event.clientY, rect);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function endDirectionDrag() {
    directionDraggingRef.current = false;
    globalDragCleanupRef.current?.();
  }

  const gizmoX = 50 + (gizmoAzimuth / 180) * 50;
  const gizmoY = 50 - (gizmoElevation / 90) * 50;
  const highlightSize = 28 + gizmoIntensity * 52;

  const stagePointerHandlers = {
    onPointerDown: beginDirectionDrag,
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (!directionDraggingRef.current) return;
      event.preventDefault();
      event.stopPropagation();
    },
    onPointerUp: endDirectionDrag,
    onPointerLeave: endDirectionDrag,
    onWheel: (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const dir = event.deltaY > 0 ? -1 : 1;
      if (activeLight === 'fill') mergeConfig({ fillLightIntensity: clamp(fillIntensity + dir * 0.05, 0, 2) });
      else if (activeLight === 'rim') mergeConfig({ rimLightIntensity: clamp(rimIntensity + dir * 0.05, 0, 2) });
      else if (activeLight === 'env') mergeConfig({ envLightIntensity: clamp(envIntensity + dir * 0.05, 0, 2) });
      else mergeConfig({ keyLightIntensity: clamp(intensity + dir * 0.05, 0, 2) });
    },
  };

  return (
    <div className="nodrag nopan nowheel mb-4 rounded-xl border border-[#353535] bg-[#242424] p-3">
      <input ref={fileInputRef} type="file" accept=".hdr,.exr,image/*" className="hidden" onChange={handleHdriUpload} />
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-[#ededed]">
        <Lightbulb className="h-4 w-4" />物理打光
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {LIGHTING_PRESETS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => mergeConfig({ preset: item.key, keyLightAzimuth: item.azimuth, keyLightElevation: item.elevation, keyLightIntensity: item.intensity, keyLightTemperature: item.temperature })}
            data-testid={`lighting-preset-${item.key}`}
            className={`nodrag rounded-full border px-2.5 py-1 text-xs ${String(value.preset) === item.key ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb] hover:bg-[#353535]'}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mb-2 flex flex-wrap gap-1.5">
        {ACTIVE_LIGHTS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => { activeLightRef.current = item.key; mergeConfig({ activeLight: item.key }); }}
            data-testid={`lighting-active-${item.key}`}
            className={`nodrag rounded-full border px-2.5 py-1 text-xs ${activeLight === item.key ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <InteractiveImageStage sourceImageUrl={sourceImageUrl} {...stagePointerHandlers}>
        <div
          className="pointer-events-none absolute rounded-full mix-blend-screen"
          style={{
            left: `${gizmoX}%`,
            top: `${gizmoY}%`,
            width: `${highlightSize}%`,
            height: `${highlightSize}%`,
            transform: 'translate(-50%, -50%)',
            background: `radial-gradient(circle, ${gizmoColor} 0%, ${gizmoColor}33 38%, transparent 70%)`,
          }}
        />
        <div className="pointer-events-none absolute left-2 right-2 top-2 flex justify-between text-[11px] text-white/85">
          <span>在图上拖拽光位</span>
          <span>{activeLight === 'key' ? '主光' : activeLight === 'fill' ? '辅光' : activeLight === 'rim' ? '轮廓' : '环境'}</span>
        </div>
        <div className="pointer-events-none absolute left-2 right-2 bottom-2 flex justify-between text-[11px] text-white/85">
          <span>方位 {Math.round(gizmoAzimuth)}° · 俯仰 {Math.round(gizmoElevation)}°</span>
          <span>强度 {gizmoIntensity.toFixed(2)}</span>
        </div>
      </InteractiveImageStage>

      <div className="mt-3 space-y-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <CompactRange label="主方位" value={`${azimuth}°`} min={-180} max={180} step={1} testId="lighting-azimuth-slider" onChange={(v) => mergeConfig({ keyLightAzimuth: v })} />
          <CompactRange label="主俯仰" value={`${elevation}°`} min={-90} max={90} step={1} testId="lighting-elevation-slider" onChange={(v) => mergeConfig({ keyLightElevation: v })} />
          <CompactRange label="主强度" value={intensity.toFixed(2)} min={0} max={2} step={0.01} testId="lighting-intensity-slider" onChange={(v) => mergeConfig({ keyLightIntensity: v })} />
          <CompactRange label="主色温" value={`${temperature}K`} min={2500} max={9000} step={100} testId="lighting-temperature-slider" onChange={(v) => mergeConfig({ keyLightTemperature: v })} />
          <CompactRange label="辅强度" value={fillIntensity.toFixed(2)} min={0} max={2} step={0.01} testId="lighting-fill-slider" onChange={(v) => mergeConfig({ fillLightIntensity: v })} />
          <CompactRange label="辅方位" value={`${fillAzimuth}°`} min={-180} max={180} step={1} testId="lighting-fill-azimuth-slider" onChange={(v) => mergeConfig({ fillLightAzimuth: v })} />
          <CompactRange label="辅俯仰" value={`${fillElevation}°`} min={-90} max={90} step={1} testId="lighting-fill-elevation-slider" onChange={(v) => mergeConfig({ fillLightElevation: v })} />
          <CompactRange label="辅色温" value={`${fillTemperature}K`} min={2500} max={9000} step={100} testId="lighting-fill-temperature-slider" onChange={(v) => mergeConfig({ fillLightTemperature: v })} />
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <ToggleButton active={rimEnabled} label="轮廓光" testId="lighting-rim-toggle" onClick={() => mergeConfig({ rimLightEnabled: !rimEnabled })} />
          <ToggleButton active={hdri} label="HDRI" testId="lighting-hdri-toggle" onClick={() => mergeConfig({ hdri: !hdri })} />
        </div>
      </div>

      <details className="mt-3 rounded-lg border border-[#404040] bg-[#1c1c1c] p-3">
        <summary className="flex cursor-pointer items-center gap-2 text-sm text-[#ededed]"><SlidersHorizontal className="h-4 w-4" />环境与 HDRI 资源</summary>
        <div className="mt-3 space-y-3">
          <label className="flex items-center justify-between gap-2 text-xs text-[#cbcbcb]">
            <span className="flex shrink-0 items-center gap-2"><CloudUpload className="h-4 w-4" />HDRI 地址</span>
            <input
              type="text"
              value={hdriUrl}
              onChange={(event) => mergeConfig({ hdriUrl: event.target.value })}
              data-testid="lighting-hdri-url-input"
              placeholder="粘贴 URL"
              className="nodrag nopan nowheel min-w-0 flex-1 rounded-md border border-[#30363d] bg-[#0d1117] px-2.5 py-1.5 text-xs text-[#e6edf3] outline-none"
            />
          </label>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <button type="button" data-testid="lighting-hdri-upload" onClick={() => fileInputRef.current?.click()} className="nodrag rounded-lg border border-[#404040] px-2.5 py-1.5 text-[#cbcbcb] hover:bg-[#353535]">上传到资产库</button>
            <button type="button" data-testid="lighting-hdri-pick-latest" onClick={() => {
              const latest = hdriAssets[hdriAssets.length - 1];
              if (latest) mergeConfig({ hdri: true, hdriUrl: latest.url, hdriAssetName: latest.name });
            }} className="nodrag rounded-lg border border-[#404040] px-2.5 py-1.5 text-[#cbcbcb] hover:bg-[#353535]">用最近 HDRI</button>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <CompactRange label="环境旋转" value={`${envRotation}°`} min={0} max={360} step={1} testId="lighting-env-rotation-slider" onChange={(v) => mergeConfig({ envLightRotation: v })} />
            <CompactRange label="环境强度" value={envIntensity.toFixed(2)} min={0} max={2} step={0.01} testId="lighting-env-intensity-slider" onChange={(v) => mergeConfig({ envLightIntensity: v })} />
            <CompactRange label="轮廓方位" value={`${rimAzimuth}°`} min={-180} max={180} step={1} testId="lighting-rim-azimuth-slider" onChange={(v) => mergeConfig({ rimLightAzimuth: v })} />
            <CompactRange label="轮廓俯仰" value={`${rimElevation}°`} min={-90} max={90} step={1} testId="lighting-rim-elevation-slider" onChange={(v) => mergeConfig({ rimLightElevation: v })} />
          </div>
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs text-[#b4b4b4]"><Search className="h-3.5 w-3.5" />HDRI 资产库</div>
            <input
              value={assetQuery}
              onChange={(event) => setAssetQuery(event.target.value)}
              placeholder="搜索 HDRI"
              className="nodrag nopan nowheel mb-2 w-full rounded-lg border border-[#303030] bg-[#111] px-2.5 py-1.5 text-xs text-[#e8e8e8] outline-none"
              data-testid="lighting-hdri-search"
            />
            {hdriAssets.length > 0 ? (
              <div className="max-h-44 space-y-1.5 overflow-y-auto rounded-lg border border-[#343434] p-2">
                {hdriAssets.slice().reverse().map((asset) => (
                  <button key={asset.id} type="button" data-testid={`lighting-hdri-asset-${asset.id}`} onClick={() => mergeConfig({ hdri: true, hdriUrl: asset.url, hdriAssetName: asset.name })} className="nodrag flex w-full items-center gap-2.5 rounded-lg border border-[#343434] px-2.5 py-1.5 text-left text-xs text-[#d7d7d7] hover:bg-[#2b2b2b]">
                    <img src={toRenderableAssetUrl(asset.thumbnail || asset.url, 'image')} alt="" className="h-9 w-14 rounded object-cover" />
                    <span className="min-w-0 flex-1 truncate">{asset.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-[#404040] px-3 py-3 text-xs text-[#8f8f8f]">暂无 HDRI 资源，先上传环境贴图。</div>
            )}
          </div>
        </div>
      </details>

      <button type="button" data-testid="lighting-apply" onClick={() => void handleApply()} className="mt-3 w-full rounded-lg border border-[#7b7b7b] bg-[#363636] px-3 py-2 text-sm text-white hover:bg-[#424242]">
        应用打光并写回
      </button>
      {applyStatus ? (
        <div data-testid="lighting-status" className="mt-2 rounded-lg border border-[#404040] bg-[#161616] px-3 py-2 text-xs text-[#b4b4b4]">{applyStatus}</div>
      ) : null}
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

function ToggleButton({ active, label, onClick, testId }: { active: boolean; label: string; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`nodrag rounded-lg border px-3 py-2 text-sm ${active ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}
    >
      {label}：{active ? '开' : '关'}
    </button>
  );
}
