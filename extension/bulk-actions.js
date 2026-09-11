// ===== 批量操作 / 类型目录选择 / 预设官方源 / 消息监听（抽离自 sidepanel.js）=====
// 本文件由 sidepanel.html 在 sidepanel.js 之后加载，确保 assets / selected / saveHandles
// 等全局变量已由 sidepanel.js 初始化，此处的 DOM 绑定与消息监听运行时均可见依赖符号。
// 纯物理拆分（普通脚本，共享全局作用域），不引入 ESM，行为零改变。

// ===== 批量操作（沿用原有接口） =====
function getChosen() {
  return window.assets.filter((_, i) => window.selected.has(i));
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

document.getElementById('import').onclick = async () => {
  if (window.HMDaoLicense && !(await window.HMDaoLicense.gate())) return;
  const list = getChosen();
  const batch = list.length ? list : window.assets;
  if (!batch.length) { setStatus('无素材', true); return; }
  sendImportToApp(batch);
};

document.getElementById('download').onclick = async () => {
  if (window.HMDaoLicense && !(await window.HMDaoLicense.gate())) return;
  const list = getChosen();
  const batch = list.length ? list : window.assets;
  if (!batch.length) { setStatus('无素材', true); return; }
  // ★ 显示「列表下载状态」：串行受限并发下载，实时刷新「已完成 X/总数」进度，
  // 解决「点下载后只看到『已发起下载 N 个』、不知何时完成/进行中」的问题。
  runBatchDownload(batch, 2);
};

// 受限并发批量下载：维持 done/fail 计数，每个完成即刷新状态栏，
// 结束给出「成功 X，失败 Y」汇总。downloadSingle 内部多数为异步但不 reject，
// 故以「是否走完」计 done；真正 throw 的（如 chrome.downloads.reject）计 fail。
async function runBatchDownload(batch, concurrency) {
  const btn = document.getElementById('download');
  if (btn) { btn.disabled = true; btn.dataset.old = btn.dataset.old || btn.textContent; btn.textContent = '⏳ 下载中…'; }
  const restore = () => { if (btn) { btn.disabled = false; btn.textContent = btn.dataset.old || '下载'; } };
  let done = 0, fail = 0;
  const total = batch.length;
  setStatus(`⬇ 批量下载中：0/${total}`);
  let idx = 0;
  async function worker() {
    while (idx < total) {
      const cur = idx++;
      const a = batch[cur];
      try {
        await downloadSingle(a);
        done++;
      } catch (_) {
        fail++;
      }
      setStatus(`⬇ 批量下载中：${done + fail}/${total}` + (fail ? `（失败 ${fail}）` : ''));
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, total); i++) workers.push(worker());
  await Promise.all(workers);
  setStatus(
    fail
      ? `批量下载完成：成功 ${done}，失败 ${fail}（失败项可在卡片上单独重试）`
      : `✅ 批量下载完成：${done}/${total} 个已保存（浏览器下载文件夹 Ddayup/）`,
    !!fail
  );
  restore();
}

document.getElementById('saveLocal').onclick = async () => {
  if (window.HMDaoLicense && !(await window.HMDaoLicense.gate())) return;
  const list = getChosen();
  const batch = list.length ? list : window.assets;
  if (!batch.length) { setStatus('无素材', true); return; }
  let done = 0, fail = 0;
  for (const a of batch) {
    try {
      const handle = window.saveHandles[a.type];
      if (!handle) { downloadSingle(a); done++; continue; }
      const res = await fetchViaBackground(a.url);
      if (!res || !res.ok) { fail++; continue; }
      // ★2026-09-10：sendMessage 会丢弃 ArrayBuffer，必须改用 b64 还原。
      let bytes = res.arrayBuffer;
      if (!bytes && res.b64) { try { bytes = b64ToBytes(res.b64); } catch (_) { bytes = null; } }
      if (!bytes) { fail++; continue; }
      const fileHandle = await handle.getFileHandle(deriveFilename(a), { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(bytes);
      await writable.close();
      done++;
    } catch (_) { fail++; }
  }
  setStatus(`保存完成：成功 ${done}，失败 ${fail}`);
};

// ===== 按类型目录选择（持久化到 IndexedDB，支持侧栏重开后恢复） =====
const IDB_NAME = 'DdayupSettings';
const IDB_STORE = 'typeDirs';
const IDB_VERSION = 1;

function openSettingsDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e);
  });
}

async function saveTypeDirHandle(type, handle) {
  const db = await openSettingsDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(handle, type);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error || new Error('IndexedDB put failed'));
  }).then(() => {
    // 同时把目录名记在 chrome.storage.local，即使权限丢失也能显示「上次选择：name（需重新授权）」
    try {
      chrome.storage.local.set({ ['dirName:' + type]: { name: handle.name, ts: Date.now() } });
    } catch (_) {}
    console.log('[Ddayup] 目录已持久化：', type, handle.name);
  });
}

async function loadTypeDirHandle(type) {
  const db = await openSettingsDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(type);
    req.onsuccess = (e) => resolve(e.target.result || null);
    req.onerror = (e) => reject(e.target.error || new Error('IndexedDB get failed'));
  });
}

// ★P0：网盘此前没有独立行 → 网盘下载永远落默认目录。补上后 download.js 的
//   userDirHandleFor('netdisk') 也能命中（网盘无设置时再回退 archive）。
const PATH_TYPES = ['image', 'video', 'audio', 'model', 'archive', 'netdisk'];

async function deleteTypeDirHandle(type) {
  const db = await openSettingsDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(type);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error || new Error('IndexedDB delete failed'));
  });
  try { chrome.storage.local.remove('dirName:' + type); } catch (_) {}
}

async function restoreSavedHandles() {
  const types = PATH_TYPES;
  for (const type of types) {
    try {
      const handle = await loadTypeDirHandle(type);
      const fallbackName = await new Promise((resolve) => {
        try {
          chrome.storage.local.get('dirName:' + type, (s) => {
            const v = s && s['dirName:' + type];
            resolve(v && v.name ? v.name : '');
          });
        } catch (_) { resolve(''); }
      });
      if (!handle) {
        // 无 handle 但有上次目录名 → 提示需重新授权
        if (fallbackName) {
          const sp = document.querySelector(`.pathText[data-type="${type}"]`);
          if (sp) sp.textContent = `⚠ ${fallbackName}（需重新授权）`;
          console.log('[Ddayup] 目录 handle 丢失，仅保留名称：', type, fallbackName);
        }
        continue;
      }
      // 静默检查权限（恢复时无用户手势，不能弹窗 requestPermission）
      let perm = 'prompt';
      try { perm = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) {
        console.log('[Ddayup] queryPermission 异常：', type, e && e.message);
      }
      // 无论权限是否持久都把 handle 挂上；真正写文件时再 requestPermission（那时是用户点击，有手势）
      window.saveHandles[type] = handle;
      const sp = document.querySelector(`.pathText[data-type="${type}"]`);
      if (sp) {
        if (perm === 'granted') sp.textContent = `✓ ${handle.name}`;
        else sp.textContent = fallbackName ? `⚠ ${fallbackName}（需重新授权）` : `⚠ ${handle.name}（需重新授权）`;
      }
      console.log('[Ddayup] 目录已恢复：', type, handle.name, 'perm=', perm);
    } catch (e) {
      console.error('[Ddayup] 恢复目录失败', type, e);
    }
  }
}

document.querySelectorAll('.pathPick').forEach((btn) => {
  btn.onclick = async () => {
    const type = btn.dataset.type;
    const sp = document.querySelector(`.pathText[data-type="${type}"]`);
    // ★2026-09-11 修复（用户实测「选了目录仍显示未设置」）：原代码只在 setStatus 提示，
    //   而 showDirectoryPicker 在部分 Chrome（尤其从 sidePanel 上下文调用）会因
    //   SecurityError/NotAllowedError 静默失败 → 用户看不到任何反馈、.pathText 永远「未设置」。
    //   现在把失败原因【直接写进 .pathText】，让用户一眼看到根因。
    if (!window.showDirectoryPicker) {
      if (sp) sp.textContent = '⚠ 此浏览器/扩展环境不支持目录选择';
      setStatus('当前环境不支持「选择目录」（需 Chrome 桌面版 + 文件系统访问 API）。下载将使用默认 Ddayup/ 目录。', true);
      return;
    }
    let handle;
    try {
      handle = await window.showDirectoryPicker();
    } catch (e) {
      // AbortError = 用户主动取消，保持「未设置」即可，不打扰
      if (e && e.name === 'AbortError') return;
      const reason = (e && e.message) ? String(e.message).slice(0, 48) : String(e);
      if (sp) sp.textContent = '⚠ 选择失败：' + reason;
      setStatus('选择目录失败：' + ((e && e.message) || e) + '（下载将用默认目录）', true);
      console.error('[Ddayup] showDirectoryPicker 异常：', type, e && e.name, e && e.message);
      return;
    }
    // 立即更新内存与 UI，保证当前会话可用；持久化失败再回退提示
    window.saveHandles[type] = handle;
    if (sp) sp.textContent = `✓ ${handle.name}`;
    setStatus(`已设置「${typeLabel(type)}」目录：${handle.name}`);
    try {
      await saveTypeDirHandle(type, handle);
    } catch (e) {
      console.error('[Ddayup] 目录持久化失败', type, e);
      if (sp) sp.textContent = `⚠ ${handle.name}（持久化失败，下次需重选）`;
      setStatus('目录持久化失败（下次打开侧栏需重新选择）：' + (e && e.message || e), true);
    }
  };
});

// 侧栏加载时恢复已保存目录
// 侧栏加载时恢复已保存目录（await：避免用户手快先点下载时 handle 还没挂上）
const __dirRestorePromise = restoreSavedHandles().then(() => restoreRelDirs());

// ===== 2026-09-11 双保险：相对子目录兜底 =====
// 当浏览器不支持 showDirectoryPicker（选绝对目录）时，用户可在文本框填相对子目录名，
// 下载落到「浏览器下载目录/Ddayup/<相对子目录>/」。扩展无法写入任意绝对盘符路径，
// 故文本框仅作相对子目录语义；若用户输入绝对路径格式，自动剥离盘符/前缀并提示。
function normalizeRelPath(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  s = s.replace(/^file:\/\//i, '');
  const m = s.match(/^[a-zA-Z]:[\\/]+(.*)$/); // Windows 盘符绝对路径 D:\ / D:/
  if (m) {
    const rest = m[1].replace(/^[\\/]+/, '');
    return rest ? { path: rest, absolute: true } : null;
  }
  if (/^[\\/]/.test(s)) { // Unix 绝对路径 /foo/bar
    const rest = s.replace(/^[\\/]+/, '');
    return rest ? { path: rest, absolute: true } : null;
  }
  return { path: s, absolute: false };
}

function saveRelDir(type, path) {
  try {
    if (path) chrome.storage.local.set({ ['relDir:' + type]: { path, ts: Date.now() } });
    else chrome.storage.local.remove('relDir:' + type);
  } catch (_) {}
}

function loadRelDir(type) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get('relDir:' + type, (s) => {
        const v = s && s['relDir:' + type];
        resolve(v && v.path ? v.path : '');
      });
    } catch (_) { resolve(''); }
  });
}

// ★被 download.js 的 dlViaChrome 调用（bulk-actions.js 在 download.js 之前加载，全局可见）。
// 返回相对子目录片段（不含前导 /），无设置返回 null。netdisk 复用 archive。
function userRelDirFor(type) {
  if (typeof relDirs === 'undefined' || !relDirs) return null;
  let v = relDirs[type];
  if (!v && type === 'netdisk') v = relDirs.archive;
  return v ? String(v).replace(/^[\\/]+/, '') : null;
}

async function restoreRelDirs() {
  for (const type of PATH_TYPES) {
    try {
      const p = await loadRelDir(type);
      if (p) {
        relDirs[type] = p;
        const sp = document.querySelector(`.pathText[data-type="${type}"]`);
        // 仅在无绝对目录设置时才用相对子目录回显，避免覆盖绝对目录显示
        if (sp && !(window.saveHandles && window.saveHandles[type])) {
          sp.textContent = `✓ 相对：${p}`;
          sp.classList.add('ok');
        }
      }
    } catch (_) {}
  }
}

function applyRelPath(type) {
  const inp = document.querySelector(`.pathInput[data-type="${type}"]`);
  const sp = document.querySelector(`.pathText[data-type="${type}"]`);
  const raw = inp ? inp.value : '';
  const norm = normalizeRelPath(raw);
  if (!norm) {
    relDirs[type] = null;
    saveRelDir(type, '');
    if (sp) { sp.textContent = '未设置'; sp.classList.remove('ok', 'warn'); }
    setStatus(`已清除「${typeLabel(type)}」相对子目录设置`);
    return;
  }
  relDirs[type] = norm.path;
  saveRelDir(type, norm.path);
  if (sp) {
    if (norm.absolute) {
      sp.textContent = `✓ 相对：${norm.path}（已去掉盘符；要写绝对路径请用「选择目录」）`;
      sp.classList.add('warn'); sp.classList.remove('ok');
    } else {
      sp.textContent = `✓ 相对：${norm.path}`;
      sp.classList.add('ok'); sp.classList.remove('warn');
    }
  }
  setStatus(`已设置「${typeLabel(type)}」相对子目录：${norm.path}（下载存到 浏览器下载目录/Ddayup/${norm.path}/）`);
}

document.querySelectorAll('.pathApply').forEach((btn) => {
  btn.onclick = () => applyRelPath(btn.dataset.type);
});
document.querySelectorAll('.pathInput').forEach((inp) => {
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyRelPath(inp.dataset.type); });
  inp.addEventListener('blur', () => applyRelPath(inp.dataset.type));
});

// ★P3 清除：删掉 IndexedDB 句柄 + 目录名 + 内存引用 + 相对子目录，UI 回到「未设置」
document.querySelectorAll('.pathClear').forEach((btn) => {
  btn.onclick = async () => {
    const type = btn.dataset.type;
    try {
      await deleteTypeDirHandle(type);
      if (window.saveHandles) window.saveHandles[type] = null;
      // ★双保险：同时清除相对子目录
      relDirs[type] = null;
      saveRelDir(type, '');
      const sp = document.querySelector(`.pathText[data-type="${type}"]`);
      if (sp) { sp.textContent = '未设置'; sp.classList.remove('ok', 'warn'); }
      setStatus(`已清除「${typeLabel(type)}」目录设置`);
    } catch (e) {
      setStatus('清除失败：' + ((e && e.message) || e), true);
    }
  };
});

// ★P3 测试写入：在设置的目录里写一个小文件，立刻验证「可写 / 权限 / 路径」是否正确
document.querySelectorAll('.pathTest').forEach((btn) => {
  btn.onclick = async () => {
    const type = btn.dataset.type;
    const handle = (window.saveHandles || {})[type];
    const sp = document.querySelector(`.pathText[data-type="${type}"]`);
    if (!handle) {
      // 相对子目录模式：无法在侧栏直接写测试文件（走 chrome.downloads 落盘），仅提示将落位置
      if (relDirs[type]) {
        setStatus(`「${typeLabel(type)}」为相对子目录模式，下载将落到 浏览器下载目录/Ddayup/${relDirs[type]}/（点一次下载即可验证）`, false);
        return;
      }
      setStatus(`「${typeLabel(type)}」尚未设置目录（绝对或相对）`, true); return;
    }
    try {
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        const p2 = await handle.requestPermission({ mode: 'readwrite' });
        if (p2 !== 'granted') { setStatus('未授权写入该目录', true); return; }
      }
      const fh = await handle.getFileHandle('.ddayup-dir-test.txt', { create: true });
      const w = await fh.createWritable();
      await w.write(new Blob(['Ddayup 目录写入测试 ' + new Date().toISOString()], { type: 'text/plain' }));
      await w.close();
      if (sp) sp.textContent = `✓ ${handle.name}`;
      setStatus(`✅ 写入成功：「${typeLabel(type)}」→ ${handle.name}（该目录下应有 .ddayup-dir-test.txt）`);
    } catch (e) {
      if (sp) sp.textContent = `⚠ ${handle.name}（写入失败）`;
      setStatus('写入测试失败：' + ((e && e.message) || e), true);
    }
  };
});

// ★2026-09-11 诊断按钮：把「目录到底设没设上」一次性摊开给用户看（无需开 DevTools）。
const __diagBtn = document.getElementById('pathDiagnose');
if (__diagBtn) {
  __diagBtn.onclick = async () => {
    let pre = document.getElementById('pathDiagOut');
    if (!pre) {
      pre = document.createElement('pre');
      pre.id = 'pathDiagOut';
      pre.style.cssText = 'margin:2px 12px 10px;padding:8px;background:#0d1117;border:1px solid #30363d;' +
        'border-radius:6px;color:#c9d1d9;font-size:10px;line-height:1.6;white-space:pre-wrap;' +
        'word-break:break-all;max-height:240px;overflow:auto';
      const details = __diagBtn.closest('details');
      (details || __diagBtn.parentElement.parentElement).appendChild(pre);
    }
    pre.textContent = '诊断中…';
    const lines = [];
    lines.push('浏览器 showDirectoryPicker: ' + (typeof window.showDirectoryPicker === 'function' ? '✅ 可用' : '❌ 不可用'));
    const inMem = Object.keys(window.saveHandles || {}).filter((k) => window.saveHandles[k]);
    lines.push('内存已挂句柄: ' + (inMem.length ? inMem.join(', ') : '（无）'));
    lines.push('');
    for (const type of PATH_TYPES) {
      let h = null, err = '';
      try { h = await loadTypeDirHandle(type); } catch (e) { err = String((e && e.message) || e); }
      const name = await new Promise((r) => {
        try {
          chrome.storage.local.get('dirName:' + type, (s) => {
            const v = s && s['dirName:' + type];
            r(v && v.name ? v.name : '');
          });
        } catch (_) { r(''); }
      });
      const mem = (window.saveHandles && window.saveHandles[type]) ? '✓在内存' : '—';
      let perm = '—';
      if (h) { try { perm = await h.queryPermission({ mode: 'readwrite' }); } catch (e) { perm = '查询失败:' + ((e && e.message) || e); } }
      lines.push(
        `${type.padEnd(8)} IndexedDB=${h ? '有(' + h.name + ')' : '无'}  上次名=${name || '无'}  ${mem}  权限=${perm}${err ? '  err=' + err : ''}`
      );
    }
    lines.push('');
    lines.push('说明：IndexedDB=无 且 上次名=无 → 从未设置成功过；');
    lines.push('      IndexedDB=有 但 权限≠granted → 点「测试」按钮重新授权；');
    lines.push('      两者都有且权限=granted → 下载应能写入，若仍落默认目录请把本截图发出。');
    const txt = lines.join('\n');
    pre.textContent = txt;
    console.log('[Ddayup][诊断] 保存目录\n' + txt);
    const noneSet = PATH_TYPES.every((t) => !(window.saveHandles && window.saveHandles[t]));
    setStatus(noneSet ? '⚠ 诊断：没有任何类型设置成功，见下方输出' : '✅ 诊断完成，见下方输出', noneSet);
  };
}

// ===== 预设素材源（数据驱动，单一事实来源）=====
// 新增平台只需在此数组追加一项，HTML 不再硬编码按钮（重构：消除四处重复的 details/presetRow 结构）。
// mediaType 标注该源主营素材类型，便于未来按图片/视频/音效分组逻辑化处理。
const PRESET_SOURCES = [
  {
    title: '📸 专业图片源',
    open: true,
    items: [
      { name: 'Unsplash', url: 'https://unsplash.com' },
      { name: 'Pexels', url: 'https://www.pexels.com/zh-cn/' },
      { name: 'Pixabay', url: 'https://pixabay.com/zh/images/' },
      { name: 'StockSnap', url: 'https://stocksnap.io' },
      { name: 'SplitShire', url: 'https://splitshire.com' },
    ],
  },
  {
    title: '🎬 专业视频源',
    items: [
      { name: 'Pexels Videos', url: 'https://www.pexels.com/zh-cn/videos/' },
      { name: 'Coverr', url: 'https://coverr.co' },
      { name: 'Mixkit 视频', url: 'https://mixkit.co/free-stock-video/' },
      { name: 'Pixabay 视频', url: 'https://pixabay.com/zh/videos/' },
    ],
  },
  {
    title: '🎵 音效 / 音乐源',
    mediaType: 'audio',
    items: [
      { name: '爱给网', url: 'https://www.aigei.com/sound/' },
      { name: 'Freesound', url: 'https://freesound.org' },
      { name: 'Mixkit Music', url: 'https://mixkit.co/free-stock-music/' },
      { name: 'Pixabay Music', url: 'https://pixabay.com/zh/music/' },
      { name: 'SoundBible', url: 'https://soundbible.com' },
    ],
  },
  {
    title: '🧊 3D 模型源',
    items: [
      { name: 'Sketchfab', url: 'https://sketchfab.com' },
      { name: 'Poly Pizza', url: 'https://poly.pizza' },
      { name: 'Quaternius', url: 'https://quaternius.com' },
      { name: 'Kenney', url: 'https://kenney.nl' },
    ],
  },
  {
    // ★2026-08-18：补充 UGC 创作/灵感源直连（这些站需登录态或需要登录态最佳体验，
    // 预设作为"快速打开"入口，点击后用户自行登录；Ddayup 在已登录的标签页里扫描即可采集）。
    title: '✨ 创作 / 灵感源',
    items: [
      { name: '抖音', url: 'https://www.douyin.com' },
      { name: 'B站', url: 'https://www.bilibili.com' },
      { name: '小红书', url: 'https://www.xiaohongshu.com' },
      { name: 'ArtStation', url: 'https://www.artstation.com' },
      { name: 'Pinterest', url: 'https://www.pinterest.com' },
      { name: 'YouTube', url: 'https://www.youtube.com' },
    ],
  },
];

// ===== 用户自定义收藏源（localStorage 持久化，可增删，点击直连）=====
const MY_SOURCES_KEY = 'hmdao_my_sources';
function loadMySources() {
  try { return JSON.parse(localStorage.getItem(MY_SOURCES_KEY) || '[]'); } catch (_) { return []; }
}
function saveMySources(list) {
  try { localStorage.setItem(MY_SOURCES_KEY, JSON.stringify(list)); } catch (_) {}
}
// 自动清理旧版本产生的重复收藏（同一 URL 只保留一条）。
function cleanupDuplicateSources() {
  const list = loadMySources();
  const seen = new Set();
  const cleaned = [];
  for (const it of list) {
    if (!it || !it.url) continue;
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    cleaned.push(it);
  }
  if (cleaned.length < list.length) saveMySources(cleaned);
  return cleaned;
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 将 PRESET_SOURCES 渲染进 #presetSources 容器（保留原 DOM 结构与 .preset class，样式不变）。
// 末尾追加「⭐ 我的收藏」分组：用户可添加/删除自定义源，点击即直连访问。
// ★注意：必须是函数声明（不能是 IIFE），因为添加/删除按钮的事件处理里要重复调用它。
function renderPresetSources() {
  const root = document.getElementById('presetSources');
  if (!root) return;
  const presetHtml = PRESET_SOURCES.map((grp) => {
    const openAttr = grp.open ? ' open' : '';
    const btns = grp.items.map((it) =>
      `<button class="preset" data-url="${it.url}">${it.name}</button>`
    ).join('');
    return `<details${openAttr}><summary>${grp.title}</summary><div class="presetRow">${btns}</div></details>`;
  }).join('');

  const mine = cleanupDuplicateSources();
  const mineBtns = mine.map((it, i) =>
    `<span class="mySrc"><button class="preset" data-url="${escapeHtml(it.url)}" title="${escapeHtml(it.category || '')}\n${escapeHtml(it.url)}">${escapeHtml(it.name || it.url)}</button>` +
    `<button class="mySrcDel" data-idx="${i}" title="删除">×</button></span>`
  ).join('');
  const mineHtml =
    `<details class="mySources" open><summary>⭐ 我的收藏</summary>` +
    `<div class="presetRow mySrcAdd">` +
    `<input class="mySrcName" type="text" placeholder="名称（可选）" />` +
    `<input class="mySrcCategory" type="text" placeholder="分类（可选）" title="给收藏站点加个分类，方便后续按类筛选" />` +
    `<input class="mySrcUrl" type="text" placeholder="粘贴网站地址，如 https://…" />` +
    `<button class="mySrcFillBtn" title="一键填入当前活动标签页的标题和地址">📋 当前页</button>` +
    `<button class="mySrcAddBtn">+ 添加</button>` +
    `</div>` +
    (mine.length ? `<div class="presetRow">${mineBtns}</div>` : `<div class="presetRow mySrcEmpty">还没有收藏，添加常用素材站吧</div>`) +
    `</details>`;

  root.innerHTML = presetHtml + mineHtml;
}
renderPresetSources();

// ===== 预设官方源 + 我的收藏（事件委托）=====
document.getElementById('presetSources').addEventListener('click', (e) => {
  const del = e.target.closest('.mySrcDel');
  if (del) {
    const idx = parseInt(del.dataset.idx, 10);
    const list = loadMySources();
    if (!isNaN(idx) && idx >= 0 && idx < list.length) {
      list.splice(idx, 1);
      saveMySources(list);
      renderPresetSources();
      setStatus('已删除收藏');
    }
    return;
  }
  if (e.target.closest('.mySrcFillBtn')) {
    e.preventDefault();
    const wrap = e.target.closest('.mySrcAdd');
    const nameInput = wrap.querySelector('.mySrcName');
    const urlInput = wrap.querySelector('.mySrcUrl');
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const t = tabs && tabs[0];
        if (!t || !t.url || t.url.startsWith('chrome://') || t.url.startsWith('edge://') || t.url.startsWith('about:')) {
          setStatus('当前页无法读取（浏览器内部页）', true);
          return;
        }
        if (nameInput) nameInput.value = t.title || '';
        if (urlInput) urlInput.value = t.url;
        setStatus('已填入当前页');
      });
    } catch (_) { setStatus('读取当前页失败', true); }
    return;
  }
  if (e.target.closest('.mySrcAddBtn')) {
    const wrap = e.target.closest('.mySrcAdd');
    const name = wrap.querySelector('.mySrcName').value.trim();
    const category = wrap.querySelector('.mySrcCategory').value.trim();
    const url = wrap.querySelector('.mySrcUrl').value.trim();
    if (!url) { setStatus('请先粘贴网站地址', true); return; }
    let norm = url;
    if (!/^https?:\/\//i.test(norm)) norm = 'https://' + norm;
    try { new URL(norm); } catch (_) { setStatus('地址格式不正确', true); return; }
    const list = loadMySources();
    // 去重：同一 URL 只保留一次
    if (list.some((it) => it.url === norm)) {
      setStatus('该地址已收藏', true);
      return;
    }
    list.push({ name: name || norm, url: norm, category });
    saveMySources(list);
    renderPresetSources();
    setStatus('已收藏 ' + norm);
    // 添加成功后保留输入框并清空，方便连续添加下一条
    const freshWrap = document.querySelector('#presetSources .mySrcAdd');
    if (freshWrap) {
      const n = freshWrap.querySelector('.mySrcName');
      const c = freshWrap.querySelector('.mySrcCategory');
      const u = freshWrap.querySelector('.mySrcUrl');
      if (n) n.value = '';
      if (c) c.value = '';
      if (u) { u.value = ''; u.focus(); }
    }
    return;
  }
  const btn = e.target.closest('.preset');
  if (!btn) return;
  const url = btn.dataset.url;
  if (!url) return;
  setStatus('打开 ' + (() => { try { return new URL(url).hostname; } catch (_) { return url; } })() + '…');
  try { chrome.runtime.sendMessage({ type: 'HMDAO_OPEN_PRESET', url }); }
    catch (_) { chrome.tabs.create({ url }); }
});

// ===== 消息监听 =====
// 入口校验：扫描来源可能带非规范 type（拼写/大小写/别名），统一归一到 ASSET_TYPES 规范集合。
// 无法识别的 type 记录日志并保留原值（不静默丢弃，交由下游按默认分支处理），避免误删合法素材。
function ingestAssets(list) {
  return (list || [])
    .filter((a) => !(a && a.url && typeof isBlockedHost === 'function' && isBlockedHost(a.url))) // ★2026-08-18 屏蔽水印来源
    .map((a) => {
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
window.activeTabId = null;
try {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0] && tabs[0].id) {
      window.activeTabId = tabs[0].id;
      // ★重新加载侧栏时先清理过期/失效素材（源页已关 + 签名限时链接过期），
      // 再读取清理后的 lastScan 渲染，避免列表里残留点不开/已 403 的死链。
      // 用回调式 sendMessage 以拿到清理结果；失败/超时则跳过清理直接读 lastScan（兜底不阻塞）。
      try {
        chrome.runtime.sendMessage({ type: 'HMDAO_CLEANUP_STALE_ASSETS' }, () => {
          // 无论清理成功与否，都继续读取最新 lastScan
          if (chrome.runtime.lastError) { /* 清理失败不阻塞 */ }
          chrome.storage.local.get('lastScan', (s) => {
            if (s && s.lastScan && s.lastScan.tabId === window.activeTabId && Array.isArray(s.lastScan.assets)) {
              window.assets = deduplicateImages(ingestAssets(s.lastScan.assets));
              render();
            } else {
              // 活动标签尚无扫描结果：清空上一页残留，等该标签结果回来
              window.assets = [];
              render();
            }
          });
        });
      } catch (_) {
        // 极端环境 sendMessage 不可用：直接读 lastScan
        chrome.storage.local.get('lastScan', (s) => {
          if (s && s.lastScan && s.lastScan.tabId === window.activeTabId && Array.isArray(s.lastScan.assets)) {
            window.assets = deduplicateImages(ingestAssets(s.lastScan.assets));
            render();
          } else {
            window.assets = [];
            render();
          }
        });
      }
    }
  });
} catch (_) {}

chrome.tabs.onActivated.addListener((info) => {
  if (info && info.tabId) {
    window.activeTabId = info.tabId;
    window.assets = []; // 切换标签先清空，避免旧页素材残留闪烁
    render();
    // ★2026-08-24 深层修复（真机 bug：顶部"当前页"与卡片不同步）：
    //   旧逻辑只清空 assets + render，顶部 title/url/thumb 仍显示旧页 → 顶部旧页 + 卡片新页错位。
    //   修复：先调 loadPagePreview（顶部 header 同步到当前活动 tab），再清空+render+通知后台。
    //   loadPagePreview 内部已幂等，无需担心重入。
    try { loadPagePreview(); } catch (_) {}
    // 通知后台：侧栏已切到新标签，停止旧标签轮询、对新标签启动轮询
    chrome.runtime.sendMessage({ type: 'HMDAO_SWITCH_TAB', tabId: info.tabId }).catch(() => {});
  }
});

// 已自动解析过的网盘分享页 URL，避免反复打开标签页解析
const __autoResolvedNetdisks = new Set();

function acceptScanResult(msg) {
  // tabId 不匹配当前活动标签 → 丢弃（防止串素材）。msg 可能未带 tabId 时（旧广播）回退为接受。
  if (msg && typeof msg.tabId === 'number' && window.activeTabId !== null && msg.tabId !== window.activeTabId) return;
  // ★2026-09-07 修复（「切 hash / 换页旧素材丢失」根因）：window.assets 的【唯一权威 owner】是
  //   sidepanel.js 的 HMDAO_SCAN_RESULT 增量合并处理器（它做「同文档增量累加 + 文档身份变化才清空」，
  //   配合建议1/2 的 hash 路由清卡开关）。本文件此前在此处 `window.assets = deduplicateImages(...)` 做
  //   【整列表覆盖】，会把上一轮扫描到的素材（如 hash 路由站切内容前的 v1）直接抹掉，导致 v1 在切到
  //   v2 后消失。改为：不再写 window.assets，只读 sidepanel 已合并好的 window.assets 做网盘自动解析，
  //   同时把渲染/状态交给 sidepanel（它已 renderNow + updateScanStatus）。避免双 handler 抢写冲突。
  if (!Array.isArray(window.assets)) window.assets = [];
  if (window.__hmdaoUpdateScanStatus) window.__hmdaoUpdateScanStatus(window.assets, 'done');
  if (typeof render === 'function') render();

  // ★ 扫描到网盘分享页入口时自动深度解析（用户无需手动找按钮），避免"看不到深度解析按钮"。
  for (const a of window.assets) {
    if (a.type === 'netdisk' && a.url && !a.tree && typeof netdiskResolve === 'function') {
      if (!__autoResolvedNetdisks.has(a.url)) {
        __autoResolvedNetdisks.add(a.url);
        netdiskResolve(a);
      }
    }
  }
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
    if (typeof ls.tabId === 'number' && window.activeTabId !== null && ls.tabId !== window.activeTabId) return;
    // ★2026-09-07 修复：lastScan 变更不再覆盖 window.assets（避免抹掉 sidepanel 增量合并的素材）。
    //   window.assets 由 sidepanel.js 的 SCAN_RESULT 处理器统一维护；这里仅触发一次重渲染，
    //   让侧栏在持久化恢复后立刻反映最新列表。
    if (!Array.isArray(window.assets)) window.assets = [];
    if (typeof render === 'function') render();
    if (window.__hmdaoUpdateScanStatus) window.__hmdaoUpdateScanStatus(window.assets, 'done');
  }
});
