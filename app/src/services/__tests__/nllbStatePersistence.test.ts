/**
 * 问题 1：NLLB-200 模型状态缓存持久化 测试
 *
 * 复现并验证的 Bug：已下载安装的模型在页面刷新后，下载面板仍显示「下载/安装」按钮。
 * 根因：状态在模块加载时被重置为 idle，没有网络无关的「已安装」持久化标记回填。
 *
 * 覆盖：
 *   ✅ 模型加载成功后写入「已安装」标记（localStorage: hmdao_nllb_installed）
 *   ✅ releaseTranslator（卸载/释放）清除「已安装」标记
 *   ✅ 刷新恢复：标记存在 + IndexedDB 确有缓存 → 状态回填为 ready（按钮显示「已安装」）
 *   ✅ 失效清理：标记存在但 IndexedDB 无缓存 → 清除失效标记，回退未安装（显示「下载」）
 *   ✅ 无「已安装」标记但 IndexedDB 确有模型缓存 → 自动识别为 ready（修复旧版安装刷新后仍显示未安装）
 *   ✅ 无标记且无缓存 → 保持 idle
 *   ✅ indexedDB 不可用（undefined）时安全回退，不崩溃
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const MODEL_NAME = 'Xenova/nllb-200-distilled-600M';
const LS_KEY_INSTALLED = 'hmdao_nllb_installed';

// 拦截 @xenova/transformers 的动态导入，避免真实包拉起 sharp 原生模块
const transformersLib = vi.hoisted(() => ({ pipeline: vi.fn() }));
vi.mock('@xenova/transformers', () => ({
  pipeline: transformersLib.pipeline,
  env: {},
}));

/** 模拟一个成功的 Transformers.js pipeline（主线程回退路径使用） */
function mockPipeline() {
  return vi.fn(async (_task: string, _model: string, opts?: any) => {
    if (opts?.progress_callback) opts.progress_callback(100);
    return async (text: string) => [{ translation_text: `[en] ${text}` }];
  });
}

/**
 * 构造一个最小可用的 fake indexedDB，满足 isModelCachedInIndexedDB 的调用序列：
 *   databases() → open(name) → objectStoreNames → transaction/objectStore/getAllKeys → close()
 */
function makeFakeIndexedDB(opts: { dbName?: string; keys?: string[] } = {}) {
  const dbName = opts.dbName ?? 'transformers-cache';
  const keys = opts.keys ?? [];
  const idb = {
    objectStoreNames: ['keyvaluepairs'] as unknown as DOMStringList,
    transaction() {
      return {
        objectStore() {
          return {
            getAllKeys() {
              const req: any = {};
              setTimeout(() => {
                req.result = keys;
                req.onsuccess && req.onsuccess();
              }, 0);
              return req;
            },
          };
        },
      };
    },
    close() {},
  };
  return {
    databases: async () => [{ name: dbName, version: 1 }],
    open(name?: string) {
      const req: any = {};
      setTimeout(() => {
        // 模拟真实浏览器：打开不存在 / 名称不符的库会触发 onerror
        if (name !== dbName) {
          req.onerror && req.onerror();
          return;
        }
        req.result = idb;
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
    deleteDatabase() {
      const req: any = {};
      setTimeout(() => {
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  } as unknown as IDBFactory;
}

/** 重新加载 localTranslate 模块（模拟页面刷新时的模块重新求值） */
async function freshImport() {
  vi.resetModules();
  return import('@/services/localTranslate');
}

beforeEach(() => {
  transformersLib.pipeline.mockReset();
  try {
    localStorage.clear();
  } catch {
    /* noop */
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('问题1：NLLB-200 状态持久化', () => {
  // ── 1. 加载成功后写入已安装标记 ──
  it('模型加载成功后写入「已安装」标记', async () => {
    vi.stubGlobal('indexedDB', makeFakeIndexedDB({ keys: [] }));
    const mod = await freshImport();

    transformersLib.pipeline.mockImplementation(mockPipeline());
    const ok = await mod.ensureTranslatorLoaded();

    expect(ok).toBe(true);
    expect(mod.getLocalTranslateState().status).toBe('ready');
    expect(localStorage.getItem(LS_KEY_INSTALLED)).toBe(MODEL_NAME);
  });

  // ── 2. 释放/卸载清除标记 ──
  it('releaseTranslator（卸载）清除「已安装」标记并回到 idle', async () => {
    vi.stubGlobal('indexedDB', makeFakeIndexedDB({ keys: [] }));
    const mod = await freshImport();

    transformersLib.pipeline.mockImplementation(mockPipeline());
    await mod.ensureTranslatorLoaded();
    expect(localStorage.getItem(LS_KEY_INSTALLED)).toBe(MODEL_NAME);

    await mod.releaseTranslator();
    expect(localStorage.getItem(LS_KEY_INSTALLED)).toBeNull();
    expect(mod.getLocalTranslateState().status).toBe('idle');
  });

  // ── 3. 刷新恢复：标记 + 缓存存在 → ready（核心 Bug 修复验证） ──
  it('刷新后：标记存在且 IndexedDB 确有缓存 → 状态恢复为 ready（面板显示「已安装」）', async () => {
    localStorage.setItem(LS_KEY_INSTALLED, MODEL_NAME);
    vi.stubGlobal(
      'indexedDB',
      makeFakeIndexedDB({
        dbName: 'transformers-cache',
        keys: [
          'https://huggingface.co/Xenova/nllb-200-distilled-600M/resolve/main/onnx/encoder_model_quantized.onnx',
        ],
      }),
    );

    const mod = await freshImport();
    // 显式 await（自动执行的 void initInstalledState() 是 fire-and-forget，测试需确定性等待）
    await mod.initInstalledState();

    expect(mod.getLocalTranslateState().status).toBe('ready');
    expect(mod.getLocalTranslateState().progress).toBe(100);
    expect(mod.MODEL_PLUGINS[0].status).toBe('ready');
    // 标记保留（模型仍安装）
    expect(localStorage.getItem(LS_KEY_INSTALLED)).toBe(MODEL_NAME);
  });

  // ── 4. 失效清理：标记存在但缓存已丢失 → 清标记、回 idle ──
  it('刷新后：标记存在但 IndexedDB 无该模型缓存 → 清除失效标记并回退未安装', async () => {
    localStorage.setItem(LS_KEY_INSTALLED, MODEL_NAME);
    vi.stubGlobal(
      'indexedDB',
      makeFakeIndexedDB({ dbName: 'transformers-cache', keys: ['some-other-unrelated-key'] }),
    );

    const mod = await freshImport();
    await mod.initInstalledState();

    expect(mod.getLocalTranslateState().status).toBe('idle');
    expect(localStorage.getItem(LS_KEY_INSTALLED)).toBeNull();
  });

  // ── 5. 无标记但 IndexedDB 确有缓存：旧代码安装的模型也能被自动识别 ──
  it('刷新后：无「已安装」标记但 IndexedDB 确有模型缓存 → 自动识别为 ready（这正是「旧版安装的模型刷新后还显示未安装」的修复）', async () => {
    // 注意：localStorage 没有任何标记（旧版本代码不会写入 hmdao_nllb_installed），
    // 但 Transformers.js 已把模型缓存进 IndexedDB。
    vi.stubGlobal(
      'indexedDB',
      makeFakeIndexedDB({
        dbName: 'transformers-cache',
        keys: [
          'https://huggingface.co/Xenova/nllb-200-distilled-600M/resolve/main/onnx/decoder_model_quantized.onnx',
        ],
      }),
    );

    const mod = await freshImport();
    await mod.initInstalledState();

    // 关键：即使没有 localStorage 标记，也应根据 IndexedDB 记录自动判为已安装
    expect(mod.getLocalTranslateState().status).toBe('ready');
    expect(mod.getLocalTranslateState().progress).toBe(100);
    expect(mod.MODEL_PLUGINS[0].status).toBe('ready');
    // 自动补写标记，便于后续快速判定
    expect(localStorage.getItem(LS_KEY_INSTALLED)).toBe(MODEL_NAME);
  });

  // ── 5b. 无标记且无缓存：保持 idle ──
  it('刷新后：无「已安装」标记且 IndexedDB 无缓存 → 保持 idle（显示「下载」按钮）', async () => {
    vi.stubGlobal('indexedDB', makeFakeIndexedDB({ keys: ['unrelated-key'] }));

    const mod = await freshImport();
    await mod.initInstalledState();

    expect(mod.getLocalTranslateState().status).toBe('idle');
  });

  // ── 6. indexedDB 不可用时安全回退 ──
  it('indexedDB 不可用（undefined）时不崩溃，清除标记回退 idle', async () => {
    localStorage.setItem(LS_KEY_INSTALLED, MODEL_NAME);
    vi.stubGlobal('indexedDB', undefined);

    const mod = await freshImport();
    await expect(mod.initInstalledState()).resolves.toBeUndefined();

    expect(mod.getLocalTranslateState().status).toBe('idle');
    expect(localStorage.getItem(LS_KEY_INSTALLED)).toBeNull();
  });

  // ── 7. 非 transformers 数据库被忽略 ──
  it('只探测含 transformers 的数据库，无关库不会误判为已安装', async () => {
    localStorage.setItem(LS_KEY_INSTALLED, MODEL_NAME);
    vi.stubGlobal(
      'indexedDB',
      makeFakeIndexedDB({ dbName: 'hmdao-storage', keys: [MODEL_NAME] }),
    );

    const mod = await freshImport();
    await mod.initInstalledState();

    // 数据库名不含 transformers → 视为未缓存 → 清除标记
    expect(mod.getLocalTranslateState().status).toBe('idle');
    expect(localStorage.getItem(LS_KEY_INSTALLED)).toBeNull();
  });
});
