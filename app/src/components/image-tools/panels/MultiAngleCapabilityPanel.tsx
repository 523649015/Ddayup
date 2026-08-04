import { Bookmark, Cpu, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolCapabilityPanelProps } from './capabilityPanelTypes';
import { applyMultiAngle } from '@/services/imageToolApply';
import { MultiAngleOrbit3D } from './MultiAngleOrbit3D';

const VIEW_PRESETS = [
  { key: 'custom',    label: '自定义',     yaw: 45,  pitch: 15,  shotScale: 'medium', framingZoom: 1 },
  { key: 'fisheye',   label: '鱼眼视角',   yaw: 18,  pitch: -6,  shotScale: 'close',  framingZoom: 1.28 },
  { key: 'tilt',      label: '倾斜视角',   yaw: 42,  pitch: 22,  shotScale: 'medium', framingZoom: 1.1 },
  { key: 'front-top', label: '正面俯拍',   yaw: 0,   pitch: 68,  shotScale: 'wide',   framingZoom: 0.92 },
  { key: 'front-low', label: '正面仰拍',   yaw: 0,   pitch: -34,  shotScale: 'wide',   framingZoom: 0.98 },
  { key: 'panorama-top', label: '全景俯拍', yaw: 138, pitch: 14,  shotScale: 'medium', framingZoom: 1.05 },
  { key: 'back',      label: '背面视角',   yaw: 180, pitch: 0,   shotScale: 'medium', framingZoom: 1 },
];

const SHOT_SCALE_LABELS: Record<string, string> = { close: '特写', medium: '中景', wide: '远景' };

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
function deriveShotScale(zoom: number) {
  if (zoom >= 1.22) return 'close';
  if (zoom <= 0.95) return 'wide';
  return 'medium';
}
function formatDegrees(value: number) { const r = Math.round(value); return r >= 0 ? `${r}°` : `${r}°`; }

export default function MultiAngleCapabilityPanel({
  value, onChange, sourceImageUrl, onApply, onCreateAsNewNode,
}: ToolCapabilityPanelProps) {
  const configRef = useRef(value);
  const [keyframeName, setKeyframeName] = useState('');
  const [applyStatus, setApplyStatus] = useState<string | null>(null);
  const [promptEnabled, setPromptEnabled] = useState(Boolean(value.promptEnabled ?? false));
  const [promptText, setPromptText] = useState(String(value.promptText ?? ''));
  const [isGenerating, setIsGenerating] = useState(false);
  const [depthModelReady, setDepthModelReady] = useState(false);
  const [usedEngine, setUsedEngine] = useState<string | null>(null);

  // 检测深度模型是否可用 + 打印诊断信息
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const { isDepthModelReady } = await import('@/services/depthEstimation');
        const ready = isDepthModelReady();
        if (!cancelled) {
          setDepthModelReady(ready);
          if (ready) console.log('[multiAngle] ✅ 深度增强已就绪 (Depth Anything V2)');
          else console.log('[multiAngle] ℹ️ 深度模型未安装，使用仿射变换兜底');
        }
      } catch { /* 忽略 */ }
    };
    check();

    const onModelsChanged = () => { check(); };
    window.addEventListener('hmdao-local-models-changed', onModelsChanged);
    return () => { window.removeEventListener('hmdao-local-models-changed', onModelsChanged); cancelled = true; };
  }, []);

  const yaw = Number(value.yaw ?? 45);
  const pitch = Number(value.pitch ?? 15);
  const consistency = Number(value.consistency ?? 0.85);
  const framingZoom = Number(value.framingZoom ?? 1);
  const cameraPreset = String(value.cameraPreset ?? 'custom');
  const keyframes = useMemo(() => Array.isArray(value.keyframes) ? value.keyframes : [], [value.keyframes]);

  function mergeConfig(next: Record<string, unknown>) {
    const merged = { ...configRef.current, ...next };
    configRef.current = merged;
    onChange(merged);
  }

  // ===== 闭环执行 =====
  async function runCamera() {
    if (!sourceImageUrl) throw new Error('请先选择素材图');
    const engineHint = depthModelReady ? '深度视差' : '仿射变换';
    setApplyStatus(`合成机位中 (${engineHint})…`);
    const params = { yaw, pitch, framingZoom, consistency, promptEnabled, depthModelReady };
    console.log('[multiAngle] 开始合成', { ...params, sourceImageUrl: sourceImageUrl?.slice(-60) });
    const start = performance.now();
    const result = await applyMultiAngle(sourceImageUrl, {
      yaw, pitch, framingZoom, consistency,
      promptEnabled,
      promptText: promptEnabled ? promptText : undefined,
    });
    console.log('[multiAngle] 合成完成', { engine: result.engine, elapsed: `${(performance.now() - start).toFixed(0)}ms`, assetId: result.assetId });
    setUsedEngine(result.engine);
    return result;
  }

  async function handleApply() {
    if (!onApply) { setApplyStatus('当前节点未启用应用到原图能力'); return; }
    setIsGenerating(true);
    try {
      const result = await runCamera();
      await onApply({ appliedImageUrl: result.url, imageUrl: sourceImageUrl, engine: result.engine, yaw, pitch, framingZoom, consistency });
      setApplyStatus('已覆盖到原图');
    } catch (err) { setApplyStatus(err instanceof Error ? err.message : '生成失败'); }
    finally { setIsGenerating(false); }
  }

  async function handleCreateAsNewNode() {
    const callback = onCreateAsNewNode ?? onApply;
    if (!callback) { setApplyStatus('当前节点未启用生成新节点能力'); return; }
    setIsGenerating(true);
    try {
      const result = await runCamera();
      await callback({ appliedImageUrl: result.url, imageUrl: sourceImageUrl, engine: result.engine, yaw, pitch, framingZoom, consistency });
      setApplyStatus('已生成新节点继承效果');
    } catch (err) { setApplyStatus(err instanceof Error ? err.message : '生成失败'); }
    finally { setIsGenerating(false); }
  }

  // ===== 关键帧管理 =====
  function addKeyframe() {
    const nextName = keyframeName.trim() || `关键帧 ${keyframes.length + 1}`;
    mergeConfig({ keyframes: [...keyframes, { name: nextName, yaw, pitch, shotScale: deriveShotScale(framingZoom), framingZoom, consistency }] });
    setKeyframeName('');
  }
  function updateKeyframe(index: number) {
    mergeConfig({ keyframes: keyframes.map((f: unknown, i: number) => i === index ? { ...(f as Record<string, unknown>), yaw, pitch, shotScale: deriveShotScale(framingZoom), framingZoom, consistency } : f) });
  }
  function removeKeyframe(index: number) {
    mergeConfig({ keyframes: keyframes.filter((_: unknown, i: number) => i !== index) });
  }

  return (
    <div className="nodrag nopan nowheel mb-4 rounded-xl border border-[#353535] bg-[#242424] p-3">
      {/* 预设标签 */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {VIEW_PRESETS.map((preset) => {
          const active = cameraPreset === preset.key;
          return (
            <button key={preset.key} type="button" data-testid={`multi-angle-preset-${preset.key}`}
              onClick={() => mergeConfig({ cameraPreset: preset.key, yaw: preset.yaw, pitch: preset.pitch, shotScale: preset.shotScale, framingZoom: preset.framingZoom })}
              className={`nodrag rounded-full border px-2.5 py-1 text-xs ${active ? 'border-[#00b4d8] bg-[#00b4d8]/15 text-[#00b4d8] font-medium' : 'border-[#404040] text-[#cbcbcb] hover:bg-[#353535]'}`}
            >{preset.label}</button>
          );
        })}
      </div>

      {/* 左右分栏：左侧 3D 轨道球（放大占比）+ 右侧滑块（缩小占比） */}
      <div className="mb-3 flex gap-3" style={{ height: 260 }}>
        <div className="min-w-0 flex-1" style={{ height: 260 }}>
          <MultiAngleOrbit3D
            yaw={yaw}
            pitch={pitch}
            zoom={framingZoom}
            imageUrl={sourceImageUrl}
            onYawChange={(v) => mergeConfig({ yaw: v, cameraPreset: 'custom' })}
            onPitchChange={(v) => mergeConfig({ pitch: v, cameraPreset: 'custom' })}
            onZoomChange={(v) => mergeConfig({ framingZoom: v, shotScale: deriveShotScale(v) })}
          />
        </div>

        <div className="flex w-[164px] flex-shrink-0 flex-col justify-center gap-3">
          <SliderField label="水平环绕" value={formatDegrees(yaw)} min={0} max={360} step={1} current={yaw}
            testId="multi-angle-yaw-slider" ticks={['0°', '180°', '360°']}
            onChange={(v) => mergeConfig({ yaw: v, cameraPreset: 'custom' })} />
          <SliderField label="垂直俯仰" value={formatDegrees(pitch)} min={-90} max={90} step={1} current={pitch}
            testId="multi-angle-pitch-slider" ticks={['-90°', '0°', '90°']}
            onChange={(v) => mergeConfig({ pitch: v, cameraPreset: 'custom' })} />
          <SliderField label="景别缩放" value={SHOT_SCALE_LABELS[deriveShotScale(framingZoom)] || '中景'} min={0.78} max={1.5} step={0.01} current={framingZoom}
            testId="multi-angle-zoom-slider" ticks={['远景', '中景', '特写']}
            onChange={(v) => mergeConfig({ framingZoom: v, shotScale: deriveShotScale(v) })} />
        </div>
      </div>

      {/* 主体一致性 + 深度模型状态 */}
      <div className="mb-3 space-y-1">
        <div className="flex items-center justify-between text-xs text-[#b4b4b4]">
          <div className="flex items-center gap-2">
            <span>主体一致性</span>
            {depthModelReady ? (
              <span className="rounded-full bg-[#00b4d8]/15 px-2 py-0.5 text-[10px] font-medium text-[#00b4d8]"><Cpu className="mr-1 inline h-2.5 w-2.5" />深度增强</span>
            ) : (
              <span className="rounded-full bg-[#888]/10 px-2 py-0.5 text-[10px] text-[#7f7f7f]">仿射变换</span>
            )}
          </div>
          <span className="font-mono text-[#00b4d8]">{consistency.toFixed(2)}</span>
        </div>
        <input type="range" min={0} max={1} step={0.01} value={consistency}
          onChange={(e) => mergeConfig({ consistency: Number(e.target.value) })}
          className="nodrag nopan nowheel w-full accent-[#00b4d8]" data-testid="multi-angle-consistency-slider" />
        <div className="flex justify-between text-[10px] text-[#666]"><span>自由变化</span><span>严格保持</span></div>
      </div>

      {/* 提示词模块 */}
      <div className="mb-3 rounded-lg border border-[#353535] bg-[#1c1c1c] p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-[#b4b4b4]"><Sparkles className="h-3.5 w-3.5 text-[#00b4d8]" /><span>AI 提示词增强</span></div>
          <button type="button" onClick={() => { const n = !promptEnabled; setPromptEnabled(n); mergeConfig({ promptEnabled: n }); }}
            className={`relative h-5 w-9 rounded-full transition-colors ${promptEnabled ? 'bg-[#00b4d8]' : 'bg-[#454545]'}`}
            data-testid="multi-angle-prompt-toggle" aria-label={promptEnabled ? '关闭提示词' : '开启提示词'}>
            <span className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform"
              style={{ transform: promptEnabled ? 'translateX(14px)' : 'translateX(0)' }} />
          </button>
        </div>
        {promptEnabled && (
          <div className="mt-2">
            <textarea value={promptText} onChange={(e) => { setPromptText(e.target.value); mergeConfig({ promptText: e.target.value }); }}
              placeholder="描述期望的新视角效果，例如：保持人物姿势，转换为侧面45°俯视..."
              className="nodrag nopan nowheel min-h-[60px] w-full resize-y rounded-lg border border-[#303030] bg-[#111] px-3 py-2 text-xs text-[#e8e8e8] outline-none placeholder:text-[#555]"
              data-testid="multi-angle-prompt-text" />
          </div>
        )}
      </div>

      {/* 关键帧 */}
      <div className="mb-3 rounded-lg border border-[#404040] bg-[#1c1c1c] p-3">
        <div className="mb-2 flex items-center justify-between text-xs text-[#b4b4b4]"><span>关键帧</span><span>{keyframes.length} 帧</span></div>
        <div className="mb-2 flex gap-2">
          <input value={keyframeName} onChange={(e) => setKeyframeName(e.target.value)} placeholder="命名当前机位，如：正面近景"
            className="nodrag nopan nowheel min-w-0 flex-1 rounded-lg border border-[#303030] bg-[#111] px-3 py-1.5 text-sm text-[#e8e8e8] outline-none"
            data-testid="multi-angle-keyframe-name" />
          <button type="button" data-testid="multi-angle-keyframe-add" onClick={addKeyframe} className="nodrag flex items-center gap-1 rounded-lg border border-[#404040] px-2.5 py-1.5 text-xs text-[#cbcbcb]"><Plus className="h-3.5 w-3.5" />保存</button>
          <button type="button" data-testid="multi-angle-keyframe-reset" onClick={() => mergeConfig({ keyframes: [] })} className="nodrag flex items-center justify-center rounded-lg border border-[#404040] px-2.5 py-1.5 text-xs text-[#cbcbcb]"><RotateCcw className="h-3.5 w-3.5" /></button>
        </div>
        <div className="space-y-1.5">
          {keyframes.length > 0 ? keyframes.map((frame: unknown, index: number) => {
            const item = frame as Record<string, unknown>;
            return (
              <div key={`${index}-${String(item.name ?? '')}`} className="flex items-center gap-2 rounded-lg border border-[#333] px-2.5 py-2 text-xs">
                <button type="button" data-testid={`multi-angle-keyframe-${index}`} onClick={() => mergeConfig({
                  yaw: Number(item.yaw ?? yaw), pitch: Number(item.pitch ?? pitch),
                  shotScale: String(item.shotScale ?? deriveShotScale(framingZoom)), framingZoom: Number(item.framingZoom ?? framingZoom),
                  consistency: Number(item.consistency ?? consistency), cameraPreset: 'custom',
                })} className="nodrag flex flex-1 items-center gap-2 text-left">
                  <Bookmark className="h-3.5 w-3.5 shrink-0 text-[#cbcbcb]" />
                  <span className="min-w-0 flex-1 truncate font-medium text-[#f3f3f3]">{String(item.name || `关键帧 ${index + 1}`)}</span>
                  <span className="shrink-0 text-[11px] text-[#a8a8a8]">{String(item.yaw ?? yaw)}° · {String(item.framingZoom ?? framingZoom).slice(0, 4)}x</span>
                </button>
                <button type="button" data-testid={`multi-angle-keyframe-update-${index}`} onClick={() => updateKeyframe(index)} className="nodrag rounded-md border border-[#3c3c3c] px-2 py-1 text-[11px] text-[#cfcfcf] hover:bg-[#2f2f2f]">覆盖</button>
                <button type="button" data-testid={`multi-angle-keyframe-remove-${index}`} onClick={() => removeKeyframe(index)} className="nodrag rounded-md border border-[#3c3c3c] p-1 text-[#cfcfcf] hover:bg-[#2f2f2f]"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            );
          }) : (<div className="text-xs text-[#8f8f8f]">常用机位可保存到此处复用。</div>)}
        </div>
      </div>

      {/* 执行按钮 */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" data-testid="multi-angle-apply" onClick={() => void handleApply()} disabled={isGenerating}
          className="rounded-lg border border-[#404040] bg-[#2a2a2a] px-3 py-2 text-sm text-[#cbcbcb] hover:bg-[#333] disabled:opacity-50">
          {isGenerating ? '生成中…' : '覆盖到原图'}
        </button>
        <button type="button" data-testid="multi-angle-new-node" onClick={() => void handleCreateAsNewNode()} disabled={isGenerating}
          className="rounded-lg border border-[#00b4d8] bg-[#00b4d8]/15 px-3 py-2 text-sm font-medium text-[#00b4d8] hover:bg-[#00b4d8]/25 disabled:opacity-50">
          {isGenerating ? '生成中…' : '生成新节点继承'}
        </button>
      </div>
      {applyStatus ? (
        <div data-testid="multi-angle-status" className="mt-2 rounded-lg border border-[#404040] bg-[#161616] px-3 py-2 text-xs text-[#b4b4b4]">
          {applyStatus}
          {usedEngine ? <span className="ml-1 text-[10px] text-[#7f7f7f]">({usedEngine})</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** 内联滑块 + 标签组件 */
function SliderField({ label, value, min, max, step, current, testId, ticks, onChange }: {
  label: string; value: string; min: number; max: number; step: number; current: number;
  testId: string; ticks: string[]; onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-[#b4b4b4]"><span>{label}</span><span className="font-mono text-[#00b4d8]">{value}</span></div>
      <input type="range" min={min} max={max} step={step} value={current}
        onChange={(e) => onChange(Number(e.target.value))}
        className="nodrag nopan nowheel w-full accent-[#00b4d8]" data-testid={testId} />
      <div className="flex justify-between text-[10px] text-[#666]">{ticks.map((t, i) => <span key={i}>{t}</span>)}</div>
    </div>
  );
}
