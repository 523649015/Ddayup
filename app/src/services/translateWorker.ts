/**
 * 翻译 Web Worker：在独立线程加载 NLLB 模型并执行推理，
 * 主线程（图片/视频节点的「自动翻译」按钮）发送消息后不会被阻塞，
 * 长提示词翻译时 UI 依旧流畅。
 *
 * 复用 translateCore.ts 的核心逻辑（createTranslator / translateWith），
 * 保证主线程回退与 Worker 路径逻辑单一来源。
 */

import { createTranslator, translateWith, type Lang } from './translateCore';

let translator: unknown = null;
let loadPromise: Promise<void> | null = null;

function post(msg: Record<string, unknown>) {
  // eslint-disable-next-line no-restricted-globals
  (self as unknown as Worker).postMessage(msg);
}

function ensureTranslator(): Promise<void> {
  if (translator) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = createTranslator((p: number) => {
    post({ type: 'progress', value: p });
  })
    .then((t) => {
      translator = t;
    })
    .catch((e) => {
      loadPromise = null;
      throw e;
    });
  return loadPromise;
}

self.onmessage = async (event: MessageEvent) => {
  const data = event.data as {
    type: 'load' | 'translate' | 'release';
    id?: number;
    text?: string;
    lang?: Lang;
  };

  try {
    switch (data.type) {
      case 'load':
        await ensureTranslator();
        post({ type: 'loaded' });
        break;

      case 'translate': {
        await ensureTranslator();
        if (!translator) {
          post({ type: 'error', id: data.id, error: '翻译模型未就绪' });
          return;
        }
        const text = typeof data.text === 'string' ? data.text : '';
        const lang: Lang = data.lang === 'zh' || data.lang === 'en' ? data.lang : 'zh';
        const out = await translateWith(translator, text, lang);
        post({ type: 'result', id: data.id, text: out });
        break;
      }

      case 'release':
        translator = null;
        loadPromise = null;
        post({ type: 'released' });
        break;

      default:
        break;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (data.type === 'translate') {
      post({ type: 'error', id: data.id, error: message });
    } else {
      post({ type: 'error', error: message });
    }
  }
};

export {};
