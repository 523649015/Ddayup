// ============================================================================
// Ddayup 扩展 — 可插拔特性管理器（FeatureManager）
// ----------------------------------------------------------------------------
// 设计目标（来自「截图识文」架构评审）：
//   1) 新增/移除一个特性 = 增删一个 features/*.js 文件 + sidepanel.html 一行 <script>
//   2) 特性自注册：挂 window.HMDAO_FEATURES，含 { id, title, enabled, init, teardown }
//   3) 支持 storage 标志一键开关（runtime 热插拔）
//   4) 后台处理器走 router.js 的 registerHandler / HMDAO_HANDLERS 注册表（见 screenshot-ocr-bg.js）
//
// 本文件是「一次性基础设施」，须在 shared/messages.js 之后、各特性脚本之前加载。
// ============================================================================
(function (root) {
  'use strict';

  const FEATURE_FLAG_PREFIX = 'hmdao:feature:';

  root.HMDAO_FEATURES = root.HMDAO_FEATURES || [];

  // 读取特性开关：默认开启；显式 false 才关闭
  function getFeatureFlag(id, defaultVal) {
    return new Promise((resolve) => {
      const def = (typeof defaultVal === 'boolean') ? defaultVal : true;
      try {
        if (root.chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(FEATURE_FLAG_PREFIX + id, (o) => {
            const v = o && o[FEATURE_FLAG_PREFIX + id];
            resolve((typeof v === 'boolean') ? v : def);
          });
        } else { resolve(def); }
      } catch (_) { resolve(def); }
    });
  }

  function makeCtx() {
    return {
      HMDAO_MSG: root.HMDAO_MSG,
      features: root.HMDAO_FEATURES,
      getFlag: getFeatureFlag,
    };
  }

  async function initFeature(f, ctx) {
    try {
      const enabled = f.enabled ? await f.enabled() : true;
      f.__enabled = enabled;
      if (enabled && typeof f.init === 'function') {
        try { await f.init(ctx); f.__inited = true; }
        catch (e) { console.error('[HMDAO][feat] init 失败:', f.id, e); f.__enabled = false; }
      }
    } catch (e) { console.error('[HMDAO][feat] enabled() 失败:', f.id, e); }
  }

  const FeatureManager = {
    getFlag: getFeatureFlag,
    register(feature) {
      if (!feature || !feature.id) return;
      root.HMDAO_FEATURES.push(feature);
      // 若引导已完成（脚本加载顺序异常导致），立即初始化该单个特性
      if (booted) initFeature(feature, makeCtx());
    },
    async initAll() {
      const ctx = makeCtx();
      for (const f of root.HMDAO_FEATURES) {
        await initFeature(f, ctx);
      }
    },
    async setEnabled(id, val) {
      return new Promise((resolve) => {
        try {
          if (!(root.chrome && chrome.storage && chrome.storage.local)) return resolve(false);
          chrome.storage.local.set({ [FEATURE_FLAG_PREFIX + id]: !!val }, async () => {
            const f = root.HMDAO_FEATURES.find((x) => x.id === id);
            if (f) {
              f.__enabled = !!val;
              if (val && !f.__inited && typeof f.init === 'function') {
                try { await f.init(makeCtx()); f.__inited = true; } catch (e) { console.error('[HMDAO][feat] 热启用失败:', id, e); }
              } else if (!val && typeof f.teardown === 'function') {
                try { f.teardown(); } catch (e) {}
              }
            }
            resolve(true);
          });
        } catch (_) { resolve(false); }
      });
    },
    isEnabled(id) {
      const f = root.HMDAO_FEATURES.find((x) => x.id === id);
      return !!(f && f.__enabled);
    },
  };

  root.FeatureManager = FeatureManager;

  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    FeatureManager.initAll();
  }
  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof self !== 'undefined' ? self : this);
