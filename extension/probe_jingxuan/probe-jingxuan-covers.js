// HMDAO 探针：抖音 jingxuan 页面 RENDER_DATA 结构 + extractVideoCovers 覆盖逻辑排查
// 用法：
//   1. 打开 https://www.douyin.com/jingxuan?modal_id=7672225675125837094
//   2. 等页面 + 视频加载完（控制台无明显红色错误）
//   3. 在 DevTools Console 粘贴本脚本整段回车执行
//   4. 把输出（"=== PROBE OUTPUT START ===" 到 "=== PROBE OUTPUT END ==="）发给 HMDAO 助手
//
// 目标：定位"侧栏抖音卡片显示电子营业执照"封面的真实根因——
//  假设 1: RENDER_DATA 是新结构（awemeId 驼峰），scan.js 的 extractVideoCovers 仍按老字段（aweme_id 下划线）读取 → byKey 为空
//  假设 2: chosen（默认封面）取自 RENDER_DATA 第一个有 video.play_addr 的对象，而第一个恰好是「电子营业执照」推广视频
//  假设 3: walk 找不到目标 modal_id 对应的 aweme 对象（new structure 字段错配）

(function probeJingxuanCovers() {
  const lines = [];
  const log = (s) => { lines.push(s); };

  // ---- 0. 基础页面信息 ----
  log('=== PROBE OUTPUT START ===');
  log('TIME: ' + new Date().toISOString());
  log('URL: ' + location.href);
  log('UA: ' + navigator.userAgent);
  const url = new URL(location.href);
  const modal_id = url.searchParams.get('modal_id') || url.searchParams.get('aweme_id') || '';
  log('modal_id: ' + JSON.stringify(modal_id));
  log('title: ' + document.title);

  // ---- 1. RENDER_DATA 是否存在 + 解码是否成功 ----
  const rEl = document.querySelector('script#RENDER_DATA, script[id="RENDER_DATA"]');
  log('RENDER_DATA element exists: ' + !!rEl);
  if (!rEl) {
    log('!! RENDER_DATA 不存在 → scan.js extractVideoCovers 全部走 og:image/<video poster>/<img> 兜底');
    return finish();
  }
  log('RENDER_DATA element id: ' + rEl.id);
  log('RENDER_DATA text length: ' + (rEl.textContent || '').length);

  let data = null;
  let parseErr = null;
  try {
    data = JSON.parse(decodeURIComponent(rEl.textContent));
    log('RENDER_DATA parsed OK (decodeURIComponent)');
  } catch (e1) {
    parseErr = e1;
    try {
      data = JSON.parse(rEl.textContent);
      log('RENDER_DATA parsed OK (raw)');
    } catch (e2) {
      log('!! RENDER_DATA 解析失败: ' + e1.message + ' / ' + e2.message);
      return finish();
    }
  }

  // ---- 2. RENDER_DATA 顶层结构 ----
  log('-- top-level keys --');
  log(JSON.stringify(Object.keys(data).slice(0, 30)));
  if (data.app) log('data.app keys: ' + JSON.stringify(Object.keys(data.app).slice(0, 30)));
  if (data.app && data.app.videoDetail) {
    const vd = data.app.videoDetail;
    log('data.app.videoDetail EXISTS (new structure)');
    log('  vd keys (first 20): ' + JSON.stringify(Object.keys(vd).slice(0, 20)));
    log('  vd.awemeId: ' + JSON.stringify(vd.awemeId));
    log('  vd.aweme_id (camel vs snake): ' + JSON.stringify(vd.aweme_id));
    log('  vd.desc / itemTitle: ' + JSON.stringify(vd.desc) + ' / ' + JSON.stringify(vd.itemTitle));
    const vid = vd.video || {};
    log('  vd.video keys: ' + JSON.stringify(Object.keys(vid).slice(0, 25)));
    const cover = vid.cover;
    if (cover) {
      log('  vd.video.cover type: ' + typeof cover + ' (object? ' + (typeof cover === 'object') + ')');
      if (typeof cover === 'object' && cover) {
        log('  vd.video.cover keys: ' + JSON.stringify(Object.keys(cover).slice(0, 10)));
        const ul = cover.url_list || cover.urlList || [];
        log('  vd.video.cover.url_list[0]: ' + JSON.stringify(ul[0]));
      } else if (typeof cover === 'string') {
        log('  vd.video.cover (string): ' + cover);
      }
    }
    // 备用：originCover / dynamicCover / gaussianCover
    log('  vd.video.originCover: ' + JSON.stringify(vid.originCover));
    log('  vd.video.dynamicCover: ' + JSON.stringify(vid.dynamicCover));
    // bitRateList
    if (vid.bitRateList && vid.bitRateList[0]) {
      log('  vd.video.bitRateList[0] keys: ' + JSON.stringify(Object.keys(vid.bitRateList[0])));
      const br0 = vid.bitRateList[0];
      log('  vd.video.bitRateList[0].playAddr[0].src: ' + (br0.playAddr && br0.playAddr[0] && br0.playAddr[0].src));
    }
  } else {
    log('!! data.app.videoDetail 不存在');
  }

  // 顶层 aweme_list（旧结构）
  if (data.aweme_list) {
    log('!! OLD STRUCTURE: data.aweme_list 存在（顶层），length=' + data.aweme_list.length);
    if (data.aweme_list[0]) {
      log('  aweme_list[0].aweme_id: ' + data.aweme_list[0].aweme_id);
      log('  aweme_list[0].awemeId: ' + data.aweme_list[0].awemeId);
      const c0 = data.aweme_list[0].video && data.aweme_list[0].video.cover;
      log('  aweme_list[0].video.cover.url_list[0]: ' + (c0 && c0.url_list && c0.url_list[0]));
    }
  }

  // ---- 3. 模拟 scan.js extractVideoCovers 的 walk 逻辑 ----
  log('-- 模拟 walk() 行为 --');
  const byKey = {};
  let chosen = null;
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 12) return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, depth + 1)); return; }
    const hasV = o.video && (o.video.play_addr || o.video.download_addr);
    if ((o.aweme_id || o.awemeId || hasV) && !chosen) {
      chosen = o;
    }
    if (modal_id && String(o.aweme_id || o.awemeId) === String(modal_id)) {
      chosen = o;
      log('  ★ walk 找到 modal_id 匹配: aweme_id=' + o.aweme_id + ' / awemeId=' + o.awemeId);
    }
    // 这是 scan.js 当前用来填 byKey 的 if
    if (o.aweme_id && o.video && o.video.cover && o.video.cover.url_list && o.video.cover.url_list[0]) {
      byKey['aweme:' + o.aweme_id] = o.video.cover.url_list[0].replace(/\\\//g, '/');
    }
    // 模拟新结构：awemeId 驼峰也能填 byKey（如果 scan.js 兼容）
    if (o.awemeId && o.video && o.video.cover && o.video.cover.url_list && o.video.cover.url_list[0]) {
      byKey['aweme:' + o.awemeId + '_NEW'] = o.video.cover.url_list[0].replace(/\\\//g, '/');
    }
    for (const k in o) { try { walk(o[k], depth + 1); } catch (_) {} }
  };
  walk(data, 0);
  log('walk 命中 aweme_list 风格的 aweme_id 数量: ' + Object.keys(byKey).filter((k) => !k.endsWith('_NEW')).length);
  log('walk 命中 awemeId(驼峰) 数量: ' + Object.keys(byKey).filter((k) => k.endsWith('_NEW')).length);
  log('byKey keys (first 10): ' + JSON.stringify(Object.keys(byKey).slice(0, 10)));

  if (chosen) {
    log('-- chosen 详情 --');
    log('  chosen.aweme_id: ' + chosen.aweme_id);
    log('  chosen.awemeId: ' + chosen.awemeId);
    const cv = chosen.video && chosen.video.cover;
    log('  chosen.video.cover.url_list[0]: ' + (cv && cv.url_list && cv.url_list[0]));
    log('  chosen 完整 path 猜测: 取决于首个 walk 命中');
  } else {
    log('!! chosen 为空 — walk 啥也没命中（说明既无 aweme_id 也无 awemeId，结构极不寻常）');
  }

  // ---- 4. 模拟 extractVideoCovers 全部 5 步，看 defaultCover 真实来源 ----
  log('-- extractVideoCovers 5 步模拟 --');
  let defaultCover = '';
  let pageCovers = [];
  // 步骤 2: RENDER_DATA 抖音
  if (!defaultCover) {
    if (chosen && chosen.video && chosen.video.cover) {
      const cl = (chosen.video.cover.url_list || []);
      if (cl.length) {
        defaultCover = cl[0].replace(/\\\//g, '/');
        log('  defaultCover 来自 RENDER_DATA.chosen.video.cover.url_list[0]');
        log('  defaultCover URL: ' + defaultCover);
        log('  验证 defaultCover 是不是「电子营业执照」类图: ' + /(verify-|license-business|qrcode|qr-|banner|ad-|promo)/i.test(defaultCover));
      }
    }
  }
  // 步骤 4: <video poster>
  document.querySelectorAll('video').forEach((v) => {
    let p = v.getAttribute('poster') || v.poster;
    if (!p && v.dataset) p = v.dataset.poster || v.dataset.cover || v.dataset.thumbnail;
    if (p) {
      try { p = new URL(p, location.href).href; } catch (_) {}
      pageCovers.push({ kind: 'poster', url: p });
    }
  });
  log('  <video poster> count: ' + pageCovers.filter((c) => c.kind === 'poster').length);
  // 步骤 5: og:image
  if (!defaultCover) {
    const og = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]');
    if (og) log('  og:image: ' + og.getAttribute('content'));
  }
  // 步骤 6（抖音专用兜底）: 页面 <img> 模式识别
  const isPromo = (u) => /(verify-|license-business|qrcode|qr-|banner|ad-|promo|advert|sponsor|avatar|emoji|logo|loading|sprite|placeholder|thumb\d{1,2}x\d{1,2}|\bicon[/-]|user-?data|sign-|favicon)/i.test(u);
  const isVideoThumb = (u) => /(tos-cn-(i|pc)|aweme-(subCover|image|cover)|img-video|image-view|img-web|aweme-image|video-cover|video-poster|aweme-cover)/i.test(u);
  const imgs = Array.from(document.querySelectorAll('img'));
  const sizeKey = (el) => { const r = el.getBoundingClientRect(); return (el.naturalWidth || r.width || 0) * (el.naturalHeight || r.height || 0); };
  const candidates = [];
  const seen = new Set();
  for (const img of imgs) {
    const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
    if (!src || /^data:/i.test(src) || /^blob:/i.test(src)) continue;
    const area = sizeKey(img);
    if (area > 0 && area < 80 * 80) continue;
    let abs;
    try { abs = new URL(src, location.href).href; } catch (_) { continue; }
    if (isPromo(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    candidates.push({ url: abs, area, isThumb: isVideoThumb(abs) });
  }
  candidates.sort((a, b) => (b.isThumb - a.isThumb) || (b.area - a.area));
  log('  <img> candidates count: ' + candidates.length);
  if (candidates.length) {
    log('  candidate[0]: ' + JSON.stringify(candidates[0]));
    log('  candidate[0] isVideoThumb: ' + candidates[0].isThumb);
    log('  candidate[0] 完整 URL: ' + candidates[0].url);
  }

  // ---- 5. 侧栏 DOM 反查（如果扩展已开 + 已扫过）----
  log('-- 侧栏 DOM 反查（如果侧栏已开并扫过本页）--');
  const cards = document.querySelectorAll('[data-hmdao-card], .hmdao-card, [class*="hmdao"] [class*="card"]');
  log('  hmdao card 数量: ' + cards.length);

  log('=== PROBE OUTPUT END ===');

  function finish() {
    const out = lines.join('\n');
    try {
      // 优先打到控制台
      console.log(out);
      // 写到 window 全局，便于复制
      window.__HMDAO_PROBE_OUT__ = out;
    } catch (e) {}
    return out;
  }
  return finish();
})();
