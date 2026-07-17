/**
 * 本地翻译核心逻辑（主线程与 Web Worker 共用）。
 *
 * 该模块不包含任何 DOM / Worker 专属 API，只负责：
 *   - 加载 Transformers.js 运行时（开发走 Vite / 生产走同源 /api/transformers）
 *   - 创建 NLLB 翻译 pipeline
 *   - 长文本分块翻译（降低单次推理长度，提升吞吐并降低卡顿）
 *
 * 把推理放进 Web Worker（见 translateWorker.ts）即可让主线程在翻译时不冻结，
 * 从而满足「翻译过程异步非阻塞」的需求；主线程回退路径（无 Worker 环境，
 * 如测试 / 老浏览器）也复用本文件，保证逻辑单一来源。
 */

export const MODEL_NAME = 'Xenova/nllb-200-distilled-600M';

export const LANG_MAP = {
  zh: { src: 'zho_Hans', tgt: 'eng_Latn' },
  en: { src: 'eng_Latn', tgt: 'zho_Hans' },
} as const;

export type Lang = 'zh' | 'en';

type TranslateProgress = (value: number) => void;

function getCurrentOrigin(): string {
  try {
    if (typeof self !== 'undefined' && (self as any).location?.origin) {
      return (self as any).location.origin;
    }
  } catch {
    /* noop */
  }
  if (typeof location !== 'undefined' && location.origin) return location.origin;
  return '';
}

export async function loadTransformersModule(): Promise<{
  pipeline: (...args: unknown[]) => Promise<unknown>;
  env: Record<string, any>;
}> {
  let mod: Record<string, any> | undefined;
  const isDev = Boolean((import.meta as any).env?.DEV);
  if (isDev) {
    mod = await import('@xenova/transformers');
  } else {
    const url = `${getCurrentOrigin()}/api/transformers/transformers.min.js`;
    mod = await import(/* @vite-ignore */ url);
  }
  if (!mod || typeof mod.pipeline !== 'function') {
    throw new Error(
      'Transformers.js 模块加载失败：未找到 pipeline 导出。' +
      '请检查本地服务（/api/transformers）是否可访问，或尝试刷新页面后重试。'
    );
  }
  return mod as { pipeline: (...args: unknown[]) => Promise<unknown>; env: Record<string, any> };
}

export async function createTranslator(onProgress?: TranslateProgress): Promise<unknown> {
  const { pipeline, env } = await loadTransformersModule();

  env.allowLocalModels = false;
  env.useBrowserCache = true;
  const origin = getCurrentOrigin();
  env.remoteHost = origin ? `${origin}/api/hf-proxy` : 'https://huggingface.co';
  env.remotePathTemplate = '{model}/resolve/{revision}';

  // 同源提供 onnxruntime-web 的 wasm（/api/transformers 由后端同源托管），
  // 避免浏览器直连外国 CDN（cdnjs.cloudflare.net / cdn.jsdelivr.net）下载 wasm 失败。
  env.backends = env.backends || {};
  env.backends.onnx = env.backends.onnx || {};
  env.backends.onnx.wasm = env.backends.onnx.wasm || {};
  env.backends.onnx.wasm.wasmPaths = `${origin}/api/transformers/`;
  // 启用多线程 wasm 推理（若后端 /api/transformers 提供了 *-threaded wasm 则生效，
  // 否则 ONNX Runtime 自动回退到单线程，不影响正确性），可显著加速长文本解码。
  try {
    const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
    env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(4, hw));
  } catch {
    /* noop */
  }
  env.logLevel = 'error';

  const translator = await pipeline('translation', MODEL_NAME, {
    progress_callback: (p: number) => {
      if (onProgress) onProgress(p);
    },
  });
  return translator;
}

/**
 * 把超长提示词切成较小片段，避免单次 ONNX 推理因序列过长而耗时过久。
 * 优先级：按换行 → 再按中英文标点切分，单段上限约 400 字符。
 */
export function chunkText(text: string): string[] {
  const maxLen = 400;
  const trimmed = (text || '').trim();
  if (!trimmed) return [text || ''];
  if (trimmed.length <= maxLen) return [trimmed];

  const lines = trimmed.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const chunks: string[] = [];

  const pushSegment = (segment: string) => {
    if (!segment) return;
    if (segment.length <= maxLen) {
      chunks.push(segment);
      return;
    }
    const segs = segment.split(/(?<=[。.!?！？；;，,])/);
    let buf = '';
    for (const seg of segs) {
      if ((buf + seg).length > maxLen) {
        if (buf) chunks.push(buf);
        buf = seg;
      } else {
        buf += seg;
      }
    }
    if (buf) chunks.push(buf);
  };

  for (const line of lines) pushSegment(line);
  return chunks.length ? chunks : [trimmed];
}

export async function translateWith(
  translator: unknown,
  text: string,
  lang: Lang,
): Promise<string> {
  const map = LANG_MAP[lang];
  const chunks = chunkText(text);
  const out: string[] = [];

  for (const chunk of chunks) {
    // 关键性能修复：未设置 max_new_tokens 时，NLLB 解码器会一路生成到模型默认上限
    // （约 256 token）。50 词长提示在 WASM CPU 上逐 token 解码正是「翻译需一两分钟」的根因。
    // 这里按输入长度给出紧凑上限（中英混合按字符估算），既保证译文完整又大幅缩短解码时间。
    const maxNewTokens = Math.min(
      256,
      Math.max(40, Math.round(chunk.length / 2) + 16),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (translator as any)(chunk, {
      src_lang: map.src,
      tgt_lang: map.tgt,
      max_new_tokens: maxNewTokens,
    });

    let translated: string;
    if (Array.isArray(res)) {
      translated = res[0]?.translation_text || chunk;
    } else if (typeof res === 'string') {
      translated = res;
    } else if (res && typeof res === 'object' && 'translation_text' in res) {
      translated = (res as { translation_text: string }).translation_text;
    } else {
      translated = chunk;
    }
    out.push(translated);
  }

  return out.join('\n');
}
