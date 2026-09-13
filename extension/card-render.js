// ===== 资产去重 + 列表渲染（卡片簇） =====
// ★2026-08-24：本地 b64ToBytes（封面主动抽帧时把后台返回字节还原为视频 Blob 用）
function b64ToBytes(b64) {
  try {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch (_) { return new Uint8Array(0); }
}
// 依赖 sidepanel.js 顶部全局：assets / selected / currentFilter / imgDimensions /
// ensureDragData / openPreview / showContextMenu / hoverPlayAudio / stopHoverAudio /
// loadImageViaRelay / displayName / getAsset / queueModelThumb / netdiskResolve /
// window.__sourcePageUrl（均在 sidepanel.js 加载后可用，故本文件在其之后加载）。
// 另被 bulk-actions.js 在入库时调用 deduplicateImages / render，故本文件须在 bulk-actions.js 之前加载。

// ===== 2026-09-11 卡片虚拟化（全量入库 + 可视区挂载）=====
// 数据层：window.assets 仍保存全量素材（列表不丢）；DOM 层：仅挂载"可视窗口 + 缓冲"内的卡片，
// 视口外的卡片从 DOM 卸载（存入复用池，滚动回来免重建），大幅降低大列表（如 liblib 509 条）的 DOM/内存开销。
// 复用既有 IntersectionObserver 懒加载（coverWhenVisible）即可保证"看不到的不拉封面"。
const HMDAO_VIRTUALIZE = false; // 虚拟化当前关闭，卡片直接挂载到 #list 的 3 列响应式网格；改为 true 可重新开启

// ★2026-09-11 JS 兜底：CSS aspect-ratio 在部分环境下对 grid item 不生效，用 CSS 变量同步行列尺寸，
//   让卡片高 = 列宽，保证绝对正方形；尺寸随侧栏宽高比自适应（3 列 5 排，侧栏越宽卡片越大）。
function hmdaoUpdateCardSize() {
  const c = document.getElementById('list');
  if (!c || !c.style) return; // 桩/DOM 缺失时安全跳过（#list 或 style 不存在则不设变量）
  const cs = getComputedStyle(c);
  const pad = parseFloat(cs.paddingLeft) || 12;
  const gap = parseFloat(cs.gap || cs.rowGap) || 16;
  const cols = 3, rows = 5;
  const availW = Math.max(180, (c.clientWidth || 300) - pad * 2);
  let size = Math.floor((availW - gap * (cols - 1)) / cols);
  size = Math.min(160, Math.max(54, size));
  c.style.setProperty('--card-size', size + 'px');
  const listH = rows * size + (rows - 1) * gap + pad * 2;
  c.style.minHeight = listH + 'px';
  c.style.maxHeight = listH + 'px';
}
// 监听 #list 宽度变化，侧栏被拖拽或首屏布局完成时自动重算卡片尺寸
(function hmdaoWatchListSize() {
  if (typeof ResizeObserver !== 'undefined') {
    try {
      const ro = new ResizeObserver((entries) => {
        for (const e of entries) if (e && e.contentRect) hmdaoUpdateCardSize();
      });
      const c = document.getElementById('list');
      if (c) ro.observe(c);
    } catch (_) {}
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', hmdaoUpdateCardSize, { passive: true });
  }
  hmdaoUpdateCardSize();
})();

function hmdaoListMetrics() {
  const c = document.getElementById('list');
  if (!c) return null;
  const cs = getComputedStyle(c);
  const PAD = parseFloat(cs.paddingLeft) || 0;
  const GAP = parseFloat(cs.rowGap || cs.gap || '6') || 6;
  const contentW = (c.clientWidth || 300) - PAD * 2;
  const tmpl = (cs.gridTemplateColumns || '').trim();
  let COLS = 3;
  const rm = /repeat\((\d+)/.exec(tmpl);
  if (rm) COLS = parseInt(rm[1], 10) || 3;
  else if (tmpl && !tmpl.includes('repeat')) { const n = tmpl.split(/\s+/).filter(Boolean).length; if (n >= 1) COLS = n; }
  const colW = Math.max(36, (contentW - (COLS - 1) * GAP) / COLS);
  const cardH = colW; // aspect-ratio:1 → 正方形
  const rowH = cardH + GAP;
  // ★2026-09-11 修复：侧栏首次打开或 CSS 高度未生效时 clientHeight 可能为 0，
  // 导致窗口计算为 0 → 不渲染任何卡 → sizer 为 0 → 滚动条不出现。用兜底高度保证首屏必渲染。
  const clientHeight = c.clientHeight || 0;
  const winH = (typeof window !== 'undefined' && window.innerHeight) || 600;
  const viewH = clientHeight || Math.max(240, Math.min(600, winH * 0.5));
  return { c, PAD, GAP, COLS, colW, cardH, rowH, contentW, clientHeight, viewH };
}
function hmdaoComputeWindow(m) {
  if (!m) return { start: 0, end: 0 };
  const c = m.c;
  const n = c.__hmdaoFilteredLen || 0;
  if (!n) return { start: 0, end: 0 };
  const viewH = m.viewH || 0;
  const scrollTop = c.scrollTop || 0;
  const rowsTotal = Math.ceil(n / m.COLS);
  // 上下各留 2 行缓冲，避免快速滚动露白
  const firstRow = Math.max(0, Math.floor(scrollTop / m.rowH) - 2);
  const lastRow = Math.min(rowsTotal - 1, Math.ceil((scrollTop + viewH) / m.rowH) + 2);
  const start = Math.min(n, firstRow * m.COLS);
  const end = Math.min(n, (lastRow + 1) * m.COLS);
  return { start, end };
}
function hmdaoPositionCard(card, i, m) {
  if (!card || !m) return;
  const row = Math.floor(i / m.COLS), col = i % m.COLS;
  card.style.position = 'absolute';
  card.style.left = (m.PAD + col * (m.colW + m.GAP)) + 'px';
  card.style.top = (m.PAD + row * m.rowH) + 'px';
  card.style.width = m.colW + 'px';
  card.style.height = m.cardH + 'px';
}
// 滚动时按 rAF 节流重渲染窗口；窗口变化会改 fullSig → renderNow 仅重挂可视区
(function hmdaoVirtualScroll() {
  const attach = () => {
    const c = document.getElementById('list');
    if (!c) { setTimeout(attach, 200); return; }
    if (c.__hmdaoScrollBound) return;
    c.__hmdaoScrollBound = true;
    let ticking = false;
    c.addEventListener('scroll', () => {
      if (ticking) return; ticking = true;
      requestAnimationFrame(() => { ticking = false; if (typeof renderNow === 'function') renderNow(); });
    }, { passive: true });
    // ★2026-09-11 修复：侧栏高度由 CSS flex 动态决定，首次 attach 时可能尚未 layout 完成，
    // 用 ResizeObserver 监听 #list 自身尺寸变化，尺寸到位后重新计算可视窗口并触发渲染。
    if (typeof ResizeObserver !== 'undefined') {
      try {
        const ro = new ResizeObserver((entries) => {
          for (const e of entries) {
            if (e.contentRect && e.contentRect.height > 0) {
              c.__hmdaoHadHeight = true;
              if (typeof renderNow === 'function') renderNow();
            }
          }
        });
        ro.observe(c);
      } catch (_) {}
    }
  };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
    else attach();
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => { if (typeof renderNow === 'function') renderNow(); });
  }
})();

// ===== 资产去重（图片 + 视频）：同源同 base 名只保留最高分辨率 / 优先 URL =====

function deduplicateImages(list) {
  if (!list || !list.length) return list;
  const groups = new Map();

  const getKey = (url) => {
    try {
      const u = new URL(url);
      const name = decodeURIComponent(u.pathname.split('/').pop() || '')
        .replace(/\?.*$/, '') // 去 query（避免 B站等缓存签名干扰）
        .replace(/[-_]\d{2,4}x\d{2,4}/gi, '')
        .replace(/[-_](?:thumb|small|medium|large|tiny|mini|preview|icon|logo|favicon|spacer|placeholder)[-_]?/gi, '')
        .replace(/\.[^.]+$/, '')
        .replace(/[-_]\d+$/, '');
      return (u.hostname + '/' + name).toLowerCase();
    } catch (_) { return url; }
  };

  const resolveScore = (a) => {
    let score = 100;
    const u = a.url || '';
    const m = u.match(/[-_](\d{3,4})[x_]\d{3,4}/i);
    if (m) score = parseInt(m[1]) || 100;
    if (/\b(?:original|full|large|big|huge|hd|fhd|uhd|4k|8k|2k|raw)\b/i.test(u)) score += 200;
    if (/\b(?:thumb|small|tiny|mini|preview|icon|logo|favicon)\b/i.test(u)) score = Math.min(score, 50);
    if ((a.source || '').indexOf('a>img') >= 0) score += 300;
    if ((a.source || '').indexOf('srcset') >= 0) score += 100;
    return score;
  };

  list.forEach((a, i) => {
    // 图片 + 视频都参与去重（音频/模型/归档通常唯一）
    if (a.type !== 'image' && a.type !== 'video') return;
    const key = getKey(a.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ idx: i, score: resolveScore(a) });
  });

  const removeSet = new Set();
  groups.forEach((grp) => {
    if (grp.length <= 1) return;
    grp.sort((x, y) => y.score - x.score);
    grp.slice(1).forEach((g) => removeSet.add(g.idx));
  });

  return removeSet.size ? list.filter((_, i) => !removeSet.has(i)) : list;
}

// ===== 分辨率降序排序（2026-08-18）：高分辨率素材靠前 =====
// 已知尺寸的按 w*h 降序；未知尺寸的（图片尚未 onload）保持其在数组中的原相对顺序（稳定）。
function dimScore(a) {
  const d = (typeof imgDimensions !== 'undefined' && imgDimensions) ? imgDimensions[a.url] : null;
  if (!d || !d.w || !d.h) return 0; // 未知尺寸 → 0 分，排在已知尺寸之后，保持原序
  return d.w * d.h;
}

function sortFilteredByDimension(arr) {
  if (!arr || arr.length < 2) return;
  arr.sort((x, y) => {
    const sx = dimScore(x), sy = dimScore(y);
    if (sx === sy) return 0; // 同分（多为未知尺寸）→ 稳定，保留原序
    return sy - sx; // 降序：高分（高分辨率）在前
  });
}

// ★2026-08-23 P5（按模块归纳）：先按类型优先级分模块（同模块相邻），组内再按分辨率高→低。
//   返回新数组（不原地破坏），供 all 视图分组渲染与异步重排使用。
const __MODULE_RANK = { image: 0, audio: 1, video: 2, model: 3, document: 4, archive: 5, netdisk: 6 };
function sortByModuleThenDimension(arr) {
  if (!arr || arr.length < 2) return arr;
  return arr.slice().sort((x, y) => {
    const rx = __MODULE_RANK[normalizeAssetType(x.type)] ?? 99;
    const ry = __MODULE_RANK[normalizeAssetType(y.type)] ?? 99;
    if (rx !== ry) return rx - ry;
    const sx = dimScore(x), sy = dimScore(y);
    return sy - sx;
  });
}

// 图片尺寸异步加载完成后，若启用分辨率排序，仅对已有卡片 DOM 重排（不重建、不重加载图片）。
let __resortTimer = null;
function rescheduleByDimension() {
  if (__resortTimer) clearTimeout(__resortTimer);
  __resortTimer = setTimeout(() => {
    __resortTimer = null;
    // ★2026-09-11 虚拟化：绝对定位下视觉顺序由 renderNow 按 filtered 索引计算，
    // 直接 appendChild 重排不再改变位置。故改为强制一次窗口重渲染（会按分辨率重排并重新定位）。
    if (HMDAO_VIRTUALIZE) { __lastRenderSig = ''; if (typeof renderNow === 'function') renderNow(); return; }
    const c = document.getElementById('list');
    if (!c) return;
    // 收集当前卡片并按分辨率重新排序后按顺序 appendChild（appendChild 已存在节点会移动，不重建）
    const cards = Array.from(c.children).filter((el) => el.classList && el.classList.contains('card'));
    if (!cards.length) return;
    const byIdx = new Map(cards.map((el) => [parseInt(el.dataset.idx || '-1', 10), el]));
    const shown = window.assets.filter((a) => byIdx.has(window.assets.indexOf(a)));
    const ordered = (currentFilter === 'all')
      ? sortByModuleThenDimension(shown.slice())
      : shown.slice().sort((x, y) => dimScore(y) - dimScore(x));
    ordered.forEach((a) => {
      const el = byIdx.get(window.assets.indexOf(a));
      if (el) c.appendChild(el); // 移动节点（保留已加载图片，无闪烁）
    });
  }, 200);
}

// ===== 按规范类型计数（D4：统一经 normalizeAssetType 归类，避免非规范 type 漏计）=====
// 任何拼写/大小写/别名（如 img/mp3/3d/pan）都会归一回 ASSET_TYPES 规范值再计数；
// 无法识别的 type 归入 cntAll 但不在分类 chip 显示（与 ingestAssets 保留原值策略一致）。
function countByType(list) {
  const counts = { image: 0, video: 0, audio: 0, model: 0, document: 0, archive: 0, netdisk: 0 };
  (list || []).forEach((a) => {
    const t = normalizeAssetType(a && a.type);
    if (t && Object.prototype.hasOwnProperty.call(counts, t)) counts[t]++;
  });
  return counts;
}

// ===== 渲染列表（类型筛选 + 尺寸筛选） =====
// ★P3 修复（闪烁跳动）：原来每次 SCAN_RESULT / storage.onChanged 都 c.innerHTML='' 全量重建，
// 轮询 + 每个网络捕获都触发 scheduleRescan → render 高频整列销毁重建 → 列表持续闪烁、图片反复加载。
// 两道缓解：1) 去抖：多次同步 render 合并为一次（150ms）。2) 签名跳过：若「筛选后的卡片键集合」
// 与上一次完全相同（资产列表无实质变化），直接 return，不重建 DOM、不重新加载图片 → 消除「无变化也闪」。
let __lastRenderSig = null;
let __renderTimer = null;

// ===== 2026-09-05 缩略图加载治理（侧栏卡顿 / 点击半天没反应 / 拖不动滑块的主因）=====
//   实测 103 张视频卡 + 98 张图片卡：每张卡【创建即无条件】loadImageViaRelay →
//   200 个后台 relay 请求同时打进 Service Worker；封面是限时签名 URL，签名每轮换一次
//   dataset.cover 就不同 → 每轮 10s 轮询再重拉一遍；封面失败还会 fire-and-forget
//   拉 8MB 视频字节抽首帧 → SW 事件循环被打满 → 点卡片/拖滑块全部排队等消息通道。
//   治理三件套：① 去重缓存（按去签名 key）② 并发限流（4 路）③ 视口懒加载（IO 600px 预取）。
const HMDAO_COVER_CACHE = new Map();   // cacheKey -> blobUrl
let HMDAO_COVER_QUEUE = [];
let HMDAO_COVER_ACTIVE = 0;
let HMDAO_COVER_IO = null;
const HMDAO_COVER_MAX_CONCURRENT = 4;
// ★2026-09-08：6 → 12（单轮批次大小）。抽帧字节上限已从 8MB 降到 2MB、且并发上限 2，
//   6 次预算在多视频画廊页（runninghub / 即梦 / iMini）只够前 6 张卡有缩略图，
//   其余恒为 🎬。适度放宽到 12（最坏 12×2MB，且仅视口内卡片才触发）。
// ★2026-09-12：从「整个侧栏会话的一次性硬上限」改为「分批懒加载 + 自动续批」模型：
//   每轮最多抽 HMDAO_FRAME_BATCH(=12) 张；这 12 张全部结算后，若视口内仍有
//   「缺封面且未抽过且未永久失败」的视频卡 → 预算重置回 12 再跑一轮 → 直到没有这样的卡为止，自动停止。
//   失败集 HMDAO_FRAME_FAILED 记录「抽帧已失败、不再重试」的资产，防止对永远失败的卡（如 B站首页裸流）无限循环。
let HMDAO_FRAME_BUDGET = 12;           // 自动抽帧（MB 级字节）单轮预算（批次大小），耗尽后由 hmdaoFramePump 自动续批
const HMDAO_FRAME_BATCH = 12;          // 每轮最多抽帧数（= 原硬上限 12）
// ===== 2026-09-12 抽帧统一调度器状态 =====
const HMDAO_FRAME_FAILED = new Set();  // 抽帧已失败、不再重试的资产身份（防死循环）
let HMDAO_FRAME_QUEUE = [];            // 待抽帧队列：{ card, a, apply }
let HMDAO_FRAME_ACTIVE = 0;            // pump 自管的在途抽帧数（≤ HMDAO_FRAME_CONCURRENCY）
const HMDAO_FRAME_CONCURRENCY = 2;     // 抽帧并发上限（与 window.__hmdao_coverFrameActive 一致）
// ★2026-09-11：最近一次「资产列表非空」的时间戳（用于空态文案区分"扫描中/切站"与"确实为空"）
let __lastAssetsAt = 0;

// ★2026-09-08 修复（豆包/抖音 CDN 缩略图 403 刷屏真凶）：
//   旧逻辑 `img.src = burl || a.url` —— relay 失败时用【侧栏自身】直连第三方 URL，
//   此时 Referer 是 chrome-extension://<id>/，豆包 imagex CDN
//   （p3-/p6-/p11-flow-imagex-sign.byteimg.com）与抖音图床一律 403：
//   控制台刷一排红色 "GET ... 403 (Forbidden)"，而图最终仍是破的，纯噪声。
//   对「明确校验 Referer / 会话 Cookie 的防盗链 CDN」禁止直连兜底：失败就保留占位图标。
function isRefererGatedCdn(u) {
  try {
    const h = new URL(String(u || '')).hostname.toLowerCase();
    return /byteimg\.com|doubao\.com|douyinpic|douyinstatic|douyinvod|douyin\.com|iesdouyin|tiktokcdn|tiktok\.com|bytedance|xhscdn|xiaohongshu|sinaimg|bilivideo|mmbiz|qpic\.cn|pstatp/i.test(h);
  } catch (_) { return false; }
}

function coverCacheKey(url) {
  try {
    const u = new URL(String(url || ''));
    return u.origin + u.pathname; // 签名在 query：抖音图床封面 URL 每轮换签名，pathname 稳定
  } catch (_) { return String(url || ''); }
}

function coverPump() {
  while (HMDAO_COVER_ACTIVE < HMDAO_COVER_MAX_CONCURRENT && HMDAO_COVER_QUEUE.length) {
    const job = HMDAO_COVER_QUEUE.shift();
    HMDAO_COVER_ACTIVE++;
    try { job(); } catch (_) { HMDAO_COVER_ACTIVE--; }
  }
}

function coverFetch(url) {
  if (!url) return Promise.resolve('');
  // ★2026-09-11：已判定为统一占位图 → 不再走后台 relay，直接判空（空出 SW 通道给真实封面）
  if (coverIsPlaceholder(url)) return Promise.resolve('');
  const key = coverCacheKey(url);
  if (HMDAO_COVER_CACHE.has(key)) return Promise.resolve(HMDAO_COVER_CACHE.get(key));
  return new Promise((resolve) => {
    HMDAO_COVER_QUEUE.push(() => {
      loadImageViaRelay(url, window.__sourcePageUrl)
        .then((b) => { if (b) HMDAO_COVER_CACHE.set(key, b); resolve(b || ''); })
        .catch(() => resolve(''))
        .then(() => { HMDAO_COVER_ACTIVE--; coverPump(); });
    });
    coverPump();
  });
}

// 仅当卡片进入视口（含 600px 预取）才真正取缩略图；命中缓存则同步直给
// ★2026-09-12 修复（控制台 `card-render.js:692 Uncaught TypeError: Cannot read properties of
//   undefined (reading 'catch')` → renderNow 的 forEach 直接抛飞 → 卡片渲染中断、列表卡一半/全空）：
//   调用点写的是 `coverWhenVisible(...).catch(()=>{})`，但旧实现在 `!url` / 缓存命中两条分支里
//   直接 `return;`（返回 undefined）→ `.catch` 在 undefined 上调用即抛。缓存命中是高频路径
//   （同一批卡片第二次渲染必命中），于是每次重渲染都抛一次，renderNow 循环被中断，后续卡片
//   全部不被挂载 → 侧栏列表"卡片都消失了"。现保证【所有分支都返回 Promise.resolve()】。
function coverWhenVisible(card, url, apply) {
  const done = () => Promise.resolve();
  if (!url) return done();
  const key = coverCacheKey(url);
  if (HMDAO_COVER_CACHE.has(key)) { try { apply(HMDAO_COVER_CACHE.get(key)); } catch (_) {} return done(); }
  if (typeof IntersectionObserver === 'undefined') {
    coverFetch(url).then((b) => { if (card.isConnected) apply(b); }).catch(() => {});
    return done();
  }
  if (!HMDAO_COVER_IO) {
    HMDAO_COVER_IO = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target;
        try { HMDAO_COVER_IO.unobserve(el); } catch (_) {}
        const u = el.dataset.coverWant;
        if (!u) continue;
        coverFetch(u).then((b) => { if (el.isConnected && typeof el.__applyCover === 'function') el.__applyCover(b); });
      }
    }, { root: document.getElementById('list') || null, rootMargin: '600px 0px' });
  }
  card.dataset.coverWant = url;
  card.__applyCover = apply;
  HMDAO_COVER_IO.observe(card);
  return done();
}

function coverVisibleNow(card) {
  try {
    const r = card.getBoundingClientRect();
    return r.bottom > -200 && r.top < (window.innerHeight + 200);
  } catch (_) { return false; }
}

// ★2026-09-11：封面是否已被 media-fetch 判为「CDN 统一占位图」。
//   占位图是 CDN 软失败（返回 200 + 统一图），重试多少次都是同一张 → 立即判死，
//   不再做 4 次 hover 重试 / 不重复占用 SW 通道，直接走抽帧兜底。
//   media-fetch.js 在本文件之前加载，但用运行时判定 + window 兜底，避免加载顺序耦合。
function coverIsPlaceholder(u) {
  try {
    if (!u) return false;
    if (typeof window.__hmdaoIsPlaceholderCover === 'function') return !!window.__hmdaoIsPlaceholderCover(u);
    if (typeof isPlaceholderCover === 'function') return !!isPlaceholderCover(u);
  } catch (_) {}
  return false;
}
// 取资产的封面 URL（a.cover 可能是数组：RENDER_DATA 部分结构 cover 为 [url,...]）
function coverUrlOf(a) {
  try { return Array.isArray(a.cover) ? (a.cover[0] || '') : (a.cover || ''); } catch (_) { return ''; }
}

// ★2026-09-11（与悬停抽帧合流）：悬停/抽帧拿到的首帧写回封面缓存 ——
//   ① 该卡有 cover（哪怕是占位图）→ 覆盖 HMDAO_COVER_CACHE 与 __thumbCache，此后重渲直接用真帧；
//   ② 该卡压根没有 cover → 记入 HMDAO_HOVER_COVER（按视频直链），渲染时直接复用，不必再抽帧。
const HMDAO_HOVER_COVER = new Map(); // 视频直链 -> 抽帧 blob URL（运行时）
function hmdaoCacheHoverCover(a, blobUrl) {
  try {
    if (!a || !blobUrl) return;
    const c = coverUrlOf(a);
    if (c) {
      try { HMDAO_COVER_CACHE.set(coverCacheKey(c), blobUrl); } catch (_) {}
      try { if (typeof __thumbCache !== 'undefined') __thumbCache.set(c, blobUrl); } catch (_) {}
    }
    if (a.url) HMDAO_HOVER_COVER.set(a.url, blobUrl);
  } catch (_) {}
}

// ★2026-09-11：把抽帧/悬停得到的封面 blob URL 贴到卡片上（无封面卡与复用缓存帧共用）
function applyHoverFrameToTag(a, tag, burl) {
  try {
    if (!tag || !burl) return;
    a.__hoverCoverBlob = burl;
    // 记入运行时缓存：下次渲染（滚动/轮询重渲）直接复用，不必再抽帧
    try { if (a && a.url) HMDAO_HOVER_COVER.set(a.url, burl); } catch (_) {}
    let im = tag.querySelector('img.cover-img');
    if (!im) {
      im = document.createElement('img');
      im.className = 'cover-img';
      im.alt = '封面';
      im.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:6px;display:block;opacity:0;transition:opacity .15s';
      tag.textContent = '';
      tag.appendChild(im);
      tag.classList.add('tag-cover');
    }
    im.src = burl;
    im.style.opacity = '1';
    tag.dataset.coverState = 'hover';
  } catch (_) {}
}

// ★2026-09-08：视频卡【压根没有封面】时的抽帧兜底（runninghub / 即梦 / iMini 等多视频页）。
//   根因：既有抽帧兜底全部写在 `if (a.cover)` 之内（relay 返回空 / coverImg.onerror 才触发），
//   而这些站点的视频卡 a.cover 本身为空（多视频页已不再下发页面级 defaultCover，见 scan.js）
//   → 既不进 relay 也不进 onerror → 卡片恒为 🎬 占位、永远没有缩略图。
//   做法：后台按源页身份拉视频前 2MB → 侧栏临时 <video> 解首帧 → canvas → PNG blob URL。
//   节流与既有兜底一致：仅视口内卡片 / 全局预算 / 并发上限 2 / 字节上限 2MB / 10s 超时释放。
//   注意：blob URL 同源，不需要 crossOrigin（避开 canvas 污染导致的截帧失败）。
// ★2026-09-09 修复（控制台 `blob:chrome-extension://<extid>/<uuid> Failed to load resource:
//   net::ERR_FILE_NOT_FOUND` 的直接来源）：
//   抽帧用的临时 <video> 在「刚画完首帧」后就被 URL.revokeObjectURL(vurl)，
//   但 tv.src 仍指向该 blob：preload='metadata' + seek 之后浏览器还在按 Range 继续读取后续字节，
//   blob 已注销却被继续读取 → Chrome 报 ERR_FILE_NOT_FOUND（扩展页控制台红字，看起来像"扩展报错"）。
//   正确释放顺序：先让媒体元素彻底停止并解绑 src（pause → removeAttribute('src') → load() 触发
//   资源选择算法中止在途请求），再 revoke —— 此后不会再有任何请求打到已注销的 blob。
function releaseFrameVideo(tv, vurl) {
  // ★2026-09-13 修复（blob ERR_FILE_NOT_FOUND 控制台噪声根因闭环）：
  //   旧逻辑在 tv.load() 之后【同步】URL.revokeObjectURL(vurl)——但 load() 中止在途 Range 请求是
  //   异步的，revoke 先于请求取消生效 → 浏览器仍在读已注销的 blob → 报 ERR_FILE_NOT_FOUND。
  //   正确做法：解绑 src 后，等媒体元素真正释放资源（'emptied' 事件，load() 中止 pending 请求后触发）
  //   再 revoke；并加超时兜底，防止极端情况下 'emptied' 不触发导致 blob 泄漏（配对且时机正确）。
  const revoke = () => { try { if (vurl) URL.revokeObjectURL(vurl); } catch (_) {} };
  try {
    if (tv) {
      try { tv.pause(); } catch (_) {}
      tv.removeAttribute('src');
      let done = false;
      let timer = null;
      const once = () => { if (done) return; done = true; if (timer) clearTimeout(timer); revoke(); };
      // 'emptied' 在 load() 真正中止在途请求后触发 → 此刻 revoke 才安全（消除 ERR_FILE_NOT_FOUND）
      tv.addEventListener('emptied', once, { once: true });
      // 兜底：异常路径或事件未触发时超时强回收，避免 blob 泄漏（done 守卫防重复 revoke）
      timer = setTimeout(once, 300);
      try { tv.load(); } catch (_) { once(); }
    } else {
      revoke();
    }
  } catch (_) {
    revoke();
  }
}

// ===== 2026-09-12 抽帧统一调度器：分批懒加载 + 自动续批 + 失败集防死循环 + 自动停止 =====
//   旧模型：HMDAO_FRAME_BUDGET 是「整个侧栏会话的一次性硬上限」，抽 12 次即止，其余视频卡恒为 🎬。
//   新模型：每轮最多抽 HMDAO_FRAME_BATCH(=12) 张（预算递减）；这 12 张全部结算后，若视口内仍有
//   「缺封面且未抽过且未永久失败」的视频卡 → 预算重置回 12 再跑一轮 → 直到没有这样的卡为止，自动停止。

// 资产身份键：用于失败集 / 幂等 / 去重。优先用稳定身份（抖音 awemeId），否则用直链。
function hmdaoFrameKey(a) {
  if (!a) return '';
  if (a.platform === 'douyin' && a.type === 'video' && a.awemeId) return 'dy:' + a.awemeId;
  return (a.url || a.cover || '');
}

// 记录卡片抽帧结算状态到 dataset（便于幂等与调试）
function hmdaoFrameMarkState(card, state) {
  try { if (card && card.dataset) card.dataset.frameState = state; } catch (_) {}
}

// 入队（幂等）：仅对「视口内、未入队、未结算、未失败」的缺封面视频卡入队；其余直接跳过。
//   视口外：不抽不扣预算，仅标记待定；滚动重渲时再次进入视口会重新入队。
function hmdaoEnqueueFrameExtract(card, a, apply) {
  if (!card || !a) return;
  if (card.__frameQueued) return;
  const fs = (card.dataset && card.dataset.frameState) || '';
  if (fs === 'queued' || fs === 'done' || fs === 'failed') return;
  const key = hmdaoFrameKey(a);
  if (HMDAO_FRAME_FAILED.has(key)) { hmdaoFrameMarkState(card, 'failed'); return; }
  // 视口外：不抽不扣预算，仅标记待定；renderNow 因滚动重算窗口后会再次评估该卡
  if (typeof coverVisibleNow === 'function' && !coverVisibleNow(card)) {
    hmdaoFrameMarkState(card, 'pending');
    return;
  }
  card.__frameQueued = true;
  hmdaoFrameMarkState(card, 'queued');
  HMDAO_FRAME_QUEUE.push({ card: card, a: a, apply: (typeof apply === 'function' ? apply : null) });
  hmdaoFramePump();
}

// 队列里是否还有「视口内且未永久失败」的可抽卡（决定是否续批 / 是否停止）
function hmdaoFrameQueueHasExtractable() {
  return HMDAO_FRAME_QUEUE.some((job) => {
    if (!job || !job.a) return false;
    if (HMDAO_FRAME_FAILED.has(hmdaoFrameKey(job.a))) return false;
    if (typeof coverVisibleNow === 'function' && !coverVisibleNow(job.card)) return false;
    return true;
  });
}

// 抽帧统一调度器：分批懒加载 + 自动续批 + 失败集防死循环 + 自动停止。
function hmdaoFramePump() {
  // 自然停止：队列空 / 并发满 / 预算耗尽且无可续批 → 无活可干即停（不会死循环）
  while (HMDAO_FRAME_QUEUE.length
         && HMDAO_FRAME_ACTIVE < HMDAO_FRAME_CONCURRENCY
         && HMDAO_FRAME_BUDGET > 0
         && (typeof window === 'undefined' || (window.__hmdao_coverFrameActive || 0) < HMDAO_FRAME_CONCURRENCY)) {
    const job = HMDAO_FRAME_QUEUE.shift();
    if (!job || !job.card || !job.a) continue;
    const a = job.a, card = job.card, apply = job.apply;
    if (HMDAO_FRAME_FAILED.has(hmdaoFrameKey(a))) { hmdaoFrameMarkState(card, 'failed'); continue; }
    // 入队后若已滚出视口 → 丢弃本次出队（不抽不扣预算），滚动重渲再进入视口时重新入队
    if (typeof coverVisibleNow === 'function' && !coverVisibleNow(card)) {
      if (card) card.__frameQueued = false;
      hmdaoFrameMarkState(card, 'pending');
      continue;
    }
    HMDAO_FRAME_BUDGET--;
    HMDAO_FRAME_ACTIVE++;
    try {
      hmdaoRunFrameExtract(a, card, (burl) => {
        try {
          if (burl) { if (apply) apply(burl); }
          else { HMDAO_FRAME_FAILED.add(hmdaoFrameKey(a)); hmdaoFrameMarkState(card, 'failed'); }
        } finally {
          HMDAO_FRAME_ACTIVE = Math.max(0, HMDAO_FRAME_ACTIVE - 1);
          if (card) card.__frameQueued = false;
          // 每张结算后：预算耗尽但队列仍有可抽卡 → 自动续批新一轮（重置回 12 再跑）
          if (HMDAO_FRAME_BUDGET <= 0 && hmdaoFrameQueueHasExtractable()) {
            HMDAO_FRAME_BUDGET = HMDAO_FRAME_BATCH;
          }
          hmdaoFramePump();
        }
      }, () => {
        // 并发闸被占用（极端防御）：回退队列、释放本槽位，等后续 settle 再驱动
        HMDAO_FRAME_ACTIVE = Math.max(0, HMDAO_FRAME_ACTIVE - 1);
        if (card) card.__frameQueued = false;
        HMDAO_FRAME_QUEUE.unshift({ card: card, a: a, apply: apply });
        hmdaoFramePump();
      });
    } catch (_) {
      HMDAO_FRAME_ACTIVE = Math.max(0, HMDAO_FRAME_ACTIVE - 1);
      if (card) card.__frameQueued = false;
      HMDAO_FRAME_FAILED.add(hmdaoFrameKey(a));
      hmdaoFrameMarkState(card, 'failed');
      hmdaoFramePump();
    }
  }
}

function hmdaoRunFrameExtract(a, card, done, onBlocked) {
  try {
    if (!a || a.type !== 'video' || !a.url) return;
    const VID = /(\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|ts)([?#]|$))|((^|\/\/|\.)(v\d+-web\.)?douyinvod\.com\/)|((\?|&)mime_type=video)|((\?|&)mime=video)/i;
    if (!VID.test(a.url)) return;
    if (typeof window.__hmdao_coverFrameActive !== 'number') window.__hmdao_coverFrameActive = 0;
    if (window.__hmdao_coverFrameActive >= 2) { try { onBlocked && onBlocked(); } catch (_) {} return; }
    // 视口判定由 hmdaoFramePump 在出队时保证；预算由 pump 统一收口，核心不再自管。
    window.__hmdao_coverFrameActive++;
    let released = false;
    const release = () => { if (!released) { released = true; window.__hmdao_coverFrameActive = Math.max(0, window.__hmdao_coverFrameActive - 1); } };
    const timer = setTimeout(release, 10000);
    const finish = () => { clearTimeout(timer); release(); };
    // ★2026-09-10：m3u8 不能走下方「后台拉前 2MB 喂 <video>」——拉到的只是【文本播放列表】，
    //   <video> 无法解码 → 直接 error → 卡片永远没有缩略图（实测 t27.cdn2020.com/index.m3u8）。
    //   改用侧栏已有的 hls.js 解析出真实分片后再抽首帧（与预览播放同一套能力，CORS 已可用）。
    if (/\.m3u8(\?|$)/i.test(a.url) && typeof window.Hls !== 'undefined' && window.Hls.isSupported && window.Hls.isSupported()) {
      try {
        const tv = document.createElement('video');
        tv.muted = true;
        tv.preload = 'metadata';
        const hls = new window.Hls({ enableWorker: false, maxBufferLength: 2 });
        let settled = false;
        let hlsTimer = null;
        const ok = (burl) => {
          if (settled) return;
          settled = true;
          // 失败不再归还预算：失败资产由 hmdaoFramePump 记入 HMDAO_FRAME_FAILED，绝不重试。
          try { if (hlsTimer) clearTimeout(hlsTimer); } catch (_) {}
          try { hls.destroy(); } catch (_) {}
          try { tv.pause(); tv.removeAttribute('src'); tv.load(); } catch (_) {}
          finish();
          try { done && done(burl); } catch (_) {}
        };
        const grab = () => {
          try {
            if (tv.videoWidth > 0 && tv.videoHeight > 0) {
              const c = document.createElement('canvas');
              const maxW = 480;
              const scale = tv.videoWidth > maxW ? maxW / tv.videoWidth : 1;
              c.width = Math.round(tv.videoWidth * scale);
              c.height = Math.round(tv.videoHeight * scale);
              const ctx = c.getContext('2d');
              if (ctx) {
                ctx.drawImage(tv, 0, 0, c.width, c.height);
                c.toBlob((pb) => ok(pb ? URL.createObjectURL(pb) : null), 'image/png');
                return;
              }
            }
            ok(null);
          } catch (_) { ok(null); }
        };
        hlsTimer = setTimeout(() => ok(null), 9000); // 超时保护，避免抽帧卡住
        hls.on(window.Hls.Events.ERROR, (_e, d) => { if (d && d.fatal) ok(null); });
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          try { const p = tv.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
        });
        tv.addEventListener('loadeddata', () => {
          try { tv.currentTime = Math.min(0.2, (tv.duration || 0.2) * 0.1); } catch (_) {}
        }, { once: true });
        tv.addEventListener('seeked', grab, { once: true });
        tv.addEventListener('error', () => ok(null), { once: true });
        hls.loadSource(a.url);
        hls.attachMedia(tv);
        return;
      } catch (_) { /* hls 分支失败则回退下方原逻辑 */ }
    }
    const referer = (window.__sourcePageUrl || '') || (a.pageUrl || '');
    chrome.runtime.sendMessage({ type: 'HMDAO_FETCH_MEDIA', url: a.url, referer: referer, maxBytes: 2 * 1024 * 1024 }, (res) => {
      if (!(res && res.ok && res.b64)) { finish(); try { done && done(null); } catch (_) {} return; }
      try {
        const blob = new Blob([b64ToBytes(res.b64)], { type: res.mime || 'video/mp4' });
        const vurl = URL.createObjectURL(blob);
        const tv = document.createElement('video');
        tv.muted = true; tv.preload = 'metadata';
        let settled = false;
        // ★2026-09-12：失败不再归还预算——失败资产由 hmdaoFramePump 记入 HMDAO_FRAME_FAILED（防死循环、不重试）。
        const ok = (burl) => {
          if (settled) return;
          settled = true;
          releaseFrameVideo(tv, vurl);
          finish();
          try { done && done(burl); } catch (_) {}
        };
        tv.addEventListener('loadeddata', () => { try { tv.currentTime = Math.min(0.1, (tv.duration || 0.1) * 0.05); } catch (_) {} }, { once: true });
        tv.addEventListener('seeked', () => {
          try {
            if (tv.videoWidth > 0 && tv.videoHeight > 0) {
              const c = document.createElement('canvas');
              const maxW = 480;
              const scale = tv.videoWidth > maxW ? maxW / tv.videoWidth : 1;
              c.width = Math.round(tv.videoWidth * scale);
              c.height = Math.round(tv.videoHeight * scale);
              const ctx = c.getContext('2d');
              if (ctx) { ctx.drawImage(tv, 0, 0, c.width, c.height); c.toBlob((pb) => ok(pb ? URL.createObjectURL(pb) : null), 'image/png'); return; }
            }
            ok(null);
          } catch (_) { ok(null); }
        }, { once: true });
        tv.addEventListener('error', () => ok(null), { once: true });
        tv.src = vurl; tv.load();
      } catch (_) { finish(); }
    });
  } catch (_) {}
}

function renderDebounced() {
  if (__renderTimer) clearTimeout(__renderTimer);
  __renderTimer = setTimeout(() => { __renderTimer = null; renderNow(); }, 150);
}

function render() { renderDebounced(); }

// ★2026-09-04 键控复用：就地更新已存在卡片的动态字段（不重建 DOM，避免封面重载闪烁）。
function patchCard(card, a, gi) {
  card.dataset.idx = String(gi);
  card.classList.toggle('sel', window.selected.has(gi));
  if (a.awemeId) card.dataset.awemeId = String(a.awemeId);
  if (a.url) { if (card.dataset.assetUrl !== a.url) card.dataset.assetUrl = a.url; }
  // 封面：仅在 cover 真正变化时才重载（避免轮换签名 url 触发封面闪烁）
  const coverUrl = Array.isArray(a.cover) ? (a.cover[0] || '') : (a.cover || '');
  // ★2026-09-05：按【去签名后的 key】比较——抖音封面 URL 每次扫描都换新签名，
  //   旧代码按完整 url 比较 → 每轮轮询都判定"封面变了" → 103 张卡每张重拉一次 → SW 打满。
  const __ck = coverUrl ? coverCacheKey(coverUrl) : '';
  if (coverUrl && card.dataset.coverKey !== __ck) {
    card.dataset.coverKey = __ck;
    card.dataset.cover = coverUrl;
    const coverImg = card.querySelector('.cover-img');
    const tag = card.querySelector('.tag');
    if (tag) {
      if (coverImg) tag.classList.add('tag-cover');
      else tag.classList.remove('tag-cover');
    }
    if (coverImg) {
      if (tag) tag.dataset.coverState = 'pending';
      coverWhenVisible(card, coverUrl, (burl) => {
        if (coverImg.src === burl) return;
        if (burl) {
          coverImg.src = burl;
          coverImg.style.opacity = '1';
          if (tag) tag.dataset.coverState = 'ok';
        } else if (tag && tag.dataset.coverState === 'pending') {
          tag.dataset.coverState = 'empty';
        }
      }).catch(() => {});
    }
  }
  // ★2026-09-04 修复：切集 / 重扫后标题、集数、未播放徽标必须就地刷新，否则"封面换了标题不变 / 已播放仍显示 📍"
  const nameEl = card.querySelector('.name');
  if (nameEl) { nameEl.textContent = displayName(a); nameEl.title = `${a.type}: ${a.url || ('页面音频#' + (a.audioIdx != null ? a.audioIdx : ''))}`; }
  const wantBadge = !!(a.notPlayed);
  let badge = card.querySelector('.hmdao-badge-unplayed');
  if (wantBadge && !badge) {
    badge = document.createElement('span');
    badge.className = 'hmdao-badge-unplayed';
    badge.textContent = '📍 未播放';
    badge.title = '该集在浏览器未播放过,字节未缓存。双击预览可能失败,请用预览弹层「▶ 切到此集播放」按钮让源页跳到该集并捕获。';
    badge.style.cssText = 'position:absolute;right:5px;top:5px;font-size:9px;padding:1px 5px;border-radius:5px;background:rgba(255,180,0,0.85);color:#332600;z-index:3;pointer-events:none';
    if (!HMDAO_VIRTUALIZE) card.style.position = 'relative';
    card.appendChild(badge);
  } else if (!wantBadge && badge) {
    badge.remove();
  }
  // 批量复选框状态跟随
  const cb = card.querySelector('.batchCb');
  if (cb) { const kb = a.awemeId || a.url || ('idx' + gi); cb.checked = window.batchSelection.has(kb); }
  // 视频卡底部直链行随 url 轮换刷新（不重建 DOM）
  if (a.type === 'video' && a.__urlRow) {
    a.__urlRow.textContent = a.url ? truncate(a.url, 46) : '';
    a.__urlRow.title = a.url || '';
  }
}

function renderNow() {
  const c = document.getElementById('list');

  // ★2026-08-23 深层修复（根因3）：window.assets 已在 sidepanel.js 三处构造逻辑中
  //   按 batchCollectEnabled 严格隔离（关闭批量时不含 __batch 资产），此处直接读 window.assets
  //   即可，保证计数 / indexOf / 点击索引完全一致，杜绝"未开批量却显示信息流素材"。
  const filtered = currentFilter === 'all' ? window.assets : window.assets.filter((a) => a.type === currentFilter);
  // ★2026-08-23 P5（按模块归纳）：currentFilter==='all' 时，先按类型优先级分组（同模块相邻），
  // 组内再按分辨率高→低排序；切换某类型筛选时则单模块平铺（不插标题）。
  if (currentFilter === 'all') sortByModuleThenDimension(filtered);
  else sortFilteredByDimension(filtered);
  // ★2026-08-30 修复（"侧栏闪烁"）：【先排序后序列化】，避免 scan.js 产出顺序变化时触发重建。
  //   之前直接 join（顺序敏感）→ 轮询每次产出可能顺序不同 → sig 变 → 重建 → 闪烁。
  //   排序后只要【资产集合】不变就不重建。
  // ★2026-09-04 修复（批量合集 57 卡侧栏闪烁/卡死真凶）：
  //   旧 sig 把【会轮换的签名直链 url】算进去 → 每轮轮询 url 一变 sig 就变 → 全量重建 57 张卡
  //   （封面图重新加载 + hover 抽帧重建）→ 卡片"一会多一会少/封面闪烁"、侧栏卡死。
  //   改：用【稳定身份】做签名——抖音视频用 awemeId（同一集、封面/标题不变则视为同一卡），
  //   其余用 url；并把【视觉字段 cover/title/notPlayed】纳入 sig，使封面/标题真正变化时仍会重建显示，
  //   但【签名 url 轮换】不再触发重建。
  const stableKeyOf = (a) => ((a && a.platform === 'douyin' && a.type === 'video' && a.awemeId) ? ('dy:' + a.awemeId) : (a && (a.url || a.cover || a.awemeId || '')));
  const sig = filtered.map((a) => (a.type || '') + '|' + stableKeyOf(a) + '|cov:' + (a.cover || '') + '|tt:' + (a.title || '') + '|np:' + (a.notPlayed ? 1 : 0)).sort().join('__SEP__');
  // ★2026-09-11 虚拟化：把"可视窗口"纳入签名，滚动导致的窗口变化必须触发重渲染（仅挂载可视区卡片）。
  const __m = HMDAO_VIRTUALIZE ? hmdaoListMetrics() : null;
  if (__m) __m.c.__hmdaoFilteredLen = filtered.length;
  const __win = (__m) ? hmdaoComputeWindow(__m) : { start: 0, end: filtered.length };
  const fullSig = sig + '|win:' + __win.start + ':' + __win.end;
  // ★2026-09-12 诊断（云桥网「filtered=0 却不知道是没素材还是被筛选掉」）：
  //   跳过分支原先只打印 filtered，无法区分两种完全不同的故障：
  //     ① window.assets 为空 → 扫描结果根本没到侧栏（广播/合并链路问题）
  //     ② window.assets 有素材，但 currentFilter 模块不匹配 → 用户切错模块，采集其实正常
  //   现在两个数字都打出来，配合侧栏空态文案即可一次定位。
  if (fullSig === __lastRenderSig) {
    console.log('[HMDAO][render] renderNow 跳过(签名未变) filtered=' + filtered.length
      + ' assets=' + (window.assets || []).length + ' filter=' + currentFilter);
    return;
  } // 无变化：跳过重建，消除闪烁
  __lastRenderSig = fullSig;
  console.log('[HMDAO][render] renderNow 渲染中 filtered=' + filtered.length + ' filter=' + currentFilter + ' window.assets=' + (window.assets || []).length);

  // ★2026-09-04 键控复用：不再 c.innerHTML='' 全量销毁重建。
  //   收集当前已存在的卡片（按 stableKey 索引），本轮只创建"新出现"的卡、复用"已存在"的卡（仅就地更新动态字段），
  //   移除"不再存在"的卡与模块标题。这样封面图不会因为整段重建而反复重载 → 彻底消除闪烁；57 卡也只做增量 DOM 操作 → 不再卡死。
  const desiredKeys = new Set(filtered.map((a) => stableKeyOf(a)));
  // ★2026-09-04 修复：扩展重载后旧版卡片没有 data-stable-key，会被 renderNow 当成"不可复用"但又不移除，
  //   导致侧栏出现幽灵重复卡、旧卡片事件处理器残留、点击无响应。先清掉这些无键遗留卡片。
  c.querySelectorAll('.card:not([data-stable-key])').forEach((el) => el.remove());
  const oldCardMap = new Map();
  c.querySelectorAll('.card[data-stable-key]').forEach((el) => { const k = el.dataset.stableKey; if (k) oldCardMap.set(k, el); });
  c.querySelectorAll('.moduleHeader').forEach((el) => el.remove());
  oldCardMap.forEach((el, k) => {
    if (!desiredKeys.has(k)) {
      // ★2026-09-05 修复（"关闭侧栏视频卡后还有声音流出"）：卡片被移除时，
      //   挂在其上的悬停抽帧 <video>（hoverVideoEl）与悬停试听不会触发 mouseleave 清理，
      //   会变成游离元素继续出声。移除前先停干净。
      try {
        if (typeof hoverVideoEl !== 'undefined' && hoverVideoEl && el.contains(hoverVideoEl)) {
          try { if (hoverVideoEl.__hmdaoHls) { hoverVideoEl.__hmdaoHls.destroy(); hoverVideoEl.__hmdaoHls = null; } } catch (_) {}
          try { hoverVideoEl.pause(); hoverVideoEl.removeAttribute('src'); hoverVideoEl.srcObject = null; hoverVideoEl.load(); } catch (_) {}
          try { if (hoverVideoEl.parentElement) hoverVideoEl.parentElement.removeChild(hoverVideoEl); } catch (_) {}
          hoverVideoEl = null;
        }
      } catch (_) {}
      try { if (typeof stopHoverAudio === 'function') stopHoverAudio(); } catch (_) {}
      el.remove();
    }
  });

  // 计数（走单一事实来源归一化，替代散落的 a.type === 'image' 硬编码比较）

  // 计数（走单一事实来源归一化，替代散落的 a.type === 'image' 硬编码比较）
  document.getElementById('cntAll').textContent = window.assets.length;
  const cnt = countByType(window.assets);
  document.getElementById('cntImg').textContent = cnt.image;
  document.getElementById('cntVid').textContent = cnt.video;
  document.getElementById('cntAud').textContent = cnt.audio;
  document.getElementById('cntMod').textContent = cnt.model;
  document.getElementById('cntArc').textContent = cnt.archive;
  document.getElementById('cntNet').textContent = cnt.netdisk;
  if (document.getElementById('cntDoc')) document.getElementById('cntDoc').textContent = cnt.document || 0;

  // ★2026-08-23 P5：模块分组标题（仅 all 视图插入；每个非空模块一个标题）
  const MODULE_ORDER = ['image', 'audio', 'video', 'model', 'document', 'archive', 'netdisk'];
  const MODULE_LABEL = { image: '🖼 图片', audio: '🔊 音效', video: '🎬 视频', model: '🧊 3D 模型', document: '📄 文档', archive: '🗜 归档', netdisk: '☁️ 网盘' };
  let lastGroupType = null;
  const grouped = currentFilter === 'all';
  // ★2026-09-08 修复（侧栏「图片 (74)/视频 (12)」标题重复 11 行的根因）：
  //   卡片走键控复用（oldCardMap + 就地 patch），容器 c 从不全量清空；而模块标题
  //   在下面 forEach 里每轮都重新 insert → 上一轮的标题永远留在容器里，
  //   每渲染/轮询一次就多一对标题（实测 10s 轮询几次后堆出 11 行）。
  //   修复：每轮渲染前先把上一轮的模块标题全部移除，本轮再按需重新插入。
  try { c.querySelectorAll(':scope > .moduleHeader').forEach((h) => h.remove()); } catch (_) {}
  // ★2026-09-08 二段修复（单轮渲染内也重复插标题的根因）：
  //   分组标题按「相邻类型变化」插入——若 filtered 未按类型排序（或后续按尺寸重排打乱），
  //   image/video 交替出现 → 每交替一次插一对标题（实测单轮就重复 10 对）。
  //   修复：分组视图下先按归一化类型做【稳定排序】（Array.sort 稳定，同类型内顺序不变），
  //   同类型必然相邻 → 每类型只插一个标题；后续尺寸重排只移动卡片、不再产生新标题。
  // ★2026-09-08 产品决策：取消「全部」视图的类型分组（含排序与模块标题）。
  //   分组在该视图反复出问题（标题重复/与卡片错位/视频卡带封面图被当成图片的观感混排），
  //   且侧栏本就有 图片/视频/音频 独立面板可精确筛选。
  //   「全部」= 全部素材混排；需要按类型看 → 切换对应类型面板。
  //   （如需恢复分组：恢复下方 sort 块与 forEach 里的模块标题插入即可。）

  filtered.forEach((a, i) => {
    // ★2026-09-12 兜底（用户实测：66 张图片只渲染出 8 张卡，banner 却显示 image:66）：
    //   renderNow 的这个 forEach 里任何一处异常（此前是 patchCard→coverWhenVisible(...).catch
    //   在 undefined 上抛）都会让整个 forEach 中断 → 该卡之后的卡片全部不被挂载，DOM 里只剩
    //   打断前已建好的少数几张卡，而横幅统计的 window.assets 仍是 66 → 计数与网格对不上。
    //   现给【单张卡片】加 try/catch：任何一张卡构建/打补丁失败只跳过它，绝不再拖垮整张列表。
    try {
    // ★2026-08-30 修复（"视频模块混入图片素材"根因）：
    //   排序 sortByModuleThenDimension 用的是【归一化后】类型（normalizeAssetType(a.type)），
    //   而分组标题插入此前用的是【原始 a.type】→ 两者不一致 → 同类型资产在视觉上不相邻，
    //   每个资产前都会插一个模块标题 → 用户看到"🎬 视频模块里混进了图片素材"。
    //   修复：标题判定与文案统一使用归一化类型，与排序保持一致。
    const aType = (typeof normalizeAssetType === 'function') ? normalizeAssetType(a.type) : (a.type || 'other');
    // ★2026-08-23 P5（按模块归纳）：all 视图下，类型切换时插入模块标题分隔
    // ★2026-09-08 产品决策：「全部」视图不再插入模块分组标题（见上方说明）。
    //   恢复分组时改回：if (grouped && aType !== lastGroupType) {
    if (false && grouped && aType !== lastGroupType) {
      lastGroupType = aType;
      const hdr = document.createElement('div');
      hdr.className = 'moduleHeader';
      hdr.style.cssText = 'grid-column:1/-1;font-size:12px;font-weight:600;color:#7cc4ff;margin:10px 2px 4px;padding-bottom:3px;border-bottom:1px solid #2a2f3a;letter-spacing:.5px;';
      hdr.textContent = (MODULE_LABEL[aType] || aType) + '（' + (cnt[aType] || 0) + '）';
      // ★2026-09-08：模块标题可点击折叠/展开该分类（此前根本没有实现，点了没反应）。
      //   折叠状态存 window.__hmdaoCollapsedTypes（跨渲染持久），点击后触发一次重渲染。
      try {
        hdr.style.cursor = 'pointer';
        hdr.title = '点击折叠/展开该分类';
        hdr.addEventListener('click', () => {
          try {
            if (!window.__hmdaoCollapsedTypes) window.__hmdaoCollapsedTypes = new Set();
            const s = window.__hmdaoCollapsedTypes;
            if (s.has(aType)) s.delete(aType); else s.add(aType);
            if (typeof renderDebounced === 'function') renderDebounced(); else render();
          } catch (_) {}
        });
      } catch (_) {}
      c.appendChild(hdr);
    }
    // 折叠中的分类：保留标题（显示数量），跳过卡片渲染
    if (grouped && window.__hmdaoCollapsedTypes && window.__hmdaoCollapsedTypes.has(aType)) return;
    const gi = window.assets.indexOf(a); // a 在原始 assets 中的索引
    // ★2026-09-04 键控复用：同 stableKey 的卡已存在 → 就地更新动态字段并复用，跳过整段重建。
    const __key = stableKeyOf(a);
    const __existing = oldCardMap.get(__key);
    const __pool = (window.__hmdaoCardPool || (window.__hmdaoCardPool = new Map()));
    // ★2026-09-11 虚拟化：视口外的卡不挂载 DOM。已挂载的先卸下并存入复用池（滚动回来时免重建/重拉封面）。
    if (HMDAO_VIRTUALIZE && (i < __win.start || i >= __win.end)) {
      if (__existing) {
        try { if (typeof stopHoverVideoFrame === 'function') stopHoverVideoFrame(__existing); } catch (_) {}
        try { if (typeof stopHoverAudio === 'function') stopHoverAudio(); } catch (_) {}
        __existing.remove();
        __pool.set(__key, __existing);
      }
      return;
    }
    if (__existing) {
      patchCard(__existing, a, gi);
      if (HMDAO_VIRTUALIZE) hmdaoPositionCard(__existing, i, __m);
      c.appendChild(__existing); // 移动到正确顺序位
      return;
    }
    const __reused = __pool.get(__key);
    if (__reused) {
      __pool.delete(__key);
      patchCard(__reused, a, gi);
      if (HMDAO_VIRTUALIZE) hmdaoPositionCard(__reused, i, __m);
      c.appendChild(__reused);
      return;
    }
    const card = document.createElement('div');
    card.className = 'card' + (window.selected.has(gi) ? ' sel' : '');
    // ★2026-09-04 关键修复（侧栏卡死/切集不刷新的真凶）：必须给新建卡片打上稳定键。
    //   旧代码漏设 dataset.stableKey → renderNow 的 oldCardMap（按 data-stable-key 查询）永远为空
    //   → 每轮 renderNow 都把全部卡片当"新卡"整段重建、重加载封面图 → 主线程被 DOM 重建淹没 → 卡死；
    //   且旧卡的 cover/title 永远不会被 patchCard 就地更新 → 切集后封面/标题不刷新。
    card.dataset.stableKey = __key;
    card.dataset.idx = String(gi);
    // ★2026-09-03：抖音视频卡带上真实 awemeId，供「当前集」高亮/自动滚动与 📍 未播放 徽标精确匹配。
    if (a && a.awemeId) {
      try { card.dataset.awemeId = String(a.awemeId); } catch (_) {}
    }
    // ★2026-08-24：让 paintHoverFrame 能定位同 URL 视频卡以刷新 coverImg（hover 截帧常驻）
    if (a && a.url) {
      try { card.dataset.assetUrl = a.url; } catch (_) {}
    }

    // ★2026-08-22 信息流批量采集：开关开启时，卡片左上角加多选框（独立 batchSelection，不污染 selected）
    if (window.batchCollectEnabled) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'batchCb';
      // 样式由 sidepanel.css 的 .batchCb 统一控制，与参考图一致
      const key = a.awemeId || a.url || ('idx' + gi);
      cb.checked = window.batchSelection.has(key);
      cb.addEventListener('click', (e) => {
        e.stopPropagation(); // 不触发卡片预览/选中
        if (cb.checked) window.batchSelection.add(key); else window.batchSelection.delete(key);
      });
      card.appendChild(cb);
    }

    // 拖拽到桌面/文件夹/其他窗口：拖拽开始时（pointerdown）才预热字节，
    // ★2026-09-05 修复（切换模块延迟卡顿根因之一）：此前【建卡即预热】—— 每张图片卡创建
    //   都触发一次后台 FETCH_MEDIA 拉全量字节；抖音图床 URL 每轮扫描换签名 → 缓存恒失效
    //   → 切到「图片」模块 = 一次性几十个后台请求 + base64 解码，侧栏明显卡顿。
    //   改为纯懒加载：pointerdown（必然先于 dragstart）时才强制补取，拖拽功能不受影响。
    card.draggable = true;
    card.addEventListener('pointerdown', () => { ensureDragData(a, true); }, { passive: true });
    card.ondragstart = (e) => onCardDragStart(e, a);

    // 双击 → 预览
    card.ondblclick = () => { try { openPreview(parseInt(card.dataset.idx || '-1', 10)); } catch (_) {} };

    // 右键 → 上下文菜单
    card.oncontextmenu = (e) => {
      e.preventDefault();
      try { showContextMenu(e.clientX, e.clientY, parseInt(card.dataset.idx || '-1', 10)); } catch (_) {}
    };

    // 单击 → 单选 + 触发预览（用户实测"点卡片没反应"——双击入口在某些场景不可靠，单击应直接打开大预览）
    // ★2026-08-18 修复：用户反馈"点击任意卡片都产生选择状态，需要优化，只保留一个选择状态"。
    // 单击直接清空已选，仅选中当前。Shift+点击累加（仍支持批量下/导入）。
    // ★2026-08-24 修复：单击卡片立即打开大预览（之前只切换 .sel 状态，没任何视觉反馈，用户感知"没反应"）。
    card.onclick = (e) => {
      // 点击复选框（批量选择入口）不触发预览
      if (e && e.target && e.target.closest && e.target.closest('.batchCb')) return;
      const gi2 = parseInt(card.dataset.idx || '-1', 10);
      // ★2026-09-06（按用户要求改回）：单击只打开预览；下载在预览弹层里由用户点「下载」按钮触发
      //   （豆包音频卡的下载按钮走 openDownloadPanel → wsAudio 分支 → 直接落盘，不弹分辨率）。
      // 真正打开大预览，让 startDouyinFrameStream 等所有 preview 流程接管
      try { openPreview(gi2); } catch (_) {}
      if (e && e.shiftKey) {
        if (window.selected.has(gi2)) window.selected.delete(gi2); else window.selected.add(gi2);
      } else {
        const wasOnly = window.selected.size === 1 && window.selected.has(gi2);
        window.selected.clear();
        if (!wasOnly) window.selected.add(gi2);
      }
      // 同步所有可见卡片 .sel 状态（多选切换时仅重置样式无大开销）
      const list = document.getElementById('list');
      if (list) {
        const cards = list.querySelectorAll('.card');
        cards.forEach((el) => {
          const idx = parseInt(el.dataset.idx || '-1', 10);
          el.classList.toggle('sel', window.selected.has(idx));
        });
      }
    };

    // 音效：鼠标悬停即试听（爱给网等音效站），移开暂停。
    // ★2026-09-06 悬停防误碰：停留 700ms 才开始播（用户要求 0.5~1s）；
    //   未到 700ms 就移开 → 取消定时器，完全不发声。移开已播的 → stopHoverAudio 立即静音。
    // ★豆包朗读（WS 流式）同样适用：hoverPlayAudio 内部已分流（实体化后走侧栏 blob 播放）。
    if (a.type === 'audio') {
      let __hoverT = null;
      card.onmouseenter = () => {
        if (__hoverT) clearTimeout(__hoverT);
        __hoverT = setTimeout(() => { __hoverT = null; try { hoverPlayAudio(a); } catch (_) {} }, 700);
      };
      card.onmouseleave = () => {
        if (__hoverT) { clearTimeout(__hoverT); __hoverT = null; }
        // ★强制静音（不依赖 stopHoverAudio 内部的 overlay 判断）：
        //   移开瞬间直接 pause 侧栏 <audio> 并卸掉 src → 立即停、零残留音。
        //   预览大窗已打开时不卸 src（避免打断大窗播放），但一定 pause。
        try {
          const au = document.getElementById('previewAudio');
          if (au) {
            au.pause();
            const ovOpen = (document.getElementById('previewOverlay') || {}).classList
              && document.getElementById('previewOverlay').classList.contains('open');
            if (!ovOpen) { try { au.removeAttribute('src'); au.load(); } catch (_) {} }
          }
          if (typeof playToken !== 'undefined') playToken++;
        } catch (_) {}
        try { stopHoverAudio(); } catch (_) {}
      };
    }

    const icons = { image: '🖼', video: '🎬', audio: '🎵', model: '🧊', archive: '📦', netdisk: '🔗' };

    if (a.type === 'image') {
      const img = document.createElement('img');
      img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      img.draggable = false; // 交给卡片统一处理拖拽
      img.onerror = () => {
        img.style.display = 'none';
        if (!card.querySelector('.imgerr')) {
          const e = document.createElement('div');
          e.className = 'imgerr tag';
          e.textContent = '🖼'; e.style.fontSize = '20px'; e.style.lineHeight = '48px';
          e.title = '缩略图源站无法访问（与 3D 预览无关）';
          card.insertBefore(e, card.firstChild);
        }
      };
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        imgDimensions[a.url] = { w, h };
        // 更新尺寸标签
        const dimEl = card.querySelector('.dim');
        if (dimEl) dimEl.textContent = `${w}×${h}`;
        // 实时应用筛选
        if (shouldExclude(a)) card.style.display = 'none';
        // ★2026-08-18：尺寸已知后，若分辨率排序启用，轻量重排列表（高分辨率靠前）
        rescheduleByDimension();
      };
      card.appendChild(img);
      // ★根因修复：避免侧栏直接 img.src=第三方URL 触发「Third-party cookie will be blocked」。
      // 经后台 relay（credentials:'omit'）取字节 → blob: URL，侧栏不再直连第三方源。
      // ★2026-09-05：改走「去重缓存 + 4 路并发限流 + 视口懒加载」，避免 98 张图片卡并发打满 SW
      coverWhenVisible(card, a.url, (burl) => {
        if (burl) { img.src = burl; return; }
        // relay 取不到字节时：防盗链 CDN 绝不直连（侧栏 Referer 必 403，只剩噪声），保留占位图标；
        // 其它站点仍保留直连兜底，不影响原本能正常显示的封面。
        if (!isRefererGatedCdn(a.url)) img.src = a.url;
      });
      // 尺寸标签
      const dim = document.createElement('div');
      dim.className = 'dim';
      if (imgDimensions[a.url]) dim.textContent = `${imgDimensions[a.url].w}×${imgDimensions[a.url].h}`;
      card.appendChild(dim);
    } else if (a.type === 'video' || a.dynamic) {
      // ★不在此处常驻 <video>：每个 video 元素会占用一个 WebMediaPlayer 实例，
      // 列表里视频多了会触发 "too many WebMediaPlayers" 硬限制，导致整体预览失效。
      // 改为：优先显示封面图（零播放器开销），无封面回退 🎬 图标；
      // 鼠标悬停时由 hoverVideoFrame 临时创建单例 <video> 抽首帧叠加显示（移开即销毁）。
      // 2026-08-24 增强：coverImg 默认 opacity:0，加载成功淡入，避免与 tag emoji 叠加闪烁；
      // relay 失败时轮询检查 a.__hoverCoverBlob（hover 抽帧截帧常驻），实现"hover 后移开也显示"。
      // ★2026-09-04 封面消毒（用户实测 lf-zt.douyin.com/.../index.html 被当封面 → media-proxy 422 / NotSameSite）：
      //   脏封面来自 defaultCover（页面图资产兜底），既走新扫描(SCAN_RESULT) 也走持久化恢复(lastScan)，
      //   统一在渲染入口拦截，避免 Network 堆积无用请求、也避免脏图卡死封面加载。
      function hmdaoIsBadCover(u) {
        try {
          var s = String(u || '');
          if (!s) return true;
          if (/\.(html?|js|css|json|txt|xml)(\?|#|$)/i.test(s)) return true;       // 结尾/带参 非图片
          if (/x-storage-web|uc-assets\/zt|index\.html/i.test(s)) return true;      // 抖音 SPA 资源壳(非图)
          // ★2026-09-04 修复：绝不能把平台【页面 URL】当封面（如 https://www.douyin.com/jingxuan/game）。
          //   这些 URL 在 media-proxy 会 422 / 被防盗链拦截，还会触发 Third-party cookie 告警。
          //   抖音/B站/YouTube 真实封面都在 CDN 子域，主域路径一定是页面。
          if (/^https?:\/\/[^/]*douyin\.com\//i.test(s) && !/\.(jpg|jpeg|png|gif|webp|avif|bmp|ico|mp4|webm|mov|m4v|mkv|ts|m3u8)(\?|#|$)/i.test(s)) return true;
          if (/^https?:\/\/[^/]*bilibili\.com\//i.test(s) && !/\.(jpg|jpeg|png|gif|webp|avif|bmp|ico|mp4|webm|mov|m4v|mkv|ts|m3u8)(\?|#|$)/i.test(s)) return true;
          if (/^https?:\/\/[^/]*youtube\.com\//i.test(s) && !/\.(jpg|jpeg|png|gif|webp|avif|bmp|ico|mp4|webm|mov|m4v|mkv|ts|m3u8)(\?|#|$)/i.test(s)) return true;
          if (/^https?:\/\/[^/]*tiktok\.com\//i.test(s) && !/\.(jpg|jpeg|png|gif|webp|avif|bmp|ico|mp4|webm|mov|m4v|mkv|ts|m3u8)(\?|#|$)/i.test(s)) return true;
          // ★2026-09-08 补充（runninghub og 分享图反复复现的根因）：
          //   旧封面会被写进持久化资产（lastScan），而增量合并按 URL 去重 → 视频 URL 不变时
          //   新扫描结果【不会覆盖】已有资产 → 脏封面即便在 scan.js 侧已不再产生，也会随
          //   面板恢复/重开一直留着。故必须在渲染入口这道统一拦截里也挡掉 og/分享/品牌图
          //   （实测 og-share-cn.png 既是品牌图、服务端又已 404，双重无用）。
          if (/og[-_.]?(?:image|share|poster)|social[-_]?(?:share|preview)|apple-touch|share[-_]?(?:image|icon|logo|img)/i.test(s)) return true;
          return false;
        } catch (_) { return false }
      }
      if (hmdaoIsBadCover(a.cover)) a.cover = '';
      // ★2026-09-11：封面已被判为「CDN 统一占位图」→ 清空，改走无封面路径（🎬 + 抽帧兜底）。
      //   覆盖"占位图在被识别出来之前就已经上屏"的卡：下一轮渲染即被纠正，且命中后不再发网络请求。
      if (a.cover && coverIsPlaceholder(coverUrlOf(a))) a.cover = '';
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.dataset.coverState = a.cover ? 'pending' : 'none'; // pending → ok | error | hover | empty
      // ★2026-09-08：无封面（a.cover 为空）的视频卡 → 主动抽首帧当缩略图。
      //   覆盖 runninghub / 即梦 / iMini 这类「多视频页、视频卡没有独立封面」的站点：
      //   它们既不进 relay 也不进 onerror（两者都要求 a.cover 非空）→ 此前恒为 🎬 占位。
      if (!a.cover && a && a.type === 'video') {
        try {
          tag.textContent = '🎬';
          // ★2026-09-11：该视频此前已悬停/抽过帧 → 直接复用缓存帧，不再重复拉字节
          const cachedHover = a.url ? HMDAO_HOVER_COVER.get(a.url) : '';
          if (cachedHover) {
            applyHoverFrameToTag(a, tag, cachedHover);
          } else {
            hmdaoEnqueueFrameExtract(card, a, (burl) => {
              if (!burl) return;
              applyHoverFrameToTag(a, tag, burl);
            });
          }
        } catch (_) {}
      }
      if (a.cover) {
        // 封面图：经后台 relay 取字节 → blob，避免侧栏直连第三方触发第三方 Cookie 告警
        const coverImg = document.createElement('img');
        coverImg.className = 'cover-img';
        coverImg.alt = '封面';
        coverImg.referrerPolicy = 'no-referrer';
        coverImg.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:6px;display:block;opacity:0;transition:opacity .15s';
        tag.textContent = '🎬';
        tag.style.cssText = 'font-size:24px;line-height:48px;display:flex;align-items:center;justify-content:center;background:#0f1620;';
        let coverResolved = false; // 任一路径成功（relay/hover缓存）即置 true，避免多次切换 emoji
        const applyHoverCover = () => {
          if (coverResolved) return;
          if (a.__hoverCoverBlob) {
            coverResolved = true;
            coverImg.src = a.__hoverCoverBlob;
            coverImg.style.opacity = '1';
            tag.dataset.coverState = 'hover';
            tag.textContent = '';
            tag.appendChild(coverImg);
            tag.classList.add('tag-cover');
          }
        };
        coverImg.onerror = () => {
          if (coverResolved) return;
          tag.dataset.coverState = 'error';
          tag.title = (tag.title || '') + ' · 封面字节拉取失败（hover console 看详情）';
          console.warn('[HMDAO][card] 封面拉取失败:', a.cover);
          // ★2026-09-11：封面已被判为「CDN 统一占位图」→ 立即判死，不做 4 次 hover 重试
          //   （每次重试都会重新拉一遍同一张占位图，纯浪费 SW 通道），直接显示 🎬 走抽帧兜底。
          if (coverIsPlaceholder(coverUrlOf(a))) {
            tag.textContent = '🎬';
            return;
          }
          // ★2026-08-25：cover 失效时若 a 是真视频且 a.url 命中真视频格式（VID_RE），主动 fire-and-forget 抽帧
          // 兜底（不依赖用户 hover）。覆盖 liblib 的 bat.bing 跟踪像素 / douyin 的 blob 加密等场景。
          // ★2026-09-01：与下方 VID_RE_FOR_COVER 保持同一套扩展判定（含无扩展名的抖音 CDN）
          const VID_RE_FOR_COVER_ERR = /(\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|ts)([?#]|$))|((^|\/\/|\.)(v\d+-web\.)?douyinvod\.com\/)|((\?|&)mime_type=video)|((\?|&)mime=video)/i;
          // ★2026-09-05 节流（侧栏卡死真凶之一）：抽帧要拉整段视频字节，103 张卡逐张 8MB
          //   会把 SW 与消息通道彻底打满。三道闸：① 仅视口内卡片 ② 全局预算 6 次 ③ 字节 8MB→2MB。
          // ★2026-09-12 收口到统一调度器：原 onerror 兜底里的「预算扣减 + 内联抽帧块」统一走 hmdaoEnqueueFrameExtract，
          //   避免与无封面分支重复扣预算；tryHover / 🚫 等视觉反馈保留在下方不变。
          if (a && a.type === 'video' && a.url && VID_RE_FOR_COVER_ERR.test(a.url) && coverVisibleNow(card)) {
            hmdaoEnqueueFrameExtract(card, a, (burl) => {
              if (!burl || coverResolved) return;
              coverResolved = true;
              a.__hoverCoverBlob = burl;
              coverImg.src = burl;
              coverImg.style.opacity = '1';
              tag.dataset.coverState = 'hover';
              tag.textContent = '';
              tag.appendChild(coverImg);
              tag.classList.add('tag-cover');
            });
          }
          // 不立即显示 🚫：先等 hover 截帧缓存 4 次×300ms（最常见场景：用户随即 hover）
          let tries = 0;
          const tryHover = () => {
            if (coverResolved) return;
            applyHoverCover();
            if (coverResolved) return;
            if (++tries >= 4) {
              tag.textContent = '🚫';
              return;
            }
            setTimeout(tryHover, 300);
          };
          tryHover();
        };
        coverImg.onload = () => {
          if (coverResolved) return;
          coverResolved = true;
          coverImg.style.opacity = '1';
        };
        // ★2026-09-01 修复：封面 URL 可能是数组（RENDER_DATA 部分结构 cover 为 [url,...]），
        // 统一规整为字符串首元素，避免 loadImageViaRelay 收到数组导致封面空白。
        const coverUrl = Array.isArray(a.cover) ? (a.cover[0] || '') : (a.cover || '');
        card.dataset.cover = coverUrl || ''; // ★2026-09-04：记录当前封面，键控复用时仅在变化时重载
        // ★2026-09-11 修复（虚拟化复用池）：不预写 coverKey；等封面真正加载成功后再写。
        // 否则卡片若在视口外被立即卸载进复用池，coverKey 已存在 → patchCard 误以为已加载过，
        // 滚动回来时不会重新触发 coverWhenVisible，导致封面永远空白。
        card.dataset.coverKey = '';
        // ★2026-09-05：视口内才取封面（103 张卡只有十几张可见），并走 4 路限流队列
        coverWhenVisible(card, coverUrl, (burl) => {
          if (coverResolved) return;
          if (burl) {
            coverImg.src = burl;
            tag.dataset.coverState = 'ok';
            card.dataset.coverKey = coverUrl ? coverCacheKey(coverUrl) : '';
            tag.title = (tag.title || '') + ' · 封面已加载（blob）';
            // onload 会触发 opacity 淡入
          } else if (tag.dataset.coverState === 'pending') {
            // loadImageViaRelay 静默返回 null（catch 吞异常）：单独再记一次，区分 onerror 的真网络错误
            tag.dataset.coverState = 'empty';
            console.warn('[HMDAO][card] 封面 relay 返回空:', coverUrl, '(referer=', window.__sourcePageUrl, ')');
            // 第一次遇到时在状态栏简要提示用户（不打扰、不重复）
            if (!window.__hmdao_coverEmptyWarned) {
              window.__hmdao_coverEmptyWarned = true;
              if (typeof setStatus === 'function') {
                setStatus('⚠ 封面字节拉取失败：后台 SW fetch 返回空。把鼠标放在卡片上查看封面 URL，详见 service worker 控制台 [HMDAO][bg] FETCH_MEDIA 日志。', true);
              }
            }
            // ★2026-08-24 修复（问题2 根因）：cover 指向本地后端资产（127.0.0.1:3000/api/assets/content/...）
            // 这类封面是「之前在 Ddayup 保存资产」时后端生成的缩略图，现在后端该 uuid 已失效 → 404。
            // 不依赖用户 hover：主动 fire-and-forget 用真实视频直链（a.url）经后台拉字节 → canvas 截首帧 → 作默认封面。
            // ★2026-08-24 扩展触发条件：除本地后端失效场景外，**a.type==='video' 且 a.url 命中真视频格式**时也兜底
            // （覆盖"v.poster 缺失 + data-* 误推非视频"等场景，让视频卡始终有缩略图）。
            // ★2026-09-01 扩展：抖音 v26-web CDN 直链【没有文件扩展名】
            //   （路径 /video/tos/.../xxx/ 后直接跟 ?a=6383&...&mime_type=video_mp4），
            //   旧正则只认 .mp4 等扩展名 → 抖音卡永远命中不到 → 抽首帧兜底从未生效（卡片恒显示 🪫）。
            //   扩展为：扩展名 OR 视频 CDN 域名 OR mime_type/mime=video 查询参数。
            //   （已实测：对抖音真实 URL 命中；对抖音图床/普通图 URL 0 误伤）
            const VID_RE_FOR_COVER = /(\.(mp4|webm|mov|m4v|mkv|ogv|m3u8|flv|ts)([?#]|$))|((^|\/\/|\.)(v\d+-web\.)?douyinvod\.com\/)|((\?|&)mime_type=video)|((\?|&)mime=video)/i;
            const isLocalBackendCover = /127\.0\.0\.1:3000|localhost:3000/.test(coverUrl || '');
            const isRealVideoUrl = a && a.type === 'video' && a.url && VID_RE_FOR_COVER.test(a.url);
            // ★2026-09-01 并发守卫：抽帧需创建临时 <video>，列表多个视频卡同时失败会并发创建
            //   多个实例，可能触发 Chromium "too many WebMediaPlayers" 硬限制导致整体预览失效。
            //   用全局计数限制并发（上限 2），并在成功/失败/超时路径都释放，防 slot 泄漏。
            // ★2026-09-12 收口到统一调度器：原 relay 空返回兜底里的「预算扣减 + 内联抽帧块」统一走 hmdaoEnqueueFrameExtract，
            //   并发/预算/2MB 上限/超时释放由 hmdaoFramePump + hmdaoRunFrameExtract 统一管控；tryHover2 / 🪫 反馈保留在下方不变。
            if ((isLocalBackendCover || isRealVideoUrl) && a.url && !coverResolved && coverVisibleNow(card)) {
              hmdaoEnqueueFrameExtract(card, a, (burl) => {
                if (!burl || coverResolved) return;
                coverResolved = true;
                a.__hoverCoverBlob = burl;
                coverImg.src = burl;
                coverImg.style.opacity = '1';
                tag.dataset.coverState = 'hover';
                tag.textContent = '';
                tag.appendChild(coverImg);
                tag.classList.add('tag-cover');
              });
            }
            // 也尝试 hover 截帧缓存（用户可能随即 hover）
            // ★2026-09-11：占位图不重试（CDN 软失败，重试只会拿到同一张图）
            if (coverIsPlaceholder(coverUrl)) { tag.textContent = '🎬'; return; }
            let tries2 = 0;
            const tryHover2 = () => {
              if (coverResolved) return;
              applyHoverCover();
              if (coverResolved) return;
              if (++tries2 >= 4) {
                tag.textContent = '🪫';
                return;
              }
              setTimeout(tryHover2, 300);
            };
            tryHover2();
          }
        });
        tag.appendChild(coverImg);
        tag.classList.add('tag-cover');
      } else {
        // 无封面源（只抓到视频直链）：立即尝试 hover 截帧缓存
        tag.textContent = '⛔';
        tag.dataset.coverState = 'none';
        tag.style.cssText += 'font-size:22px;line-height:48px;cursor:pointer;color:#6e7681';
        if (a.__hoverCoverBlob) {
          const coverImg = document.createElement('img');
          coverImg.className = 'cover-img';
          coverImg.src = a.__hoverCoverBlob;
          coverImg.referrerPolicy = 'no-referrer';
          coverImg.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:6px;display:block;opacity:1';
          tag.textContent = '';
          tag.appendChild(coverImg);
          tag.classList.add('tag-cover');
        }
      }
      // ★便于用户定位问题：把封面 / 媒体 URL 写到 title，悬停可见。
      // 把 hoverVideoFrame 的「点击预览 · 悬停抽帧」摘要拼到前面。
      tag.title = '点击预览 · 悬停抽帧' + (a.cover ? ('\n封面: ' + truncate(a.cover, 80)) : '\n⚠ 无封面源（只抓到视频直链）');
      // 悬停抽帧（单例 video，移开即清理）
      // ★2026-09-11 修复（鼠标扫过列表就把侧栏拖垮）：
      //   ① mouseenter 加 500ms 延迟 —— 只有"真正停留"才抽帧，快速划过直接跳过；
      //   ② mouseleave 立即 clearTimeout 撤销未执行的抽帧，并让在途结果失效（stopHoverVideoFrame 内序号自增）。
      let hoverFrameTimer = null;
      card.addEventListener('mouseenter', () => {
        try {
          if (hoverFrameTimer) clearTimeout(hoverFrameTimer);
          hoverFrameTimer = setTimeout(() => {
            hoverFrameTimer = null;
            try {
              // hoverVideoFrame 是 async：挂 catch 防止任何异常变成未捕获的 promise rejection（控制台红字）
              const p = hoverVideoFrame(a, card);
              if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch (_) {}
          }, 500);
        } catch (_) {}
      });
      card.addEventListener('mouseleave', () => {
        try { if (hoverFrameTimer) { clearTimeout(hoverFrameTimer); hoverFrameTimer = null; } } catch (_) {}
        try { stopHoverVideoFrame(card); } catch (_) {}
      });
      card.appendChild(tag);
    } else {
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = icons[a.type] || '📦';
      tag.style.fontSize = '20px'; tag.style.lineHeight = '48px'; tag.style.padding = '2px 6px';
      card.appendChild(tag);
      // 3D 模型卡片：离屏渲染真实缩略图替换 🧊 图标（仅可渲染格式，串行队列）
      if (a.type === 'model') queueModelThumb(a, card);
    }

    const name = document.createElement('div');
    name.className = 'name'; name.textContent = displayName(a); name.title = `${a.type}: ${a.url || ('页面音频#' + (a.audioIdx != null ? a.audioIdx : ''))}`;
    card.appendChild(name);
    // ★2026-08-23 P5：视频卡底部显示当前真实直链（同步抖音当前播放），便于核对"卡片与页面一致"。
    // 在 syncDouyinCurrentUrl 更新 a.url 后由 refreshCardUrl(a) 刷新此行。
    if (a.type === 'video') {
      const urlRow = document.createElement('div');
      urlRow.className = 'url-row';
      // ★2026-09-11 修复：urlRow 必须绝对定位，否则会撑高 video 卡片、破坏三列网格导致卡片重叠/错位。
      urlRow.style.cssText = 'position:absolute;left:0;right:0;bottom:18px;font-size:8px;color:#7cc4ff;background:rgba(13,17,23,.8);padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:2;';
      urlRow.textContent = a.url ? truncate(a.url, 46) : '';
      urlRow.title = a.url || '';
      card.appendChild(urlRow);
      a.__urlRow = urlRow;
    }
    // 卡片级「下载」按钮：点击即下载该单条（走 downloadSingle，已有顶部进度条），
    // 并在卡片上短暂显示该条状态（下载中/已保存），让用户对每条素材的下载进度有感知。
    if (a.type !== 'netdisk') {
      if (!HMDAO_VIRTUALIZE) card.style.position = 'relative';
      const dlBtn = document.createElement('button');
      dlBtn.className = 'card-dl-btn';
      dlBtn.textContent = '⬇';
      dlBtn.title = '下载此素材';
      const dlState = document.createElement('span');
      dlState.className = 'card-dl-state';
      dlBtn.onclick = (e) => {
        e.stopPropagation();
        if (dlBtn.disabled) return;
        dlBtn.disabled = true;
        dlState.style.display = '';
        dlState.textContent = '⏳ 下载中';
        downloadSingle(a).then(() => {
          dlState.textContent = '✅ 已保存';
          setTimeout(() => { dlState.style.display = 'none'; }, 2500);
          dlBtn.disabled = false;
        }).catch(() => {
          dlState.textContent = '⚠ 失败';
          dlState.style.background = 'rgba(248,81,73,0.9)';
          setTimeout(() => { dlState.style.display = 'none'; dlState.style.background = 'rgba(31,111,235,0.9)'; }, 2500);
          dlBtn.disabled = false;
        });
      };
      card.appendChild(dlBtn);
      card.appendChild(dlState);
    }
    // 网盘分享：卡片上直接给「深度解析」入口（打开网盘页自动填码并读文件列表）
    const isNetdiskType = a.type === 'netdisk' || a.type === 'archive' || a.type === 'netdisk-file';
    const isNetdiskUrl = /pan\.xunlei\.com\/s\/|pan\.quark\.cn\/s\/|pan\.baidu\.com\/s\//i.test(a.url || a.parentUrl || '');
    if (isNetdiskType && isNetdiskUrl) {
      if (!HMDAO_VIRTUALIZE) card.style.position = 'relative';
      const rbtn = document.createElement('button');
      rbtn.textContent = (a.tree && a.tree.length) ? '🔓 重新解析' : '🔓 深度解析';
      rbtn.title = '读取/刷新网盘文件列表';
      rbtn.style.cssText = 'position:absolute;right:4px;bottom:4px;font-size:12px;padding:6px 10px;z-index:3;border:none;border-radius:6px;background:#1a8cff;color:#0d1117;font-weight:600;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.3)';
      rbtn.onclick = (e) => { e.stopPropagation(); netdiskResolve(a); };
      card.appendChild(rbtn);
    }
    // 平台视频：标注「无水印源」徽标（B站/Douyin/YouTube 采集的是平台原画/无码流，
    // 不含片尾平台水印；若成片本身含水印（如 UP 主自加），属平台/作者内容，扩展无法去除）。
    const plat = (a.source || a.sourceDomain || (a.url ? (() => { try { return new URL(a.url).hostname; } catch (_) { return ''; } })() : ''));
    if (a.type === 'video' && /bilibili|douyin|bytedance|douyinvod|youtube|googlevideo/i.test(plat)) {
      const wm = document.createElement('span');
      wm.textContent = '无水印源';
      wm.style.cssText = 'position:absolute;left:5px;top:5px;font-size:9px;padding:1px 5px;border-radius:5px;background:rgba(46,160,67,0.85);color:#fff;z-index:3;pointer-events:none';
      if (!HMDAO_VIRTUALIZE) card.style.position = 'relative';
      card.appendChild(wm);
    }
    // ★2026-09-03 修复：抖音合集「未播放」徽标——判定从「对比合集 modal_id」改为「对比当前正在播放的那集」。
    //   旧逻辑拿 a.awemeId 与 modal_id 比，而每张卡的 awemeId 都是真实集(永≠modal_id) → 20 张全被打标。
    //   现用侧栏记录的 window.__hmdao_curAwemeId（SCAN_RESULT 带下来的当前集）判断：只有「非当前播放的那集」才标 📍。
    //   另外：a.notPlayed 是 scan.js 已算好的「浏览器未实际播放过」标记，二者取并集，确保当前集绝不被误标。
    const isCurDouyin = (a.type === 'video' && a.platform === 'douyin' && a.awemeId);
    if (isCurDouyin) {
      const curPlaying = (typeof window.__hmdao_curAwemeId === 'string') ? window.__hmdao_curAwemeId : '';
      const isNotCurrent = (curPlaying && String(curPlaying) !== String(a.awemeId)) || (a.notPlayed === true);
      if (isNotCurrent) {
        const badge = document.createElement('span');
        badge.className = 'hmdao-badge-unplayed';
        badge.textContent = '📍 未播放';
        badge.title = '该集在浏览器未播放过,字节未缓存。双击预览可能失败,请用预览弹层「▶ 切到此集播放」按钮让源页跳到该集并捕获。';
        badge.style.cssText = 'position:absolute;right:5px;top:5px;font-size:9px;padding:1px 5px;border-radius:5px;background:rgba(255,180,0,0.85);color:#332600;z-index:3;pointer-events:none';
        if (!HMDAO_VIRTUALIZE) card.style.position = 'relative';
        card.appendChild(badge);
      } else {
        // ★当前正在播放的那集：加高亮边框 + 自动滚动到可视区，源页切集时侧栏实时跟随。
        card.classList.add('hmdao-current');
        card.style.boxShadow = '0 0 0 2px #00d4aa, 0 0 10px rgba(0,212,170,0.5)';
        try {
          if (window.__hmdao_autoScrollCurrent && !card._hmdaoScrolled) {
            card._hmdaoScrolled = true;
            card.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        } catch (_) {}
      }
    }
    // ★2026-09-11：B站合集「当前集」高亮 + 📍未播放徽标（与抖音逻辑对等）。
    //   B站没有 awemeId/curAwemeId 体系，改用源页 URL 的 bvid+?p= 与卡片 url 比对：
    //   源页(侧栏记录的 __sourcePageUrl)切到哪一集，哪一集卡片就高亮；其余标「📍 未播放」。
    const isCurBili = (a.type === 'video' && a.source === 'bilibili-batch' && a.url);
    if (isCurBili) {
      const curBiliKey = (typeof biliEpisodeKey === 'function') ? biliEpisodeKey(window.__sourcePageUrl || '') : '';
      const isCurrent = !!curBiliKey && biliSameEpisode(a.url, window.__sourcePageUrl || '');
      if (isCurrent) {
        card.classList.add('hmdao-current');
        card.style.boxShadow = '0 0 0 2px #00d4aa, 0 0 10px rgba(0,212,170,0.5)';
        try {
          if (window.__hmdao_autoScrollCurrent && !card._hmdaoScrolled) {
            card._hmdaoScrolled = true;
            card.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        } catch (_) {}
      } else {
        const badge = document.createElement('span');
        badge.className = 'hmdao-badge-unplayed';
        badge.textContent = '📍 未播放';
        badge.title = '该集未在源页播放过。双击预览可能失败，请用预览弹层「▶ 切到该集播放」按钮让源页跳到该集。';
        badge.style.cssText = 'position:absolute;right:5px;top:5px;font-size:9px;padding:1px 5px;border-radius:5px;background:rgba(255,180,0,0.85);color:#332600;z-index:3;pointer-events:none';
        if (!HMDAO_VIRTUALIZE) card.style.position = 'relative';
        card.appendChild(badge);
      }
    }
    card.dataset.stableKey = __key;
    if (HMDAO_VIRTUALIZE) hmdaoPositionCard(card, i, __m);
    c.appendChild(card);
    } catch (__cardErr) {
      try { console.warn('[HMDAO][render] 单卡渲染失败，已跳过（不影响其余卡片）:', (__cardErr && __cardErr.message) || __cardErr); } catch (_) {}
    }
  });

  // ★2026-09-11 修复（"未发现可采集素材"闪现）：
  //   扫描进行中 / 切站时 assets 会被短暂清空（或首帧尚未到达），此时渲染出的空态
  //   会闪一句"未发现可采集素材，请确认页面已加载"，误导用户以为采集失败。
  //   判定：1.5s 内曾有过资产 → 视为「扫描中/切换中」，不显示"未发现"，只显示"正在扫描…"。
  let __hadAssetsRecently = false;
  try {
    const __n = Array.isArray(window.assets) ? window.assets.length : 0;
    if (__n > 0) __lastAssetsAt = Date.now();
    __hadAssetsRecently = __lastAssetsAt > 0 && (Date.now() - __lastAssetsAt) < 1500;
  } catch (_) {}
  // ★2026-09-11 虚拟化：插入全列表高度占位(sizer)，使滚动条代表"完整列表"而非仅已挂载窗口。
  if (HMDAO_VIRTUALIZE && __m) {
    const __totalRows = Math.ceil(filtered.length / __m.COLS);
    const __totalH = Math.max(0, __m.PAD * 2 + __totalRows * __m.rowH - __m.GAP);
    let __sizer = c.querySelector('#listSizer');
    if (!__sizer) { __sizer = document.createElement('div'); __sizer.id = 'listSizer'; __sizer.style.cssText = 'position:absolute;left:0;top:0;width:1px;pointer-events:none;'; c.appendChild(__sizer); }
    __sizer.style.height = __totalH + 'px';
  }
  // 清理上一轮残留的空态（避免重复堆叠），本轮按需重建
  c.querySelectorAll('.hmdao-empty').forEach((el) => el.remove());
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'hmdao-empty';
    empty.style.cssText = 'position:absolute;left:0;right:0;top:' + (__m ? __m.PAD : 10) + 'px;text-align:center;color:#6e7681;font-size:11px;padding:20px';
    if (!window.assets.length) {
      empty.textContent = __hadAssetsRecently ? '正在扫描…' : '未发现可采集素材，请确认页面已加载';
    } else {
      empty.textContent = '当前类型/尺寸筛选下没有素材';
    }
    c.appendChild(empty);
  }
  // ★2026-09-11 渲染完成后强制同步卡片尺寸，确保每张卡都是正方形且不撑高
  try { hmdaoUpdateCardSize(); } catch (_) {}
}

function shouldExclude(a) {
  if (!minWidth && !minHeight && !excludeIcons && !blockWatermark) return false;
  // ★2026-08-18：域名在「水印来源屏蔽」名单 → 直接隐藏（平台夹杂水印，不采）
  if (blockWatermark && isBlockedHost(a.url)) return true;
  const dim = imgDimensions[a.url];
  if (!dim) return false; // 非图片或未加载 → 不排除
  if (excludeIcons && dim.w <= 64 && dim.h <= 64) return true;
  if (minWidth && dim.w < minWidth) return true;
  if (minHeight && dim.h < minHeight) return true;
  return false;
}

function reapplyFilters() {
  document.querySelectorAll('#list .card').forEach((card) => {
    const idx = parseInt(card.dataset.idx || '-1', 10);
    const a = getAsset(idx);
    if (!a) return;
    card.style.display = shouldExclude(a) ? 'none' : '';
  });
}
