// progress.js —— 多任务下载进度管理（重构版，2026-08-11）
//
// 设计目标（对应需求）：
//  1) 实时进度百分比 / 进度条：每个任务独立卡片，rAF 节流渲染（≤10fps）
//  2) 失败即时标记 + 原因：interrupted 时映射 chrome DOWNLOAD_INTERRUPT_REASON 为中文文案
//  3) 完成即时标记 + 自动入库：complete 时回调 onComplete(dlId, asset)（由 sidepanel 注入）
//  4) 多任务并发状态隔离：__dlTasks 以 dlId 为键，互不覆盖；finishDownloadProgress 不再清空他人
//  5) 异常（断网 / 取消）：cancel(dlId) 调 chrome.downloads.cancel + 用户取消标记；interrupted 单独标记
//  6) 性能：transform: scaleX 替代 width（GPU 合成免重排）；仅更新变化属性；卡片 DOM 复用

(function () {
  // ── 任务状态机 ──
  // 'pending' | 'downloading' | 'completed' | 'failed' | 'cancelled'
  const STATE = {
    PENDING: 'pending',
    DOWNLOADING: 'downloading',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
  };

  // chrome DOWNLOAD_INTERRUPT_REASON → 中文可读文案
  const INTERRUPT_REASON_TEXT = {
    FILE_FAILED: '文件写入失败（磁盘权限/路径无效/文件名冲突，建议换保存目录或重试）',
    FILE_ACCESS_DENIED: '文件访问被拒绝（权限/占用）',
    FILE_NO_SPACE: '磁盘空间不足',
    FILE_NAME_TOO_LONG: '文件名过长',
    FILE_TOO_LARGE: '文件过大',
    FILE_VIRUS_INFECTED: '文件被安全软件拦截',
    FILE_TRANSIENT_ERROR: '临时文件错误，请重试',
    FILE_BLOCKED: '文件被浏览器策略阻止',
    FILE_SECURITY_CHECK_FAILED: '安全校验失败',
    FILE_TOO_SHORT: '文件下载不完整',
    NETWORK_FAILED: '网络错误',
    NETWORK_TIMEOUT: '网络超时（断网/服务器无响应）',
    NETWORK_DISCONNECTED: '网络已断开',
    NETWORK_SERVER_DOWN: '服务器不可用',
    NETWORK_INVALID_REQUEST: '请求无效（链接过期/防盗链）',
    SERVER_FAILED: '服务器内部错误',
    SERVER_NO_RANGE: '服务器不支持断点续传',
    SERVER_BAD_CONTENT: '服务器返回内容异常',
    SERVER_UNAUTHORIZED: '服务器未授权（需登录/Cookie 失效）',
    SERVER_CERT_PROBLEM: 'SSL 证书问题',
    SERVER_FORBIDDEN: '服务器拒绝访问（403 防盗链）',
    USER_CANCELED: '已取消',
    USER_SHUTDOWN: '浏览器关闭导致中断',
    CRASH: '浏览器崩溃导致中断',
  };

  function reasonText(r) {
    if (!r) return '未知错误';
    const known = INTERRUPT_REASON_TEXT[r];
    // ★2026-08-30：所有中断原因都带原始 reason 码，便于用户/排障确认真实中断类型
    //   （例如 FILE_FAILED 实为「CDN 拒绝/防盗链」而非真的磁盘权限问题）。
    if (known) return known + ' [' + r + ']';
    return '下载失败：' + r;
  }

  // ── 运行时状态 ──
  const tasks = new Map(); // dlId -> task record
  const knownDownloadIds = new Set(); // 本扩展创建的 chrome.downloads id
  let container = null;     // #dlProgressContainer
  let root = null;          // #dlProgress
  let onCompleteCb = null;  // (dlId, record) => void  自动入库回调
  let rafScheduled = false;
  let dirtyKeys = new Set();
  let collapsed = false;

  let seq = 0;
  function nextDlId() { return 'dl_' + (++seq); }

  function ensureDom() {
    if (root) return;
    root = document.getElementById('dlProgress');
    if (!root) return;
    root.style.display = 'none';
    root.innerHTML = '';
    // 标题 + 任务容器
    const header = document.createElement('div');
    header.className = 'dlProgressHeader';
    header.innerHTML = '<span class="dlProgressTitle">⬇ 下载任务</span><span class="dlProgressCount" id="dlProgressCount"></span>';
    // 折叠 / 清除按钮
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'dlProgressToggle';
    toggleBtn.title = '折叠/展开';
    toggleBtn.textContent = '▲';
    toggleBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      if (container) container.classList.toggle('collapsed', collapsed);
      toggleBtn.textContent = collapsed ? '▼' : '▲';
    });
    header.appendChild(toggleBtn);
    const clearBtn = document.createElement('button');
    clearBtn.className = 'dlProgressClear';
    clearBtn.title = '清除已完成';
    clearBtn.textContent = '清除';
    clearBtn.addEventListener('click', clearFinished);
    header.appendChild(clearBtn);
    root.appendChild(header);
    container = document.createElement('div');
    container.className = 'dlProgressContainer';
    container.id = 'dlProgressContainer';
    root.appendChild(container);
  }

  // ── 渲染调度（rAF 节流，避免每帧重排）──
  function scheduleRender() {
    if (rafScheduled) return;
    rafScheduled = true;
    const run = () => {
      rafScheduled = false;
      renderDirty();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function renderDirty() {
    if (!container) ensureDom();
    if (!container) return;
    let active = 0;
    for (const key of tasks.keys()) {
      if (!dirtyKeys.has(key)) continue;
      dirtyKeys.delete(key);
      const t = tasks.get(key);
      renderTask(t);
      if (t.state === STATE.PENDING || t.state === STATE.DOWNLOADING) active++;
    }
    // 更新计数 + 整体可见性
    const countEl = document.getElementById('dlProgressCount');
    if (countEl) {
      const total = tasks.size;
      const done = [...tasks.values()].filter((t) => t.state === STATE.COMPLETED || t.state === STATE.FAILED || t.state === STATE.CANCELLED).length;
      countEl.textContent = total ? `${done}/${total}` : '';
    }
    // 全部终态且该任务卡超过 1 条时仍保留（用户可查看失败原因）；仅当无任何任务才隐藏容器
    if (tasks.size === 0) {
      root.style.display = 'none';
    } else {
      root.style.display = 'block';
    }
  }

  function fmtPct(t) {
    if (t.totalBytes && t.totalBytes > 0) {
      const p = Math.min(100, Math.round((t.receivedBytes / t.totalBytes) * 100));
      return p + '%';
    }
    return '';
  }

  function fmtSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }

  function renderTask(t) {
    let el = document.getElementById('dltask_' + t.dlId);
    if (!el) {
      el = document.createElement('div');
      el.className = 'dlTask';
      el.id = 'dltask_' + t.dlId;
      container.appendChild(el);
    }
    // 图标 / 状态着色
    let icon = '⬇';
    let iconCls = '';
    if (t.state === STATE.COMPLETED) { icon = '✅'; iconCls = 'done'; }
    else if (t.state === STATE.FAILED) { icon = '⚠'; iconCls = 'fail'; }
    else if (t.state === STATE.CANCELLED) { icon = '⊘'; iconCls = 'cancel'; }

    const indeterminate = t.state === STATE.DOWNLOADING && (!t.totalBytes || t.totalBytes <= 0);
    const pct = fmtPct(t);
    const sizeText = (t.totalBytes > 0) ? `${fmtSize(t.receivedBytes)} / ${fmtSize(t.totalBytes)}` : (t.receivedBytes > 0 ? fmtSize(t.receivedBytes) : '');

    // 仅在终态展示状态文案行（失败原因 / 完成提示）
    let statusLine = '';
    if (t.state === STATE.FAILED) statusLine = `<div class="dlTaskReason">${escapeHtml(t.reason || '下载失败')}</div>`;
    else if (t.state === STATE.CANCELLED) statusLine = `<div class="dlTaskReason">已取消</div>`;
    else if (t.state === STATE.COMPLETED) statusLine = `<div class="dlTaskReason done">${escapeHtml(t.doneText || '已保存')}</div>`;

    // 取消按钮（仅进行中可点）
    const cancelBtn = (t.state === STATE.PENDING || t.state === STATE.DOWNLOADING)
      ? `<button class="dlTaskCancel" data-dlid="${t.dlId}" title="取消下载">✕</button>`
      : '';

    el.className = 'dlTask state-' + t.state + (iconCls ? ' ' + iconCls : '');
    el.innerHTML =
      `<div class="dlTaskRow">
         <span class="dlTaskIcon">${icon}</span>
         <span class="dlTaskName" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
         <span class="dlTaskPct">${pct}</span>
         ${cancelBtn}
       </div>
       <div class="dlTaskBarWrap">
         <div class="dlTaskBar${indeterminate ? ' indeterminate' : ''}" style="${indeterminate ? '' : `transform: scaleX(${t.totalBytes > 0 ? Math.min(1, t.receivedBytes / t.totalBytes) : 0})`}"></div>
       </div>
       ${sizeText ? `<div class="dlTaskSize">${sizeText}</div>` : ''}
       ${statusLine}`;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function markDirty(dlId) { dirtyKeys.add(dlId); scheduleRender(); }

  // ── 对外 API ──
  function registerTask(opts) {
    ensureDom();
    const dlId = opts.dlId || nextDlId();
    const t = {
      dlId,
      name: opts.name || '下载中…',
      state: STATE.PENDING,
      receivedBytes: 0,
      totalBytes: 0,
      reason: '',
      doneText: '',
      downloadId: opts.downloadId || null, // chrome.downloads 真实 id（用于取消）
      asset: opts.asset || null, // 关联的素材对象（完成时自动入库用）
    };
    tasks.set(dlId, t);
    markDirty(dlId);
    return dlId;
  }

  function updateTask(dlId, patch) {
    const t = tasks.get(dlId);
    if (!t) return;
    Object.assign(t, patch);
    if (patch.state === STATE.DOWNLOADING && t.state !== STATE.DOWNLOADING) {
      // 首次进入 downloading：保持 pending→downloading 过渡
    }
    markDirty(dlId);
  }

  // 绑定 chrome 下载 id（onCreated 后回填，使 cancel 可用）
  function bindDownloadId(dlId, downloadId) {
    const t = tasks.get(dlId);
    if (t) { t.downloadId = downloadId; tasks.set(dlId, t); }
    if (downloadId != null) knownDownloadIds.add(downloadId);
  }

  // 绑定 chrome 下载 id 到「最近一个尚未关联 downloadId 的进行中任务卡」
  // （供 background onCreated 在 downloadId 可知的第一时间回填，消除 dlViaChrome 的竞争条件：
  //   download() 的 .then 回填晚于 onChanged/onCreated 触发，否则会创建重复哑卡）。
  function bindLatestPending(downloadId) {
    if (downloadId == null) return false;
    let target = null;
    for (const t of tasks.values()) {
      if (t.downloadId == null && (t.state === STATE.PENDING || t.state === STATE.DOWNLOADING)) {
        target = t; break;
      }
    }
    if (target) {
      target.downloadId = downloadId;
      tasks.set(target.dlId, target);
      knownDownloadIds.add(downloadId);
      return true;
    }
    return false;
  }

  function progress(dlId, received, total) {
    const t = tasks.get(dlId);
    if (!t) return;
    t.receivedBytes = received || 0;
    t.totalBytes = total || 0;
    if (t.state === STATE.PENDING) t.state = STATE.DOWNLOADING;
    markDirty(dlId);
  }

  // 真实进度回流（来自 background 转发 onChanged，比侧栏自监听更可靠）
  function progressByDownloadId(downloadId, received, total) {
    if (!knownDownloadIds.has(downloadId)) return false;
    for (const t of tasks.values()) {
      if (t.downloadId === downloadId) { progress(t.dlId, received, total); return true; }
    }
    return false;
  }

  // 按 chrome downloadId 完成/失败（供 sidepanel onChanged 精确命中）
  function completeByDownloadId(downloadId, doneText) {
    if (!knownDownloadIds.has(downloadId)) return false;
    for (const t of tasks.values()) {
      if (t.downloadId === downloadId) { complete(t.dlId, doneText); return true; }
    }
    return false;
  }
  function failByDownloadId(downloadId, reason) {
    if (!knownDownloadIds.has(downloadId)) return false;
    for (const t of tasks.values()) {
      if (t.downloadId === downloadId) { fail(t.dlId, reason); return true; }
    }
    return false;
  }

  function complete(dlId, doneText) {
    const t = tasks.get(dlId);
    if (!t || t.state === STATE.COMPLETED) return;
    t.state = STATE.COMPLETED;
    t.doneText = doneText || '已保存（浏览器下载文件夹）';
    markDirty(dlId);
    // 自动入库回调（sidepanel 注入，把素材加入资源库）
    if (onCompleteCb) {
      try { onCompleteCb(dlId, t); } catch (_) {}
    }
  }

  function fail(dlId, reason) {
    const t = tasks.get(dlId);
    if (!t || t.state === STATE.COMPLETED || t.state === STATE.CANCELLED) return;
    t.state = STATE.FAILED;
    t.reason = reasonText(reason);
    markDirty(dlId);
  }

  function cancel(dlId) {
    const t = tasks.get(dlId);
    if (!t) return;
    if (t.state === STATE.COMPLETED) return;
    // 调用 chrome.downloads.cancel（若已绑定真实 id）
    if (t.downloadId != null && chrome.downloads && chrome.downloads.cancel) {
      try { chrome.downloads.cancel(t.downloadId); } catch (_) {}
    }
    t.state = STATE.CANCELLED;
    markDirty(dlId);
  }

  // 兼容旧调用名（保持现有 download.js 不动）：旧函数名语义调整为「完成某下载」
  function finishDownloadProgress(text, ok, dlId) {
    if (dlId && tasks.has(dlId)) {
      if (ok) complete(dlId, (text || '').replace(/^✅\s*/, ''));
      else fail(dlId, typeof text === 'string' ? text : '');
      return;
    }
    // 无 dlId：作用于最近一个进行中任务（兼容批量场景兜底）
    let target = null;
    for (const t of tasks.values()) {
      if (t.state === STATE.PENDING || t.state === STATE.DOWNLOADING) { target = t; break; }
    }
    if (target) {
      if (ok) complete(target.dlId, (text || '').replace(/^✅\s*/, ''));
      else fail(target.dlId, typeof text === 'string' ? text : '');
    }
  }

  function setOnComplete(cb) { onCompleteCb = cb; }

  // 清理已完成（保留失败的，方便排查）；用户点击「清除」时调用
  function clearFinished() {
    for (const [k, t] of tasks) {
      if (t.state === STATE.COMPLETED || t.state === STATE.CANCELLED) {
        const el = document.getElementById('dltask_' + k);
        if (el) el.remove();
        if (t.downloadId != null) knownDownloadIds.delete(t.downloadId);
        tasks.delete(k);
      }
    }
    if (tasks.size === 0 && root) root.style.display = 'none';
  }

  // 暴露到全局
  window.HmdaoProgress = {
    STATE,
    registerTask,
    updateTask,
    bindDownloadId,
    bindLatestPending,
    progress,
    progressByDownloadId,
    completeByDownloadId,
    failByDownloadId,
    complete,
    fail,
    cancel,
    finishDownloadProgress,
    setOnComplete,
    clearFinished,
    hasTask: (dlId) => tasks.has(dlId),
    getTask: (dlId) => tasks.get(dlId),
    hasDownloadId: (downloadId) => knownDownloadIds.has(downloadId),
    // ★2026-08-23 P0：返回「正在进行中（未结束）」的任务所关联素材的 url 集合，
    //   供 doRescan 在清空旧素材时跳过这些（用户要求：正在下载的内容不清理）。
    getDownloadingAssetUrls: () => {
      const urls = new Set();
      tasks.forEach((t) => {
        if (t && t.asset && t.asset.url && t.state !== STATE.COMPLETED && t.state !== STATE.FAILED && t.state !== STATE.CANCELLED) {
          urls.add(t.asset.url);
        }
      });
      return Array.from(urls);
    },
  };

  // ── 旧 API 兼容别名（audio-playback.js / download.js 等仍在调用）──
  // 这些旧函数共享单全局「当前任务」语义，在多任务下退化为「作用于最近一个进行中任务」，
  // 或不登记独立卡片——统一桥接到新 API，避免改动散落各处的调用点。
  let _legacyDlId = null;
  window.showDownloadProgress = function (name) {
    _legacyDlId = registerTask({ name: name || '下载中…' });
    return _legacyDlId;
  };
  window.pulseDownloadProgress = function (name) {
    const id = registerTask({ name: name || '处理中…' });
    updateTask(id, { state: STATE.DOWNLOADING, totalBytes: 0, receivedBytes: 0 });
    return id;
  };
  window.updateDownloadProgress = function (downloadId, received, total) {
    // 旧调用传的是 chrome downloadId：优先按 downloadId 命中精确任务卡
    if (progressByDownloadId(downloadId, received, total)) return;
    // 否则作用于最近一个进行中任务
    if (_legacyDlId && tasks.has(_legacyDlId)) progress(_legacyDlId, received, total);
  };
  // 旧 finishDownloadProgress(text, ok)：无 dlId 时作用于最近进行中任务（内部已处理）
  window.finishDownloadProgress = finishDownloadProgress;
})();
