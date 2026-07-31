// ===== 右键上下文菜单簇（抽离自 sidepanel.js）=====
// 依赖 sidepanel.js 全局：ctxAssetIdx / getAsset / openPreview / setStatus / errStr /
// saveSingleToLocal / doFindSimilar，以及 audio-playback.js 的 playAudioInPage /
// netdiskResolve（在 sidepanel.js 定义）。故本文件须在 sidepanel.js 与 audio-playback.js 之后加载。
// 纯物理拆分（普通脚本，共享全局作用域），行为零改变。

// 当前右键菜单所指资产（基于 global index）
let ctxAsset = null; // 缓存当前右键资产

function showContextMenu(x, y, idx) {
  ctxAssetIdx = idx;
  ctxAsset = getAsset(idx);
  if (!ctxAsset) return;
  const menu = document.getElementById('ctxMenu');
  // 防溢出
  const mw = 170, mh = 240;
  menu.style.left = Math.min(x, window.innerWidth - mw - 6) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - mh - 6) + 'px';
  menu.style.display = 'block';
}

// 点击菜单外区域关闭
document.addEventListener('click', (e) => {
  if (!e.target.closest('#ctxMenu')) {
    document.getElementById('ctxMenu').style.display = 'none';
  }
});

// 菜单项分发
document.querySelectorAll('#ctxMenu button[data-action]').forEach((btn) => {
  btn.onclick = () => {
    const action = btn.dataset.action;
    const a = ctxAsset;
    document.getElementById('ctxMenu').style.display = 'none';
    if (!a) return;
    switch (action) {
      case 'preview': openPreview(ctxAssetIdx); break;
      case 'play': if (a.type === 'audio') playAudioInPage(a, { visual: true }); break;
      case 'download': downloadSingle(a); break;
      case 'save': saveSingleToLocal(a); break;
        case 'copy':
          navigator.clipboard.writeText(a.url).then(() => setStatus('已复制链接')).catch(() => setStatus('复制失败', true));
          break;
        case 'netresolve': netdiskResolve(a); break;
      case 'open': chrome.tabs.create({ url: a.url }); break;
      case 'similar': doFindSimilar(a); break;
    }
  };
});
