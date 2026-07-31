// ===== 批量操作 / 类型目录选择 / 预设官方源 / 消息监听（抽离自 sidepanel.js）=====
// 本文件由 sidepanel.html 在 sidepanel.js 之后加载，确保 assets / selected / saveHandles
// 等全局变量已由 sidepanel.js 初始化，此处的 DOM 绑定与消息监听运行时均可见依赖符号。
// 纯物理拆分（普通脚本，共享全局作用域），不引入 ESM，行为零改变。

// ===== 批量操作（沿用原有接口） =====
function getChosen() {
  return assets.filter((_, i) => selected.has(i));
}

// 任务 N：导入到 Ddayup 用回调式发送（绕过 Promise 包裹层），真实捕获 lastError，
// 区分「Ddayup 页未打开」的失败提示，避免 .catch 被包裹层静默成 undefined 而假成功。
function sendImportToApp(batch) {
  setStatus(`发送 ${batch.length} 个…`);
  chrome.runtime.sendMessage({ type: 'HMDAO_IMPORT_TO_APP', assets: batch }, (resp) => {
    if (chrome.runtime.lastError) {
      warnStatus('导入失败');
      return;
    }
    setStatus('已发送，素材入库后可查看');
  });
}

document.getElementById('import').onclick = () => {
  const list = getChosen();
  const batch = list.length ? list : assets;
  if (!batch.length) { setStatus('无素材', true); return; }
  sendImportToApp(batch);
};

document.getElementById('download').onclick = () => {
  const list = getChosen();
  const batch = list.length ? list : assets;
  if (!batch.length) { setStatus('无素材', true); return; }
  let ok = 0;
  batch.forEach((a) => { downloadSingle(a); ok++; });
  setStatus(`已发起下载 ${ok} 个`);
};

document.getElementById('saveLocal').onclick = async () => {
  const list = getChosen();
  const batch = list.length ? list : assets;
  if (!batch.length) { setStatus('无素材', true); return; }
  let done = 0, fail = 0;
  for (const a of batch) {
    try {
      const handle = saveHandles[a.type];
      if (!handle) { downloadSingle(a); done++; continue; }
      const res = await fetchViaBackground(a.url);
      if (!res || !res.ok) { fail++; continue; }
      const fileHandle = await handle.getFileHandle(deriveFilename(a), { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(res.arrayBuffer);
      await writable.close();
      done++;
    } catch (_) { fail++; }
  }
  setStatus(`保存完成：成功 ${done}，失败 ${fail}`);
};

// ===== 按类型目录选择 =====
document.querySelectorAll('.pathPick').forEach((btn) => {
  btn.onclick = async () => {
    const type = btn.dataset.type;
    if (!window.showDirectoryPicker) { setStatus('浏览器不支持', true); return; }
    try {
      const handle = await window.showDirectoryPicker();
      saveHandles[type] = handle;
      const sp = document.querySelector(`.pathText[data-type="${type}"]`);
      if (sp) sp.textContent = `✓ ${handle.name}`;
      setStatus(`已设置「${typeLabel(type)}」目录：${handle.name}`);
    } catch (e) {
      if (e && e.name !== 'AbortError') setStatus('失败：' + (e.message || e), true);
    }
  };
});

// ===== 预设官方源 =====
document.querySelectorAll('.preset').forEach((btn) => {
  btn.onclick = async () => {
    const url = btn.dataset.url;
    if (!url) return;
    setStatus('打开 ' + (() => { try { return new URL(url).hostname; } catch (_) { return url; } })() + '…');
    try { await chrome.runtime.sendMessage({ type: 'HMDAO_OPEN_PRESET', url }); }
    catch (_) { chrome.tabs.create({ url }); }
  };
});

// ===== 消息监听 =====
// 入口校验：扫描来源可能带非规范 type（拼写/大小写/别名），统一归一到 ASSET_TYPES 规范集合。
// 无法识别的 type 记录日志并保留原值（不静默丢弃，交由下游按默认分支处理），避免误删合法素材。
function ingestAssets(list) {
  return (list || []).map((a) => {
    if (a && typeof a.type === 'string') {
      const norm = normalizeAssetType(a.type);
      if (norm && norm !== a.type) { a.type = norm; }
      else if (!norm) { console.warn('[HMDAO][ingest] 非规范 type：', a.type, 'url=', a.url); }
    }
    return a;
  });
}

// ★P2 修复（串素材）：侧栏按「当前活动标签」隔离素材。
// 切换标签页后，旧标签仍在后台轮询产生 SCAN_RESULT / lastScan 变更，
// 旧逻辑整体覆盖 assets → 上个网页的素材混入当前页。现在只接受「当前活动标签」的结果。
let activeTabId = null;
try {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0] && tabs[0].id) {
      activeTabId = tabs[0].id;
      // 首次拿到活动标签后，立即拉取该标签最近的扫描结果（若已存在）
      chrome.storage.local.get('lastScan', (s) => {
        if (s && s.lastScan && s.lastScan.tabId === activeTabId && Array.isArray(s.lastScan.assets)) {
          assets = deduplicateImages(ingestAssets(s.lastScan.assets));
          render();
        } else {
          // 活动标签尚无扫描结果：清空上一页残留，等该标签结果回来
          assets = [];
          render();
        }
      });
    }
  });
} catch (_) {}

chrome.tabs.onActivated.addListener((info) => {
  if (info && info.tabId) {
    activeTabId = info.tabId;
    assets = []; // 切换标签先清空，避免旧页素材残留闪烁
    render();
    // 通知后台：侧栏已切到新标签，停止旧标签轮询、对新标签启动轮询
    chrome.runtime.sendMessage({ type: 'HMDAO_SWITCH_TAB', tabId: info.tabId }).catch(() => {});
  }
});

function acceptScanResult(msg) {
  // tabId 不匹配当前活动标签 → 丢弃（防止串素材）。msg 可能未带 tabId 时（旧广播）回退为接受。
  if (msg && typeof msg.tabId === 'number' && activeTabId !== null && msg.tabId !== activeTabId) return;
  assets = deduplicateImages(ingestAssets(msg.assets || []));
  render();
  setStatus(`已发现 ${assets.length} 个素材（已去重）` + (msg.polling ? ' · 持续识别中…' : ''));
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'HMDAO_SCAN_RESULT') {
    acceptScanResult(msg);
  }
});

// 侧栏关闭时通知后台停止轮询，释放定时器
window.addEventListener('beforeunload', () => {
  chrome.runtime.sendMessage({ type: 'HMDAO_PANEL_CLOSED' }).catch(() => {});
});

// ★关键修复（P3）：SCAN_RESULT 通过 chrome.runtime.sendMessage 无 tabId 广播，
// 在 MV3 下只能被「当前打开的扩展页面」接收，且 SW 重启 / 侧栏加载时序竞态都会让广播丢失 → 侧栏为空。
// 改用 storage 持久化 + onChanged 实时推送：scanTab 写入 'lastScan' 后，此处立即更新侧栏，
// 无论侧栏是已打开（监听变更）还是刚加载（读一次），都能可靠拿到扫描结果。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.lastScan && changes.lastScan.newValue && Array.isArray(changes.lastScan.newValue.assets)) {
    const ls = changes.lastScan.newValue;
    // tabId 不匹配当前活动标签 → 跳过（P2 串素材修复）
    if (typeof ls.tabId === 'number' && activeTabId !== null && ls.tabId !== activeTabId) return;
    assets = deduplicateImages(ingestAssets(ls.assets));
    render();
    setStatus(`已发现 ${assets.length} 个素材（已去重）`);
  }
});
