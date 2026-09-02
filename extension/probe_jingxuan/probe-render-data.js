// ============================================================
// 抖音 jingxuan RENDER_DATA 探针（极简版）
// 目标：把页面 RENDER_DATA 的真实结构打印到控制台 + 自动复制到剪贴板
// 用法：打开 https://www.douyin.com/jingxuan?modal_id=7672225675125837094
//      等视频开始播放 → F12 → Console → 粘贴本脚本整段 → 回车
//      然后把控制台输出（或剪贴板内容）发给我
// ============================================================
(function () {
  const out = [];
  out.push('=== RENDER_DATA 探针输出 START ===');
  out.push('URL: ' + location.href);
  out.push('UA: ' + (navigator.userAgent || '').slice(0, 60));
  out.push('TITLE: ' + document.title);

  const el = document.querySelector('script#RENDER_DATA, script[id="RENDER_DATA"]');
  out.push('RENDER_DATA element found: ' + !!el);
  if (!el) {
    out.push('!! 没有 RENDER_DATA 节点，请确认这是 jingxuan 详情页');
    return finish(out);
  }
  out.push('RENDER_DATA text length: ' + (el.textContent || '').length);

  let data = null;
  try {
    data = JSON.parse(decodeURIComponent(el.textContent));
  } catch (e) {
    try { data = JSON.parse(el.textContent); out.push('RENDER_DATA 用 raw 解析'); }
    catch (e2) { out.push('!! 解析失败: ' + e.message + ' / ' + e2.message); return finish(out); }
  }
  out.push('RENDER_DATA top-level keys: ' + JSON.stringify(Object.keys(data).slice(0, 30)));

  // 路径 1: data.app.videoDetail
  if (data.app) {
    out.push('--- data.app 子 keys ---');
    out.push('data.app keys: ' + JSON.stringify(Object.keys(data.app).slice(0, 30)));
    const vd = data.app.videoDetail;
    if (vd) {
      out.push('--- data.app.videoDetail 存在 ---');
      out.push('vd 类型: ' + typeof vd + (Array.isArray(vd) ? ' (array, len=' + vd.length + ')' : ''));
      if (typeof vd === 'object' && !Array.isArray(vd)) {
        out.push('vd keys: ' + JSON.stringify(Object.keys(vd).slice(0, 30)));
        // 关键字段
        ['awemeId', 'aweme_id', 'desc', 'itemTitle', 'title', 'videoId', 'groupId'].forEach((k) => {
          out.push('  vd.' + k + ' = ' + JSON.stringify(vd[k]));
        });
        if (vd.video) {
          out.push('--- vd.video ---');
          out.push('vd.video keys: ' + JSON.stringify(Object.keys(vd.video).slice(0, 30)));
          const cv = vd.video.cover;
          out.push('vd.video.cover type: ' + typeof cv + (Array.isArray(cv) ? ' (array)' : ''));
          if (cv && typeof cv === 'object' && !Array.isArray(cv)) {
            out.push('vd.video.cover keys: ' + JSON.stringify(Object.keys(cv).slice(0, 20)));
            out.push('vd.video.cover.url_list type: ' + typeof (cv.url_list) + ' first=' + JSON.stringify((cv.url_list || [])[0]));
            out.push('vd.video.cover.urlList first: ' + JSON.stringify(cv.urlList && cv.urlList[0]));
            // 其他字段
            ['originCover', 'dynamicCover', 'gaussCover', 'horizontalCover', 'verticalCover', 'playAddr', 'downloadAddr'].forEach((k) => {
              if (vd.video[k]) {
                const v = vd.video[k];
                out.push('  vd.video.' + k + ' type=' + typeof v + ' first=' + JSON.stringify(Array.isArray(v) ? v[0] : (v && v.url_list && v.url_list[0])));
              }
            });
          }
          // bitRateList
          if (vd.video.bitRateList && vd.video.bitRateList.length) {
            out.push('vd.video.bitRateList length: ' + vd.video.bitRateList.length);
            out.push('vd.video.bitRateList[0] keys: ' + JSON.stringify(Object.keys(vd.video.bitRateList[0])));
          }
        }
      } else if (Array.isArray(vd)) {
        out.push('vd[0] keys: ' + JSON.stringify(Object.keys(vd[0] || {}).slice(0, 20)));
        if (vd[0]) {
          out.push('  vd[0].awemeId = ' + JSON.stringify(vd[0].awemeId));
          out.push('  vd[0].aweme_id = ' + JSON.stringify(vd[0].aweme_id));
        }
      }
    } else {
      out.push('!! data.app.videoDetail 不存在');
    }
    // 老结构
    if (data.app.aweme_list) {
      out.push('--- data.app.aweme_list 存在 length=' + data.app.aweme_list.length + ' ---');
      if (data.app.aweme_list[0]) {
        out.push('aweme_list[0] keys: ' + JSON.stringify(Object.keys(data.app.aweme_list[0]).slice(0, 20)));
        out.push('  aweme_list[0].aweme_id = ' + JSON.stringify(data.app.aweme_list[0].aweme_id));
        out.push('  aweme_list[0].awemeId = ' + JSON.stringify(data.app.aweme_list[0].awemeId));
        const c0 = data.app.aweme_list[0].video && data.app.aweme_list[0].video.cover;
        out.push('  aweme_list[0].video.cover.url_list[0] = ' + (c0 && c0.url_list && c0.url_list[0]));
      }
    }
  } else {
    out.push('!! data.app 不存在');
  }
  // 顶层 aweme_list（更老的结构）
  if (data.aweme_list) {
    out.push('--- 顶层 data.aweme_list 存在 length=' + data.aweme_list.length + ' ---');
    if (data.aweme_list[0]) {
      out.push('  aweme_list[0].aweme_id = ' + JSON.stringify(data.aweme_list[0].aweme_id));
    }
  }

  // 找任意含 video.cover 的对象，列出所有可能的 cover 路径
  out.push('--- 找 5 个含 video.cover 的对象 + 其 id 字段 ---');
  let count = 0;
  const seen = new Set();
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > 8 || count >= 5) return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, d + 1)); return; }
    if (o.video && o.video.cover) {
      const cv = o.video.cover;
      const cvUrl = (cv && (cv.url_list || cv.urlList) || [])[0];
      if (cvUrl && !seen.has(cvUrl)) {
        seen.add(cvUrl);
        const ids = ['awemeId', 'aweme_id', 'videoId', 'groupId'].filter((k) => o[k] != null);
        out.push('  hit: idFields=' + JSON.stringify(ids) + ' cover[0]=' + cvUrl.slice(0, 100));
        count++;
      }
    }
    for (const k in o) { try { walk(o[k], d + 1); } catch (_) {} }
  };
  walk(data, 0);

  // modal_id 是否在数据里能匹配上
  const modal_id = new URL(location.href).searchParams.get('modal_id') || '';
  out.push('--- modal_id 匹配测试 ---');
  out.push('modal_id = ' + modal_id);
  if (modal_id) {
    let matched = 0;
    const walk2 = (o, d) => {
      if (!o || typeof o !== 'object' || d > 8) return;
      if (Array.isArray(o)) { o.forEach((x) => walk2(x, d + 1)); return; }
      if (String(o.awemeId) === modal_id || String(o.aweme_id) === modal_id) {
        matched++;
        if (matched <= 3) {
          out.push('  matched: ' + (o.awemeId ? 'awemeId' : 'aweme_id') + ' = ' + (o.awemeId || o.aweme_id) + ' desc=' + (o.desc || '').slice(0, 30));
        }
      }
      for (const k in o) { try { walk2(o[k], d + 1); } catch (_) {} }
    };
    walk2(data, 0);
    out.push('  modal_id 总命中数: ' + matched);
  }

  out.push('=== RENDER_DATA 探针输出 END ===');
  return finish(out);
})();

function finish(out) {
  const text = out.join('\n');
  console.log(text);
  try {
    // 尝试复制到剪贴板（注意：剪贴板需 https + 用户手势触发，首次执行可能失败，但控制台能看到）
    navigator.clipboard.writeText(text).then(() => console.log('[probe] 已自动复制到剪贴板')).catch(() => console.log('[probe] 剪贴板复制失败，请手动复制控制台输出'));
  } catch (e) {}
  return text;
}
