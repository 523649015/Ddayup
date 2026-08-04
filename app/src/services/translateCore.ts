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

  // onnxruntime-web 的 wasm 路径必须区分 dev / 生产：
  //   - dev 模式：@xenova/transformers 2.17.2 走 src/transformers.js →
  //     src/backends/onnx.js → `import 'onnxruntime-web'`。Vite 解析到项目装的
  //     onnxruntime-web 1.27.0（不是 transformers 自带的 1.14.0）。
  //     1.27.0 的 wasm 是外置的，必须从同源静态路径加载——本项目是 /ort-wasm/。
  //   - 生产模式：translateCore 走 /api/transformers/transformers.min.js，
  //     该文件是 webpack 自包含包（带 onnxruntime-web 1.14.0 + 内嵌 wasm），
  //     wasm 也由该路径同源提供。
  // 关键：@xenova/transformers 2.17.2 的 src/env.js 会在模块加载时立即把
  //   onnx_env.wasm.wasmPaths 覆盖为 jsdelivr CDN（在浏览器下 RUNNING_LOCALLY=false）。
  // 我们这里再覆盖一次，指向正确的同源路径。
  // 同时强制单线程（numThreads=1），原因：
  //   1) onnxruntime-web 1.27.0 在 numThreads>1 时会通过 PThread Worker 派生
  //      ort-wasm-simd-threaded.jsep.mjs / jspi.mjs / .asyncify.mjs。
  //      这些文件在 public/ort-wasm/ 下，Vite dev 模式 transform pipeline 会拦截并报
  //      "This file is in /public and will be copied as-is during build" 错误。
  //   2) Vite 7 的 ortWasmBypass 中间件虽然注册了，但只在 transformRequest 之外
  //      拦截 HTTP 请求，对 Vite 内部的 transformRequest 流程不生效（这正是浏览器
  //      报 "Failed to load url /ort-wasm/ort-wasm-simd-threaded.jsep.mjs" 的根因）。
  //   3) 单线程走 ort-wasm-simd-threaded.mjs（不带 jsep/jspi/asyncify 后缀），
  //      Vite 不会触发子模块 transform，避免整个错误链。
  //   4) NLLB 翻译是串行解码（每 token 都要上一步的 hidden state），多线程加速有限，
  //      单线程对翻译延迟影响可忽略。
  const isDev = Boolean((import.meta as any).env?.DEV);
  const wasmBase = isDev ? '/ort-wasm/' : `${origin}/api/transformers/`;
  env.backends = env.backends || {};
  env.backends.onnx = env.backends.onnx || {};
  env.backends.onnx.wasm = env.backends.onnx.wasm || {};
  env.backends.onnx.wasm.wasmPaths = wasmBase;
  env.backends.onnx.wasm.numThreads = 1; // 强制单线程，避免 Vite 拦截 jsep/jspi 子 Worker
  // proxy 关闭：onnxruntime-web 默认会从远程拉取 .mjs 文件（在我们这里会失败），
  // 关掉后所有 wasm 路径都从 wasmPaths 解析。
  env.backends.onnx.wasm.proxy = false;
  env.logLevel = 'error';

  // 运行时诊断：把 ORT 实际看到的 wasm 配置 POST 回 dev 服务器（/api/diag），
  // 用于确认 wasmPaths 覆盖是否真的生效（中国网络下若回退到 jsdelivr CDN 会失败）。
  try {
    const wasm = env.backends?.onnx?.wasm ?? {};
    const diag = {
      wasmPaths: wasm.wasmPaths,
      numThreads: wasm.numThreads,
      proxy: wasm.proxy,
      dev: Boolean((import.meta as any).env?.DEV),
      origin: getCurrentOrigin(),
      ua: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    };
    fetch('/api/diag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(diag),
    }).catch(() => {});
  } catch {
    /* noop */
  }


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
