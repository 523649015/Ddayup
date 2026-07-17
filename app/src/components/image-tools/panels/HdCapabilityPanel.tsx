import { Camera, Crop, Eraser, LayoutGrid, Paintbrush2, ScanEye, Sparkles, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { toRenderableAssetUrl } from '@/services/generation';
import {
  applyHdUpscale,
  applyHdRestore,
  applyHdOutpaint,
  applyHdInpaint,
  applyHdCutout,
  applyHdCrop,
} from '@/services/imageToolApply';
import type { ToolCapabilityPanelProps } from './capabilityPanelTypes';

const HD_MODE_KEYS = ['upscale', 'outpaint', 'inpaint', 'erase', 'cutout', 'crop', 'restore'] as const;

type HdMode = (typeof HD_MODE_KEYS)[number];

type MaskPoint = {
  x: number;
  y: number;
  brushSize: number;
  brushMode: 'paint' | 'erase';
  targetMode: 'inpaint' | 'erase';
};

const HD_MODES: Array<{
  key: HdMode;
  label: string;
  icon: typeof Sparkles;
  description: string;
}> = [
  { key: 'upscale', label: '高清放大', icon: Sparkles, description: '提升分辨率并尽量保留原图纹理细节。' },
  { key: 'outpaint', label: '智能扩图', icon: LayoutGrid, description: '向四周延展画面，补足留白和构图空间。' },
  { key: 'inpaint', label: '局部重绘', icon: Paintbrush2, description: '用蒙版局部修补瑕疵或替换指定区域。' },
  { key: 'erase', label: '物体移除', icon: Eraser, description: '擦除干扰物并自动补全周围背景。' },
  { key: 'cutout', label: '智能抠图', icon: ScanEye, description: '提取主体并尽量保护边缘和发丝。' },
  { key: 'crop', label: '智能裁切', icon: Crop, description: '调整构图中心与输出比例，快速重构画面。' },
  { key: 'restore', label: '画质修复', icon: Wand2, description: '修复旧图细节，并通过滑杆进行前后对比。' },
];

const UPSCALE_OPTIONS = ['1.5x', '2x', '4x'] as const;
const CROP_RATIOS = ['1:1', '4:5', '16:9', '9:16'] as const;
const OUTPAINT_DIRECTIONS = [
  { value: 'left', label: '向左' },
  { value: 'top', label: '向上' },
  { value: 'right', label: '向右' },
  { value: 'bottom', label: '向下' },
  { value: 'both', label: '四周' },
] as const;
const PREVIEW_WIDTH = 360;
const PREVIEW_HEIGHT = 220;

const MODE_DEFAULTS: Record<HdMode, Record<string, unknown>> = {
  upscale: {
    upscale: '2x',
    denoise: 0.25,
    detailBoost: 0.45,
    restoration: true,
    faceRestore: true,
    preserveTexture: true,
  },
  outpaint: {
    outpaintDirection: 'right',
    outpaintRatio: 0.35,
    outpaintFeather: 0.5,
    preserveTexture: true,
  },
  inpaint: {
    brushMode: 'paint',
    brushSize: 24,
    maskStrength: 0.8,
    maskPoints: [],
  },
  erase: {
    brushMode: 'erase',
    brushSize: 30,
    eraseFeather: 0.55,
    restoration: true,
    maskPoints: [],
  },
  cutout: {
    faceRestore: true,
    edgeFeather: 0.35,
    subjectThreshold: 0.58,
    preserveTexture: true,
  },
  crop: {
    cropRatio: '1:1',
    cropCenterX: 0.5,
    cropCenterY: 0.5,
    cropZoom: 1,
  },
  restore: {
    restoration: true,
    faceRestore: true,
    preserveTexture: true,
    textureRecovery: 0.7,
    compareSplit: 0.55,
  },
};

export default function HdCapabilityPanel({ value, onChange, sourceImageUrl, onApply }: ToolCapabilityPanelProps) {
  const [activeMode, setActiveMode] = useState<HdMode>(parseHdMode(value.hdMode));
  const modeMeta = useMemo(() => HD_MODES.find((item) => item.key === activeMode) || HD_MODES[0], [activeMode]);
  const modeMaskPoints = useMemo(() => getModeMaskPoints(value.maskPoints, activeMode), [activeMode, value.maskPoints]);
  const [hdStatus, setHdStatus] = useState<string | null>(null);

  async function handleApplyByMode() {
    if (typeof sourceImageUrl !== 'string' || !sourceImageUrl) {
      setHdStatus('请先选择素材图');
      return;
    }
    setHdStatus('处理中…');
    try {
      const mode = activeMode;
      let result;
      if (mode === 'upscale') result = await applyHdUpscale(sourceImageUrl, value);
      else if (mode === 'restore') result = await applyHdRestore(sourceImageUrl, value);
      else if (mode === 'outpaint') result = await applyHdOutpaint(sourceImageUrl, value);
      else if (mode === 'inpaint') result = await applyHdInpaint(sourceImageUrl, { ...value, mode: 'inpaint' });
      else if (mode === 'erase') result = await applyHdInpaint(sourceImageUrl, { ...value, mode: 'erase' });
      else if (mode === 'cutout') result = await applyHdCutout(sourceImageUrl, value);
      else return;
      await onApply?.({ appliedImageUrl: result.url, imageUrl: sourceImageUrl, hdMode: mode, engine: result.engine, ...value });
      setHdStatus(`已生成并写回素材图（${result.engine}）`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setHdStatus(message);
    }
  }

  async function handleApplyCrop() {
    if (typeof sourceImageUrl !== 'string' || !sourceImageUrl) {
      setHdStatus('请先选择素材图');
      return;
    }
    try {
      const frame = getCropFrame(String(value.cropRatio ?? '1:1'), Number(value.cropCenterX ?? 0.5), Number(value.cropCenterY ?? 0.5), Number(value.cropZoom ?? 1));
      const result = await applyHdCrop(sourceImageUrl, frame);
      await onApply?.({ appliedImageUrl: result.url, imageUrl: sourceImageUrl, hdMode: 'crop', cropRatio: value.cropRatio, cropZoom: value.cropZoom, engine: result.engine });
      setHdStatus('已裁切并写回素材图');
    } catch (err) {
      setHdStatus(err instanceof Error ? err.message : '裁切失败');
    }
  }

  useEffect(() => {
    setActiveMode(parseHdMode(value.hdMode));
  }, [value.hdMode]);

  function patchValue(changes: Record<string, unknown>, mode: HdMode = activeMode) {
    onChange({
      ...value,
      ...changes,
      hdMode: mode,
      toolOperation: `hd_${mode}`,
    });
  }

  function updateMode(mode: HdMode) {
    setActiveMode(mode);
    patchValue(fillModeDefaults(mode, value), mode);
  }

  return (
    <div className="mb-4 rounded-xl border border-[#353535] bg-[#242424] p-3">
      <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
        {HD_MODES.map((mode) => {
          const Icon = mode.icon;
          const active = activeMode === mode.key;
          return (
            <button
              key={mode.key}
              type="button"
              onClick={() => updateMode(mode.key)}
              data-testid={`hd-mode-${mode.key}`}
              className={`rounded-lg border px-3 py-2 text-left ${active ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <Icon className="h-4 w-4" />
                {mode.label}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-4 rounded-lg border border-[#404040] bg-[#1c1c1c] p-3">
        <HdPreviewStage sourceImageUrl={sourceImageUrl} mode={activeMode} value={value} onChange={patchValue} />

        {activeMode === 'upscale' ? (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-sm">
              {UPSCALE_OPTIONS.map((option) => {
                const selected = String(value.upscale ?? '2x') === option;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => patchValue({ upscale: option })}
                    data-testid={`hd-upscale-${option.toLowerCase()}`}
                    className={`rounded-lg border px-3 py-2 ${selected ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
            <RangeRow label="去噪强度" value={Number(value.denoise ?? 0.25).toFixed(2)}>
              <input type="range" min={0} max={1} step={0.01} value={Number(value.denoise ?? 0.25)} onChange={(event) => patchValue({ denoise: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="hd-denoise-slider" />
            </RangeRow>
            <RangeRow label="细节增强" value={Number(value.detailBoost ?? 0.45).toFixed(2)}>
              <input type="range" min={0} max={1} step={0.01} value={Number(value.detailBoost ?? 0.45)} onChange={(event) => patchValue({ detailBoost: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="hd-detail-boost-slider" />
            </RangeRow>
            <div className="grid grid-cols-1 gap-2 text-sm">
              <Toggle active={Boolean(value.restoration ?? true)} label="修复增强" testId="hd-restoration-toggle" onClick={() => patchValue({ restoration: !Boolean(value.restoration ?? true) })} />
              <Toggle active={Boolean(value.faceRestore ?? true)} label="人脸修复" testId="hd-face-restore-toggle" onClick={() => patchValue({ faceRestore: !Boolean(value.faceRestore ?? true) })} />
              <Toggle active={Boolean(value.preserveTexture ?? true)} label="纹理保真" testId="hd-preserve-texture-toggle" onClick={() => patchValue({ preserveTexture: !Boolean(value.preserveTexture ?? true) })} />
            </div>
          </div>
        ) : null}

        {activeMode === 'outpaint' ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-[#b4b4b4]">拖拽预览区边缘手柄扩展</span>
              <button type="button" onClick={() => patchValue({ outpaintDirection: 'both' })} data-testid="hd-outpaint-both" className={`nodrag rounded-full border px-2.5 py-1 text-xs ${String(value.outpaintDirection ?? 'right') === 'both' ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}>四周扩展</button>
            </div>
            <RangeRow label="扩图比例" value={Number(value.outpaintRatio ?? 0.35).toFixed(2)}>
              <input type="range" min={0.1} max={1} step={0.01} value={Number(value.outpaintRatio ?? 0.35)} onChange={(event) => patchValue({ outpaintRatio: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="hd-outpaint-ratio-slider" />
            </RangeRow>
            <RangeRow label="边缘羽化" value={Number(value.outpaintFeather ?? 0.5).toFixed(2)}>
              <input type="range" min={0} max={1} step={0.01} value={Number(value.outpaintFeather ?? 0.5)} onChange={(event) => patchValue({ outpaintFeather: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="hd-outpaint-feather-slider" />
            </RangeRow>
          </div>
        ) : null}

        {activeMode === 'inpaint' ? (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <button type="button" onClick={() => patchValue({ brushMode: 'paint' })} data-testid="hd-brush-paint" className={`rounded-lg border px-3 py-2 ${String(value.brushMode ?? 'paint') === 'paint' ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}>涂抹</button>
              <button type="button" onClick={() => patchValue({ brushMode: 'erase' })} data-testid="hd-brush-erase" className={`rounded-lg border px-3 py-2 ${String(value.brushMode ?? 'paint') === 'erase' ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}>擦除</button>
              <button type="button" onClick={() => patchValue({ maskPoints: clearModeMaskPoints(value.maskPoints, 'inpaint') })} data-testid="hd-mask-clear" className="rounded-lg border border-[#404040] px-3 py-2 text-[#cbcbcb]">清空蒙版</button>
            </div>
            <RangeRow label="画笔大小" value={`${Number(value.brushSize ?? 24)}px`}>
              <input type="range" min={1} max={120} step={1} value={Number(value.brushSize ?? 24)} onChange={(event) => patchValue({ brushSize: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="hd-brush-size-slider" />
            </RangeRow>
            <RangeRow label="蒙版强度" value={Number(value.maskStrength ?? 0.8).toFixed(2)}>
              <input type="range" min={0} max={1} step={0.01} value={Number(value.maskStrength ?? 0.8)} onChange={(event) => patchValue({ maskStrength: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="hd-mask-strength-slider" />
            </RangeRow>
          </div>
        ) : null}

        {activeMode === 'erase' ? (
          <div className="space-y-3">
            <button type="button" onClick={() => patchValue({ maskPoints: clearModeMaskPoints(value.maskPoints, 'erase') })} data-testid="hd-erase-mask-clear" className="rounded-lg border border-[#404040] px-3 py-2 text-[#cbcbcb]">清空移除蒙版</button>
            <RangeRow label="画笔大小" value={`${Number(value.brushSize ?? 30)}px`}>
              <input type="range" min={1} max={140} step={1} value={Number(value.brushSize ?? 30)} onChange={(event) => patchValue({ brushSize: Number(event.target.value), brushMode: 'erase' })} className="nodrag nopan nowheel w-full" data-testid="hd-erase-brush-size-slider" />
            </RangeRow>
            <RangeRow label="修复羽化" value={Number(value.eraseFeather ?? 0.55).toFixed(2)}>
              <input type="range" min={0} max={1} step={0.01} value={Number(value.eraseFeather ?? 0.55)} onChange={(event) => patchValue({ eraseFeather: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="hd-erase-feather-slider" />
            </RangeRow>
            <Toggle active={Boolean(value.restoration ?? true)} label="自动补全" testId="hd-erase-autofill" onClick={() => patchValue({ restoration: !Boolean(value.restoration ?? true) })} />
          </div>
        ) : null}

        {activeMode === 'cutout' ? (
          <div className="space-y-3">
            <Toggle active={Boolean(value.faceRestore ?? true)} label="发丝保护" testId="hd-cutout-hairline" onClick={() => patchValue({ faceRestore: !Boolean(value.faceRestore ?? true) })} />
            <RangeRow label="主体阈值" value={Number(value.subjectThreshold ?? 0.58).toFixed(2)}>
              <input type="range" min={0} max={1} step={0.01} value={Number(value.subjectThreshold ?? 0.58)} onChange={(event) => patchValue({ subjectThreshold: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="hd-cutout-threshold-slider" />
            </RangeRow>
            <RangeRow label="边缘羽化" value={Number(value.edgeFeather ?? 0.35).toFixed(2)}>
              <input type="range" min={0} max={1} step={0.01} value={Number(value.edgeFeather ?? 0.35)} onChange={(event) => patchValue({ edgeFeather: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="hd-cutout-feather-slider" />
            </RangeRow>
          </div>
        ) : null}

        {activeMode === 'crop' ? (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-2 text-sm">
              {CROP_RATIOS.map((ratio) => {
                const active = String(value.cropRatio ?? '1:1') === ratio;
                return (
                  <button key={ratio} type="button" onClick={() => patchValue({ cropRatio: ratio })} data-testid={`hd-crop-${ratio.replace(':', '-')}`} className={`rounded-lg border px-3 py-2 ${active ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}>
                    {ratio}
                  </button>
                );
              })}
            </div>
            <RangeRow label="裁切缩放" value={Number(value.cropZoom ?? 1).toFixed(2)}>
              <input type="range" min={1} max={2.4} step={0.01} value={Number(value.cropZoom ?? 1)} onChange={(event) => patchValue({ cropZoom: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="hd-crop-zoom-slider" />
            </RangeRow>
            <div className="grid grid-cols-2 gap-3">
              <MiniStat label="焦点 X" value={Number(value.cropCenterX ?? 0.5).toFixed(2)} />
              <MiniStat label="焦点 Y" value={Number(value.cropCenterY ?? 0.5).toFixed(2)} />
            </div>
            <button type="button" data-testid="hd-crop-apply" onClick={() => void handleApplyCrop()} className="w-full rounded-lg border border-[#7b7b7b] bg-[#363636] px-3 py-2 text-sm text-white hover:bg-[#424242]">应用到素材图</button>
          </div>
        ) : null}

        {activeMode === 'restore' ? (
          <div className="space-y-3">
            <RangeRow label="纹理恢复" value={Number(value.textureRecovery ?? 0.7).toFixed(2)}>
              <input type="range" min={0} max={1} step={0.01} value={Number(value.textureRecovery ?? 0.7)} onChange={(event) => patchValue({ textureRecovery: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="hd-texture-recovery-slider" />
            </RangeRow>
            <RangeRow label="对比滑杆" value={Number(value.compareSplit ?? 0.55).toFixed(2)}>
              <input type="range" min={0.1} max={0.9} step={0.01} value={Number(value.compareSplit ?? 0.55)} onChange={(event) => patchValue({ compareSplit: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="hd-restore-compare-slider" />
            </RangeRow>
            <div className="grid grid-cols-1 gap-2 text-sm">
              <Toggle active={Boolean(value.faceRestore ?? true)} label="人脸修复" testId="hd-restore-face-toggle" onClick={() => patchValue({ faceRestore: !Boolean(value.faceRestore ?? true) })} />
              <Toggle active={Boolean(value.preserveTexture ?? true)} label="纹理保真" testId="hd-restore-texture-toggle" onClick={() => patchValue({ preserveTexture: !Boolean(value.preserveTexture ?? true) })} />
            </div>
          </div>
        ) : null}

        {activeMode !== 'crop' ? (
          <button type="button" data-testid={`hd-apply-${activeMode}`} onClick={() => void handleApplyByMode()} className="mt-4 w-full rounded-lg border border-[#7b7b7b] bg-[#363636] px-3 py-2 text-sm text-white hover:bg-[#424242]">
            应用到素材图
          </button>
        ) : null}
        {hdStatus ? (
          <div data-testid="hd-apply-status" className="mt-2 rounded-lg border border-[#404040] bg-[#161616] px-3 py-2 text-xs text-[#b4b4b4]">{hdStatus}</div>
        ) : null}
      </div>
    </div>
  );
}

function RangeRow({ label, value, children }: { label: string; value: string; children: ReactNode }) {
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

function Toggle({ active, label, onClick, testId }: { active: boolean; label: string; onClick: () => void; testId: string }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} className={`rounded-lg border px-3 py-2 text-left ${active ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}>
      {label}：{active ? '开启' : '关闭'}
    </button>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#404040] bg-[#242424] px-3 py-2 text-xs text-[#d5d5d5]">
      <div className="text-[#8f8f8f]">{label}</div>
      <div className="mt-1 font-medium text-white">{value}</div>
    </div>
  );
}

function ModeSummary({ mode, value, maskCount }: { mode: HdMode; value: Record<string, unknown>; maskCount: number }) {
  const summary = buildModeSummary(mode, value, maskCount);
  const signals = buildResultSignals(mode, value, maskCount);
  return (
    <div className="mb-4 rounded-lg border border-[#404040] bg-[linear-gradient(135deg,rgba(255,255,255,0.09),rgba(255,255,255,0.02))] p-3 text-xs text-[#f1f1f1]">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Camera className="h-4 w-4" />
        结果细化
      </div>
      <div className="mt-1 text-[#d4d4d4]">{summary}</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {signals.map((signal) => (
          <span key={signal} className="rounded-full border border-white/12 bg-white/8 px-2 py-1 text-[11px] text-[#f4f4f4]">{signal}</span>
        ))}
      </div>
    </div>
  );
}
function HdPreviewStage({ sourceImageUrl, mode, value, onChange }: { sourceImageUrl?: string; mode: HdMode; value: Record<string, unknown>; onChange: (changes: Record<string, unknown>) => void; }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [drawingMask, setDrawingMask] = useState(false);
  const [draggingCrop, setDraggingCrop] = useState(false);
  const cropCornerRef = useRef<{ corner: string; startX: number; startY: number; baseZoom: number } | null>(null);
  const outpaintRef = useRef<{ dir: string } | null>(null);
  const modeMaskPoints = useMemo(() => getModeMaskPoints(value.maskPoints, mode), [mode, value.maskPoints]);
  const cropFrame = useMemo(() => getCropFrame(String(value.cropRatio ?? '1:1'), Number(value.cropCenterX ?? 0.5), Number(value.cropCenterY ?? 0.5), Number(value.cropZoom ?? 1)), [value.cropCenterX, value.cropCenterY, value.cropRatio, value.cropZoom]);
  const modeMeta = getModeMeta(mode);
  const resultSignals = buildResultSignals(mode, value, modeMaskPoints.length);
  const renderSourceImageUrl = useMemo(() => toRenderableAssetUrl(sourceImageUrl || '', 'image'), [sourceImageUrl]);

  useEffect(() => {
    function onMove(event: MouseEvent) {
      if (cropCornerRef.current && stageRef.current) {
        const rect = stageRef.current.getBoundingClientRect();
        const dx = (event.clientX - cropCornerRef.current.startX) / rect.width;
        const dy = (event.clientY - cropCornerRef.current.startY) / rect.height;
        const delta = Math.max(Math.abs(dx), Math.abs(dy));
        const sign = cropCornerRef.current.corner === 'tl' || cropCornerRef.current.corner === 'br' ? -1 : 1;
        const nextZoom = clamp(cropCornerRef.current.baseZoom + sign * delta * 1.8, 1, 2.4);
        onChange({ cropZoom: Number(nextZoom.toFixed(2)) });
      }
      if (outpaintRef.current && stageRef.current) {
        const rect = stageRef.current.getBoundingClientRect();
        const dir = outpaintRef.current.dir;
        let ratio = 0.35;
        if (dir === 'right') ratio = ((event.clientX - rect.left) / rect.width) * 1.2;
        else if (dir === 'left') ratio = ((rect.right - event.clientX) / rect.width) * 1.2;
        else if (dir === 'bottom') ratio = ((event.clientY - rect.top) / rect.height) * 1.2;
        else ratio = ((rect.bottom - event.clientY) / rect.height) * 1.2;
        onChange({ outpaintRatio: Number(clamp(ratio, 0.1, 1).toFixed(2)), outpaintDirection: dir });
      }
    }
    function onUp() {
      cropCornerRef.current = null;
      outpaintRef.current = null;
      setDraggingCrop(false);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [onChange]);

  function appendMaskPoint(event: ReactPointerEvent<HTMLDivElement>, targetMode: 'inpaint' | 'erase') {
    const point = getRelativePoint(event, stageRef.current);
    if (!point) return;
    const nextPoint: MaskPoint = {
      x: point.x,
      y: point.y,
      brushSize: Number(value.brushSize ?? (targetMode === 'erase' ? 30 : 24)),
      brushMode: targetMode === 'erase' ? 'erase' : parseBrushMode(value.brushMode),
      targetMode,
    };
    const nextPoints = pushMaskPoint(value.maskPoints, nextPoint);
    onChange({ maskPoints: nextPoints, brushMode: nextPoint.brushMode });
  }

  function appendMaskPointFromMouseEvent(event: React.MouseEvent<HTMLDivElement>, targetMode: 'inpaint' | 'erase') {
    appendMaskPoint(event as unknown as ReactPointerEvent<HTMLDivElement>, targetMode);
  }

  function updateCropFocus(event: ReactPointerEvent<HTMLDivElement>) {
    const point = getRelativePoint(event, stageRef.current);
    if (!point) return;
    onChange({ cropCenterX: point.x, cropCenterY: point.y });
  }

  function updateCropFocusFromMouseEvent(event: React.MouseEvent<HTMLDivElement>) {
    updateCropFocus(event as unknown as ReactPointerEvent<HTMLDivElement>);
  }

  function beginInteraction(event: { preventDefault: () => void; stopPropagation: () => void }) {
    event.preventDefault();
    event.stopPropagation();
  }

  const upscaleFilter = `contrast(${1.02 + Number(value.detailBoost ?? 0.45) * 0.22}) saturate(${1.03 + Number(value.detailBoost ?? 0.45) * 0.16}) brightness(${1.01 + Number(value.detailBoost ?? 0.45) * 0.04})`;
  const restoreFilter = `contrast(${1.04 + Number(value.textureRecovery ?? 0.7) * 0.18}) saturate(${1.02 + Number(value.textureRecovery ?? 0.7) * 0.14}) brightness(1.02)`;

  if (!renderSourceImageUrl) {
    return (
      <div className="mb-4 flex h-[300px] w-full items-center justify-center rounded-lg border border-[#303030] bg-[linear-gradient(135deg,#10161f,#133337)] text-center text-sm text-[#d8d8d8]" data-testid="hd-preview-canvas">
        <div>
          <div className="font-medium text-white">HD 预览区</div>
          <div className="mt-1 text-xs text-[#b7c2c8]">上传或选择图片后，可在这里直接预演精修结果。</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={stageRef}
      data-testid="hd-preview-canvas"
      className="nodrag nopan nowheel relative mb-4 h-[300px] w-full overflow-hidden rounded-lg border border-[#303030] bg-[#101010]"
      style={{ touchAction: 'none' }}
      onPointerDown={(event) => {
        if (mode !== 'inpaint' && mode !== 'erase' && mode !== 'crop') return;
        beginInteraction(event);
        if (mode === 'inpaint') {
          setDrawingMask(true);
          appendMaskPoint(event, 'inpaint');
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        if (mode === 'erase') {
          setDrawingMask(true);
          appendMaskPoint(event, 'erase');
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        if (mode === 'crop') {
          setDraggingCrop(true);
          updateCropFocus(event);
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }}
      onPointerMove={(event) => {
        if (drawingMask && (mode === 'inpaint' || mode === 'erase')) beginInteraction(event);
        if (draggingCrop && mode === 'crop') beginInteraction(event);
        if (drawingMask && mode === 'inpaint') appendMaskPoint(event, 'inpaint');
        if (drawingMask && mode === 'erase') appendMaskPoint(event, 'erase');
        if (draggingCrop && mode === 'crop') updateCropFocus(event);
      }}
      onPointerUp={(event) => {
        if (drawingMask || draggingCrop) beginInteraction(event);
        setDrawingMask(false);
        setDraggingCrop(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerLeave={() => {
        setDrawingMask(false);
        setDraggingCrop(false);
      }}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        if (mode !== 'inpaint' && mode !== 'erase' && mode !== 'crop') return;
        beginInteraction(event);
        if (mode === 'inpaint') {
          setDrawingMask(true);
          appendMaskPointFromMouseEvent(event, 'inpaint');
        }
        if (mode === 'erase') {
          setDrawingMask(true);
          appendMaskPointFromMouseEvent(event, 'erase');
        }
        if (mode === 'crop') {
          setDraggingCrop(true);
          updateCropFocusFromMouseEvent(event);
        }
      }}
      onMouseMove={(event) => {
        if (drawingMask && (mode === 'inpaint' || mode === 'erase')) beginInteraction(event);
        if (draggingCrop && mode === 'crop') beginInteraction(event);
        if (drawingMask && mode === 'inpaint') appendMaskPointFromMouseEvent(event, 'inpaint');
        if (drawingMask && mode === 'erase') appendMaskPointFromMouseEvent(event, 'erase');
        if (draggingCrop && mode === 'crop') updateCropFocusFromMouseEvent(event);
      }}
      onMouseUp={(event) => {
        if (drawingMask || draggingCrop) beginInteraction(event);
        setDrawingMask(false);
        setDraggingCrop(false);
      }}
      onMouseLeave={() => {
        setDrawingMask(false);
        setDraggingCrop(false);
      }}
    >
      <img src={renderSourceImageUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-90" draggable={false} />
      {mode === 'upscale' ? <img src={renderSourceImageUrl} alt="" className="absolute inset-0 h-full w-full object-cover mix-blend-screen opacity-70" style={{ filter: upscaleFilter }} draggable={false} /> : null}
      {mode === 'outpaint' ? (
        <>
          <OutpaintOverlay direction={String(value.outpaintDirection ?? 'right')} ratio={Number(value.outpaintRatio ?? 0.35)} />
          <div
            data-outpaint-handle="left"
            onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); outpaintRef.current = { dir: 'left' }; }}
            className="absolute left-0 top-0 h-full w-3.5 cursor-ew-resize bg-gradient-to-r from-cyan-300/40 to-transparent"
          />
          <div
            data-outpaint-handle="right"
            onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); outpaintRef.current = { dir: 'right' }; }}
            className="absolute right-0 top-0 h-full w-3.5 cursor-ew-resize bg-gradient-to-l from-cyan-300/40 to-transparent"
          />
          <div
            data-outpaint-handle="top"
            onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); outpaintRef.current = { dir: 'top' }; }}
            className="absolute left-0 top-0 h-3.5 w-full cursor-ns-resize bg-gradient-to-b from-cyan-300/40 to-transparent"
          />
          <div
            data-outpaint-handle="bottom"
            onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); outpaintRef.current = { dir: 'bottom' }; }}
            className="absolute bottom-0 left-0 h-3.5 w-full cursor-ns-resize bg-gradient-to-t from-cyan-300/40 to-transparent"
          />
        </>
      ) : null}
      {mode === 'crop' ? <CropOverlay frame={cropFrame} onCornerDown={(corner, event) => { event.preventDefault(); event.stopPropagation(); cropCornerRef.current = { corner, startX: event.clientX, startY: event.clientY, baseZoom: Number(value.cropZoom ?? 1) }; }} /> : null}
      {mode === 'cutout' ? <CutoutOverlay threshold={Number(value.subjectThreshold ?? 0.58)} feather={Number(value.edgeFeather ?? 0.35)} /> : null}
      {mode === 'restore' ? (
        <>
          <img src={renderSourceImageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" style={{ filter: restoreFilter, clipPath: `inset(0 ${Math.max(0, (1 - Number(value.compareSplit ?? 0.55)) * 100)}% 0 0)` }} draggable={false} />
          <div className="absolute bottom-0 top-0 w-px bg-white/70" style={{ left: `${Number(value.compareSplit ?? 0.55) * 100}%` }} />
        </>
      ) : null}
      {(mode === 'inpaint' || mode === 'erase') ? <MaskOverlay points={modeMaskPoints} maskStrength={Number(value.maskStrength ?? 0.8)} eraseFeather={Number(value.eraseFeather ?? 0.55)} /> : null}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3 text-[11px] text-[#f6f6f6]">
        <span className="rounded-full bg-black/45 px-2 py-1">{modeMeta.label}预演</span>
      </div>
      <div className="pointer-events-none absolute left-3 top-11 flex max-w-[78%] flex-wrap gap-1.5">
        {resultSignals.slice(0, 3).map((signal) => (
          <span key={signal} className="rounded-full bg-black/45 px-2 py-1 text-[11px] text-[#ececec]">{signal}</span>
        ))}
      </div>
      {mode === 'crop' ? <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[11px] text-[#ececec]">在预览区拖动即可调整构图中心</div> : null}
      {(mode === 'inpaint' || mode === 'erase') ? <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[11px] text-[#ececec]">拖动画笔即可写入精修蒙版</div> : null}
    </div>
  );
}
function OutpaintOverlay({ direction, ratio }: { direction: string; ratio: number }) {
  const inset = Math.max(9, 22 - ratio * 10);
  const shadeStyle = getOutpaintShade(direction, ratio);
  return (
    <>
      <div className="absolute inset-0 bg-black/18" />
      <div className="absolute rounded-[18px] border border-dashed border-white/60 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]" style={{ left: inset, top: inset, right: inset, bottom: inset }} />
      <div className="absolute rounded-[18px] border border-cyan-200/45" style={shadeStyle} />
    </>
  );
}

function CropOverlay({ frame, onCornerDown }: { frame: ReturnType<typeof getCropFrame>; onCornerDown?: (corner: string, event: React.MouseEvent) => void; }) {
  const corners = [
    { key: 'tl', style: { left: 0, top: 0, transform: 'translate(-50%, -50%)' } },
    { key: 'tr', style: { right: 0, top: 0, transform: 'translate(50%, -50%)' } },
    { key: 'bl', style: { left: 0, bottom: 0, transform: 'translate(-50%, 50%)' } },
    { key: 'br', style: { right: 0, bottom: 0, transform: 'translate(50%, 50%)' } },
  ] as const;
  return (
    <>
      <div className="absolute inset-0 bg-black/40" />
      <div className="absolute rounded-[18px] border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.48)]" style={{ left: `${frame.left}%`, top: `${frame.top}%`, width: `${frame.width}%`, height: `${frame.height}%` }}>
        <div className="absolute left-1/3 top-0 h-full w-px bg-white/45" />
        <div className="absolute left-2/3 top-0 h-full w-px bg-white/45" />
        <div className="absolute top-1/3 h-px w-full bg-white/45" />
        <div className="absolute top-2/3 h-px w-full bg-white/45" />
        <div className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-black/60" />
        {corners.map((corner) => (
          <div
            key={corner.key}
            data-crop-corner={corner.key}
            onMouseDown={(event) => onCornerDown?.(corner.key, event)}
            className="absolute h-4 w-4 cursor-nwse-resize rounded-sm border border-cyan-200 bg-black/70"
            style={corner.style}
          />
        ))}
      </div>
    </>
  );
}

function CutoutOverlay({ threshold, feather }: { threshold: number; feather: number }) {
  const width = 40 + threshold * 18;
  const height = 56 + threshold * 14;
  const glow = 8 + feather * 18;
  return (
    <>
      <div className="absolute inset-0 bg-[linear-gradient(45deg,rgba(255,255,255,0.08)_25%,transparent_25%,transparent_50%,rgba(255,255,255,0.08)_50%,rgba(255,255,255,0.08)_75%,transparent_75%,transparent)] bg-[length:18px_18px] opacity-20" />
      <div className="absolute inset-0 bg-black/28" />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[48%] border-2 border-white/80 bg-cyan-300/20" style={{ width: `${width}%`, height: `${height}%`, boxShadow: `0 0 ${glow}px rgba(125, 211, 252, 0.55)` }} />
    </>
  );
}

function MaskOverlay({ points, maskStrength, eraseFeather }: { points: MaskPoint[]; maskStrength: number; eraseFeather: number }) {
  return (
    <>
      {points.map((point, index) => {
        const isErase = point.brushMode === 'erase';
        const alpha = isErase ? 0.16 + eraseFeather * 0.18 : 0.18 + maskStrength * 0.24;
        return (
          <div key={`${index}-${point.x}-${point.y}-${point.targetMode}`} className={`absolute rounded-full ${isErase ? 'ring-1 ring-white/60' : 'ring-1 ring-cyan-200/75'}`} style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%`, width: Math.max(10, point.brushSize * 0.55), height: Math.max(10, point.brushSize * 0.55), transform: 'translate(-50%, -50%)', backgroundColor: isErase ? `rgba(255,255,255,${alpha})` : `rgba(34,211,238,${alpha})` }} />
        );
      })}
    </>
  );
}

function getModeMeta(mode: HdMode) {
  return HD_MODES.find((item) => item.key === mode) || HD_MODES[0];
}

function parseHdMode(value: unknown): HdMode {
  return HD_MODE_KEYS.includes(value as HdMode) ? (value as HdMode) : 'upscale';
}

function parseBrushMode(value: unknown): 'paint' | 'erase' {
  return value === 'erase' ? 'erase' : 'paint';
}

function fillModeDefaults(mode: HdMode, currentValue: Record<string, unknown>) {
  const nextValue: Record<string, unknown> = { ...currentValue };
  const defaults = MODE_DEFAULTS[mode];
  for (const [key, fieldValue] of Object.entries(defaults)) {
    if (nextValue[key] === undefined) nextValue[key] = fieldValue;
  }
  nextValue.hdMode = mode;
  nextValue.toolOperation = `hd_${mode}`;
  return nextValue;
}

function getModeMaskPoints(raw: unknown, mode: HdMode): MaskPoint[] {
  if (!Array.isArray(raw) || (mode !== 'inpaint' && mode !== 'erase')) return [];
  return raw.map((item) => normalizeMaskPoint(item)).filter((item): item is MaskPoint => Boolean(item && item.targetMode === mode));
}

function normalizeMaskPoint(raw: unknown): MaskPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const targetMode = item.targetMode === 'erase' ? 'erase' : item.targetMode === 'inpaint' ? 'inpaint' : null;
  if (!targetMode) return null;
  return { x: clamp01(Number(item.x ?? 0)), y: clamp01(Number(item.y ?? 0)), brushSize: clamp(Number(item.brushSize ?? 24), 1, 140), brushMode: item.brushMode === 'erase' ? 'erase' : 'paint', targetMode };
}

function clearModeMaskPoints(raw: unknown, targetMode: 'inpaint' | 'erase') {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => {
    const point = normalizeMaskPoint(item);
    return point ? point.targetMode !== targetMode : true;
  });
}

function pushMaskPoint(raw: unknown, nextPoint: MaskPoint) {
  const existing = Array.isArray(raw) ? raw : [];
  const normalized = existing.map((item) => normalizeMaskPoint(item)).filter((item): item is MaskPoint => Boolean(item));
  const lastPoint = [...normalized].reverse().find((item) => item.targetMode === nextPoint.targetMode);
  if (lastPoint) {
    const dx = lastPoint.x - nextPoint.x;
    const dy = lastPoint.y - nextPoint.y;
    if (Math.hypot(dx, dy) < 0.01) return normalized;
  }
  return [...normalized, nextPoint];
}

function getRelativePoint(event: ReactPointerEvent<HTMLDivElement>, element: HTMLDivElement | null) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01((event.clientY - rect.top) / rect.height) };
}

function getCropFrame(ratioKey: string, centerX: number, centerY: number, zoom: number) {
  const ratioMap: Record<string, [number, number]> = { '1:1': [1, 1], '4:5': [4, 5], '16:9': [16, 9], '9:16': [9, 16] };
  const [rw, rh] = ratioMap[ratioKey] || [1, 1];
  let width = 260 / Math.max(1, zoom);
  let height = width * (rh / rw);
  if (height > 172) {
    height = 172;
    width = height * (rw / rh);
  }
  const left = clamp(centerX * PREVIEW_WIDTH - width / 2, 0, PREVIEW_WIDTH - width);
  const top = clamp(centerY * PREVIEW_HEIGHT - height / 2, 0, PREVIEW_HEIGHT - height);
  return { left: (left / PREVIEW_WIDTH) * 100, top: (top / PREVIEW_HEIGHT) * 100, width: (width / PREVIEW_WIDTH) * 100, height: (height / PREVIEW_HEIGHT) * 100 };
}

function getOutpaintShade(direction: string, ratio: number) {
  const depth = 14 + ratio * 20;
  if (direction === 'left') return { left: 0, top: 0, bottom: 0, width: `${depth}%` };
  if (direction === 'top') return { left: 0, top: 0, right: 0, height: `${depth}%` };
  if (direction === 'bottom') return { left: 0, right: 0, bottom: 0, height: `${depth}%` };
  if (direction === 'both') return { left: `${depth * 0.55}%`, top: `${depth * 0.42}%`, right: `${depth * 0.55}%`, bottom: `${depth * 0.42}%` };
  return { right: 0, top: 0, bottom: 0, width: `${depth}%` };
}

function buildModeSummary(mode: HdMode, value: Record<string, unknown>, maskCount: number) {
  if (mode === 'upscale') return `当前将以 ${String(value.upscale ?? '2x')} 输出，去噪 ${Number(value.denoise ?? 0.25).toFixed(2)}，细节增强 ${Number(value.detailBoost ?? 0.45).toFixed(2)}。`;
  if (mode === 'outpaint') return `画面会朝 ${formatOutpaintDirection(String(value.outpaintDirection ?? 'right'))} 扩展，扩图比例 ${Number(value.outpaintRatio ?? 0.35).toFixed(2)}，边缘羽化 ${Number(value.outpaintFeather ?? 0.5).toFixed(2)}。`;
  if (mode === 'inpaint') return `已记录 ${maskCount} 个局部重绘采样点，画笔 ${Number(value.brushSize ?? 24)}px，蒙版强度 ${Number(value.maskStrength ?? 0.8).toFixed(2)}。`;
  if (mode === 'erase') return `已记录 ${maskCount} 个移除采样点，画笔 ${Number(value.brushSize ?? 30)}px，修复羽化 ${Number(value.eraseFeather ?? 0.55).toFixed(2)}。`;
  if (mode === 'cutout') return `主体提取会优先保留边缘细节，主体阈值 ${Number(value.subjectThreshold ?? 0.58).toFixed(2)}，边缘羽化 ${Number(value.edgeFeather ?? 0.35).toFixed(2)}。`;
  if (mode === 'crop') return `输出比例 ${String(value.cropRatio ?? '1:1')}，裁切缩放 ${Number(value.cropZoom ?? 1).toFixed(2)}，焦点位于 (${Number(value.cropCenterX ?? 0.5).toFixed(2)}, ${Number(value.cropCenterY ?? 0.5).toFixed(2)})。`;
  return `修复对比滑杆位于 ${Number(value.compareSplit ?? 0.55).toFixed(2)}，纹理恢复 ${Number(value.textureRecovery ?? 0.7).toFixed(2)}，适合旧图与压缩图修复。`;
}

function buildResultSignals(mode: HdMode, value: Record<string, unknown>, maskCount: number) {
  if (mode === 'upscale') return [`${String(value.upscale ?? '2x')} 输出倍率`, `${Boolean(value.faceRestore ?? true) ? '人脸修复' : '人脸原样'}`, `${Boolean(value.preserveTexture ?? true) ? '纹理保真' : '纹理更平滑'}`];
  if (mode === 'outpaint') return [`${formatOutpaintDirection(String(value.outpaintDirection ?? 'right'))}扩图`, `扩图比 ${Number(value.outpaintRatio ?? 0.35).toFixed(2)}`, `羽化 ${Number(value.outpaintFeather ?? 0.5).toFixed(2)}`];
  if (mode === 'inpaint') return [`${maskCount} 个重绘点`, `画笔 ${Number(value.brushSize ?? 24)}px`, `强度 ${Number(value.maskStrength ?? 0.8).toFixed(2)}`];
  if (mode === 'erase') return [`${maskCount} 个移除点`, `羽化 ${Number(value.eraseFeather ?? 0.55).toFixed(2)}`, `${Boolean(value.restoration ?? true) ? '自动补全开启' : '自动补全关闭'}`];
  if (mode === 'cutout') return [`阈值 ${Number(value.subjectThreshold ?? 0.58).toFixed(2)}`, `羽化 ${Number(value.edgeFeather ?? 0.35).toFixed(2)}`, `${Boolean(value.faceRestore ?? true) ? '发丝保护开启' : '发丝保护关闭'}`];
  if (mode === 'crop') return [`${String(value.cropRatio ?? '1:1')} 构图`, `缩放 ${Number(value.cropZoom ?? 1).toFixed(2)}`, `焦点 ${Number(value.cropCenterX ?? 0.5).toFixed(2)} / ${Number(value.cropCenterY ?? 0.5).toFixed(2)}`];
  return [`纹理恢复 ${Number(value.textureRecovery ?? 0.7).toFixed(2)}`, `对比滑杆 ${Number(value.compareSplit ?? 0.55).toFixed(2)}`, `${Boolean(value.preserveTexture ?? true) ? '细节保留' : '更平滑修复'}`];
}

function formatOutpaintDirection(direction: string) {
  const match = OUTPAINT_DIRECTIONS.find((item) => item.value === direction);
  return match ? match.label : '向右';
}
function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number) {
  return clamp(value, 0, 1);
}










