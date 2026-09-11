// Ddayup · 抖音 API 捕获诊断（2026-09-04）
// 用途：查清"详情/列表接口到底发没发、响应是不是 JSON、里面有没有视频数据"。
// 这是所有问题的源头：dyVideoUrlByAweme 恒为 0 → 无封面/无标题/无直链 → 只剩 blob（没画面没声音）。
//
// 用法（粘到【抖音源页】Console 回车）：
//   1) 粘贴本段代码 → 回车
//   2) 滚一下列表 / 切换一集 / 或刷新页面（目的是让页面重新发 API 请求）
//   3) 看控制台里所有 [DIAG-API] 开头的日志，或执行 copy(__DIAG_API_LOG)
//   4) 把日志贴给开发者
(function () {
  var log = [];
  var seen = {};
  // 只关心可能含视频数据的接口（放宽匹配，宁多勿漏）
  function isApi(u) {
    return /\/aweme\/|iteminfo|aweme_?detail|mix|collection|series|general\/search|video\/app/i.test(u || '');
  }
  function note(kind, u, extra) {
    if (!isApi(u)) return;
    var key = kind + '|' + String(u).split('?')[0];
    if (seen[key]) return;
    seen[key] = 1;
    var line = kind + '  ' + String(u).slice(0, 130) + (extra ? '\n      ' + extra : '');
    try { console.log('%c[DIAG-API] ' + line, 'color:#0af'); } catch (e) {}
    log.push({ kind: kind, url: String(u), extra: extra || '' });
  }

  // ---- fetch ----
  var origFetch = window.fetch;
  window.fetch = function () {
    var u = (typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url)) || '';
    note('FETCH-REQ', u, '');
    var p = origFetch.apply(this, arguments);
    try {
      p.then(function (r) {
        try {
          var ct = (r.headers && r.headers.get) ? (r.headers.get('content-type') || '') : '';
          note('FETCH-RESP', u, 'status=' + r.status + '  content-type=' + ct);
          if (r.clone && /json/i.test(ct)) {
            r.clone().text().then(function (t) {
              var s = String(t || '');
              note('FETCH-JSON', u, 'len=' + s.length + '  是否含video=' + (/"video"|\\"video\\"/.test(s)) + '  头部=' + s.slice(0, 200));
            })['catch'](function () {});
          } else {
            note('FETCH-NOTJSON', u, '响应非 JSON（protobuf/二进制？）content-type=' + ct);
          }
        } catch (e) {}
      })['catch'](function () {});
    } catch (e) {}
    return p;
  };

  // ---- XHR ----
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    try { this.__diagUrl = String(u || ''); note('XHR-REQ', this.__diagUrl, 'method=' + m); } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    var u = self.__diagUrl || '';
    if (isApi(u)) {
      try {
        self.addEventListener('load', function () {
          try {
            var ct = '';
            try { ct = self.getResponseHeader('content-type') || ''; } catch (e) {}
            var t = '';
            try { t = String(self.responseText || ''); } catch (e) { t = '(responseText 不可读，可能是 arraybuffer/blob)'; }
            note('XHR-RESP', u, 'status=' + self.status + '  content-type=' + ct + '  len=' + t.length);
            note('XHR-BODY', u, '头部=' + t.slice(0, 220));
          } catch (e) {}
        });
      } catch (e) {}
    }
    return origSend.apply(this, arguments);
  };

  // ---- 后端存活检查（封面走 /api/media-proxy，后端挂了封面必挂）----
  var backends = ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://127.0.0.1:8792'];
  backends.forEach(function (b) {
    try {
      fetch(b + '/api/health', { method: 'GET' })
        .then(function (r) { console.log('%c[DIAG-BACKEND] ' + b + ' → HTTP ' + r.status + '（在线）', 'color:#0f0'); })
        ['catch'](function (e) { console.log('%c[DIAG-BACKEND] ' + b + ' → 连接失败（' + (e && e.message) + '）', 'color:#f00'); });
    } catch (e) {
      console.log('%c[DIAG-BACKEND] ' + b + ' → 异常 ' + e.message, 'color:#f00');
    }
  });

  // ---- 当前采集状态快照 ----
  try {
    var c = window.__hmdao_captures || {};
    console.log('%c[DIAG-STATE]', 'color:#f60;font-weight:bold', {
      'curAwemeId': c.curAwemeId || '(空)',
      'dyUrls': (c.dyUrls || []).length,
      'dyAudios': (c.dyAudios || []).length,
      'dyVideoUrlByAweme': Object.keys(c.dyVideoUrlByAweme || {}).length,
      'dyCoverByAweme': Object.keys(c.dyCoverByAweme || {}).length,
      'dyTitlesByAweme': Object.keys(c.dyTitlesByAweme || {}).length,
      'dyEpisodeByAweme': Object.keys(c.dyEpisodeByAweme || {}).length,
    });
  } catch (e) {}

  window.__DIAG_API_LOG = log;
  console.log('%c【API 诊断已装载】现在请：滚一下列表 / 切换一集 / 刷新页面，然后看上方 [DIAG-API] 日志，或执行 copy(__DIAG_API_LOG)', 'color:#0f0;font-weight:bold;font-size:13px');
  return 'diag-installed';
})();
