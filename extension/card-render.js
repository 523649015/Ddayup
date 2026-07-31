// ===== 资产去重 + 列表渲染（卡片簇） =====
// 依赖 sidepanel.js 顶部全局：assets / selected / currentFilter / imgDimensions /
// ensureDragData / openPreview / showContextMenu / hoverPlayAudio / stopHoverAudio /
// loadImageViaRelay / displayName / getAsset / queueModelThumb / netdiskResolve /
// window.__sourcePageUrl（均在 sidepanel.js 加载后可用，故本文件在其之后加载）。
// 另被 bulk-actions.js 在入库时调用 deduplicateImages / render，故本文件须在 bulk-actions.js 之前加载。

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

// ===== 按规范类型计数（D4：统一经 normalizeAssetType 归类，避免非规范 type 漏计）=====
// 任何拼写/大小写/别名（如 img/mp3/3d/pan）都会归一回 ASSET_TYPES 规范值再计数；
// 无法识别的 type 归入 cntAll 但不在分类 chip 显示（与 ingestAssets 保留原值策略一致）。
function countByType(list) {
  const counts = { image: 0, video: 0, audio: 0, model: 0, archive: 0, netdisk: 0 };
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

function renderDebounced() {
  if (__renderTimer) clearTimeout(__renderTimer);
  __renderTimer = setTimeout(() => { __renderTimer = null; renderNow(); }, 150);
}

function render() { renderDebounced(); }

function renderNow() {
  const c = document.getElementById('list');

  const filtered = currentFilter === 'all' ? assets : assets.filter((a) => a.type === currentFilter);
  const sig = filtered.map((a) => (a.type || '') + '|' + (a.url || '')).join('__SEP__');
  if (sig === __lastRenderSig) return; // 无变化：跳过重建，消除闪烁
  __lastRenderSig = sig;

  c.innerHTML = '';

  // 计数（走单一事实来源归一化，替代散落的 a.type === 'image' 硬编码比较）
  document.getElementById('cntAll').textContent = assets.length;
  const cnt = countByType(assets);
  document.getElementById('cntImg').textContent = cnt.image;
  document.getElementById('cntVid').textContent = cnt.video;
  document.getElementById('cntAud').textContent = cnt.audio;
  document.getElementById('cntMod').textContent = cnt.model;
  document.getElementById('cntArc').textContent = cnt.archive;
  document.getElementById('cntNet').textContent = cnt.netdisk;

  filtered.forEach((a) => {
    const gi = assets.indexOf(a); // a 在原始 assets 中的索引
    const card = document.createElement('div');
    card.className = 'card' + (selected.has(gi) ? ' sel' : '');
    card.dataset.idx = String(gi);
    // 拖拽到桌面/文件夹/其他窗口：渲染即预热字节（确保拖拽前已缓存为真实 File），
    // pointerdown 时强制补取最可能被拖的这张（不受并发限制）
    card.draggable = true;
    if (a.type !== 'video') ensureDragData(a, false);
    card.addEventListener('pointerdown', () => { ensureDragData(a, true); }, { passive: true });
    card.ondragstart = (e) => onCardDragStart(e, a);

    // 双击 → 预览
    card.ondblclick = () => openPreview(gi);

    // 右键 → 上下文菜单
    card.oncontextmenu = (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, gi);
    };

    // 单击 → 选择/取消
    card.onclick = () => {
      if (selected.has(gi)) selected.delete(gi); else selected.add(gi);
      card.classList.toggle('sel');
    };

    // 音效：鼠标悬停即试听（爱给网等音效站），移开暂停
    if (a.type === 'audio') {
      card.onmouseenter = () => hoverPlayAudio(a);
      card.onmouseleave = () => stopHoverAudio();
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
      };
      card.appendChild(img);
      // ★根因修复：避免侧栏直接 img.src=第三方URL 触发「Third-party cookie will be blocked」。
      // 经后台 relay（credentials:'omit'）取字节 → blob: URL，侧栏不再直连第三方源。
      loadImageViaRelay(a.url, window.__sourcePageUrl).then((burl) => { img.src = burl || a.url; });
      // 尺寸标签
      const dim = document.createElement('div');
      dim.className = 'dim';
      if (imgDimensions[a.url]) dim.textContent = `${imgDimensions[a.url].w}×${imgDimensions[a.url].h}`;
      card.appendChild(dim);
    } else if (a.type === 'video') {
      // ★不在此处常驻 <video>：每个 video 元素会占用一个 WebMediaPlayer 实例，
      // 列表里视频多了会触发 "too many WebMediaPlayers" 硬限制，导致整体预览失效。
      // 改为：优先显示封面图（零播放器开销），无封面回退 🎬 图标；
      // 鼠标悬停时由 hoverVideoFrame 临时创建单例 <video> 抽首帧叠加显示（移开即销毁）。
      const tag = document.createElement('div');
      tag.className = 'tag';
      if (a.cover) {
        // 封面图：经后台 relay 取字节 → blob，避免侧栏直连第三方触发第三方 Cookie 告警
        const coverImg = document.createElement('img');
        coverImg.className = 'cover-img';
        coverImg.alt = '封面';
        coverImg.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:6px;display:block';
        tag.textContent = '🎬';
        tag.style.cssText = 'font-size:24px;line-height:48px;display:flex;align-items:center;justify-content:center;background:#0f1620;';
        coverImg.onerror = () => { tag.textContent = '🎬'; }; // 封面拉取失败回退图标
        loadImageViaRelay(a.cover, window.__sourcePageUrl).then((burl) => { if (burl) coverImg.src = burl; });
        tag.appendChild(coverImg);
      } else {
        tag.textContent = '🎬';
        tag.style.fontSize = '24px'; tag.style.lineHeight = '48px'; tag.style.cursor = 'pointer';
      }
      tag.title = '点击预览视频 · 悬停抽帧';
      // 悬停抽帧（单例 video，移开即清理）
      card.addEventListener('mouseenter', () => hoverVideoFrame(a, card));
      card.addEventListener('mouseleave', () => stopHoverVideoFrame(card));
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
    // 网盘分享：卡片上直接给「深度解析」入口（打开网盘页自动填码并读文件列表）
    if (a.type === 'netdisk') {
      card.style.position = 'relative';
      const rbtn = document.createElement('button');
      rbtn.textContent = '🔓 深度解析';
      rbtn.style.cssText = 'position:absolute;right:3px;bottom:3px;font-size:9px;padding:2px 5px;z-index:3;border:none;border-radius:5px;background:#1a8cff;color:#fff;cursor:pointer';
      rbtn.onclick = (e) => { e.stopPropagation(); netdiskResolve(a); };
      card.appendChild(rbtn);
    }
    c.appendChild(card);
  });

  if (!filtered.length && c.children.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'grid-column:1/-1;text-align:center;color:#6e7681;font-size:11px;padding:20px';
    empty.textContent = assets.length ? '当前类型/尺寸筛选下没有素材' : '未发现可采集素材，请确认页面已加载';
    c.appendChild(empty);
  }
}

function shouldExclude(a) {
  if (!minWidth && !minHeight && !excludeIcons) return false;
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
