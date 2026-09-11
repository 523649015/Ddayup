// 花瓣采集修复验证脚本（在 huaban.com/pins/xxxx 页面的 DevTools Console 里粘贴运行）
// 用途：确认 HMDAO 扩展的花瓣分支是否已绕过 CORS，能经 background 通道拿到完整 board。
// 前置：扩展已重载、已登录花瓣、当前在 https://huaban.com/pins/xxxx 页面。

(async () => {
  const out = [];
  const log = (...a) => { console.log('[verify]', ...a); out.push(a.join(' ')); };

  // 1) 确认 background 通道存在
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
    log('FAIL: 不在扩展注入上下文（请确认扩展已重载且在 huaban 页面）');
    return out;
  }
  log('background 通道可用');

  // 2) 经 HMDAO_NETDISK_FETCH 拉单图接口（模拟 scan.js 的 hbFetch）
  const pinId = location.pathname.match(/\/pins\/(\d+)/)?.[1];
  if (!pinId) { log('FAIL: 当前不是 /pins/<id> 详情页'); return out; }
  log('当前 pinId =', pinId);

  const resp = await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'HMDAO_NETDISK_FETCH', url: 'https://api.huaban.com/pins/' + pinId + '?fetch=1', method: 'GET',
        headers: { 'Accept': 'application/json', 'Referer': location.href, 'X-Requested-With': 'XMLHttpRequest' } },
      (r) => resolve(r)
    );
  });
  log('单图接口 ok =', resp?.ok, 'status =', resp?.status);
  if (!resp?.json?.pin) { log('WARN: 接口未返回 pin（可能未登录/风控）'); }
  else {
    const p = resp.json.pin;
    log('单图 file.key =', p.file?.key);
    log('board_id =', p.board_id);
    if (p.board_id) {
      // 3) 翻页验证
      let max = 0, got = 0, page = 0;
      while (page < 3) { // 仅验证前 3 页
        const j = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { type: 'HMDAO_NETDISK_FETCH', url: 'https://api.huaban.com/boards/' + p.board_id + '/pins?limit=40&max=' + max, method: 'GET',
              headers: { 'Accept': 'application/json', 'Referer': location.href, 'X-Requested-With': 'XMLHttpRequest' } },
            (r) => resolve(r)
          );
        });
        if (!j?.json?.pins?.length) { log('翻页第', page, '页无数据，停止'); break; }
        got += j.json.pins.length;
        max = j.json.pins[j.json.pins.length - 1].pin_id || (max + 40);
        page++;
        if (j.json.pins.length < 40) break;
      }
      log('翻页前', page, '页共采到', got, '张 —— 说明 board 翻页接口已绕过 CORS 生效');
    }
  }
  log('验证完成。若 ok=true 且采到多张，说明修复生效，重载扩展后侧栏扫描应能看到全量素材。');
  return out;
})();
