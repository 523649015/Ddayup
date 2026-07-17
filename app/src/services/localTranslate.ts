/**
 * 本地浏览器端翻译服务（Transformers.js + NLLB-200 模型）
 * 无需 API Key，模型首次下载后缓存于浏览器 IndexedDB。
 *
 * 架构：
 *   ├── 优先本地 NLLB 模型（zh↔en 双向）
 *   └── 降级到远端 LLM API（需 API Key）
 *
 * 性能：模型加载与推理默认在 Web Worker（translateWorker.ts）中执行，
 * 主线程在翻译长提示词时不被阻塞，保障 UI 流畅。
 * 不支持 Worker 的环境（如 jsdom 测试 / 老浏览器）自动回退到主线程，
 * 复用同一份核心逻辑（translateCore.ts）。
 */

import { createTranslator, translateWith, MODEL_NAME, type Lang } from './translateCore';

type TranslateState = {
  status: 'idle' | 'downloading' | 'ready' | 'error';
  progress: number; // 0-100
  error: string | null;
  modelName: string;
};

type TranslateListener = (state: TranslateState) => void;

const MODEL_DESC = '自动翻译提示词（中↔英），无需 API Key';

let currentState: TranslateState = {
  status: 'idle',
  progress: 0,
  error: null,
  modelName: MODEL_NAME,
};

/** 本地模型插件元数据（供模型面板展示） */
export interface LocalModelPlugin {
  id: string;
  name: string;
  description: string;
  size: string;
  source: string;
  status: 'idle' | 'downloading' | 'ready' | 'error';
  progress: number;
  error: string | null;
  canUpdate: boolean;
}

export const MODEL_PLUGINS: LocalModelPlugin[] = [
  {
    id: 'nllb-200-translation',
    name: 'NLLB-200 翻译模型',
    description: MODEL_DESC,
    size: '~600MB',
    source: 'Hugging Face Hub',
    status: 'idle',
    progress: 0,
    error: null,
    canUpdate: false,
  },
];

// ── 加载/翻译状态 ──
let wasManuallyPaused = false;
let loadOnce: Promise<boolean> | null = null;
let loadResolve: ((v: boolean) => void) | null = null;
let translatorMain: unknown = null; // 主线程回退时使用
const pending = new Map<number, { resolve: (s: string) => void; reject: (e: unknown) => void }>();
let msgId = 0;
let worker: Worker | null = null;
const useWorker = typeof Worker !== 'undefined';

const listeners = new Set<TranslateListener>();

function syncModelPlugins() {
  const plugin = MODEL_PLUGINS[0];
  plugin.status = currentState.status;
  plugin.progress = currentState.progress;
  plugin.error = currentState.error;
  // canUpdate 由 checkForModelUpdates / saveInstalledRevision 独立管理
}

function setState(patch: Partial<TranslateState>) {
  currentState = { ...currentState, ...patch };
  syncModelPlugins();
  listeners.forEach((fn) => fn(currentState));
}

/** 订阅翻译模型加载状态变化 */
export function onLocalTranslateStateChange(fn: TranslateListener): () => void {
  listeners.add(fn);
  fn(currentState);
  return () => {
    listeners.delete(fn);
  };
}

/** 获取当前加载状态快照 */
export function getLocalTranslateState(): Readonly<TranslateState> {
  return currentState;
}

function formatLoadError(raw: string): string {
  if (raw.includes('Failed to fetch') || raw.includes('NetworkError')) {
    return (
      '模型下载失败：无法访问 Hugging Face Hub（已优先使用国内镜像 hf-mirror.com）。' +
      '请检查网络后重试，或在 API 密钥页面配置硅基流动密钥作为备选方案。'
    );
  }
  if (raw.includes('offset is out of bounds')) {
    return (
      '本地翻译模型加载失败：模型缓存文件已损坏（offset is out of bounds）。' +
      '已自动清理浏览器模型缓存，请重新点击「翻译」重新下载。'
    );
  }
  return `本地翻译模型加载失败：${raw}`;
}

/** 清除 Transformers.js 在 IndexedDB 中的模型缓存（库名默认 transformers-cache）。
 *  当模型下载被截断/损坏时（典型报错 offset is out of bounds），需清掉坏缓存再重下。 */
async function clearTransformersCache(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('transformers-cache');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  } catch {
    /* noop */
  }
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./translateWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent) => onWorkerMessage(event.data);
    worker.onerror = (event: ErrorEvent) => {
      if (currentState.status === 'downloading') {
        const m = `翻译 Worker 异常：${event.message || 'unknown'}`;
        const formatted = formatLoadError(m);
        setState({ status: 'error', error: formatted });
        loadResolve && loadResolve(false);
      }
    };
  }
  return worker;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onWorkerMessage(msg: any) {
  switch (msg?.type) {
    case 'progress':
      if (currentState.status === 'downloading' || currentState.status === 'idle') {
        setState({
          status: 'downloading',
          progress: Math.min(99, 10 + Math.round((msg.value || 0) * 0.89)),
        });
      }
      break;
    case 'loaded':
      setState({ status: 'ready', progress: 100 });
      markInstalled();
      saveInstalledRevision().catch(() => {});
      loadResolve && loadResolve(true);
      break;
    case 'result': {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.resolve(msg.text);
      }
      break;
    }
    case 'released':
      break;
    case 'error':
      if (msg.id != null) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.reject(new Error(msg.error));
        }
      } else {
        const formatted = formatLoadError(msg.error);
        if (formatted.includes('offset is out of bounds')) {
          clearTransformersCache().catch(() => {});
        }
        setState({ status: 'error', error: formatted });
        loadResolve && loadResolve(false);
      }
      break;
    default:
      break;
  }
}

/** 初始化/确保翻译模型已加载（Worker 或主线程回退） */
export async function ensureTranslatorLoaded(): Promise<boolean> {
  if (currentState.status === 'ready') return true;
  if (loadOnce) return loadOnce;

  setState({ status: 'downloading', progress: wasManuallyPaused ? currentState.progress : 0, error: null });

  loadOnce = new Promise<boolean>((resolve) => {
    loadResolve = resolve;
    const timer = setTimeout(() => {
      const m =
        '模型下载超时（10分钟）：Hugging Face Hub 可能无法访问。请检查网络，' +
        '或在 API 密钥页面配置硅基流动密钥作为备选方案。';
      setState({ status: 'error', error: m });
      loadResolve && loadResolve(false);
    }, 600000);

    const finishReady = () => {
      clearTimeout(timer);
      setState({ status: 'ready', progress: 100 });
      markInstalled();
      saveInstalledRevision().catch(() => {});
      loadResolve && loadResolve(true);
    };
    const finishError = (raw: string) => {
      clearTimeout(timer);
      const m = formatLoadError(raw);
      if (m.includes('offset is out of bounds')) {
        clearTransformersCache().catch(() => {});
      }
      setState({ status: 'error', error: m });
      loadResolve && loadResolve(false);
    };

    try {
      if (useWorker) {
        getWorker().postMessage({ type: 'load' });
      } else {
        createTranslator((p: number) =>
          setState({ status: 'downloading', progress: Math.min(99, 10 + Math.round((p || 0) * 0.89)) }),
        )
          .then((t) => {
            translatorMain = t;
            finishReady();
          })
          .catch((e) => finishError(e instanceof Error ? e.message : String(e)));
      }
    } catch (e) {
      finishError(e instanceof Error ? e.message : String(e));
    }
  });

  return loadOnce;
}

/** 执行本地翻译（Worker 或主线程回退，均异步非阻塞主线程 UI） */
export async function localTranslate(text: string, sourceLang: Lang): Promise<string> {
  const loaded = await ensureTranslatorLoaded();
  if (!loaded) {
    throw new Error(currentState.error || '本地翻译模型未就绪');
  }

  try {
    if (useWorker) {
      const id = ++msgId;
      return await new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        getWorker().postMessage({ type: 'translate', id, text, lang: sourceLang });
      });
    }
    if (!translatorMain) throw new Error('翻译模型未就绪');
    return await translateWith(translatorMain, text, sourceLang);
  } catch (e) {
    const m = e instanceof Error ? e.message : '';
    if (m.includes('offset is out of bounds')) {
      await clearTransformersCache().catch(() => {});
    }
    if (m.includes('Failed to fetch') || m.includes('NetworkError')) {
      throw new Error(
        '模型下载失败：无法访问 Hugging Face Hub（已优先使用国内镜像 hf-mirror.com）。' +
        '请检查网络后重试，或在 API 密钥页面配置硅基流动密钥作为备选方案。',
      );
    }
    if (m.includes('offset is out of bounds')) {
      throw new Error(
        '本地翻译模型加载失败：模型缓存文件已损坏（offset is out of bounds）。' +
        '已自动清理浏览器模型缓存，请重新点击「翻译」重新下载。',
      );
    }
    throw e;
  }
}

/** 暂停模型下载（仅标记；Worker 内模型已缓存于 IndexedDB，恢复后可快速重载） */
export function pauseDownload(): void {
  wasManuallyPaused = true;
}

/** 检查是否由用户手动暂停 */
export function getWasManuallyPaused(): boolean {
  return wasManuallyPaused;
}

/** 释放模型内存（可选，长时间不使用时调用） */
export async function releaseTranslator(): Promise<void> {
  if (worker) {
    try {
      worker.postMessage({ type: 'release' });
    } catch {
      /* noop */
    }
  }
  translatorMain = null;
  loadOnce = null;
  loadResolve = null;
  wasManuallyPaused = false;
  // 卸载/释放即视为移除本地安装（IndexedDB 缓存可能仍残留，但标记失效后
  // 下次 initInstalledState 会重新探测；若用户执行的是「卸载」则缓存也已被清空）。
  clearInstalledMarker();
  setState({ status: 'idle', progress: 0, error: null });
}

// ── 版本检查（主线程，直连 Hugging Face Hub API 仅做版本比对，失败静默） ──
const LS_KEY_REVISION = 'hmdao_nllb_revision';
// 网络无关的「已安装」标记：仅在模型真正加载成功后写入，
// 用于刷新后把面板状态从 idle 恢复为 ready（已安装），不依赖联网。
const LS_KEY_INSTALLED = 'hmdao_nllb_installed';

function markInstalled(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY_INSTALLED, MODEL_NAME);
  } catch {
    /* noop */
  }
}

function clearInstalledMarker(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LS_KEY_INSTALLED);
  } catch {
    /* noop */
  }
}

/**
 * 探测 Transformers.js 是否已将 NLLB 模型缓存到 IndexedDB。
 * 关键点：
 *  - 不依赖「仓库名/库名」去猜（旧版 transformers 缓存库名可能是 transformers-cache / transformers_cache / onnx…，
 *    且不同版本路径大小写不一），而是**按模型文件特征**判定：缓存键里只要出现
 *    decoder_model / encoder_model / tokenizer.json / config.json / .onnx 等 NLLB 专属文件签名，即视为已安装。
 *  - 候选库名：优先扫描 indexedDB.databases() 中所有含 transformers/cache/onnx/hf 等线索的库；
 *    若 databases() 不可用，则兜底直连一组已知典型库名。
 * 这是「已安装」判定的可靠依据：模型文件确实存在于本地缓存记录中。
 */
// NLLB 模型文件的强特征（与仓库名/大小写无关，命中任意一个即证明模型在本地）
const MODEL_FILE_SIGNATURES = [
  'decoder_model',
  'encoder_model',
  'tokenizer.json',
  'tokenizer_config.json',
  'config.json',
  '.onnx',
  'nllb-200',
  'xenova',
];

// 候选库名的线索词（databases() 可用时，只扫命中这些线索的库，避免误开无关库）
const DB_NAME_HINTS = ['transformers', 'cache', 'onnx', 'hf', 'hugging', 'xenova', 'nllb', 'model', 'ml'];
// databases() 不可用时的兜底库名（覆盖常见命名变体）
const DB_NAME_FALLBACK = [
  'transformers-cache',
  'transformers_cache',
  'transformers',
  'onnx-cache',
  'hf-cache',
  'huggingface',
];

// transformers.js v2 把模型权重缓存到浏览器 **Cache Storage（Cache API）**，
// 缓存名为 'transformers-cache'（见 node_modules/@xenova/transformers 的 caches.open('transformers-cache')），
// 键是模型文件 URL（含 onnx/tokenizer/config 等签名），并非 IndexedDB。
// 旧版检测只扫 IndexedDB，导致刷新后始终判定为「未安装」。这里补扫 Cache Storage。
const CACHE_NAME_HINTS = ['transformers', 'nllb', 'xenova', 'hf', 'hugging', 'model', 'onnx', 'cache'];

async function isModelCachedInCacheStorage(): Promise<boolean> {
  if (typeof caches === 'undefined' || typeof caches.keys !== 'function') return false;
  try {
    const allNames = await caches.keys();
    if (allNames.length === 0) return false;
    // 优先只扫命中线索的缓存，避免误开无关缓存；无命中则全扫兜底
    const names = allNames.filter((n) => CACHE_NAME_HINTS.some((h) => n.toLowerCase().includes(h)));
    const toScan = names.length ? names : allNames;
    for (const name of toScan) {
      const cache = await caches.open(name);
      const requests = await cache.keys();
      const hit = requests.some((req) =>
        MODEL_FILE_SIGNATURES.some((sig) => String(req.url).toLowerCase().includes(sig)),
      );
      if (hit) {
        // eslint-disable-next-line no-console
        console.info('[nllb-detect] ✅ 在 Cache Storage', name, '中找到 NLLB 模型缓存 → 判定为已安装');
        return true;
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[nllb-detect] 读取 Cache Storage 失败（模型可能仍可用，但无法据此判定已安装）：', e);
  }
  return false;
}

async function isModelCachedInIndexedDB(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;

  const dbNames: string[] = [];
  if (typeof indexedDB.databases === 'function') {
    try {
      const list = await indexedDB.databases();
      for (const db of list) {
        if (!db?.name) continue;
        const n = db.name.toLowerCase();
        if (DB_NAME_HINTS.some((h) => n.includes(h))) dbNames.push(db.name);
      }
    } catch {
      /* noop */
    }
  }
  // 兜底：databases() 不可用，直连已知典型库名
  if (dbNames.length === 0) dbNames.push(...DB_NAME_FALLBACK);

  const looksLikeModel = (k: unknown): boolean => {
    const s = String(k).toLowerCase();
    return MODEL_FILE_SIGNATURES.some((sig) => s.includes(sig));
  };

  const probeDB = (name: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      try {
        const open = indexedDB.open(name);
        open.onerror = () => resolve(false);
        // 未指定版本时理论上不会触发升级；若触发则立即关闭，绝不破坏库结构
        open.onupgradeneeded = () => {
          try {
            open.transaction?.abort?.();
          } catch {
            /* noop */
          }
          resolve(false);
        };
        open.onsuccess = () => {
          const idb = open.result;
          const finish = (hit: boolean) => {
            try {
              idb.close();
            } catch {
              /* noop */
            }
            resolve(hit);
          };
          try {
            const storeNames = Array.from(idb.objectStoreNames);
            if (storeNames.length === 0) return finish(false);
            let pending = storeNames.length;
            let found = false;
            for (const store of storeNames) {
              try {
                const tx = idb.transaction(store, 'readonly');
                const req = tx.objectStore(store).getAllKeys();
                req.onsuccess = () => {
                  if (!found && (req.result as unknown[]).some(looksLikeModel)) found = true;
                  if (--pending === 0) finish(found);
                };
                req.onerror = () => {
                  if (--pending === 0) finish(found);
                };
              } catch {
                if (--pending === 0) finish(found);
              }
            }
          } catch {
            finish(false);
          }
        };
      } catch {
        resolve(false);
      }
    });

  // 诊断日志：直接输出到控制台，便于在 3000 端排查「仍显示未安装」时看到扫描了哪些库。
  // eslint-disable-next-line no-console
  console.info('[nllb-detect] 扫描 IndexedDB 候选库:', dbNames);
  for (const name of dbNames) {
    if (await probeDB(name)) {
      // eslint-disable-next-line no-console
      console.info('[nllb-detect] ✅ 在', name, '中找到 NLLB 模型缓存 → 判定为已安装');
      return true;
    }
  }
  // eslint-disable-next-line no-console
  console.warn('[nllb-detect] ⚠️ 未在任何 IndexedDB 中找到 NLLB 模型缓存文件（decoder_model/.onnx/tokenizer.json 等）。继续检查 Cache Storage…');
  return false;
}

// 综合判定：IndexedDB 或 Cache Storage 任一命中即视为已安装（transformers.js v2 实际用 Cache Storage）。
async function isModelCachedLocally(): Promise<boolean> {
  if (await isModelCachedInIndexedDB()) return true;
  if (await isModelCachedInCacheStorage()) return true;
  return false;
}

/**
 * 模块加载时（含页面刷新）执行一次：直接读取 IndexedDB 中真实的模型缓存记录来判定「已安装」。
 * 这样即便是旧版本代码安装的模型（只有缓存、没有写入 localStorage 标记），刷新后也能被自动识别，
 * 面板正确显示「已安装 / 禁用」而非「下载」；并在后台预热 Worker（从缓存读取，不重新下载）。
 * 若缓存已丢失（如用户清过站点数据），则清除失效标记，回退到未安装态。
 */
export async function initInstalledState(): Promise<void> {
  const cached = await isModelCachedLocally();
  if (cached) {
    // 写回标记，便于后续快速判定；同时立即置为 ready
    markInstalled();
    setState({ status: 'ready', progress: 100, error: null });
    if (useWorker) {
      try {
        getWorker().postMessage({ type: 'load' });
      } catch {
        /* noop */
      }
    }
    return;
  }
  // 缓存不存在：若之前写过标记，说明是失效标记，清除之
  clearInstalledMarker();
}

/** 供面板「重新检测」按钮调用：强制按 IndexedDB 实际记录重新判定已安装状态。 */
export const recheckInstalled = initInstalledState;
// 刷新后立即恢复已安装状态（异步、非阻塞）
void initInstalledState();

export async function checkForModelUpdates(): Promise<void> {
  try {
    const resp = await fetch('https://huggingface.co/api/models/Xenova/nllb-200-distilled-600M', {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return;
    const info = (await resp.json()) as { sha?: string };
    const latestSha = info.sha;
    if (!latestSha) return;

    const installedSha = localStorage.getItem(LS_KEY_REVISION);
    if (installedSha && installedSha !== latestSha) {
      MODEL_PLUGINS[0].canUpdate = true;
      listeners.forEach((fn) => fn(currentState));
    }
  } catch {
    // 更新检查可选，静默失败
  }
}

async function saveInstalledRevision(): Promise<void> {
  try {
    const resp = await fetch('https://huggingface.co/api/models/Xenova/nllb-200-distilled-600M', {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return;
    const info = (await resp.json()) as { sha?: string };
    if (info.sha) {
      localStorage.setItem(LS_KEY_REVISION, info.sha);
      MODEL_PLUGINS[0].canUpdate = false;
    }
  } catch {
    // 静默失败
  }
}

// 导出类型，供面板展示
export type { LocalModelPlugin, TranslateState };
