const BROKEN_DCC_TEXT_RE = /\uFFFD|\u951f|\?{2,}|ï¿½|[闂闁婵濠缂鐘鍙]/;
const BROKEN_DCC_TEXT_HINTS = new Set(['闂', '闁', '婵', '濠', '缂']);

export function isBrokenDccText(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (BROKEN_DCC_TEXT_RE.test(raw)) return true;
  const suspiciousCount = [...raw].reduce((count, char) => count + (BROKEN_DCC_TEXT_HINTS.has(char) ? 1 : 0), 0);
  const replacementCount = (raw.match(/\?/g) || []).length;
  return suspiciousCount >= 2 || (raw.length <= 120 ? replacementCount >= 3 : replacementCount >= 5);
}

export function sanitizeDccText(value, fallback = '') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return isBrokenDccText(raw) ? fallback : raw;
}

function buildRuntimeState(stage, state, label, message, reason) {
  return {
    stage,
    state,
    label,
    message,
    reason,
    dedupeKey: `${stage}:${state}:${reason}`,
  };
}

function inferActivityState(message, level = 'info') {
  const raw = String(message || '').toLowerCase();
  if (level === 'error') return 'error';
  if (/failed|error|unreachable|offline|not running|not ready|missing|duplicate|stale/.test(raw)) return 'error';
  if (/ready|online|completed|connected|started|launched|passed/.test(raw)) return 'ready';
  return 'waiting';
}

export function classifyDccActivity(engine, message, { level = 'info', action = '' } = {}) {
  const safeMessage = sanitizeDccText(message, engine === 'unreal' ? '等待 Unreal 状态更新。' : '等待 Blender 状态更新。');
  const haystack = `${action} ${safeMessage}`.toLowerCase();
  const state = inferActivityState(safeMessage, level);

  if (/frame|preview|camera|viewport|record/.test(haystack)) {
    return buildRuntimeState('frame', state, state === 'ready' ? '首帧已到达' : state === 'error' ? '预览/录制异常' : '等待首帧预览', safeMessage, 'frame-activity');
  }
  if (/bridge|connect|service|8766|8792|socket|failed to fetch|service unavailable/.test(haystack)) {
    return buildRuntimeState('bridge', state, state === 'ready' ? '桥接已上线' : state === 'error' ? '桥接不可用' : '等待桥接上线', safeMessage, 'bridge-activity');
  }
  if (/plugin|install|reinstall|rebuild|enable|add-on|startupmodule|mount/.test(haystack)) {
    return buildRuntimeState('plugin', state, state === 'ready' ? '插件已就绪' : state === 'error' ? '插件阶段异常' : '等待插件就绪', safeMessage, 'plugin-activity');
  }
  return buildRuntimeState('host', state, state === 'ready' ? '宿主已就绪' : state === 'error' ? '宿主未就绪' : '等待宿主启动', safeMessage, 'host-activity');
}

export function deriveDccRuntimeState(engine, status) {
  const fallback = buildRuntimeState(
    'host',
    'waiting',
    engine === 'unreal' ? '等待 Unreal 启动' : '等待 Blender 启动',
    engine === 'unreal' ? '请先正常打开 Unreal 主窗口，再点击 Connect。' : '请先正常打开 Blender 窗口，再点击 Connect。',
    'host-not-running',
  );
  if (!status || typeof status !== 'object') return fallback;

  if (engine === 'unreal') {
    const plugin = status.plugin || {};
    const host = status.host || {};
    const duplicateInstall = Boolean(plugin.duplicateInstall);
    const shadowCopies = Number(plugin.engineShadowCopies || 0);
    const staleReceipts = Array.isArray(plugin.staleTargetReceiptFiles) ? plugin.staleTargetReceiptFiles.length : 0;
    const hostProcessRunning = Boolean(host.hostProcessRunning);
    const targetProjectRunning = Boolean(host.targetProjectRunning);
    const installed = Boolean(plugin.installed);
    const enabledInProject = Boolean(plugin.enabledInProject);
    const buildArtifactsPresent = Boolean(plugin.buildArtifactsPresent);
    const bridgeOnline = Boolean(plugin.directBridgeOnline);
    const bridgeReady = Boolean(plugin.directBridgeReadyForTargetProject);
    const cameraCount = Math.max(0, Number(plugin.cameraCount || 0));

    if (!hostProcessRunning) return buildRuntimeState('host', 'waiting', '等待 Unreal 主窗口', '先正常打开 Unreal，再回到节点点击 Connect。', 'host-not-running');
    if (!targetProjectRunning) return buildRuntimeState('host', 'waiting', '等待目标工程就绪', 'Unreal 已启动，但目标工程还没进入可连接状态。', 'project-not-ready');
    if (duplicateInstall) return buildRuntimeState('plugin', 'error', '插件安装冲突', '检测到 Unreal 插件重复安装，只保留一个安装位置后再连接。', 'duplicate-install');
    if (shadowCopies > 0) return buildRuntimeState('plugin', 'error', '插件残留待清理', `检测到 ${shadowCopies} 份 Unreal 插件残留副本，请先 Cleanup。`, 'shadow-copies');
    if (staleReceipts > 0) return buildRuntimeState('plugin', 'error', '旧构建回执待清理', `检测到 ${staleReceipts} 份 Unreal 旧回执，请先 Cleanup。`, 'stale-receipts');
    if (!installed) return buildRuntimeState('plugin', 'error', '插件未安装', 'HMDao Unreal Capture 还未安装到当前工程或引擎。', 'plugin-missing');
    if (!enabledInProject) return buildRuntimeState('plugin', 'waiting', '等待插件在工程内启用', '插件文件已在位，但还没在当前 Unreal 工程里启用。', 'plugin-disabled');
    if (!buildArtifactsPresent) return buildRuntimeState('plugin', 'waiting', '等待插件构建完成', '插件已启用，但构建产物还没完全就绪。', 'plugin-build-pending');
    if (!bridgeOnline) return buildRuntimeState('bridge', 'waiting', '等待桥接上线', '宿主和插件已就绪，正在等待 HMDao 直连桥上线。', 'bridge-offline');
    if (!bridgeReady) return buildRuntimeState('bridge', 'waiting', '等待当前工程挂桥', 'HMDao 直连桥已在线，但当前工程会话还没完成握手。', 'bridge-not-ready');
    if (cameraCount <= 0) return buildRuntimeState('frame', 'waiting', '等待首个视口/相机', '桥接已就绪，但 Unreal 还没上报可预览的相机或视口。', 'camera-missing');
    return buildRuntimeState('frame', 'ready', '首帧预览已就绪', '宿主、插件、桥接和首帧预览都已就绪。', 'frame-ready');
  }

  const plugin = status.plugin || {};
  const host = status.host || {};
  const visibleRunningHosts = Array.isArray(host.runningHosts) ? host.runningHosts.length : 0;
  const headlessRunningHosts = Array.isArray(host.headlessRunningHosts) ? host.headlessRunningHosts.length : 0;
  const installed = Array.isArray(plugin.installedVersions) && plugin.installedVersions.length > 0;
  const addonEnabledInRunningHost = Boolean(plugin.addonEnabledInRunningHost);
  const serviceReachable = Boolean(plugin.serviceReachable);
  const readyForLiveCapture = Boolean(plugin.readyForLiveCapture);

  if (visibleRunningHosts <= 0 && headlessRunningHosts > 0) {
    return buildRuntimeState('host', 'waiting', '等待 Blender 可见窗口', '当前只有后台 helper 在线，请先让 Blender 主窗口完全打开。', 'visible-host-missing');
  }
  if (visibleRunningHosts <= 0) return buildRuntimeState('host', 'waiting', '等待 Blender 窗口', '请先正常打开 Blender 主窗口，再点击 Connect。', 'host-not-running');
  if (!installed) return buildRuntimeState('plugin', 'error', '插件未安装', 'HMDao Blender Capture 还没有安装到当前 Blender 配置。', 'plugin-missing');
  if (!addonEnabledInRunningHost) return buildRuntimeState('plugin', 'waiting', '等待插件在 Blender 内启用', 'Blender 已打开，但当前可见会话还没加载 HMDao Blender Capture。', 'addon-disabled');
  if (!serviceReachable) return buildRuntimeState('bridge', 'waiting', '等待 8766 捕获服务', '插件已加载，正在等待 8766 捕获服务上线。', 'service-offline');
  if (!readyForLiveCapture) return buildRuntimeState('frame', 'waiting', '等待首帧预览', '捕获服务已在线，但实时预览还没进入可用状态。', 'frame-pending');
  return buildRuntimeState('frame', 'ready', '首帧预览已就绪', 'Blender 宿主、插件、8766 服务和首帧预览都已就绪。', 'frame-ready');
}
