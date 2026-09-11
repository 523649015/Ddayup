// Ddayup 扩展 · 抖音合集采集诊断脚本（2026-09-03）
// 用法：把下面【整段代码】复制 → 粘贴到 Console → 回车。
//   · 粘到「抖音源页」Console → 自动跑 A 段（源页捕获诊断）
//   · 粘到「侧栏面板」Console（面板内右键→检查）→ 自动跑 B 段（卡片诊断）
// 注意：只复制代码块本身，不要把周围的中文说明文字一起复制进去。
(function () {
  var trackOf = function (u) {
    try {
      var q = new URL(u).searchParams;
      var m = q.get('mime_type') || q.get('mime') || '';
      if (/audio/i.test(m)) return 'AUDIO_音频轨';
      if (/video/i.test(m)) return 'VIDEO_视频轨';
    } catch (e) {}
    return '未知_无mime参数';
  };
  var isBeacon = function (u) {
    return /(mssdk|msToken|ms_appid|slardar|apm\.|beacon|log-sdk|webid|tea\.|toblog|\/web\/common|monitor\.|\/monitor\/|pixel\.)/i.test(u || '');
  };
  var cut = function (s, n) { return String(s == null ? '' : s).slice(0, n); };
  var inPanel = (typeof window.assets !== 'undefined') && !window.__hmdao_captures;

  if (inPanel) {
    // ---------------- B 段：侧栏卡片诊断 ----------------
    var cur = window.__hmdao_curAwemeId || '';
    var cards = (window.assets || []).map(function (a, i) {
      return {
        'idx': i,
        'type': a.type,
        'platform': a.platform || '',
        'awemeId': a.awemeId || '(无)',
        '是否当前集': (a.awemeId && cur && String(a.awemeId) === String(cur)) ? 'YES' : (a.awemeId ? 'no' : '-'),
        'url轨道': a.type === 'video' ? trackOf(a.url) : '-',
        'url': cut(a.url, 90),
        'dashAudio': a.dashAudio ? ('有_' + trackOf(a.dashAudio)) : '无',
        'cover': a.cover ? (isBeacon(a.cover) ? 'BAD_监控信标必404' : cut(a.cover, 64)) : '(无封面)',
        'title': a.title ? cut(a.title, 30) : '(无标题)',
        'episodeNo': a.episodeNo || '(无集数)',
        'notPlayed': a.notPlayed === true ? '未播放' : (a.notPlayed === false ? '已播放' : '-'),
      };
    });
    var vids = cards.filter(function (c) { return c.type === 'video'; });
    var probs = [];
    if (!cur) probs.push('BAD 侧栏拿不到当前集(__hmdao_curAwemeId 空) → 高亮/未播放徽标全部失效');
    var audioOnly = vids.filter(function (c) { return c['url轨道'].indexOf('AUDIO') === 0; });
    if (audioOnly.length) probs.push('BAD ' + audioOnly.length + ' 张卡 url 是音频轨 → 预览"只有声音没画面"，卡索引: ' + audioOnly.map(function (c) { return c.idx; }).join(','));
    var unknownTrack = vids.filter(function (c) { return c['url轨道'].indexOf('未知') === 0; });
    if (unknownTrack.length) probs.push('WARN ' + unknownTrack.length + ' 张卡 url 无 mime 参数(无法判定轨道) → 可能是被误分类的音频轨，卡索引: ' + unknownTrack.map(function (c) { return c.idx; }).join(','));
    var bad = vids.filter(function (c) { return String(c.cover).indexOf('BAD_') === 0; });
    if (bad.length) probs.push('BAD ' + bad.length + ' 张卡封面是监控信标 → 缩略图 404，卡索引: ' + bad.map(function (c) { return c.idx; }).join(','));
    var noTitle = vids.filter(function (c) { return c.title === '(无标题)'; });
    if (noTitle.length) probs.push('WARN ' + noTitle.length + ' 张卡无标题');
    var noEp = vids.filter(function (c) { return c.episodeNo === '(无集数)'; });
    if (noEp.length) probs.push('WARN ' + noEp.length + ' 张卡无集数');
    var hit = vids.filter(function (c) { return c['是否当前集'] === 'YES'; });
    if (cur && !hit.length) probs.push('BAD 没有任何一张卡匹配当前集 ' + cur + ' → 侧栏与源页脱节');
    if (!probs.length) probs.push('OK 未发现明显问题');
    var outB = {
      '①侧栏当前集': cur || '(空)',
      '②源页tabId': window.__hmdao_sourceTabId || '(未设置)',
      '③资产总数': (window.assets || []).length,
      '④视频卡明细': vids,
      '⑤问题汇总': probs,
    };
    console.log('%c【B段·侧栏诊断】', 'color:#0af;font-weight:bold');
    console.log(outB);
    return outB;
  }

  // ---------------- A 段：源页捕获诊断 ----------------
  var caps = window.__hmdao_captures || {};
  var modalId = '';
  try { modalId = new URL(location.href).searchParams.get('modal_id') || '(无)'; } catch (e) { modalId = '(无)'; }
  var vids2 = Object.keys(caps.dyVideoUrlByAweme || {}).slice(0, 25).map(function (k) {
    return {
      'awemeId': k,
      '是当前集': k === caps.curAwemeId ? 'YES' : 'no',
      '轨道': trackOf(caps.dyVideoUrlByAweme[k]),
      '集数': (caps.dyEpisodeByAweme || {})[k] || '(无)',
      '标题': cut((caps.dyTitlesByAweme || {})[k] || '(无)', 26),
      '封面': (caps.dyCoverByAweme || {})[k] ? (isBeacon(caps.dyCoverByAweme[k]) ? 'BAD_监控信标' : cut(caps.dyCoverByAweme[k], 62)) : '(无)',
      '直链': cut(caps.dyVideoUrlByAweme[k], 80),
    };
  });
  var curV = (caps.dyVideoUrlByAweme || {})[caps.curAwemeId] || '';
  var curA = (caps.dyAudiosByAweme || {})[caps.curAwemeId] || '';
  var outA = {
    '①当前集curAwemeId': caps.curAwemeId || '(空)',
    '①URL的modal_id': modalId,
    '①当前集与modal_id相同?': (caps.curAwemeId && caps.curAwemeId === modalId) ? 'BAD_仍锁在合集ID' : 'OK',
    '②dyUrls条数_轨道': (caps.dyUrls || []).slice(0, 12).map(function (u, i) {
      return String(i) + '|' + ((caps.dyAwemes || [])[i] || '无') + '|' + trackOf(u) + '|' + cut(u, 70);
    }),
    '②dyAudios条数': (caps.dyAudios || []).length,
    '③当前集视频直链': curV ? (trackOf(curV) + ' | ' + cut(curV, 80)) : 'BAD_无(预览必然失败/只有声音)',
    '③当前集音频轨': curA ? ('有 | ' + cut(curA, 70)) : '无',
    '④每集明细': vids2,
    '⑤映射键数量': {
      'cover': Object.keys(caps.dyCoverByAweme || {}).length,
      'title': Object.keys(caps.dyTitlesByAweme || {}).length,
      'episode': Object.keys(caps.dyEpisodeByAweme || {}).length,
      'videoUrl': Object.keys(caps.dyVideoUrlByAweme || {}).length,
      'formats': Object.keys(caps.dyFormatsByAweme || {}).length,
    },
  };
  console.log('%c【A段·源页诊断】', 'color:#0f0;font-weight:bold');
  console.log(outA);
  return outA;
})();
