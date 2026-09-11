// Ddayup · 抖音 API 捕获诊断 v3（2026-09-04）
// 目的：一锤定音 —— 详情页/合集列表接口到底发没发、响应是 JSON 还是 protobuf 二进制。
// 这是"没缩略图 / 没标题 / 没直链 / 刷新不同步"的总源头：
//   dyVideoUrlByAweme 恒为 0 → 无封面无标题无直链 → 只剩 MSE 的 blob（后台 fetch 必失败）
//   而侧栏"增量合并从不删除" → 没有新数据时旧卡片一直显示 → 表现成"刷新后不同步"
//
// 用法（粘到【抖音源页】Console 回车）：
//   1) 粘贴 → 回车（页面会自动记录之后所有请求）
//   2) 滚一下播放列表 / 切换一集 / 或按 F5 刷新
//   3) 执行：__DIAG_REPORT()      ← 打印汇总表格
//   4) 把输出贴给开发者
(function () {
  var REQ = [];
  var seen = {};

  function short(u) {
    return String(u || '').replace(/^https?:\/\/(www\.)?/, '').slice(0, 120);
  }
  // 判定响应体类型：JSON / protobuf二进制 / HTML / 其它
  function classify(ct, body) {
    var c = String(ct || '');
    if (/json/i.test(c)) return 'JSON';
    if (/protobuf|octet-stream|binary|x-www-form/i.test(c)) return 'PROTOBUF/二进制';
    if (/html/i.test(c)) return 'HTML';
    var b = String(body || '');
    if (!b) return '空响应';
    // 无 content-type 时按首字符猜：二进制通常含大量控制字符
    var ctrl = 0;
    for (var i = 0; i < Math.min(b.length, 40); i++) {
      var n = b.charCodeAt(i);
      if (n < 9 || (n > 13 && n < 32)) ctrl++;
    }
    if (ctrl > 3) return '二进制(无ct)';
    if (/^\s*[{[]/.test(b)) return 'JSON(无ct)';
    return '其它';
  }
  function add(row) {
    var k = row.method + '|' + row.url.split('?')[0];
    if (seen[k]) return;
    seen[k] = 1;
    REQ.push(row);
  }
  // 是否是"可能含视频数据"的接口（仅用于打 ★ 标记，不过滤记录）
  function interesting(u) {
    return /\/aweme\/|iteminfo|aweme_?detail|mix|collection|series|general\/search/i.test(u || '');
  }

  // ---- fetch ----
  var origFetch = window.fetch;
  window.fetch = function () {
    var u = (typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url)) || '';
    var row = { method: 'FETCH', url: u, ct: '', status: '', len: 0, kind: '', head: '' };
    var p = origFetch.apply(this, arguments);
    try {
      p.then(function (r) {
        try {
          row.ct = (r.headers && r.headers.get) ? (r.headers.get('content-type') || '') : '';
          row.status = r.status;
          if (r.clone) {
            r.clone().text().then(function (t) {
              row.len = String(t || '').length;
              row.kind = classify(row.ct, t);
              row.head = String(t || '').replace(/\s+/g, ' ').slice(0, 90);
              add(row);
            })['catch'](function () { row.kind = '读取失败'; add(row); });
          } else { row.kind = '无clone'; add(row); }
        } catch (e) { add(row); }
      })['catch'](function (e) { row.kind = '请求失败:' + (e && e.message); add(row); });
    } catch (e) { add(row); }
    return p;
  };

  // ---- XHR ----
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    try { this.__dU = String(u || ''); this.__dM = String(m || 'GET'); } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    var row = { method: self.__dM || 'XHR', url: self.__dU || '', ct: '', status: '', len: 0, kind: '', head: '' };
    try {
      self.addEventListener('load', function () {
        try {
          try { row.ct = self.getResponseHeader('content-type') || ''; } catch (e) {}
          row.status = self.status;
          var t = '';
          try { t = String(self.responseText || ''); } catch (e) {
            t = '';
            row.kind = 'responseText不可读(可能是arraybuffer/blob→多半是protobuf)';
          }
          row.len = t.length;
          if (!row.kind) row.kind = classify(row.ct, t);
          row.head = t.replace(/\s+/g, ' ').slice(0, 90);
          add(row);
        } catch (e) { add(row); }
      });
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

  // ---- 汇总报告 ----
  window.__DIAG_REPORT = function () {
    var rows = REQ.slice().sort(function (a, b) {
      return (interesting(b.url) ? 1 : 0) - (interesting(a.url) ? 1 : 0);
    });
    var counts = {};
    rows.forEach(function (r) { counts[r.kind] = (counts[r.kind] || 0) + 1; });
    var caps = window.__hmdao_captures || {};
    var rd = null, rdKeys = [];
    try {
      var el = document.querySelector('script#RENDER_DATA, script[id="RENDER_DATA"]');
      if (el && el.textContent) {
        var raw = el.textContent;
        rd = JSON.parse(decodeURIComponent(raw));
        rdKeys = Object.keys(rd || {});
      }
    } catch (e) { rdKeys = ['(RENDER_DATA 解析失败: ' + e.message + ')']; }

    var out = {
      '① 本次捕获到请求数': rows.length,
      '② 响应类型分布': counts,
      '③ 关键接口(★=可能含视频数据)': rows.slice(0, 40).map(function (r) {
        return (interesting(r.url) ? '★ ' : '  ') + r.method + ' ' + r.status + ' [' + r.kind + '] len=' + r.len
          + ' ' + short(r.url)
          + (r.head ? '\n      头部: ' + r.head : '');
      }),
      '④ 当前采集映射': {
        curAwemeId: caps.curAwemeId || '(空)',
        dyUrls: (caps.dyUrls || []).length,
        dyAudios: (caps.dyAudios || []).length,
        dyVideoUrlByAweme: Object.keys(caps.dyVideoUrlByAweme || {}).length,
        dyCoverByAweme: Object.keys(caps.dyCoverByAweme || {}).length,
        dyTitlesByAweme: Object.keys(caps.dyTitlesByAweme || {}).length,
        dyEpisodeByAweme: Object.keys(caps.dyEpisodeByAweme || {}).length,
      },
      '⑤ RENDER_DATA 顶层键': rdKeys.slice(0, 20),
      '⑥ 主播放器 window.player': (function () {
        try { return !!window.player && !!window.player.video; } catch (e) { return false; }
      })(),
    };
    console.log('%c【诊断汇总 v3】', 'color:#f60;font-weight:bold;font-size:14px');
    console.log(out);
    return out;
  };

  console.log('%c【API 诊断 v3 已装载】请滚动列表 / 切换一集 / 按 F5 刷新，然后执行 __DIAG_REPORT()', 'color:#0f0;font-weight:bold;font-size:13px');
  return 'diag-v3-installed';
})();
