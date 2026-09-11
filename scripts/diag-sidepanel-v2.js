(function () {
  var cut = function (s, n) { return String(s == null ? '' : s).slice(0, n); };
  var host = function (u) { try { return new URL(u).hostname; } catch (e) { return '?'; } };
  var mime = function (u) { try { var q = new URL(u).searchParams; return q.get('mime') || q.get('mime_type') || '无'; } catch (e) { return '?'; } };
  var inPanel = (typeof window.assets !== 'undefined') && !window.__hmdao_captures;
  var out = { 'WHERE': inPanel ? '侧栏' : '源页' };

  if (inPanel) {
    // ---------- 侧栏 ----------
    out['①构建版本(确认是否重载)'] = (function () { var f = document.querySelector('footer'); return f ? cut(f.textContent, 200) : '(无footer)'; })();
    out['①扩展ID'] = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime.id : '?';
    out['②侧栏curAwemeId'] = window.__hmdao_curAwemeId || '(空 ← 切集不同步真凶)';
    out['②源页tabId'] = window.__hmdao_sourceTabId || '(空)';
    var assets = window.assets || [];
    out['③资产总数'] = assets.length;
    out['③每张卡完整字段'] = assets.map(function (a, i) {
      return {
        'idx': i,
        'type': a.type,
        'platform': a.platform || '(空)',
        'awemeId': a.awemeId || '(无)',
        'title': cut(a.title, 36),
        'episodeNo': a.episodeNo || '(无)',
        'cover': a.cover ? host(a.cover) + ' | ' + cut(a.cover, 60) : '(无)',
        'url': a.url ? host(a.url) + ' | mime=' + mime(a.url) + ' | ' + cut(a.url, 60) : '(无)',
        'dashAudio': a.dashAudio ? ('有 mime=' + mime(a.dashAudio)) : '无',
        'notPlayed': a.notPlayed === true ? '未播放' : (a.notPlayed === false ? '已播放' : '-'),
        'source': a.source || '(空)',
      };
    });
    var probs = [];
    if (out['①构建版本(确认是否重载)'].indexOf('2026-09-03') < 0) probs.push('WARN 构建版本不含 2026-09-03 → 你可能没重载扩展（按 chrome://extensions 点刷新按钮）');
    if (!window.__hmdao_curAwemeId) probs.push('BAD 侧栏curAwemeId空 → 切集不会同步(可能没重载 或 modal_id误杀仍存在)');
    var vids = assets.filter(function (a) { return a.type === 'video'; });
    if (vids.length === 1 && !vids[0].awemeId) probs.push('BAD 仅有1张匿名卡 → 集合批量合成未生效(可能没重载 或 scan.js 出错)');
    if (vids.length > 1) {
      var noTit = vids.filter(function (a) { return !a.title; });
      if (noTit.length) probs.push('WARN ' + noTit.length + '/' + vids.length + ' 张卡无标题');
      var noEp = vids.filter(function (a) { return !a.episodeNo; });
      if (noEp.length) probs.push('WARN ' + noEp.length + '/' + vids.length + ' 张卡无集数');
    }
    var badCover = vids.filter(function (a) {
      if (!a.cover) return false;
      var h = host(a.cover);
      return !/(douyinpic|byteimg|bytedance|tos-cn|p\d+-pc|amemv|tiktokv|googleusercontent|byteicdn)/i.test(h);
    });
    if (badCover.length) probs.push('BAD ' + badCover.length + ' 张卡封面域名异常(可能是电子营业执照等非视频图): 索引 ' + badCover.map(function (a) { return assets.indexOf(a); }).join(','));
    if (vids.length && !vids[0].url) probs.push('BAD 视频卡url为空');
    var audioOnly = vids.filter(function (a) { return a.url && /audio/i.test(mime(a.url)); });
    if (audioOnly.length) probs.push('BAD ' + audioOnly.length + ' 张卡url是音频轨(只有声音没画面)');
    if (!probs.length) probs.push('OK 未发现明显问题');
    out['④问题汇总'] = probs;
    out['⑤一键重扫'] = '在控制台执行: chrome.runtime.sendMessage({type:"HMDAO_RESCAN_TAB"})';
  } else {
    // ---------- 源页 ----------
    var caps = window.__hmdao_captures || {};
    out['①当前集curAwemeId'] = caps.curAwemeId || '(空 ← 切集不同步真凶)';
    var modalId = '';
    try { modalId = new URL(location.href).searchParams.get('modal_id') || ''; } catch (e) {}
    out['①URL的modal_id'] = modalId || '(无)';
    out['①当前集===modal_id?'] = (caps.curAwemeId && modalId && caps.curAwemeId === modalId) ? 'YES(首次打开正常)' : 'no';
    out['②dyUrls条数'] = (caps.dyUrls || []).length;
    out['②dyAudios条数'] = (caps.dyAudios || []).length;
    var vmap = caps.dyVideoUrlByAweme || {};
    out['②已采集集数(标题/封面/直链)'] = Object.keys(vmap).length;
    out['②每集元数据完整度'] = Object.keys(vmap).slice(0, 5).map(function (k) {
      return k + ' | 标题=' + (caps.dyTitlesByAweme && caps.dyTitlesByAweme[k] ? '✓' : '✗') +
        ' | 集数=' + (caps.dyEpisodeByAweme && caps.dyEpisodeByAweme[k] || '?') +
        ' | 封面=' + (caps.dyCoverByAweme && caps.dyCoverByAweme[k] ? host(caps.dyCoverByAweme[k]).slice(0, 20) : '✗') +
        ' | 轨道=' + mime(vmap[k]);
    });
    var probs = [];
    if (!caps.curAwemeId) {
      if (modalId && vmap[modalId]) probs.push('BAD curAwemeId空但modal_id命中已采集集 → 可能没重载(兜底修复需要新代码)');
      else probs.push('BAD curAwemeId空且modal_id没命中 → 播放器对象未找到 且 列表API也没抓到');
    }
    if ((caps.dyUrls || []).length === 0 && (caps.dyAudios || []).length === 0) probs.push('INFO dyUrls/dyAudios全0 → 抖音用MSE播放,fetch拦截不到流(正常,需依赖合集列表API)');
    if (Object.keys(vmap).length === 0) probs.push('BAD dyVideoUrlByAweme空 → 合集列表API没抓到,12集卡片一个都生不成');
    if (!probs.length) probs.push('OK 源页捕获看起来正常');
    out['③问题汇总'] = probs;
    out['④一键重扫'] = '执行: chrome.runtime.sendMessage({type:"HMDAO_RESCAN_TAB"})';
  }

  console.log('%c【Ddayup诊断】' + out['WHERE'], 'color:#f60;font-weight:bold;font-size:14px');
  console.log(out);
  return out;
})();
