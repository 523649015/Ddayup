// Ddayup 浏览器扩展桥接（Web App 侧）
// 与 MV3 扩展通过 externally_connectable + window.postMessage 双向通信。
//
// 扩展采用 MV3（Ddayup网页素材采集扩展），Chrome / Edge (Chromium) 通用。
// 无需填扩展 ID：「检测」靠 content script 握手；「打开采集」手动点扩展图标即可
// （background.js 已设 openPanelOnActionClick，点击图标自动开侧栏并扫描当前页）。
// HMDAO_EXTENSION_ID 仅作为可选项：填了可让 Web 端主动弹侧栏；不填也能用。

import type { AssetItem, AIDeepAnalysis } from '@/types/assets';
import { useAuthStore } from '@/store/useAuthStore';

export const HMDAO_EXTENSION_ID = ''; // 可选：加载解压版后的扩展 ID（留空则靠手动点图标触发）

const PING = 'HMDAO_EXT_PING';
const PONG = 'HMDAO_EXT_PONG';

export interface ExtensionAssetRef {
  url: string;
  type: 'image' | 'video' | 'audio' | 'model';
  source?: string;
  pageUrl?: string;
  name?: string;
}

// 各组件 build 标记（由 background.js 统一汇总）。
// 用于在网页端「检测是否已安装」处一眼分辨扩展各组件是旧版还是新版。
export interface HmdaoBuilds {
  background: string | null;
  sidepanel: string | null;
  detect: string | null;
  injectMain: string | null;
}

let _hmdaoExtBuild: string | null = null;

/** 读取最近一次检测到的扩展 build 号（detect 组件）；null 表示扩展未安装或运行的是旧版 */
export function getHmdaoExtBuild(): string | null {
  return _hmdaoExtBuild;
}

let _hmdaoExtBuilds: HmdaoBuilds | null = null;

/** 读取最近一次检测到的全部组件 build；null 表示未查询到/旧版 */
export function getHmdaoExtBuilds(): HmdaoBuilds | null {
  return _hmdaoExtBuilds;
}

/**
 * 统一入口：一次拿到扩展全部组件的 build 标记（经 background.js 汇总，再由 detect.js 转发）。
 * Web App 发 HMDAO_GET_BUILDS（window postMessage）→ detect.js 转发 background →
 * background 返回 HMDAO_BUILDS → detect.js 回传 HMDAO_BUILDS → 本函数 resolve。
 * 超时（扩展未安装/没加载 detect.js）返回 null。
 */
export function fetchHmdaoExtBuilds(timeoutMs = 400): Promise<HmdaoBuilds | null> {
  return new Promise((resolve) => {
    let done = false;
    const onResp = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.type !== 'HMDAO_BUILDS') return;
      done = true;
      window.removeEventListener('message', onResp);
      clearTimeout(timer);
      _hmdaoExtBuilds = (d.builds as HmdaoBuilds) || null;
      resolve(_hmdaoExtBuilds);
    };
    const timer = setTimeout(() => {
      if (done) return;
      window.removeEventListener('message', onResp);
      resolve(null);
    }, timeoutMs);
    window.addEventListener('message', onResp);
    window.postMessage({ type: 'HMDAO_GET_BUILDS' }, '*');
  });
}

let _extInstalled = false;
let _extVersion: string | null = null;
let _extDetectedAt = 0;

/** 检测扩展是否安装：content script 在 127.0.0.1:3000 注入并响应握手 */
export function detectHmdaoExtension(timeoutMs = 600): Promise<boolean> {
  if (_extInstalled) return Promise.resolve(true);
  return new Promise((resolve) => {
    const w = window as any;
    // 扩展的桥接脚本运行在 ISOLATED 世界，直接挂 window 的属性页面读不到，
    // 因此存在标记同时打在 <html> 的 data 属性上（DOM 在两个世界间共享）。
    const el = document.documentElement;
    const domFlag = el && el.getAttribute('data-hmdao-ext') === '1';
    if (w.__hmdaoExtInstalled || domFlag) {
      _extInstalled = true;
      _hmdaoExtBuild = w.__hmdaoExtBuild || (el && el.getAttribute('data-hmdao-ext-build')) || null;
      return resolve(true);
    }
    const cleanup = () => {
      window.removeEventListener('message', onPong);
      clearTimeout(timer);
    };
    const onPong = (e: MessageEvent) => {
      const d = e.data;
      if (d && d.type === PONG) {
        _hmdaoExtBuild = d.build || null;
        cleanup();
        resolve(true);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    window.addEventListener('message', onPong);
    window.postMessage({ type: PING }, '*');
  });
}

let _presenceWatched = false;

/** 页面加载即启动扩展存在性监听（content script 注入后会回 PONG），结果缓存供按钮直读 */
export function startExtensionPresenceWatch(): void {
  if (_presenceWatched || typeof window === 'undefined') return;
  _presenceWatched = true;
  const onPong = (e: MessageEvent) => {
    const d = e.data;
    if (!d || d.type !== PONG) return;
    _extInstalled = true;
    _extVersion = d.version || null;
    _hmdaoExtBuild = d.build || null;
    _extDetectedAt = Date.now();
  };
  window.addEventListener('message', onPong);
  // content script 在 document_idle 注入，延迟两轮探测兜底
  window.setTimeout(() => window.postMessage({ type: PING }, '*'), 600);
  window.setTimeout(() => window.postMessage({ type: PING }, '*'), 2000);
}

/** 用户在弹窗点「我已安装，重新检测」时调用 */
export function recheckExtensionPresence(): Promise<boolean> {
  return new Promise((resolve) => {
    const onPong = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.type !== PONG) return;
      _extInstalled = true;
      _extVersion = d.version || null;
      _hmdaoExtBuild = d.build || null;
      window.removeEventListener('message', onPong);
      resolve(true);
    };
    window.addEventListener('message', onPong);
    window.setTimeout(() => {
      window.removeEventListener('message', onPong);
      resolve(_extInstalled);
    }, 800);
    window.postMessage({ type: PING }, '*');
  });
}

export function isExtensionDetected(): boolean {
  return _extInstalled;
}

/** 诊断信息：暴露「为什么没检测到」，帮用户自查（地址不匹配 / 扩展被禁用等） */
export function getExtensionDetectionDiagnostics() {
  return {
    installed: _extInstalled,
    origin: typeof window !== 'undefined' ? window.location.origin : '',
    version: _extVersion,
    build: _hmdaoExtBuild,
    detectedAt: _extDetectedAt,
    manifestMatches: ['http://127.0.0.1:3000/*', 'http://localhost:3000/*'],
  };
}

/**
 * 通知扩展打开采集侧栏并扫描当前页。
 * - 若已配置 HMDAO_EXTENSION_ID：主动发外部消息弹侧栏（最优体验）。
 * - 若未配置或发送失败：返回 false，由调用方提示用户「点击扩展图标」手动打开
 *   （background.js 已设 openPanelOnActionClick，点击图标即开侧栏并扫描）。
 * 返回 true 表示已自动打开；false 表示需用户手动点图标。
 */
export async function openExtensionScan(): Promise<boolean> {
  const w = window as any;
  const chromeRt = w.chrome && w.chrome.runtime;
  if (!chromeRt || !HMDAO_EXTENSION_ID) return false;
  try {
    await chromeRt.sendMessage(HMDAO_EXTENSION_ID, { type: 'HMDAO_OPEN_SCAN' });
    return true;
  } catch (_) {
    return false;
  }
}

/** 监听扩展发来的「找相似」事件 */
export interface FindSimilarRef { url: string; name: string; type: string; }

export function onExtensionFindSimilar(cb: (ref: FindSimilarRef) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail && detail.url) cb({ url: detail.url, name: detail.name || '', type: detail.type || 'image' });
  };
  window.addEventListener('hmdao:find-similar', handler);
  return () => window.removeEventListener('hmdao:find-similar', handler);
}

/** 监听扩展发来的「网页资源导入」事件，回调中调用 store.collectFromUrl 入库 */
export function onExtensionWebAssetsImported(cb: (assets: ExtensionAssetRef[]) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail && Array.isArray(detail.assets)) cb(detail.assets as ExtensionAssetRef[]);
  };
  window.addEventListener('hmdao:import-web-assets', handler);
  return () => window.removeEventListener('hmdao:import-web-assets', handler);
}

/** 扩展机器人上传的素材 → 触发画布 SmartAgent 媒体工作流的回调载荷 */
export interface AgentWorkflowRef {
  asset?: { id?: string; url?: string; name?: string; type?: string };
  userText?: string;
  /** 扩展机器人上传时若置 true，画布侧改用「深度 VLM 分析」喂给工作流，效果等同 AIDeepAnalysisPanel → 机器人联动 */
  deepAnalyze?: boolean;
}

/**
 * 监听扩展发来的「运行智能体工作流」事件（扩展机器人助手上传图片/视频时触发）。
 * 回调中由 SmartAgent 复用 buildMediaAwarePlan + createWorkflowFromPlan 建节点。
 */
export function onRunAgentWorkflow(cb: (ref: AgentWorkflowRef) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail || {};
    const asset = detail.asset;
    if (asset && (asset.url || asset.id)) {
      cb({
        asset: { id: asset.id, url: asset.url, name: asset.name, type: asset.type },
        userText: detail.userText,
        deepAnalyze: !!detail.deepAnalyze,
      });
    }
  };
  window.addEventListener('hmdao:run-agent-workflow', handler as EventListener);
  return () => window.removeEventListener('hmdao:run-agent-workflow', handler as EventListener);
}

/** AIDeepAnalysisPanel → 机器人面板：把已算好的深度分析结果直接交给 SmartAgent 生成工作流 */
export interface DeepAnalysisToAgentRef {
  item?: AssetItem | null;
  analysis?: AIDeepAnalysis | null;
  userText?: string;
}
export function onDeepAnalysisToAgent(cb: (ref: DeepAnalysisToAgentRef) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail || {};
    if (detail && detail.analysis && detail.item) {
      cb({ item: detail.item, analysis: detail.analysis, userText: detail.userText });
    }
  };
  window.addEventListener('hmdao:deep-analysis-to-agent', handler as EventListener);
  return () => window.removeEventListener('hmdao:deep-analysis-to-agent', handler as EventListener);
}

// ===== 扩展 AI 助手后端桥接（与 Web App 智能机器人共用 LLM 通道，密钥留在服务端） =====
// 链路：detect.js 派发 window 'hmdao:ai-chat' {text, mode} -> 本处理器 -> POST /api/extension-ai -> 回传 postMessage 'hmdao:ai-chat-reply'
let aiBridgeStarted = false;

export function initExtensionAiBridge(): void {
  if (aiBridgeStarted) return;
  aiBridgeStarted = true;

  const handler = async (e: Event) => {
    const detail = (e as CustomEvent).detail || {};
    const text = typeof detail.text === 'string' ? detail.text : '';
    const mode = typeof detail.mode === 'string' ? detail.mode : 'chat';
    if (!text) {
      window.postMessage({ type: 'hmdao:ai-chat-reply', ok: false, error: '缺少文案内容' }, '*');
      return;
    }
    try {
      const resp = await fetch('/api/extension-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, mode }),
      });
      const data = await resp.json().catch(() => ({} as any));
      if (data && data.ok) {
        window.postMessage({ type: 'hmdao:ai-chat-reply', ok: true, text: data.text }, '*');
      } else {
        const errMsg = (data && (data.error || data.message)) || `HTTP ${resp.status}`;
        window.postMessage({ type: 'hmdao:ai-chat-reply', ok: false, error: errMsg }, '*');
      }
    } catch (err: any) {
      window.postMessage({ type: 'hmdao:ai-chat-reply', ok: false, error: err?.message || '请求失败' }, '*');
    }
  };

  window.addEventListener('hmdao:ai-chat', handler as EventListener);
}

// ===== 官网登录态 → 扩展 同步（2026-09-14）=====
// 官网与扩展原本是两套独立令牌（session vs extToken），用户官网登录后扩展仍提示未登录。
// 这里用「一次性绑定码」打通：官网凭 session 换 6 位短码 → 投递给扩展 → 扩展用短码 + deviceId 换令牌。
// 长令牌绝不经网页传递，短码 5 分钟有效、单次消费，泄露窗口极小。
export interface SyncLoginResult {
  success: boolean;
  error?: string | null;
  email?: string | null;
}

export function syncLoginToExtension(timeoutMs = 8000): Promise<SyncLoginResult> {
  return new Promise((resolve) => {
    let settled = false;
    // ★timer 必须先声明为可变变量：done() 可能在 const timer 赋值前被同步调用
    //   （如「官网未登录」分支），否则会命中 TDZ 抛错、Promise 永不 resolve（调用方挂起）。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (v: SyncLoginResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onRes);
      if (timer) clearTimeout(timer);
      resolve(v);
    };

    const onRes = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.type !== 'HMDAO_WEB_BIND_RESULT') return;
      done({ success: !!d.success, error: d.error || null, email: d.email || null });
    };

    (async () => {
      try {
        const token = useAuthStore.getState().session?.accessToken;
        if (!token) { done({ success: false, error: '请先在官网登录' }); return; }

        const resp = await fetch('/api/extension/account/bind-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({}),
        });
        const data = await resp.json().catch(() => ({} as any));
        if (!resp.ok || !data?.success) {
          done({ success: false, error: (data?.error?.message) || `获取绑定码失败（HTTP ${resp.status}）` });
          return;
        }
        const code = String(data.code || '');
        if (!code) { done({ success: false, error: '绑定码为空' }); return; }

        window.addEventListener('message', onRes);
        // 通道 1（可选）：已知扩展 ID 时直接 sendMessage（商店版/固定 ID 场景）
        const w = window as any;
        if (w.chrome?.runtime && HMDAO_EXTENSION_ID) {
          try { await w.chrome.runtime.sendMessage(HMDAO_EXTENSION_ID, { type: 'HMDAO_BIND_FROM_WEB', code }); } catch { /* 忽略，走兜底 */ }
        }
        // 通道 2（兜底，无需扩展 ID）：postMessage 由注入本站的 site-auth-bridge.js 接收
        window.postMessage({ type: 'HMDAO_WEB_BIND', code }, '*');
      } catch (err: any) {
        done({ success: false, error: err?.message || '同步失败' });
      }
    })();

    timer = setTimeout(() => {
      done({ success: false, error: '扩展未响应，请确认已安装并启用「Ddayup 网页素材采集扩展」后重试' });
    }, timeoutMs);
  });
}

// ===== 扩展登录态 → 官网 反向自动登录（2026-09-14）=====
// 官网页面处于 MAIN 世界、拿不到 chrome.runtime，必须经注入本站的 site-auth-bridge.js（ISOLATED）中转。
// 凭据只在「扩展存储 → 内容脚本 → 同源页面」之间流动，全程不出本机、不跨域。
export interface ExtensionCredsResult {
  ok: boolean;
  email?: string | null;
  password?: string | null;
  error?: string | null;
}

/**
 * 主动向扩展索取本机记住的凭据（官网未登录时自动登录）。
 * 链路：window.postMessage(HMDAO_WEB_REQUEST_CREDS) → site-auth-bridge → background 读 chrome.storage → 同源回传。
 * 超时 / 扩展未安装 / 本机无记住的凭据 → 返回 ok:false（调用方静默降级）。
 */
export function requestExtensionCreds(timeoutMs = 1500): Promise<ExtensionCredsResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: ExtensionCredsResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onRes);
      clearTimeout(timer);
      resolve(v);
    };
    const onRes = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.type !== 'HMDAO_EXT_CREDS') return;
      if (d.source === 'push') return; // push 由 onExtensionAutoLogin 消费，避免重复触发
      if (d.email && d.password) done({ ok: true, email: d.email, password: d.password });
    };
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), timeoutMs);
    window.addEventListener('message', onRes);
    window.postMessage({ type: 'HMDAO_WEB_REQUEST_CREDS' }, '*');
  });
}

/**
 * 监听扩展「登录成功」主动推送的凭据（background → site-auth-bridge → 本页）。
 * 返回取消订阅函数。
 */
export function onExtensionAutoLogin(cb: (creds: { email: string; password: string }) => void): () => void {
  const handler = (e: MessageEvent) => {
    const d = e.data;
    if (!d || d.type !== 'HMDAO_EXT_CREDS') return;
    if (d.source && d.source !== 'push') return; // 仅消费主动推送，避免与 requestExtensionCreds 重复
    if (d.email && d.password) cb({ email: d.email, password: d.password });
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

/**
 * 监听扩展发来的「请重新同步登录态」请求。
 * 场景：扩展侧令牌失效（服务端重启/令牌被吊销）且本机没有可自动重登的凭据时，
 *   扩展会请求本页重新走一次「绑定码」同步（自愈），用户无需手动点任何按钮。
 * 返回取消订阅函数。
 */
export function onSiteRefreshLoginRequest(cb: () => void): () => void {
  const handler = (e: MessageEvent) => {
    const d = e.data;
    if (!d || d.type !== 'HMDAO_SITE_REFRESH_LOGIN') return;
    cb();
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

// 模块加载即自动注册（extensionBridge 已被常驻组件引入），保证 Web App 打开即生效
if (typeof window !== 'undefined') {
  initExtensionAiBridge();
}
