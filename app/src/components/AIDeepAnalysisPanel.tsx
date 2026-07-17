/**
 * HMDao AI 深度分析面板
 * - 图片深度分析（光影/风格/主体/构图/运镜）
 * - 提示词精准提取
 * - 基于提示词自动生成相似图片
 * - 模型推荐
 */
import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles, Loader2, Wand2, Image as ImageIcon, Play,
  Sun, Palette, Eye, Camera, Heart, Copy, Check,
  ChevronDown, ExternalLink, Zap, Brain, AlertCircle,
  RefreshCw, Plus, Languages, History,
} from 'lucide-react';
import { deepAnalyzeImage, generateSimilarVariants, getActiveVisionModels, loadVariantImageWithRetry } from '@/services/aiDeepAnalysisService';
import type { AIDeepAnalysis, RecommendedVLMModel } from '@/types/assets';
import type { AssetItem } from '@/types/assets';
import { RECOMMENDED_VLM_MODELS } from '@/types/assets';
import { getByokRuntime } from '@/api/byok';
import { consumeVisionActivationFlag } from '@/services/visionActivation';

interface AIDeepAnalysisPanelProps {
  item: AssetItem | null;
  onAnalysisComplete?: (analysis: AIDeepAnalysis) => void;
  onGeneratedImage?: (imageUrl: string, prompt: string) => void;
  compact?: boolean;
}

type AnalysisStatus = 'idle' | 'analyzing' | 'done' | 'generating' | 'error';
type DisplayLanguage = 'zh' | 'en';

interface GenerationVariant {
  id: string;
  imageUrl?: string;
  prompt: string;
  status: 'pending' | 'generating' | 'done' | 'failed';
  error?: string;
  /** 已加载（用于 503 重试后的真实 <img> 展示） */
  loadedUrl?: string;
}

export function AIDeepAnalysisPanel({
  item,
  onAnalysisComplete,
  onGeneratedImage,
  compact = false,
}: AIDeepAnalysisPanelProps) {
  const [status, setStatus] = useState<AnalysisStatus>('idle');
  const [analysis, setAnalysis] = useState<AIDeepAnalysis | null>(null);
  const [error, setError] = useState('');
  const [variants, setVariants] = useState<GenerationVariant[]>([]);
  const [copiedField, setCopiedField] = useState('');
  const [showModelRecs, setShowModelRecs] = useState(false);
  const [selectedModel, setSelectedModel] = useState<RecommendedVLMModel>(RECOMMENDED_VLM_MODELS[0]);
  const [dynamicModels, setDynamicModels] = useState<RecommendedVLMModel[]>([]);
  const [activatedProviders, setActivatedProviders] = useState<Set<string>>(new Set());
  const [hasActivatedVision, setHasActivatedVision] = useState(false);
  const [activationToast, setActivationToast] = useState<string | null>(null);
  const [displayLang, setDisplayLang] = useState<DisplayLanguage>('zh');
  const navigate = useNavigate();

  // 素材已有分析结果时自动恢复，避免重复分析
  useEffect(() => {
    const existing = item?.analysis;
    if (existing && existing.subject && existing.analyzedAt) {
      // AssetImageAnalysis 与 AIDeepAnalysis 字段兼容映射
      setAnalysis({
        engine: existing.runtime?.requestedEngine || 'auto',
        provider: existing.runtime?.provider || 'local',
        model: existing.runtime?.model || 'auto',
        compositePrompt: existing.promptEn || existing.compositePrompt || '',
        promptZh: existing.promptZh || '',
        promptEn: existing.promptEn || '',
        subject: existing.subject || '',
        scene: existing.scene || '',
        style: existing.style || '',
        lighting: existing.lighting || '',
        composition: existing.composition || '',
        camera: existing.camera || '',
        mood: existing.mood || '',
        palette: existing.palette || [],
        keywords: existing.keywords || [],
        suggestedParams: existing.suggestedParams || { aspectRatio: '16:9', quality: 'high' },
        analyzedAt: existing.analyzedAt,
      });
      setStatus('done');
    }
  }, [item?.id]); // 仅在素材变化时触发

  // 构建推荐模型列表（动态+静态，去重，只保留5个主流模型）并同步激活状态
  const recommendedModels = (() => {
    const seen = new Set<string>();
    const merged: RecommendedVLMModel[] = [];
    for (const m of [...dynamicModels, ...RECOMMENDED_VLM_MODELS]) {
      const key = `${m.provider}:${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(m);
    }
    return merged;
  })();

  const isProviderActivated = useCallback(
    (provider: string) => activatedProviders.has(String(provider || '').trim().toLowerCase()),
    [activatedProviders],
  );

  // 自动将默认选中项落到用户已激活的平台，并拉取运行时推荐的视觉模型
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const runtime = await getByokRuntime();
        const activated = (runtime?.activatedProviders || [])
          .map((record) => String(record?.provider || '').trim().toLowerCase())
          .filter(Boolean);
        const activatedSet = new Set(activated);
        if (cancelled) return;
        setActivatedProviders(activatedSet);

        // 从运行时推荐（recommendations.imageAnalysis）动态生成模型
        const rec = runtime?.recommendations?.imageAnalysis;
        const dynamic: RecommendedVLMModel[] = [];
        const candidates = [
          ...(rec?.primary ? [rec.primary] : []),
          ...(rec?.alternates || []),
          ...(rec?.candidates || []),
        ];
        const dynamicKeys = new Set<string>();
        for (const c of candidates) {
          if (!c?.model) continue;
          const key = `${c.provider || ''}:${c.model}`;
          if (dynamicKeys.has(key)) continue;
          dynamicKeys.add(key);
          dynamic.push({
            id: c.model,
            name: c.title || `${c.providerLabel || c.provider} · ${c.model}`,
            provider: c.provider,
            providerName: c.providerLabel || c.provider,
            description: c.recommendation || `来自${c.providerLabel || c.provider}的视觉模型`,
            strengths: ['运行时推荐'],
            free: true,
            freeQuota: c.pricingSummary || '按平台额度',
            setupGuide: `在 API 管理面板激活${c.providerLabel || c.provider}`,
            priority: 0,
          });
        }

        if (!cancelled) {
          setDynamicModels(dynamic);

          // hasActivatedVision：只要有任一静态推荐模型对应的 provider 已激活，就认为可用
          const anyRecActivated = RECOMMENDED_VLM_MODELS.some((m) =>
            activatedSet.has(String(m.provider || '').trim().toLowerCase()),
          ) || dynamic.some((m) => activatedSet.has(String(m.provider || '').trim().toLowerCase()));
          setHasActivatedVision(anyRecActivated);

          // 闭环反馈：从本面板跳转激活后返回
          const pending = consumeVisionActivationFlag();
          if (pending && anyRecActivated) {
            const lowered = pending.providers.map((p) => p.toLowerCase());
            const allModels = [...dynamic, ...RECOMMENDED_VLM_MODELS];
            const matched = allModels.find((m) => lowered.includes(m.provider.toLowerCase())) || allModels[0];
            setActivationToast(`视觉模型已激活，已自动切换至 ${matched?.name || '云端模型'}`);
            window.setTimeout(() => setActivationToast(null), 4500);
          }

          // 默认选中：优先已激活平台对应的模型
          const allModels = [...dynamic, ...RECOMMENDED_VLM_MODELS];
          const activeMatch = allModels.find((m) => activatedSet.has(String(m.provider || '').trim().toLowerCase()));
          if (activeMatch) {
            setSelectedModel(activeMatch);
            return;
          }
          // 其次选静态推荐首位
          if (RECOMMENDED_VLM_MODELS.length > 0) {
            setSelectedModel(RECOMMENDED_VLM_MODELS[0]);
          }
        }
      } catch {
        // 读取失败保持默认推荐项
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ===== 开始分析 ===== */
  const handleAnalyze = useCallback(async () => {
    if (!item || status === 'analyzing') return;

    setStatus('analyzing');
    setError('');
    setVariants([]);

    try {
      // 将用户选择的推荐模型真正注入分析请求（provider + model 生效）
      const result = await deepAnalyzeImage(item, {
        provider: selectedModel.provider,
        model: selectedModel.id,
      });
      setAnalysis(result);
      setStatus('done');
      onAnalysisComplete?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI分析失败，请检查网络或API配置');
      setStatus('error');
    }
  }, [item, status, onAnalysisComplete, selectedModel]);

  /* ===== 生成相似图片 ===== */
  const handleGenerateSimilar = useCallback(async () => {
    if (!analysis || !item || status === 'generating') return;

    setStatus('generating');
    const variantIds = Array.from({ length: 4 }, (_, i) => `variant_${Date.now()}_${i}`);

    setVariants(
      variantIds.map((id) => ({
        id,
        prompt: analysis.compositePrompt,
        status: 'generating' as const,
      })),
    );

    try {
      const results = await generateSimilarVariants(analysis, 4, item.url);

      const settled = await Promise.all(
        results.map(async (result, i) => {
          const baseId = variantIds[i];
          if (result?.success && result.imageUrl) {
            // 异步加载图片，偶发 503 自动换种子重试一次
            const load = await loadVariantImageWithRetry(result.imageUrl);
            if (load.ok) {
              return {
                id: baseId,
                imageUrl: result.imageUrl,
                loadedUrl: load.url,
                prompt: result.prompt,
                status: 'done' as const,
              };
            }
            return {
              id: baseId,
              imageUrl: result.imageUrl,
              prompt: result.prompt,
              status: 'failed' as const,
              error: load.error || '图片加载失败',
            };
          }
          return {
            id: baseId,
            prompt: '',
            status: 'failed' as const,
            error: result?.error || '生成失败',
          };
        }),
      );

      setVariants(settled);
      setStatus('done');
    } catch (err) {
      setVariants((prev) =>
        prev.map((v) => ({ ...v, status: 'failed' as const, error: '生成失败' })),
      );
      setStatus('error');
      setError(err instanceof Error ? err.message : '相似图片生成失败');
    }
  }, [analysis, item, status]);

  /* ===== 单张变体重试（换种子重新加载） ===== */
  const handleRetryVariant = useCallback(async (variantId: string) => {
    setVariants((prev) =>
      prev.map((v) => (v.id === variantId ? { ...v, status: 'generating' as const, error: undefined } : v)),
    );
    const target = variants.find((v) => v.id === variantId);
    if (!target?.imageUrl) return;
    const load = await loadVariantImageWithRetry(target.imageUrl);
    setVariants((prev) =>
      prev.map((v) => {
        if (v.id !== variantId) return v;
        if (load.ok) return { ...v, loadedUrl: load.url, status: 'done' as const, error: undefined };
        return { ...v, status: 'failed' as const, error: load.error || '重试失败' };
      }),
    );
  }, [variants]);

  /* ===== 复制提示词 ===== */
  const handleCopy = useCallback(async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(''), 2000);
    } catch { /* clipboard not available */ }
  }, []);

  /* ===== 重新分析 ===== */
  const handleRetry = useCallback(() => {
    setStatus('idle');
    setError('');
    setVariants([]);
    void handleAnalyze();
  }, [handleAnalyze]);

  if (!item || (item.type !== 'image' && item.type !== 'video')) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-[#6e7681]">
        <Brain className="w-10 h-10 mb-3 opacity-20" />
        <p className="text-xs">选择图片素材进行 AI 深度分析</p>
      </div>
    );
  }

  /* ===== 空闲状态 ===== */
  if (status === 'idle') {
    return (
      <div className="space-y-4">
        <div className="rounded-xl bg-[#161b22] ring-1 ring-[#21262d] p-4">
          <div className="flex items-center gap-2 mb-3">
            <Brain className="w-4 h-4 text-[#00d4aa]" />
            <span className="text-xs font-medium text-[#e6edf3]">AI 深度分析</span>
            <span className="text-[10px] text-[#00d4aa] bg-[#00d4aa]/10 px-1.5 py-0.5 rounded">免费</span>
          </div>
          <p className="text-[11px] text-[#8b949e] leading-relaxed mb-4">
            调用视觉大模型对图片进行深度解读，精准提取光影、风格、主体、构图、运镜等核心视觉特征，
            并自动生成高度相似的参考图片。
          </p>

          {!hasActivatedVision && (
            <div className="mb-4 rounded-xl border border-[#f59e0b]/25 bg-[#f59e0b]/10 p-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-[#f59e0b] mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] text-[#ffd29a] leading-relaxed">
                    未检测到已激活的视觉模型，当前使用本地启发式链路（解析能力有限）。
                    在 API 管理中激活硅基流动 / 通义万相等视觉模型，即可启用云端深度分析。
                  </p>
                  <button
                    type="button"
                    onClick={() => navigate(`/settings/api-keys?from=deep-analysis&vision=1&provider=${encodeURIComponent(selectedModel.provider)}`)}
                    className="mt-2 flex items-center gap-1 rounded-lg bg-[#f59e0b]/20 px-2.5 py-1.5 text-[11px] font-medium text-[#ffd29a] hover:bg-[#f59e0b]/30 transition-colors"
                  >
                    <Zap className="w-3 h-3" />
                    去 API 管理激活视觉模型
                  </button>
                </div>
              </div>
            </div>
          )}

          {activationToast ? (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-[#00d4aa]/30 bg-[#00d4aa]/10 px-3 py-2 text-[11px] text-[#7cf7d4]">
              <Check className="w-3.5 h-3.5 shrink-0" />
              {activationToast}
            </div>
          ) : null}

          {/* 推荐模型 */}
          <div className="mb-3">
            <button
              onClick={() => setShowModelRecs(!showModelRecs)}
              className="flex items-center gap-1 text-[10px] text-[#1a8cff] hover:text-[#4da6ff] transition-colors"
            >
              推荐模型 ({recommendedModels.length})
              <ChevronDown className={`w-3 h-3 transition-transform ${showModelRecs ? 'rotate-180' : ''}`} />
            </button>
            {showModelRecs && (
              <div className="mt-2 space-y-1.5">
                {recommendedModels.map((model) => {
                  const activated = isProviderActivated(model.provider);
                  const isDynamic = dynamicModels.some((d) => d.provider === model.provider && d.id === model.id);
                  return (
                  <button
                    key={`${model.provider}:${model.id}`}
                    onClick={() => setSelectedModel(model)}
                    className={`w-full text-left flex items-start gap-2 p-2 rounded-lg transition-colors ${
                      selectedModel.id === model.id && selectedModel.provider === model.provider
                        ? 'bg-[#1a8cff]/10 ring-1 ring-[#1a8cff]/20'
                        : activated
                          ? 'hover:bg-[#00d4aa]/5'
                          : 'hover:bg-[#21262d] opacity-60'
                    }`}
                  >
                    <span
                      className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${
                        activated ? 'bg-[#00d4aa]' : 'bg-[#484f58]'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-medium text-[#c9d1d9]">{model.name}</span>
                        {activated ? (
                          <span className="text-[9px] text-[#00d4aa] bg-[#00d4aa]/10 px-1 rounded">已激活</span>
                        ) : (
                          <span className="text-[9px] text-[#6e7681] bg-[#30363d] px-1 rounded">未激活</span>
                        )}
                        {isDynamic && (
                          <span className="text-[9px] text-[#a855f7] bg-[#a855f7]/10 px-1 rounded">实时</span>
                        )}
                        {model.priority === 1 && (
                          <span className="text-[9px] text-[#f59e0b] bg-[#f59e0b]/10 px-1 rounded">推荐</span>
                        )}
                      </div>
                      <p className="text-[9px] text-[#6e7681] mt-0.5">{model.description}</p>
                      {model.freeQuota && (
                        <p className="text-[8px] text-[#8b949e] mt-0.5">{model.freeQuota}</p>
                      )}
                    </div>
                  </button>
                  );
                })}
              </div>
            )}
          </div>
          <button
            onClick={handleAnalyze}
            className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl bg-gradient-to-r from-[#00d4aa] to-[#1a8cff] text-[#0d1117] text-xs font-semibold hover:from-[#00e5b3] hover:to-[#4da6ff] transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-[#00d4aa]/10"
          >
            <Sparkles className="w-4 h-4" />
            开始 AI 深度分析
          </button>
        </div>
      </div>
    );
  }

  /* ===== 分析中 / 生成中 ===== */
  if (status === 'analyzing' || status === 'generating') {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-[#6e7681]">
        <div className="relative mb-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#00d4aa]/20 to-[#1a8cff]/20 flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-[#00d4aa]" />
          </div>
          <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-[#1a8cff] flex items-center justify-center">
            <Brain className="w-3 h-3 text-white" />
          </div>
        </div>
        <p className="text-sm font-medium text-[#e6edf3]">
          {status === 'analyzing' ? 'AI 深度分析中…' : 'AI 生成相似图片中…'}
        </p>
        <p className="text-[10px] mt-1">{status === 'analyzing' ? '正在提取光影、风格、主体等视觉特征' : '基于分析结果生成高度相似的参考图片'}</p>
      </div>
    );
  }

  /* ===== 错误状态 ===== */
  if (status === 'error' && !analysis) {
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <div className="w-12 h-12 rounded-full bg-[#f85149]/10 flex items-center justify-center mb-3">
          <AlertCircle className="w-6 h-6 text-[#f85149]" />
        </div>
        <p className="text-xs text-[#ff9b9b] mb-3 text-center max-w-[240px]">{error || '分析失败'}</p>
        <button
          onClick={handleRetry}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#21262d] text-[#c9d1d9] text-xs hover:bg-[#30363d] transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          重新分析
        </button>
      </div>
    );
  }

  if (!analysis) return null;

  /* ===== 分析结果面板 ===== */
  return (
    <div className="space-y-3">
      {/* 分析结果 */}
      <div className="rounded-xl bg-[#161b22] ring-1 ring-[#21262d] divide-y divide-[#21262d]">
        {/* 生成提示词（中英可切换） */}
        <div className="p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-medium text-[#e6edf3] flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-[#00d4aa]" />
              {displayLang === 'zh' ? '生成提示词（中文）' : 'Generation Prompt (English)'}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setDisplayLang(displayLang === 'zh' ? 'en' : 'zh')}
                className="flex items-center gap-0.5 text-[9px] text-[#1a8cff] hover:text-[#4da6ff] transition-colors px-1.5 py-0.5 rounded bg-[#1a8cff]/10"
                title={displayLang === 'zh' ? 'Switch to English' : '切换到中文'}
              >
                <Languages className="w-3 h-3" />
                {displayLang === 'zh' ? 'EN' : '中'}
              </button>
              <button
                onClick={() => handleCopy(displayLang === 'zh' ? (analysis.promptZh || analysis.compositePrompt) : (analysis.promptEn || analysis.compositePrompt), 'prompt')}
                className="flex items-center gap-1 text-[10px] text-[#8b949e] hover:text-[#00d4aa] transition-colors"
              >
                {copiedField === 'prompt' ? <Check className="w-3 h-3 text-[#00d4aa]" /> : <Copy className="w-3 h-3" />}
                {copiedField === 'prompt' ? '已复制' : '复制'}
              </button>
            </div>
          </div>
          <p className="text-[11px] text-[#c9d1d9] leading-relaxed">
            {displayLang === 'zh'
              ? (analysis.promptZh || analysis.compositePrompt)
              : (analysis.promptEn || analysis.compositePrompt)
            }
          </p>
          {analysis.analyzedAt ? (
            <div className="mt-1.5 flex items-center gap-1 text-[8px] text-[#484f58]">
              <History className="w-2.5 h-2.5" />
              {new Date(analysis.analyzedAt).toLocaleString()}
            </div>
          ) : null}
        </div>

        {/* 视觉特征网格 */}
        <div className="p-3">
          <span className="text-[10px] font-medium text-[#e6edf3] mb-2 block">视觉特征解析</span>
          <div className="grid grid-cols-2 gap-2">
            {[
              { icon: <ImageIcon className="w-3 h-3" />, label: '主体', value: analysis.subject, color: '#00d4aa' },
              { icon: <Eye className="w-3 h-3" />, label: '场景', value: analysis.scene, color: '#1a8cff' },
              { icon: <Palette className="w-3 h-3" />, label: '风格', value: analysis.style, color: '#f59e0b' },
              { icon: <Sun className="w-3 h-3" />, label: '光影', value: analysis.lighting, color: '#ff6b35' },
              { icon: <Camera className="w-3 h-3" />, label: '视角', value: analysis.camera, color: '#a855f7' },
              { icon: <Heart className="w-3 h-3" />, label: '氛围', value: analysis.mood, color: '#ef4444' },
            ].map(({ icon, label, value, color }) => (
              <div
                key={label}
                className="rounded-lg bg-[#0d1117] p-2 border border-[#21262d]"
              >
                <div className="flex items-center gap-1 mb-1">
                  <span style={{ color }}>{icon}</span>
                  <span className="text-[9px] text-[#6e7681]">{label}</span>
                </div>
                <p className="text-[10px] text-[#c9d1d9] leading-snug">{value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* 关键词 + 调色板 */}
        <div className="p-3">
          {analysis.keywords.length > 0 && (
            <div className="mb-2">
              <span className="text-[10px] text-[#6e7681] mb-1.5 block">关键词</span>
              <div className="flex flex-wrap gap-1">
                {analysis.keywords.map((kw) => (
                  <span key={kw} className="px-1.5 py-0.5 rounded-md bg-[#0d1117] text-[#8b949e] text-[9px] border border-[#21262d]">
                    {kw}
                  </span>
                ))}
              </div>
            </div>
          )}
          {analysis.palette.length > 0 && (
            <div>
              <span className="text-[10px] text-[#6e7681] mb-1.5 block">调色板</span>
              <div className="flex gap-1.5">
                {analysis.palette.map((color, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <div
                      className="w-5 h-5 rounded-md ring-1 ring-[#30363d]"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-[9px] text-[#6e7681]">{color}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={handleGenerateSimilar}
          className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-gradient-to-r from-[#00d4aa] to-[#00b894] text-[#07110e] text-[11px] font-semibold hover:from-[#00e5b3] hover:to-[#00d4aa] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Wand2 className="w-3.5 h-3.5" />
          生成相似图片
        </button>
        <button
          onClick={handleAnalyze}
          className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-[#21262d] text-[#c9d1d9] text-[11px] font-medium hover:bg-[#30363d] transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          重新分析
        </button>
      </div>

      {/* 生成的相似图片 */}
      {variants.length > 0 && (
        <div className="rounded-xl bg-[#161b22] ring-1 ring-[#21262d] p-3">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="w-3.5 h-3.5 text-[#f59e0b]" />
            <span className="text-[10px] font-medium text-[#e6edf3]">AI 生成的相似图片</span>
            <span className="text-[9px] text-[#00d4aa] bg-[#00d4aa]/10 px-1 rounded ml-auto">Pollinations · 免Key</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {variants.map((variant, i) => (
              <div
                key={variant.id}
                className="rounded-lg overflow-hidden bg-[#0d1117] ring-1 ring-[#21262d]"
              >
                <div className="aspect-square relative">
                  {variant.status === 'generating' || variant.status === 'pending' ? (
                    <div className="flex items-center justify-center w-full h-full">
                      <Loader2 className="w-6 h-6 animate-spin text-[#6e7681]" />
                    </div>
                  ) : variant.status === 'done' && variant.loadedUrl ? (
                    <>
                      <img
                        src={variant.loadedUrl}
                        alt={`变体 ${i + 1}`}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                      <button
                        onClick={() => onGeneratedImage?.(variant.loadedUrl!, variant.prompt)}
                        className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity bg-black/50"
                      >
                        <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[#00d4aa]/85 text-[#07110e] text-[10px] font-medium">
                          <Plus className="w-3 h-3" /> 导入
                        </span>
                      </button>
                    </>
                  ) : (
                    <div className="flex flex-col items-center justify-center w-full h-full text-[#f85149]/60 px-1 text-center">
                      <AlertCircle className="w-5 h-5" />
                      <span className="text-[9px] mt-1">失败</span>
                      {variant.error && (
                        <span className="text-[8px] text-[#f85149]/70 mt-0.5 leading-tight">{variant.error}</span>
                      )}
                      <button
                        onClick={() => handleRetryVariant(variant.id)}
                        className="mt-1 flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[#f85149]/15 text-[#ff9b9b] text-[8px] hover:bg-[#f85149]/25"
                      >
                        <RefreshCw className="w-2.5 h-2.5" /> 重试
                      </button>
                    </div>
                  )}

                  {/* 状态标签 */}
                  {variant.status === 'done' && (
                    <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/60 text-[#00d4aa] text-[8px]">
                      变体 {i + 1}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 技术信息 */}
      <div className="text-[9px] text-[#6e7681] px-1 flex items-center justify-between">
        <span>分析引擎：{analysis.engine}</span>
        <span>模型：{analysis.provider}/{analysis.model}</span>
      </div>

      {error && (
        <div className="rounded-lg bg-[#f85149]/10 border border-[#f85149]/20 px-3 py-2 text-[10px] text-[#ff9b9b] flex items-start gap-1.5">
          <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
          {error}
        </div>
      )}
    </div>
  );
}
