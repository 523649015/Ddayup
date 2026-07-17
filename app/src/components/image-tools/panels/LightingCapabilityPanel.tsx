import { CloudUpload, Lightbulb, Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildEnvironmentThumbnail } from '@/lib/assetThumbs';
import { toRenderableAssetUrl } from '@/services/generation';
import { useAssetStore } from '@/store/useAssetStore';
import type { ToolCapabilityPanelProps } from './capabilityPanelTypes';

const LIGHTING_PRESETS = [
  { key: 'rembrandt', label: '伦勃朗光', azimuth: 45, elevation: 30, intensity: 0.82, temperature: 5200 },
  { key: 'butterfly', label: '蝴蝶光', azimuth: 0, elevation: 52, intensity: 0.76, temperature: 5600 },
  { key: 'side_rim', label: '侧逆光', azimuth: -60, elevation: 18, intensity: 0.6, temperature: 4800 },
  { key: 'studio_soft', label: '柔光棚拍', azimuth: 25, elevation: 38, intensity: 0.7, temperature: 5400 },
  { key: 'golden_hour', label: '金色时刻', azimuth: 105, elevation: 22, intensity: 0.88, temperature: 6100 },
  { key: 'noir', label: '黑色电影', azimuth: -30, elevation: 8, intensity: 0.58, temperature: 4300 },
  { key: 'commercial', label: '商业硬光', azimuth: 15, elevation: 45, intensity: 0.95, temperature: 5800 },
  { key: 'product', label: '产品展示', azimuth: 70, elevation: 35, intensity: 0.78, temperature: 5600 },
];

const ACTIVE_LIGHTS = [
  { key: 'key', label: '主光' },
  { key: 'fill', label: '辅光' },
  { key: 'rim', label: '轮廓光' },
  { key: 'env', label: '环境光' },
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

export default function LightingCapabilityPanel({ value, onChange }: ToolCapabilityPanelProps) {
  const addAssetItem = useAssetStore((state) => state.addItem);
  const assetItems = useAssetStore((state) => state.items);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const configRef = useRef(value);
  const directionDraggingRef = useRef(false);
  const globalDragCleanupRef = useRef<(() => void) | null>(null);
  const activeLightRef = useRef(String(value.activeLight ?? 'key'));
  const [assetQuery, setAssetQuery] = useState('');

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

  function attachGlobalDragListeners() {
    globalDragCleanupRef.current?.();
    const handleMove = (event: MouseEvent) => {
      if (!directionDraggingRef.current) return;
      event.preventDefault();
      handleDirectionMove(event.clientX, event.clientY);
    };
    const handleUp = () => {
      endDirectionDrag();
    };
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

  function handleDirectionMove(clientX: number, clientY: number) {
    const rect = panelRef.current?.querySelector<HTMLElement>('[data-testid="lighting-direction-pad"]')?.getBoundingClientRect();
    if (!rect) return;

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

  function beginDirectionDrag(clientX: number, clientY: number) {
    directionDraggingRef.current = true;
    attachGlobalDragListeners();
    handleDirectionMove(clientX, clientY);
  }

  function endDirectionDrag() {
    directionDraggingRef.current = false;
    globalDragCleanupRef.current?.();
  }

  return (
    <div ref={panelRef} className="nodrag nopan nowheel mb-4 rounded-xl border border-[#353535] bg-[#242424] p-3">
      <input ref={fileInputRef} type="file" accept=".hdr,.exr,image/*" className="hidden" onChange={handleHdriUpload} />
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-[#ededed]"><Lightbulb className="h-4 w-4" />物理打光控制台</div>

      <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
        {LIGHTING_PRESETS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => mergeConfig({ preset: item.key, keyLightAzimuth: item.azimuth, keyLightElevation: item.elevation, keyLightIntensity: item.intensity, keyLightTemperature: item.temperature })}
            data-testid={`lighting-preset-${item.key}`}
            className={`nodrag rounded-lg border px-3 py-2 text-left ${String(value.preset) === item.key ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb] hover:bg-[#353535]'}`}
          >
            <div className="font-medium">{item.label}</div>
            <div className="mt-1 text-[11px] opacity-70">{item.azimuth}° / {item.elevation}°</div>
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {ACTIVE_LIGHTS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => { activeLightRef.current = item.key; mergeConfig({ activeLight: item.key }); }}
            data-testid={`lighting-active-${item.key}`}
            className={`nodrag rounded-full border px-3 py-1.5 text-xs ${activeLight === item.key ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-lg border border-[#404040] bg-[#1c1c1c] p-3">
          <div
            className="nodrag nopan nowheel relative mb-3 h-36 w-full overflow-hidden rounded-2xl border border-[#555] bg-[radial-gradient(circle,_rgba(255,255,255,0.14),_rgba(255,255,255,0.03)_58%,_rgba(2,6,23,0.88)_100%)]"
            data-testid="lighting-direction-pad"
            style={{ touchAction: 'none', cursor: 'crosshair' }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              beginDirectionDrag(event.clientX, event.clientY);
              event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!directionDraggingRef.current) return;
              event.preventDefault();
              event.stopPropagation();
              handleDirectionMove(event.clientX, event.clientY);
            }}
            onPointerUp={endDirectionDrag}
            onPointerCancel={endDirectionDrag}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              beginDirectionDrag(event.clientX, event.clientY);
            }}
            onMouseMove={(event) => {
              if (!directionDraggingRef.current) return;
              event.preventDefault();
              event.stopPropagation();
              handleDirectionMove(event.clientX, event.clientY);
            }}
            onMouseUp={endDirectionDrag}
          >
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),transparent_24%,rgba(125,211,252,0.05)_66%,rgba(2,6,23,0.12))]" />
            <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_12px_rgba(255,255,255,0.9)]" />
            <div className="absolute left-1/2 top-1/2 h-0.5 w-14 -translate-x-1/2 -translate-y-1/2 bg-cyan-200/70" style={{ transform: `translate(-50%, -50%) rotate(${gizmoAzimuth}deg)` }} />
            <div className="absolute inset-x-4 top-3 flex items-center justify-between text-xs text-[#d8edf7]">
              <span>拖拽调整光位</span>
              <span>当前：{activeLight === 'key' ? '主光' : activeLight === 'fill' ? '辅光' : activeLight === 'rim' ? '轮廓光' : '环境光'}</span>
            </div>
            <div className="absolute inset-x-4 bottom-3 flex items-center justify-between text-xs text-[#d8edf7]">
              <span>方位 {Math.round(gizmoAzimuth)}° · 俯仰 {Math.round(gizmoElevation)}°</span>
              <span>强度 {gizmoIntensity.toFixed(2)}</span>
            </div>
          </div>

          <SliderRow label="主光方位" value={`${azimuth}°`}>
            <input type="range" min={-180} max={180} step={1} value={azimuth} onChange={(event) => mergeConfig({ keyLightAzimuth: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="lighting-azimuth-slider" />
          </SliderRow>
          <SliderRow label="主光俯仰" value={`${elevation}°`}>
            <input type="range" min={-90} max={90} step={1} value={elevation} onChange={(event) => mergeConfig({ keyLightElevation: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="lighting-elevation-slider" />
          </SliderRow>
          <SliderRow label="主光强度" value={intensity.toFixed(2)}>
            <input type="range" min={0} max={2} step={0.01} value={intensity} onChange={(event) => mergeConfig({ keyLightIntensity: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="lighting-intensity-slider" />
          </SliderRow>
          <SliderRow label="主光色温" value={`${temperature}K`}>
            <input type="range" min={2500} max={9000} step={100} value={temperature} onChange={(event) => mergeConfig({ keyLightTemperature: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="lighting-temperature-slider" />
          </SliderRow>
          <SliderRow label="辅光强度" value={fillIntensity.toFixed(2)}>
            <input type="range" min={0} max={2} step={0.01} value={fillIntensity} onChange={(event) => mergeConfig({ fillLightIntensity: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="lighting-fill-slider" />
          </SliderRow>
          <SliderRow label="辅光方位" value={`${fillAzimuth}°`}>
            <input type="range" min={-180} max={180} step={1} value={fillAzimuth} onChange={(event) => mergeConfig({ fillLightAzimuth: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="lighting-fill-azimuth-slider" />
          </SliderRow>
          <SliderRow label="辅光俯仰" value={`${fillElevation}°`}>
            <input type="range" min={-90} max={90} step={1} value={fillElevation} onChange={(event) => mergeConfig({ fillLightElevation: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="lighting-fill-elevation-slider" />
          </SliderRow>
          <SliderRow label="辅光色温" value={`${fillTemperature}K`}>
            <input type="range" min={2500} max={9000} step={100} value={fillTemperature} onChange={(event) => mergeConfig({ fillLightTemperature: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="lighting-fill-temperature-slider" />
          </SliderRow>
          <SliderRow label="轮廓光强度" value={rimIntensity.toFixed(2)}>
            <input type="range" min={0} max={2} step={0.01} value={rimIntensity} onChange={(event) => mergeConfig({ rimLightIntensity: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="lighting-rim-intensity-slider" />
          </SliderRow>
          <div className="grid grid-cols-2 gap-2 text-sm text-[#eaeaea]">
            <ToggleButton active={rimEnabled} label="轮廓光" testId="lighting-rim-toggle" onClick={() => mergeConfig({ rimLightEnabled: !rimEnabled })} />
            <ToggleButton active={hdri} label="HDRI 环境光" testId="lighting-hdri-toggle" onClick={() => mergeConfig({ hdri: !hdri })} />
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-[#404040] bg-[#1c1c1c] p-3">
          <div className="flex items-center gap-2 text-sm text-[#ededed]"><SlidersHorizontal className="h-4 w-4" />环境与资产</div>
          <label className="flex cursor-pointer items-center justify-between rounded-lg border border-[#404040] px-3 py-2 text-sm text-[#cbcbcb]">
            <span className="flex items-center gap-2"><CloudUpload className="h-4 w-4" />HDRI 资源地址</span>
            <input
              type="text"
              value={hdriUrl}
              onChange={(event) => mergeConfig({ hdriUrl: event.target.value })}
              data-testid="lighting-hdri-url-input"
              placeholder="粘贴 HDRI 资产 URL"
              className="nodrag nopan nowheel ml-3 w-[54%] rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-1.5 text-sm text-[#e6edf3] outline-none"
            />
          </label>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <button type="button" data-testid="lighting-hdri-upload" onClick={() => fileInputRef.current?.click()} className="nodrag rounded-lg border border-[#404040] px-3 py-2 text-[#cbcbcb] hover:bg-[#353535]">上传 HDRI 到资产库</button>
            <button type="button" data-testid="lighting-hdri-pick-latest" onClick={() => {
              const latest = hdriAssets[hdriAssets.length - 1];
              if (latest) mergeConfig({ hdri: true, hdriUrl: latest.url, hdriAssetName: latest.name });
            }} className="nodrag rounded-lg border border-[#404040] px-3 py-2 text-[#cbcbcb] hover:bg-[#353535]">使用最近 HDRI</button>
          </div>

          <div className="grid grid-cols-2 gap-2 text-sm">
            <RangeRow label="环境光旋转" value={`${envRotation}°`}>
              <input type="range" min={0} max={360} step={1} value={envRotation} onChange={(event) => mergeConfig({ envLightRotation: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="lighting-env-rotation-slider" />
            </RangeRow>
            <RangeRow label="环境光强度" value={envIntensity.toFixed(2)}>
              <input type="range" min={0} max={2} step={0.01} value={envIntensity} onChange={(event) => mergeConfig({ envLightIntensity: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="lighting-env-intensity-slider" />
            </RangeRow>
            <RangeRow label="轮廓光方位" value={`${rimAzimuth}°`}>
              <input type="range" min={-180} max={180} step={1} value={rimAzimuth} onChange={(event) => mergeConfig({ rimLightAzimuth: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="lighting-rim-azimuth-slider" />
            </RangeRow>
            <RangeRow label="轮廓光俯仰" value={`${rimElevation}°`}>
              <input type="range" min={-90} max={90} step={1} value={rimElevation} onChange={(event) => mergeConfig({ rimLightElevation: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="lighting-rim-elevation-slider" />
            </RangeRow>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2 text-sm text-[#ededed]"><Search className="h-4 w-4" />HDRI 资产库</div>
            <input
              value={assetQuery}
              onChange={(event) => setAssetQuery(event.target.value)}
              placeholder="搜索 HDRI / 环境资源"
              className="nodrag nopan nowheel mb-3 w-full rounded-lg border border-[#303030] bg-[#111] px-3 py-2 text-sm text-[#e8e8e8] outline-none"
              data-testid="lighting-hdri-search"
            />
            {hdriAssets.length > 0 ? (
              <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-[#343434] p-2">
                {hdriAssets.slice().reverse().map((asset) => (
                  <button key={asset.id} type="button" data-testid={`lighting-hdri-asset-${asset.id}`} onClick={() => mergeConfig({ hdri: true, hdriUrl: asset.url, hdriAssetName: asset.name })} className="nodrag flex w-full items-center gap-3 rounded-lg border border-[#343434] px-3 py-2 text-left text-xs text-[#d7d7d7] hover:bg-[#2b2b2b]">
                    <img src={toRenderableAssetUrl(asset.thumbnail || asset.url, 'image')} alt="" className="h-10 w-16 rounded object-cover" />
                    <span className="min-w-0 flex-1 truncate">{asset.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-[#404040] px-3 py-4 text-xs text-[#8f8f8f]">还没有可用的 HDRI 资源，先上传一张环境贴图吧。</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SliderRow({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
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

function RangeRow({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return <SliderRow label={label} value={value}>{children}</SliderRow>;
}

function ToggleButton({ active, label, onClick, testId }: { active: boolean; label: string; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`nodrag rounded-lg border px-3 py-2 ${active ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}
    >
      {label}：{active ? '开启' : '关闭'}
    </button>
  );
}


