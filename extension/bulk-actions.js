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
      // ★2026-09-12：若有「后端绝对路径」通道，统一交 downloadSingle（→ trySaveToUserDir→后端流式写盘），
      //   避免此处的「拉字节进侧栏」旧 FSA 通道抢占；无句柄时同样回退 downloadSingle。
      const hasBackend = (typeof dirPaths !== 'undefined' && dirPaths && dirPaths[a.type]);
      const handle = window.saveHandles[a.type];
      if (hasBackend || !handle) { downloadSingle(a); done++; continue; }
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

// ===== 绝对路径通道（后端 dirPath:<type>，由本地服务 127.0.0.1:3000 写盘）=====
// ★2026-09-12：chrome.downloads.download 只能写「浏览器默认下载目录 + 相对子目录」，
//   无法写任意绝对目录；File System Access API 在 side panel 里又不可靠（句柄常为 null）。
//   故「真实绝对路径 → 后端流式落盘」是本项目写任意盘符/大文件的唯一可靠通道。
// ★2026-09-13：绝对路径来源由「手动输入框」改为【后端原生目录选择器】（见 __pickDirViaBackend），
//   返回值即真实绝对路径，直接存入下面的 dirPaths。
// ★必须用 var（与 saveHandles 同理）：顶层 var 进入全局对象（window.dirPaths），跨 <script>
//   共享，使 download.js 的后端落盘通道能读到；const/let 不跨 <script>，会导致读不到。
var dirPaths = { image: null, video: null, audio: null, model: null, archive: null, netdisk: null };
const dirPathStorageKey = (type) => 'dirPath:' + type;

// 规范化绝对路径：去首尾空白，去掉尾部分隔符（保留根 "/" 与 "D:\"）。
function normalizeAbsDir(p) {
  let s = String(p == null ? '' : p).trim();
  if (!s) return '';
  s = s.replace(/[\\/]+$/, '');
  return s;
}
// 绝对路径判定已不再在扩展侧使用（手动输入框已移除；目录由后端原生选择器返回绝对路径）。
// 本地后端基址（save-to-dir / probe-dir / pick-directory 均为【本机专属】端点）。
// ★2026-09-13 关键修复：这些端点「写本机磁盘 / 弹本机系统目录对话框」，只有【本机后端】能处理；
//   而 apiBaseUrl() 在默认配置下会返回云端地址（DdayupConfig.DEFAULT_API_BASE=https://mingmingchuangyi.cn），
//   云端既没有 /api/media/save-to-dir 路由、也无法访问本机磁盘 → 表现为「选了目录也存不进/报 No route」。
//   故这里【只认环回地址】，非环回一律回退本机默认端口（与 router.js 的 SW 网盘落盘硬编码 127.0.0.1:3000 一致）。
function ddBackendBase() {
  let b = '';
  try { if (typeof apiBaseUrl === 'function') b = String(apiBaseUrl() || '').replace(/\/+$/, ''); } catch (_) { b = ''; }
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(b)) return b;
  return 'http://127.0.0.1:3000';
}
// 持久化绝对路径到 chrome.storage.local（键 dirPath:<type>），并同步内存 dirPaths。
// 注意：不等待 storage 回调（部分环境/桩不回调会导致 await 挂起）；写入是尽力而为 + 持久化。
function saveDirPath(type, abs) {
  dirPaths[type] = abs;
  try {
    chrome.storage.local.set({ [dirPathStorageKey(type)]: abs }, () => { void chrome.runtime.lastError; });
  } catch (_) { /* 忽略 */ }
  return Promise.resolve();
}
// 清除某类型的绝对路径（内存 + chrome.storage.local）。
function deleteDirPath(type) {
  dirPaths[type] = null;
  try {
    chrome.storage.local.remove(dirPathStorageKey(type), () => { void chrome.runtime.lastError; });
  } catch (_) { /* 忽略 */ }
  return Promise.resolve();
}
// 侧栏加载时恢复绝对路径（与 restoreSavedHandles 并行，互不阻塞）。
// 带兜底超时：即便 storage 回调始终不来，也不会让 __dirRestorePromise 永久挂起。
function restoreDirPaths() {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    const timer = setTimeout(done, 1500);
    let keys;
    try { keys = PATH_TYPES.map((t) => dirPathStorageKey(t)); } catch (_) { clearTimeout(timer); return done(); }
    try {
      chrome.storage.local.get(keys, (s) => {
        const store = s || {};
        for (const type of PATH_TYPES) {
          const v = store[dirPathStorageKey(type)];
          if (typeof v === 'string' && v.trim()) dirPaths[type] = normalizeAbsDir(v);
        }
        clearTimeout(timer);
        done();
      });
    } catch (_) { clearTimeout(timer); done(); }
  });
}
// 统一刷新 6 行 .pathText 文案：绝对路径（后端通道）优先于句柄，其次默认基线。
function refreshPathTexts() {
  for (const type of PATH_TYPES) {
    const sp = document.querySelector(`.pathText[data-type="${type}"]`);
    if (!sp) continue;
    if (dirPaths[type]) {
      sp.textContent = '✅ 已设置：' + dirPaths[type];
      if (sp.classList) { sp.classList.add('ok'); sp.classList.remove('warn'); }
    } else if (window.saveHandles && window.saveHandles[type]) {
      sp.textContent = '✅ 已设置(句柄)：' + window.saveHandles[type].name;
      if (sp.classList) { sp.classList.add('ok'); sp.classList.remove('warn'); }
    } else {
      const sub = (typeof typeDirs !== 'undefined' && typeDirs[type]) || 'other';
      sp.textContent = `未设置 · 默认 Ddayup/${sub}/`;
      if (sp.classList) { sp.classList.remove('ok', 'warn'); }
    }
  }
}

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
        // 无 handle 但有上次目录名 → 提示需重新授权（若已设绝对路径，则由其显示优先，不覆盖）
        if (fallbackName && !dirPaths[type]) {
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
      // 绝对路径（后端通道）显示优先，避免句柄恢复覆盖用户填的路径
      if (!dirPaths[type]) {
        const sp = document.querySelector(`.pathText[data-type="${type}"]`);
        if (sp) {
          if (perm === 'granted') sp.textContent = `✅ 已设置(句柄)：${handle.name}`;
          else sp.textContent = fallbackName ? `⚠ ${fallbackName}（需重新授权）` : `⚠ ${handle.name}（需重新授权）`;
        }
      }
      console.log('[Ddayup] 目录已恢复：', type, handle.name, 'perm=', perm);
    } catch (e) {
      console.error('[Ddayup] 恢复目录失败', type, e);
    }
  }
}

// ★2026-09-13 重构（用户诉求「要目录选择、不要手动输入」的最终落点）：
//   「选择目录」【先调后端原生目录选择器】拿【真实绝对路径】→ 存入 dirPath:<type>。
//   ★ 为什么是后端优先：唯一可靠的落盘通道是后端 /api/media/save-to-dir，它必须【绝对路径字符串】，
//     而手写绝对路径粘贴与此走的是【完全相同】的可靠写盘通道（phase20 E2E 已验证 sha256 一致）。
//     后端 /api/settings/assets/pick-directory 用 PowerShell FolderBrowserDialog（-STA）返回已 path.resolve 的
//     真实绝对路径，且无需登录态 → 点「选择目录」即可拿到与手写粘贴等价的可靠路径。
//   ★ 为什么 FSA 不再兜底：FSA showDirectoryPicker 只返回 FileSystemDirectoryHandle（【没有绝对路径字符串】），
//     且在 side panel 里【不可靠/不持久】：句柄常返回 null、刚 showDirectoryPicker 之后 requestPermission 会
//     【误报 'prompt'（实际已授权）】。若把 FSA 当主通道，就会「点选择目录像设上了，测试/下载仍提示尚未设置、
//     落默认目录」——正是用户最初报的 bug。故 .pathPick 只走后端原生选择器；
//     FSA 句柄仅在恢复旧设置/手动场景下保留，不再作为「选择目录」入口的兜底。
//   调后端原生目录选择器。返回 { canceled, path, error }：
//   path 非空 = 用户选中（绝对路径）；canceled=true = 用户取消；error 非空 = 后端不可用/失败。
async function __pickDirViaBackend(type) {
  const call = async () => {
    const r = await fetch(ddBackendBase() + '/api/settings/assets/pick-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initialPath: dirPaths[type] || '' }),
      // 用户点“确定”前该请求会一直 pending → 必须给足超时（120s）
      signal: AbortSignal.timeout(120000),
    });
    const d = await r.json().catch(() => ({}));
    return { r, d };
  };
  let res;
  try {
    res = await call();
  } catch (e) {
    // 连接失败（本地服务未启动）→ 拉起后端一次后重试；仍失败则返回原因（不静默）
    try {
      if (typeof ensureBackendRunningNative === 'function') await ensureBackendRunningNative({ silent: true });
    } catch (_) { /* 忽略拉起失败，继续重试一次 */ }
    try { res = await call(); }
    catch (e2) { return { canceled: false, path: '', error: (e2 && e2.message) || 'connection failed' }; }
  }
  const r = res && res.r;
  const d = res && res.d;
  if (r && r.ok && d && d.success) {
    if (d.canceled) return { canceled: true, path: '' };
    return { canceled: false, path: d.path ? normalizeAbsDir(d.path) : '' };
  }
  return { canceled: false, path: '', error: (d && d.error) || (r ? ('HTTP ' + r.status) : 'unknown') };
}

document.querySelectorAll('.pathPick').forEach((btn) => {
  btn.onclick = async () => {
    const type = btn.dataset.type;
    const sp = document.querySelector(`.pathText[data-type="${type}"]`);
    if (sp) { sp.textContent = '选择中…（请在系统弹窗中选择目录）'; if (sp.classList) { sp.classList.remove('ok', 'warn'); } }

    // ★2026-09-13 重构（用户诉求「要目录选择、不要手动输入」的最终落点）：
    //   1) 后端原生目录选择器优先：FolderBrowserDialog(-STA) 返回【真实绝对路径】→ 存 dirPath:<type>。
    //      这是与「手动粘贴绝对路径」完全相同的可靠写盘通道（后端 /api/media/save-to-dir，phase20 已验证 sha256 一致），
    //      而 FSA showDirectoryPicker 在侧栏不可靠/不持久（句柄常为 null、权限误报），且不返回真实绝对路径，
    //      故 FSA 不再作为 .pathPick 的兜底；后端不可用时无法选择目录，需启动本地服务后重试。
    let picked = { canceled: false, path: '', error: '' };
    try { picked = await __pickDirViaBackend(type); }
    catch (e) { picked = { canceled: false, path: '', error: (e && e.message) || 'pick failed' }; }

    if (picked.canceled) { refreshPathTexts(); return; }   // 用户取消：恢复原显示，不打扰
    if (picked.path) {
      // 拿到绝对路径 → 清掉可能残留的 FSA 句柄（避免两套通道互相覆盖显示），存 + 显示「✅ 已设置：<path>」
      try { if (window.saveHandles) window.saveHandles[type] = null; } catch (_) {}
      try { await deleteTypeDirHandle(type); } catch (_) {}
      await saveDirPath(type, picked.path);
      if (sp) { sp.textContent = '✅ 已设置：' + picked.path; if (sp.classList) { sp.classList.add('ok'); sp.classList.remove('warn'); } }
      setStatus(`✅ 已设置「${typeLabel(type)}」保存目录：${picked.path}（由本地服务写盘）`);
      console.log('[Ddayup][userdir] 绝对路径已保存：', type, picked.path);
      return;
    }

    // 2) 后端不可用 → 无法弹出系统目录选择框，明确提示启动后端。
    //    FSA showDirectoryPicker 在侧栏不可靠/不持久（句柄常为 null、权限误报），且不返回真实绝对路径，
    //    不满足「目录选择→真实路径」需求，故不再作为 .pathPick 的兜底；启动后端后即可重试。
    const backendErr = picked.error || '后端目录选择不可用';
    const isConnErr = /failed|refused|unreachable|ECONN|fetch|timeout/i.test(String(backendErr));
    const errMsg = isConnErr
      ? `无法弹出系统目录选择框：本地 Ddayup 后端（127.0.0.1:3000）未启动。请先启动后端，然后重试。`
      : `无法弹出系统目录选择框：${backendErr}（请确认本地服务 127.0.0.1:3000 已启动）`;
    if (sp) { sp.textContent = '⚠ 后端未启动：' + backendErr; if (sp.classList) { sp.classList.add('warn'); } }
    setStatus(errMsg, true);
  };
});

// 侧栏加载时恢复已保存目录
// ★2026-09-12：并行恢复「绝对路径通道」与「句柄通道」，两者互不阻塞（allSettled）；
//   完成后统一 refreshPathTexts，保证显示确定（绝对路径优先），避免任一恢复晚到互相覆盖。
const __dirRestorePromise = Promise.allSettled([restoreDirPaths(), restoreSavedHandles()])
  .then(() => { try { refreshPathTexts(); } catch (_) {} });

// ★P3 清除：删掉 绝对路径(chrome.storage.local) + IndexedDB 句柄 + 目录名 + 内存引用，UI 回到「默认路径」基线
document.querySelectorAll('.pathClear').forEach((btn) => {
  btn.onclick = async () => {
    const type = btn.dataset.type;
    try {
      await deleteDirPath(type);
      await deleteTypeDirHandle(type);
      if (window.saveHandles) window.saveHandles[type] = null;
      const sp = document.querySelector(`.pathText[data-type="${type}"]`);
      if (sp) {
        const sub = (typeof typeDirs !== 'undefined' && typeDirs[type]) || 'other';
        sp.textContent = `未设置 · 默认 Ddayup/${sub}/`;
        sp.classList.remove('ok', 'warn');
      }
      setStatus(`已清除「${typeLabel(type)}」目录设置`);
    } catch (e) {
      setStatus('清除失败：' + ((e && e.message) || e), true);
    }
  };
});

// ★P3 测试写入：优先用「绝对路径」调后端 probe-dir 验证；无绝对路径时再走句柄写测试文件（原逻辑）
document.querySelectorAll('.pathTest').forEach((btn) => {
  btn.onclick = async () => {
    const type = btn.dataset.type;
    const sp = document.querySelector(`.pathText[data-type="${type}"]`);
    const abs = dirPaths[type];
    if (abs) {
      setStatus(`正在验证目录可写：${abs} …`);
      try {
        const r = await fetch(ddBackendBase() + '/api/media/probe-dir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withDeviceAuthBody({ dir: abs }, await getExtDeviceAuth())),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d && d.ok) {
          if (sp) { sp.textContent = '✅ 已设置：' + abs; if (sp.classList) { sp.classList.add('ok'); sp.classList.remove('warn'); } }
          setStatus(`✅ 目录可写：「${typeLabel(type)}」→ ${abs}`);
        } else {
          if (sp) { sp.textContent = '⚠ 目录不可写：' + abs; if (sp.classList) sp.classList.add('warn'); }
          setStatus('目录验证失败：' + ((d && d.error) || ('HTTP ' + r.status)) + '（请确认本地服务已启动，且路径存在/有权限）', true);
        }
      } catch (e) {
        if (sp) { sp.textContent = '⚠ 无法连接本地服务'; if (sp.classList) sp.classList.add('warn'); }
        setStatus('目录验证失败：无法连接本地服务 127.0.0.1:3000 → ' + ((e && e.message) || e), true);
      }
      return;
    }
    const handle = (window.saveHandles || {})[type];
    if (!handle) {
      setStatus(`「${typeLabel(type)}」尚未设置目录，请点「选择目录」弹出系统目录选择框选定保存目录`, true); return;
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
      if (sp) sp.textContent = `✅ 已设置(句柄)：${handle.name}`;
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
