// Shared types, constants and pure helpers extracted from DccEnvironmentPanel.tsx.
// Moved verbatim — no behavior change.
import {
  AlertTriangle,
  Bot,
  Box,
  Gamepad2,
  Loader2,
  Play,
  RefreshCcw,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  Trash2,
  Wrench,
} from 'lucide-react';
import {
  type DccEnvironmentJob,
  type DccEnvironmentLogEntry,
  type DccPluginAction,
  type DccPluginLayer,
  type DccPluginStatusResponse,
} from '@/api/dccPluginManager';
import { isUnrealLegacyPreviewEnabled, type DccEngine } from '@/services/dcc/types';
import { isBrokenDccText as sharedIsBrokenDccText, normalizeDccRuntimePresentation, sanitizeDccVisibleText } from '@/services/dcc/runtimeState';

export type Language = 'zh' | 'en';



export type Translate = (zh: string, en: string) => string;







export const SHOW_UNREAL_COMPAT_MODE = isUnrealLegacyPreviewEnabled();



export const UNREAL_COMPAT_LAYER_KEYS = new Set([



  'official-capture',



  'remote-control',



  'remote-control-startup-policy',



  'pixel-streaming',



]);



export const DCC_ENVIRONMENT_MONITOR_EVENT = 'hmdao:dcc-environment-monitor';







export const ENGINE_META: Record<DccEngine, { labelZh: string; labelEn: string; icon: typeof Box; accent: string }> = {



  blender: { labelZh: 'Blender', labelEn: 'Blender', icon: Box, accent: '#f59e0b' },



  unreal: { labelZh: '\u865a\u5e7b\u5f15\u64ce', labelEn: 'Unreal Engine', icon: Gamepad2, accent: '#22c55e' },



};







export type UnrealPluginStatus = DccPluginStatusResponse['engines']['unreal'];



export type BlenderPluginStatus = DccPluginStatusResponse['engines']['blender'];



export type AnyPluginStatus = UnrealPluginStatus | BlenderPluginStatus | null;

export type UnrealActionGuardState = {
  action: 'connect' | 'install' | 'reinstall';
  mode: 'info' | 'confirm';
  title: string;
  description: string;
  details: string[];
  confirmLabel?: string;
};

export type DiagnosticPanelItem = {


  key: string;



  label: string;



  state: 'ready' | 'warning' | 'error' | 'waiting' | 'idle';



  summary: string;



  detail: string;



  nextStep?: string;



  action?: DccPluginAction | null;



  actionLabel?: string;



};



export type StatusActionBanner = {



  tone: 'ready' | 'warning' | 'error' | 'waiting' | 'idle';



  reason: string;



  nextStep?: string;



  action?: DccPluginAction | null;



  actionLabel?: string;



};







export const EXACT_ZH_MAP: Record<string, string> = {



  'Installation': '\u5b89\u88c5\u72b6\u6001',



  'User profiles': '\u7528\u6237\u914d\u7f6e',



  'Add-on files': '\u63d2\u4ef6\u6587\u4ef6',



  'Add-on enable state': '\u63d2\u4ef6\u542f\u7528\u72b6\u6001',



  'Capture service': '\u6355\u83b7\u670d\u52a1',



  'Preview startup load': '\u9884\u89c8\u542f\u52a8\u8d1f\u8f7d',



  'Headless helper': '\u65e0\u7a97\u53e3\u8f85\u52a9\u8fdb\u7a0b',



  'Blender Plugin Adapter': 'Blender \u63d2\u4ef6\u9002\u914d\u5668',



  'Unreal Plugin Adapter': '\u865a\u5e7b\u63d2\u4ef6\u9002\u914d\u5668',



  'DCC Environment Manager': 'DCC \u73af\u5883\u7ba1\u7406\u5668',



  'The plugin files are installed, but the 8766 capture service is not running yet.': '\u63d2\u4ef6\u6587\u4ef6\u5df2\u5b89\u88c5\uff0c\u4f46 8766 \u6355\u83b7\u670d\u52a1\u8fd8\u672a\u542f\u52a8\u3002',



  'Blender plugin is installed and the 8766 capture service is online.': 'Blender \u63d2\u4ef6\u5df2\u5b89\u88c5\uff0c8766 \u6355\u83b7\u670d\u52a1\u5df2\u5728\u7ebf\u3002',



  'Blender was detected, but HMDao Blender Capture is not installed yet.': '\u5df2\u68c0\u6d4b\u5230 Blender\uff0c\u4f46 HMDao Blender Capture \u8fd8\u672a\u5b89\u88c5\u3002',



  'No local Blender profile directory was detected yet.': '\u8fd8\u672a\u68c0\u6d4b\u5230\u672c\u673a Blender \u914d\u7f6e\u76ee\u5f55\u3002',



  'Unreal plugin, project enablement, and direct bridge are all ready.': 'Unreal \u63d2\u4ef6\u3001\u9879\u76ee\u542f\u7528\u548c\u76f4\u8fde\u6865\u63a5\u90fd\u5df2\u5c31\u7eea\u3002',



  'HMDao custom Unreal plugin, project enablement, and direct bridge are all ready.': 'HMDao \u81ea\u5b9a\u4e49 Unreal \u63d2\u4ef6\u3001\u9879\u76ee\u542f\u7528\u548c\u76f4\u8fde\u6865\u63a5\u90fd\u5df2\u5c31\u7eea\u3002',



};







export const REGEX_REPLACEMENTS: Array<[RegExp, string]> = [



  [/^Detected (\d+) Blender profile director(?:y|ies)\.?$/i, '\u68c0\u6d4b\u5230 $1 \u4e2a Blender \u914d\u7f6e\u76ee\u5f55\u3002'],



  [/^Installed to (.+)$/i, '\u5df2\u5b89\u88c5\u5230 $1'],



  [/^The visible Blender session has loaded HMDao Blender Capture \(PID (\d+)\)\.$/i, '\u5f53\u524d\u53ef\u89c1\u7684 Blender \u4f1a\u8bdd\u5df2\u52a0\u8f7d HMDao Blender Capture\uff08PID $1\uff09\u3002'],



  [/^No visible Blender session with HMDao Blender Capture loaded was detected yet\.$/i, '\u8fd8\u672a\u68c0\u6d4b\u5230\u5df2\u52a0\u8f7d HMDao Blender Capture \u7684\u53ef\u89c1 Blender \u4f1a\u8bdd\u3002'],



  [/^127\.0\.0\.1:8766 is online from a visible Blender session\.$/i, '127.0.0.1:8766 \u5df2\u7531\u53ef\u89c1 Blender \u4f1a\u8bdd\u542f\u52a8\u5e76\u5728\u7ebf\u3002'],



  [/^127\.0\.0\.1:8766 is online, but the source is not a visible Blender UI session yet\.$/i, '127.0.0.1:8766 \u5df2\u5728\u7ebf\uff0c\u4f46\u5f53\u524d\u6765\u6e90\u8fd8\u4e0d\u662f\u53ef\u89c1\u7684 Blender \u754c\u9762\u4f1a\u8bdd\u3002'],



  [/^127\.0\.0\.1:8766 is offline right now\. You can use Connect to start the Blender capture service on demand\.$/i, '127.0.0.1:8766 \u5f53\u524d\u79bb\u7ebf\uff0c\u53ef\u4ee5\u901a\u8fc7 Connect \u6309\u9700\u542f\u52a8 Blender \u6355\u83b7\u670d\u52a1\u3002'],



  [/^Unreal target project is running, but .* Current phase: (.+)\.$/i, 'Unreal \u76ee\u6807\u9879\u76ee\u5df2\u5728\u8fd0\u884c\uff0c\u4f46 HMDao \u63d2\u4ef6\u6a21\u5757\u8fd8\u6ca1\u6709\u8fdb\u5165\u53ef\u8fde\u63a5\u9636\u6bb5\u3002\u5f53\u524d\u9636\u6bb5\uff1a$1\u3002'],



  [/^The Unreal project is open and waiting for the direct bridge to become ready\.$/i, 'Unreal \u5de5\u7a0b\u5df2\u6253\u5f00\uff0c\u6b63\u5728\u7b49\u5f85\u76f4\u8fde\u6865\u63a5\u5c31\u7eea\u3002'],



  [/^HMDao Unreal Capture is online and waiting for a camera or viewport source\.$/i, 'HMDao Unreal Capture \u5df2\u5728\u7ebf\uff0c\u6b63\u5728\u7b49\u5f85\u6444\u50cf\u673a\u6216\u89c6\u53e3\u6e90\u3002'],



];







export function isBrokenDccText(value: string | undefined | null) {



  return sharedIsBrokenDccText(value);



}







export function localizeDccDynamicText(value: string | undefined | null, language: Language, fallback = '') {



  const raw = String(value || '').trim();



  if (!raw) return fallback;



  const normalized = raw.replace(/^"|"$/g, '').trim();



  if (language === 'en') return isBrokenDccText(normalized) ? fallback : normalized;



  const mapped = EXACT_ZH_MAP[normalized] || REGEX_REPLACEMENTS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), normalized);



  if (mapped && !isBrokenDccText(mapped)) return mapped;



  if (!isBrokenDccText(normalized)) return normalized;



  return fallback;



}







export function getEngineDisplayLabel(engine: DccEngine, t: Translate) {



  const meta = ENGINE_META[engine];



  return t(meta.labelZh, meta.labelEn);



}







export function getAdapterFallbackLabel(engine: DccEngine, t: Translate) {



  return engine === 'unreal' ? t('', 'Unreal Plugin Adapter') : t('', 'Blender Plugin Adapter');



}







export function localizeAdapterLabel(value: string | undefined | null, engine: DccEngine, language: Language, t: Translate) {



  const raw = String(value || '').trim();



  const fallback = getAdapterFallbackLabel(engine, t);



  if (!raw || isBrokenDccText(raw)) return fallback;



  if (/dcc-environment-manager/i.test(raw)) return t('', 'DCC Environment Manager');



  if (/unrealpluginadapter/i.test(raw)) return t('', 'Unreal Plugin Adapter');



  if (/blenderpluginadapter/i.test(raw)) return t('', 'Blender Plugin Adapter');



  return localizeDccDynamicText(raw, language, fallback);



}







export function getUnrealSummaryFallback(status: UnrealPluginStatus | null, t: Translate) {

  if (!status) return t('', 'Loading status...');

  if (status.plugin.syncState && !status.plugin.syncState.runtimeInSync) {
    return t('', 'The deployed Unreal plugin runtime is older than the repaired source. Rebuild or reinstall first.');
  }

  if (status.plugin.duplicateInstall) return t('', 'Duplicate Unreal plugin install detected. Keep only one scan location.');


  const shadowCopyCount = Number(status.plugin.engineShadowCopies || 0);



  if (shadowCopyCount > 0) return t('', `Detected ${shadowCopyCount} leftover Unreal plugin copies. Cleanup first.`);



  const staleReceiptCount = Array.isArray(status.plugin.staleTargetReceiptFiles) ? status.plugin.staleTargetReceiptFiles.length : 0;



  if (staleReceiptCount > 0) return t('', `Detected ${staleReceiptCount} stale Unreal build receipts. Cleanup first.`);



  if (status.plugin.directBridgeReadyForTargetProject) return t('', 'Unreal plugin, project enablement, and direct bridge are all ready.');



  if (status.plugin.directBridgeOnline) return t('', 'HMDao Unreal Capture is online and waiting for a camera or viewport source.');



  if (status.host.targetProjectRunning) return t('', 'The Unreal project is open and waiting for the direct bridge to become ready.');



  if (status.host.hostProcessRunning) return t('', 'Unreal Editor is running, but the target project is not fully ready yet.');



  if (status.plugin.installed) return t('', 'HMDao Unreal Capture is installed. Open the project and connect.');



  return t('', 'Unreal plugin install was not detected yet. Install or reinstall first.');



}







export function getBlenderSummaryFallback(status: BlenderPluginStatus | null, t: Translate) {



  if (!status) return t('', 'Loading status...');



  if (status.plugin.readyForLiveCapture) return t('', 'Blender capture service is ready for live preview.');



  if (status.plugin.serviceReachable) return t('', 'Blender capture service is online and waiting for live capture readiness.');



  if ((status.host.runningHosts?.length || 0) > 0) return t('', 'Blender is running and waiting for HMDao Capture Service to start.');



  if (status.plugin.installedVersions.length > 0) return t('', 'The Blender plugin is installed. Start Blender and connect.');



  return t('', 'Blender plugin install was not detected yet. Install first.');



}







export function getEngineSummaryFallback(engine: DccEngine, status: AnyPluginStatus, t: Translate) {



  return engine === 'unreal' ? getUnrealSummaryFallback(status && status.id === 'unreal' ? status : null, t) : getBlenderSummaryFallback(status && status.id === 'blender' ? status : null, t);



}







export function sanitizeOptionLabel(label: string | undefined | null, fallback: string, language: Language) {

  return localizeDccDynamicText(label, language, fallback) || fallback;

}

export function normalizeWindowsPathKey(value: string | undefined | null) {

  return String(value || '').replace(/\//g, '\\').trim().toLowerCase();

}

export function getParentWindowsPath(filePath: string | undefined | null) {

  const normalized = String(filePath || '').trim();

  return normalized ? normalized.replace(/[\\/][^\\/]+$/, '') : '';

}

export function pluginLevelClasses(level: string) {


  if (level === 'ready') return 'border-[#2f6f4f] bg-[#123021] text-[#baf4ce]';



  if (level === 'error') return 'border-[#6a3737] bg-[#2a1717] text-[#ffd0d0]';



  return 'border-[#5d4d2b] bg-[#241f13] text-[#f6df9a]';



}







export function pluginLayerDotClasses(state: string) {



  if (state === 'ready') return 'bg-[#4ade80]';



  if (state === 'error') return 'bg-[#f87171]';



  return 'bg-[#facc15]';



}







export function pluginActionLabel(action: string, t: Translate) {

  if (action === 'repair') return t('\u5feb\u901f\u68c0\u67e5', 'Quick Check');

  if (action === 'reinstall') return t('\u91cd\u88c5', 'Reinstall');

  if (action === 'rebuild') return t('\u91cd\u5efa', 'Rebuild');

  if (action === 'detect') return t('\u68c0\u6d4b', 'Detect');

  if (action === 'connect') return t('\u8fde\u63a5', 'Connect');

  if (action === 'start') return t('\u542f\u52a8 Unreal', 'Start Unreal');

  if (action === 'open-project') return t('\u6253\u5f00\u9879\u76ee', 'Open Project');

  if (action === 'install') return t('\u5b89\u88c5', 'Install');

  if (action === 'update') return t('\u66f4\u65b0', 'Update');

  if (action === 'cleanup') return t('\u6e05\u7406', 'Cleanup');

  if (action === 'remove') return t('\u79fb\u9664', 'Remove');

  if (action === 'rollback') return t('\u56de\u9000', 'Rollback');

  if (action === 'ready') return t('\u5df2\u5c31\u7eea', 'Ready');

  return t(localizeDccDynamicText(action, 'zh', action) || action, action);

}



export function pluginActionDescription(action: string, t: Translate) {

  if (action === 'repair') return t('\u6267\u884c\u4e00\u6b21\u5feb\u901f\u3001\u65e0\u7834\u574f\u6027\u7684\u5065\u5eb7\u68c0\u67e5\uff0c\u8986\u76d6\u7aef\u53e3\u3001\u8fdb\u7a0b\u3001\u8fd0\u884c\u65f6\u72b6\u6001\u548c\u6865\u63a5\u5c31\u7eea\u60c5\u51b5\u3002', 'Runs a fast, non-destructive health check for ports, processes, runtime state, and bridge readiness.');

  if (action === 'reinstall') return t('\u628a\u5f53\u524d\u76ee\u6807\u4e0a\u7684\u63d2\u4ef6\u526f\u672c\u66ff\u6362\u4e3a\u4e00\u4efd\u5168\u65b0\u7684\u5e72\u51c0\u5b89\u88c5\u3002', 'Replaces the current installed plugin copy with a clean one for the selected target.');

  if (action === 'rebuild') return t('\u5f53\u5df2\u5b89\u88c5\u7684\u8fd0\u884c\u65f6\u7f3a\u5931\u6216\u4e0e\u5f53\u524d\u6e90\u7801\u4e0d\u4e00\u81f4\u65f6\uff0c\u91cd\u5efa\u63d2\u4ef6\u4e8c\u8fdb\u5236\u6587\u4ef6\u3002', 'Rebuilds plugin binaries when the installed runtime is missing or out of sync.');

  if (action === 'detect') return t('\u5237\u65b0\u5f53\u524d DCC \u73af\u5883\u72b6\u6001\uff0c\u5e76\u91cd\u65b0\u626b\u63cf\u6b63\u5728\u8fd0\u884c\u7684\u5bbf\u4e3b\uff0c\u4e0d\u4f1a\u89e6\u53d1\u91cd\u88c5\u6216\u91cd\u5efa\u3002', 'Refreshes the current DCC runtime status and rescans the running host without reinstalling anything.');

  if (action === 'connect') return t('\u8ba9\u5df2\u7ecf\u8fd0\u884c\u7684 DCC \u5bbf\u4e3b\u4e3b\u52a8\u56de\u8fde HMDao\uff0c\u5e76\u5237\u65b0\u9884\u89c8\u6e90\u6216\u6444\u50cf\u673a\u5217\u8868\u3002', 'Asks the already running DCC host to bridge back to HMDao and refresh preview sources.');

  if (action === 'start') return t('\u5f53\u6ca1\u6709\u53ef\u89c1\u5bbf\u4e3b\u4f1a\u8bdd\u65f6\uff0c\u4ece\u9009\u4e2d\u7684\u5f15\u64ce\u548c\u9879\u76ee\u542f\u52a8 Unreal\u3002', 'Launches Unreal from the selected engine and project when no visible host session is running.');

  if (action === 'open-project') return t('\u7528\u5df2\u68c0\u6d4b\u5230\u7684\u5f15\u64ce\u6253\u5f00\u5f53\u524d\u9009\u4e2d\u7684 Unreal \u9879\u76ee\u3002', 'Opens the selected Unreal project in the detected engine.');

  if (action === 'install') return t('\u628a\u63d2\u4ef6\u5b89\u88c5\u5230\u5f53\u524d\u9009\u4e2d\u7684\u76ee\u6807\u4f4d\u7f6e\uff0c\u4e0d\u4f1a\u6539\u52a8\u63d2\u4ef6\u4e4b\u5916\u7684\u5de5\u7a0b\u5185\u5bb9\u3002', 'Installs the plugin to the selected target without changing project content beyond the plugin itself.');

  if (action === 'update') return t('\u628a\u5f53\u524d\u5df2\u5b89\u88c5\u7684\u63d2\u4ef6\u66f4\u65b0\u5230\u6700\u65b0\u51c6\u5907\u597d\u7684\u8fd0\u884c\u65f6\u7248\u672c\u3002', 'Updates the installed plugin copy to the latest prepared runtime.');

  if (action === 'cleanup') return t('\u6e05\u7406\u5b89\u5168\u7f13\u5b58\u3001\u4e34\u65f6\u6587\u4ef6\u548c\u8fc7\u671f\u8fd0\u884c\u65f6\u6b8b\u7559\uff0c\u4e0d\u4f1a\u52a8\u5230\u5df2\u5b89\u88c5\u7684\u63d2\u4ef6\u3002', 'Clears safe caches, temp files, and stale runtime residue. Installed plugins remain untouched.');

  if (action === 'remove') return t('\u4ece\u5f53\u524d\u9009\u4e2d\u76ee\u6807\u79fb\u9664\u63d2\u4ef6\u5b89\u88c5\uff0c\u540c\u65f6\u5c3d\u91cf\u4fdd\u7559\u53ef\u7528\u7684\u56de\u9000\u5907\u4efd\u3002', 'Removes the installed plugin copy from the selected target while preserving rollback data when available.');

  if (action === 'rollback') return t('\u5c06\u5f53\u524d\u9009\u4e2d\u76ee\u6807\u56de\u6062\u5230\u4e0a\u4e00\u4efd\u5df2\u4fdd\u5b58\u7684\u63d2\u4ef6\u5907\u4efd\u3002', 'Restores the last saved plugin backup for the selected target.');

  if (action === 'ready') return t('\u5f53\u524d\u5bbf\u4e3b\u4f1a\u8bdd\u548c\u63d2\u4ef6\u8def\u5f84\u72b6\u6001\u5df2\u7ecf\u5c31\u7eea\u3002', 'The current host and plugin path already look ready.');

  return t('\u6267\u884c\u9009\u4e2d\u7684 DCC \u73af\u5883\u64cd\u4f5c\u3002', 'Runs the selected DCC environment action.');

}


export function pluginActionIcon(action: DccPluginAction) {



  if (action === 'detect') return RefreshCcw;



  if (action === 'connect') return Play;



  if (action === 'reinstall') return RotateCcw;



  if (action === 'rebuild') return Wrench;



  if (action === 'cleanup') return Trash2;



  if (action === 'remove') return Trash2;



  if (action === 'rollback') return RotateCcw;



  if (action === 'repair') return Wrench;



  return ShieldCheck;



}







export function jobStatusClasses(status: string) {



  if (status === 'completed') return 'border-[#2f6f4f] bg-[#123021] text-[#baf4ce]';



  if (status === 'failed') return 'border-[#6a3737] bg-[#2a1717] text-[#ffd0d0]';



  if (status === 'running') return 'border-[#365269] bg-[#172532] text-[#c8e7ff]';



  return 'border-[#4e4327] bg-[#241f13] text-[#f6df9a]';



}







export function jobStatusLabel(status: string, t: Translate) {



  if (status === 'completed') return t('', 'Completed');



  if (status === 'failed') return t('', 'Failed');



  if (status === 'running') return t('', 'Running');



  if (status === 'queued') return t('', 'Queued');



  if (status === 'pending') return t('', 'Pending');



  return status;



}







export function logLevelClasses(level: string) {



  if (level === 'error') return 'text-[#ffcbcb]';



  if (level === 'warn') return 'text-[#f6df9a]';



  return 'text-[#c9f2de]';



}







export function logLevelLabel(level: string, t: Translate) {



  if (level === 'error') return t('', 'Error');



  if (level === 'warn') return t('', 'Warn');



  if (level === 'info') return t('', 'Info');



  return level.toUpperCase();



}







export function formatEnvironmentTime(value: string | undefined | null, language: Language) {



  if (!value) return '';



  const date = new Date(value);



  if (Number.isNaN(date.getTime())) return value;



  return date.toLocaleString(language === 'en' ? 'en-US' : 'zh-CN', { hour12: false });



}







export function formatLogContext(context?: Record<string, unknown> | null) {



  if (!context) return '';



  try {



    return JSON.stringify(context, null, 2);



  } catch {



    return String(context);



  }



}











export function dedupeRuntimeItems<T extends { dedupeKey?: string | null; id: string }>(items: T[]) {



  const seen = new Set<string>();



  return items.filter((item) => {



    const key = String(item.dedupeKey || item.id);



    if (seen.has(key)) return false;



    seen.add(key);



    return true;



  });



}







export function runtimeStageToneClasses(state: string) {



  if (state === 'ready') return 'border-[#2f6f4f] bg-[#123021] text-[#baf4ce]';



  if (state === 'error') return 'border-[#6a3737] bg-[#2a1717] text-[#ffd0d0]';



  if (state === 'warning') return 'border-[#5d4d2b] bg-[#241f13] text-[#f6df9a]';



  if (state === 'waiting') return 'border-[#365269] bg-[#172532] text-[#c8e7ff]';



  return 'border-[#30363d] bg-[#161b22] text-[#9da7b3]';



}







export function runtimeStageStateLabel(state: string, t: Translate) {



  if (state === 'ready') return t('\u5df2\u5b8c\u6210', 'Completed');



  if (state === 'error') return t('\u5f02\u5e38', 'Issue');



  if (state === 'warning') return t('\u9700\u5904\u7406', 'Attention');



  if (state === 'waiting') return t('\u8fdb\u884c\u4e2d', 'In Progress');



  return t('\u5f85\u68c0\u67e5', 'Pending');



}







export function normalizeDiagnosticState(value: string | undefined | null): DiagnosticPanelItem['state'] {



  if (value === 'ready' || value === 'warning' || value === 'error' || value === 'waiting') return value;



  return 'idle';



}







export function diagnosticStateLabel(state: DiagnosticPanelItem['state'], t: Translate) {



  if (state === 'ready') return t('\u5df2\u7a33\u5b9a', 'Ready');



  if (state === 'warning') return t('\u9700\u5904\u7406', 'Attention');



  if (state === 'error') return t('\u5f02\u5e38', 'Issue');



  if (state === 'waiting') return t('\u7b49\u5f85\u4e2d', 'Waiting');



  return t('\u5f85\u68c0\u67e5', 'Pending');



}







export function findLayerByKey(layers: DccPluginLayer[] | undefined, keys: string[]) {



  return (layers || []).find((layer) => keys.includes(String(layer.key || ''))) || null;



}







export function localizeLayerDetail(layer: DccPluginLayer | null, language: Language, fallback: string) {



  return localizeDccDynamicText(layer?.detail, language, fallback) || fallback;



}







export function getUnrealStartupDiagnostics(
  status: UnrealPluginStatus | null,
  language: Language,
  t: Translate,
): DiagnosticPanelItem[] {
  if (!status) {
    return [
      {
        key: 'host-startup',
        label: t('', 'Host Startup'),
        state: 'idle',
        summary: t('', 'Waiting for scan'),
        detail: t('', 'Connect or refresh to load Unreal startup diagnostics.'),
        nextStep: t('', 'Run one scan first, then separate host startup stalls from config pollution or background residue.'),
      },
      {
        key: 'config-pollution',
        label: t('', 'Config Pollution'),
        state: 'idle',
        summary: t('', 'Waiting for scan'),
        detail: t('', 'DDC, startup policy, and project-browser drift are only evaluated after the first scan.'),
        nextStep: t('', 'If startup policy drift is present, this card will point directly to Quick Check.'),
      },
      {
        key: 'background-residue',
        label: t('', 'Background Residue'),
        state: 'idle',
        summary: t('', 'Waiting for scan'),
        detail: t('', 'The first scan checks for duplicate installs, leftover engine backup copies, and stale receipts.'),
        nextStep: t('', 'If residue is present, this card will point directly to Cleanup or Reinstall.'),
      },
    ];
  }

  const customPluginLayer = findLayerByKey(status.layers, ['custom-plugin-install', 'engine-install']);
  const ddcLayer = findLayerByKey(status.layers, ['ddc-zen']);
  const projectDdcLayer = findLayerByKey(status.layers, ['project-ddc-policy']);
  const epicLaunchLayer = findLayerByKey(status.layers, ['engine-launch-ddc-policy', 'project-browser-startup-ui']);
  const startupLayer = findLayerByKey(status.layers, ['startup-phase']);
  const projectRuntimeLayer = findLayerByKey(status.layers, ['target-project-runtime', 'project']);

  const startupProbe = status.host.startupProbe || null;
  const startupProbeCategory = String(startupProbe?.category || '').trim();
  const startupProbeReason = localizeDccDynamicText(startupProbe?.reason, language, String(startupProbe?.reason || '').trim());
  const startupProbeDetail = localizeDccDynamicText(startupProbe?.detail, language, String(startupProbe?.detail || '').trim());
  const startupPhaseLabel = String(startupProbe?.phaseLabel || '').trim();
  const windowState = String(startupProbe?.windowState || '').trim();
  const hasNoFreshLog = Boolean(startupProbe?.hasNoFreshLog);

  const hostRunning = Boolean(status.host.hostProcessRunning);
  const projectRunning = Boolean(status.host.targetProjectRunning);
  const projectSelected = Boolean(status.project);
  const bridgeOnline = Boolean(status.plugin.directBridgeOnline);
  const bridgeReady = Boolean(status.plugin.directBridgeReadyForTargetProject);
  const cameraCount = Number(status.plugin.cameraCount || 0);
  const pluginSync = status.plugin.syncState || null;

  const shadowCopies = Number(status.plugin.engineShadowCopies || 0);
  const staleReceipts = Array.isArray(status.plugin.staleTargetReceiptFiles) ? status.plugin.staleTargetReceiptFiles.length : 0;
  const hasPluginResidue = Boolean(status.plugin.duplicateInstall || shadowCopies > 0 || staleReceipts > 0);

  const hostStartupBlocked = startupProbeCategory === 'host-stuck';
  const configPollutionLikely = startupProbeCategory === 'config-pollution';
  const backgroundResidueLikely = startupProbeCategory === 'background-residue' || hasPluginResidue;
  const startupHealthy = startupProbeCategory === 'ready' || bridgeReady;
  const startupWaiting = startupProbeCategory === 'waiting';
  const startupUnavailable = startupProbeCategory === 'unavailable';

  const hostLayerDetail = localizeLayerDetail(startupLayer || projectRuntimeLayer, language, startupProbeDetail || startupProbeReason || '');
  const configLayerDetail = [
    localizeLayerDetail(ddcLayer, language, ''),
    localizeLayerDetail(projectDdcLayer, language, ''),
    localizeLayerDetail(epicLaunchLayer, language, ''),
    configPollutionLikely ? startupProbeDetail : '',
  ].filter(Boolean).join(' ');
  const residueLayerDetail = localizeLayerDetail(
    customPluginLayer,
    language,
    startupProbeDetail || startupProbeReason || '',
  );

  const hostStartupAction = hostStartupBlocked
    ? ('repair' as const)
    : bridgeOnline && cameraCount <= 0
      ? ('connect' as const)
      : null;

  return [
    {
      key: 'host-startup',
      label: t('', 'Host Startup'),
      state: hostStartupBlocked ? 'warning' : startupHealthy ? 'ready' : hostRunning || projectRunning || startupWaiting ? 'waiting' : projectSelected && !startupUnavailable ? 'waiting' : 'idle',
      summary: hostStartupBlocked
        ? t('', 'Unreal host startup is stuck before the editor becomes connectable')
        : startupHealthy
          ? t('', 'The Unreal editor and target project look connectable')
          : projectRunning
            ? t('', 'The target Unreal project is still finishing startup')
            : hostRunning
              ? t('', 'The Unreal editor is open, but the selected project is not ready yet')
              : projectSelected
                ? t('', 'Waiting for the Unreal editor window')
                : t('', 'No Unreal project is selected yet'),
      detail: hostStartupBlocked
        ? [startupProbeReason, hostLayerDetail].filter(Boolean).join(' ')
        : startupHealthy
          ? t('', 'This no longer looks like an Unreal host startup stall.')
          : hostLayerDetail || t('', 'No connectable Unreal editor session is available yet.'),
      nextStep: hostStartupBlocked
        ? hasNoFreshLog || windowState
          ? t('', 'Run Quick Check, then relaunch Unreal visibly from the selected project. If it still stalls before a fresh log appears, the slowdown is in Unreal host startup or graphics initialization, not the HMDao attach path.')
          : t('', 'Relaunch Unreal visibly from the selected project. If it sticks on the same startup phase again, run Quick Check before reconnecting.')
        : startupHealthy
          ? bridgeOnline && cameraCount <= 0
            ? t('', 'Bring the level viewport or active camera sequencer back to the foreground, then click Connect again to refresh the camera list.')
            : t('', 'Host startup looks healthy. If browser preview is still missing, continue with Connect or camera refresh only.')
          : !hostRunning
            ? t('', 'Start Unreal first, wait until the editor window is responsive, then click Connect again.')
            : !projectRunning
              ? t('', 'Open the selected project first, wait until it really enters the editor, then click Connect again.')
              : t('', 'Wait for the current Unreal startup phase to finish before retrying Connect.'),
      action: hostStartupAction,
      actionLabel: hostStartupBlocked
        ? t('', 'Quick Check')
        : bridgeOnline && cameraCount <= 0
          ? t('', 'Connect')
          : '',
    },
    {
      key: 'config-pollution',
      label: t('', 'Config Pollution'),
      state: configPollutionLikely ? 'warning' : projectSelected || hostRunning || projectRunning || startupHealthy || startupWaiting ? 'ready' : 'idle',
      summary: configPollutionLikely
        ? t('', 'Unreal startup defaults are still heavier than the intended lightweight attach path')
        : projectSelected || hostRunning || projectRunning || startupHealthy
          ? t('', 'No startup policy drift is visible right now')
          : t('', 'Waiting for startup policy scan'),
      detail: configLayerDetail || t('', 'This card turns warning only when DDC, startup browser, or RC autostart policy has drifted back to a heavier path.'),
      nextStep: configPollutionLikely
        ? t('', 'Run Quick Check first. It rewrites lightweight DDC, classic project-browser startup, and on-demand Remote Control policy before you retry Connect.')
        : t('', 'Config pollution is not the primary issue right now. If Connect still fails, focus on host startup or background residue first.'),
      action: configPollutionLikely ? 'repair' : null,
      actionLabel: configPollutionLikely ? t('', 'Quick Check') : '',
    },
    {
      key: 'background-residue',
      label: t('', 'Background Residue'),
      state: backgroundResidueLikely ? 'warning' : 'ready',
      summary: backgroundResidueLikely
        ? status.plugin.duplicateInstall
          ? t('', 'Duplicate Unreal plugin install scopes are still conflicting')
          : shadowCopies > 0
            ? t('', 'Leftover Unreal plugin backup copies are still being scanned')
            : staleReceipts > 0
              ? t('', 'Stale Unreal build receipts are still polluting startup checks')
              : t('', 'Background residue is still dragging Unreal startup down')
        : t('', 'No duplicate install, backup copy, or stale receipt residue was detected'),
      detail: residueLayerDetail || (backgroundResidueLikely
        ? t('', 'This looks more like leftover HMDao plugin residue than Unreal itself being slow every time.')
        : t('', 'There is no sign that HMDao residue is dragging Unreal startup right now.')),
      nextStep: backgroundResidueLikely
        ? status.plugin.duplicateInstall
          ? t('', 'Run Reinstall first so only one shared engine-level install remains, then retry Connect from the selected project.')
          : t('', 'Run Cleanup first to remove backup plugin copies and stale receipts before the next Epic or standalone Unreal launch.')
        : t('', 'Background residue is not the primary issue right now. If Unreal is still slow, look at host startup or config pollution first.'),
      action: backgroundResidueLikely ? (status.plugin.duplicateInstall ? 'reinstall' : 'cleanup') : null,
      actionLabel: backgroundResidueLikely
        ? status.plugin.duplicateInstall
          ? t('', 'Reinstall')
          : t('', 'Cleanup')
        : '',
    },
    {
      key: 'plugin-sync',
      label: t('', 'Plugin Sync'),
      state: pluginSync && pluginSync.runtimeInSync ? 'ready' : pluginSync ? 'warning' : 'idle',
      summary: pluginSync
        ? pluginSync.runtimeInSync
          ? t('', 'The installed Unreal runtime matches the repaired plugin build')
          : t('', 'The installed Unreal runtime is older than the repaired plugin source')
        : t('', 'Waiting for plugin sync check'),
      detail: pluginSync
        ? localizeDccDynamicText(pluginSync.summary, language, pluginSync.summary)
        : t('', 'Connect or refresh to compare the deployed Unreal DLL with the repaired HMDao plugin source.'),
      nextStep: pluginSync
        ? pluginSync.runtimeInSync
          ? t('', 'Plugin sync looks correct. If Unreal is still slow, keep the focus on host startup, DDC, Zen, or project readiness.')
          : t('', 'Run Rebuild or Reinstall once so the deployed Unreal DLL catches up to the repaired source, then retry Connect.')
        : t('', 'Run one scan first so the panel can compare source and deployed runtime timestamps.'),
      action: pluginSync && !pluginSync.runtimeInSync ? 'rebuild' : null,
      actionLabel: pluginSync && !pluginSync.runtimeInSync ? t('', 'Rebuild') : '',
    },
  ];
}
export function getBlenderStartupDiagnostics(

  status: BlenderPluginStatus | null,

  language: Language,

  t: Translate,

): DiagnosticPanelItem[] {

  if (!status) {

    return [

      {

        key: 'host-startup',

        label: t('', 'Host Startup'),

        state: 'idle',

        summary: t('', 'Waiting for scan'),

        detail: t('', 'Connect or refresh to load Blender startup diagnostics.'),

        nextStep: t('', 'Run one scan first, then separate host startup stalls from config pollution or background residue.'),

      },

      {

        key: 'config-pollution',

        label: t('', 'Config Pollution'),

        state: 'idle',

        summary: t('', 'Waiting for scan'),

        detail: t('', 'Config pollution is only flagged after a clean startup probe succeeds.'),

        nextStep: t('', 'If the clean probe passes, the panel will point you to a --factory-startup check directly.'),

      },

      {

        key: 'background-residue',

        label: t('', 'Background Residue'),

        state: 'idle',

        summary: t('', 'Waiting for scan'),

        detail: t('', 'The first scan checks whether orphan helpers or hidden Blender processes are still present.'),

        nextStep: t('', 'If residue is present, this card will point directly to Cleanup.'),

      },

    ];

  }



  const visibleHosts = status.host.runningHosts?.length || 0;

  const hiddenHosts = status.host.hiddenRunningHosts?.length || 0;

  const headlessHosts = status.host.headlessRunningHosts?.length || 0;

  const helperLayer = findLayerByKey(status.layers, ['headless-helper']);

  const probeLayer = findLayerByKey(status.layers, ['startup-probe']);

  const startupProbe = status.host.startupProbe || null;

  const startupProbeCategory = String(startupProbe?.category || '').trim();

  const executablePath = String(startupProbe?.executablePath || status.host.installations?.[0]?.executablePath || '').trim();

  const probeReason = String(startupProbe?.backgroundReason || startupProbe?.cliReason || '').trim();

  const profileLabel = String(startupProbe?.profile || '').trim();

  const hostStartupBlocked = startupProbeCategory === 'host-stuck';

  const configPollutionLikely = startupProbeCategory === 'config-pollution';

  const backgroundResidueLikely = startupProbeCategory === 'background-residue' || (headlessHosts > 0 && visibleHosts === 0);



  const factoryStartupCommand = executablePath

    ? `${executablePath} --factory-startup`

    : 'Blender --factory-startup';



  return [

    {

      key: 'host-startup',

      label: t('', 'Host Startup'),

      state: hostStartupBlocked ? 'warning' : visibleHosts > 0 ? 'ready' : executablePath ? 'waiting' : 'idle',

      summary: hostStartupBlocked

        ? t('', 'Blender host startup is stuck before the visible window appears')

        : visibleHosts > 0

          ? t('', 'The Blender host window is up normally')

          : t('', 'Waiting for the Blender window'),

      detail: hostStartupBlocked

        ? (localizeDccDynamicText(probeReason, language, probeReason) || localizeLayerDetail(probeLayer, language, t('', 'The clean startup probe already shows a Blender host startup problem.')))

        : visibleHosts > 0

          ? t('', 'This no longer looks like a Blender host startup stall.')

          : t('', 'No visible Blender window is available yet, so host startup cannot be confirmed.'),

      nextStep: hostStartupBlocked

        ? hiddenHosts > 0

          ? t('', 'Run Cleanup first to remove hidden Blender processes, then restart the Blender host alone and check whether the window appears.')

          : t('', `Run ${factoryStartupCommand} first. If that is still slow, the issue is Blender host startup or graphics initialization, not HMDao.`)

        : visibleHosts > 0

          ? t('', 'The host window is up, so move on to config pollution or residue checks.')

          : t('', 'Bring up the visible Blender window first, then continue the Connect flow.'),

      action: hostStartupBlocked ? (hiddenHosts > 0 ? 'cleanup' : 'repair') : null,

      actionLabel: hostStartupBlocked ? (hiddenHosts > 0 ? t('', 'Cleanup') : t('', 'Quick Check')) : '',

    },

    {

      key: 'config-pollution',

      label: t('', 'Config Pollution'),

      state: configPollutionLikely ? 'warning' : visibleHosts > 0 ? 'ready' : executablePath ? 'waiting' : 'idle',

      summary: configPollutionLikely

        ? t('', 'The clean startup probe passed, so user config or third-party add-ons are more likely slowing startup')

        : visibleHosts > 0

          ? t('', 'No config pollution signal is visible right now')

          : t('', 'Waiting for the clean startup probe result'),

      detail: configPollutionLikely

        ? t('', `The clean background probe${profileLabel && profileLabel !== 'failed' ? ` (${profileLabel})` : ''} succeeded, which means the Blender binary itself is probably fine. The current slowdown is more likely in user config, cache, or other add-ons.`)

        : t('', 'If this card later turns warning, it means clean Blender startup works but the normal user environment is polluted.'),

      nextStep: configPollutionLikely

        ? t('', `Run ${factoryStartupCommand} first. If that opens quickly, disable third-party add-ons and clean Blender user config/cache before bringing HMDao back.`)

        : visibleHosts > 0

          ? t('', 'Config pollution is not the primary conclusion right now. Continue with Connect or 8766 diagnosis first.')

          : t('', 'Wait for the clean probe result before switching to a --factory-startup check.'),

    },

    {

      key: 'background-residue',

      label: t('', 'Background Residue'),

      state: backgroundResidueLikely ? 'warning' : 'ready',

      summary: backgroundResidueLikely

        ? t('', 'A background helper or stale session is still dragging Blender down')

        : t('', 'No orphan helper or stale session was detected'),

      detail: localizeLayerDetail(

        helperLayer,

        language,

        backgroundResidueLikely

          ? t('', 'This looks more like leftover HMDao background state than Blender host startup being inherently slow every time.')

          : t('', 'There is no sign that HMDao background residue is dragging Blender right now.'),

      ),

      nextStep: backgroundResidueLikely

        ? t('', 'Run Cleanup first to remove orphan helpers, stale requests, and runtime residue, then reconnect from a visible Blender window.')

        : t('', 'Background residue is not the primary cause right now. If Connect still fails, look at host startup or config pollution first.'),

      action: backgroundResidueLikely ? 'cleanup' : null,

      actionLabel: backgroundResidueLikely ? t('', 'Cleanup') : '',

    },

  ];

}



export function diagnosticStateRank(state: DiagnosticPanelItem['state']) {



  if (state === 'error') return 0;



  if (state === 'warning') return 1;



  if (state === 'waiting') return 2;



  if (state === 'ready') return 3;



  return 4;



}







export function getTopStatusBanner({



  engine,



  runtimeState,



  diagnostics,



  pluginStatusError,



  hasLoadedStatus,



  t,



}: {



  engine: DccEngine;



  runtimeState: ReturnType<typeof normalizeDccRuntimePresentation>;



  diagnostics: DiagnosticPanelItem[];



  pluginStatusError: string;



  hasLoadedStatus: boolean;



  t: Translate;



}): StatusActionBanner | null {



  if (!hasLoadedStatus) {



    return {



      tone: 'waiting',



      reason: t('\u5c1a\u672a\u5f00\u59cb\u68c0\u6d4b\u5f53\u524d DCC \u73af\u5883\u3002', 'No DCC status scan has run yet.'),



      nextStep: t('\u5148\u70b9\u51fb Connect \u6216 Refresh\uff0c\u7136\u540e\u518d\u6839\u636e\u539f\u56e0\u5361\u548c\u542f\u52a8\u8bca\u65ad\u5904\u7406\u3002', 'Connect or refresh first, then act on the cause and startup diagnostics.'),



    };



  }







  const candidates = diagnostics



    .filter((item) => item.state !== 'ready' && item.state !== 'idle')



    .sort((left, right) => {



      const byState = diagnosticStateRank(left.state) - diagnosticStateRank(right.state);



      if (byState !== 0) return byState;



      if (left.action && !right.action) return -1;



      if (!left.action && right.action) return 1;



      return 0;



    });



  const primary = candidates[0] || null;







  if (!pluginStatusError && !primary && runtimeState.state === 'ready') {



    return null;



  }







  const fallbackReason = primary



    ? `${primary.label}: ${primary.summary}`



    : runtimeState.message;



  const reason = pluginStatusError



    ? sanitizeDccVisibleText(pluginStatusError, fallbackReason)



    : sanitizeDccVisibleText(runtimeState.message, fallbackReason);



  const nextStep = primary?.nextStep || (engine === 'unreal'



    ? t('\u4f18\u5148\u53c2\u8003\u4e0a\u65b9\u542f\u52a8\u8bca\u65ad\uff0c\u9010\u9879\u6267\u884c Quick Check / Cleanup / Open Project / Connect\u3002', 'Use the startup diagnostics above and work through Quick Check / Cleanup / Open Project / Connect in order.')



    : t('\u4f18\u5148\u53c2\u8003\u4e0a\u65b9\u542f\u52a8\u8bca\u65ad\uff0c\u5148\u6e05\u7406\u540e\u53f0\u6b8b\u7559\uff0c\u518d\u786e\u8ba4\u53ef\u89c1 Blender \u4f1a\u8bdd\u548c 8766 \u670d\u52a1\u3002', 'Use the startup diagnostics above: clear background residue first, then confirm the visible Blender session and 8766 service.'));







  return {



    tone: pluginStatusError ? 'error' : primary?.state || runtimeState.state,



    reason,



    nextStep,



    action: primary?.action || null,



    actionLabel: primary?.actionLabel || '',



  };



}







export function runtimeStageSteps(_engine: DccEngine, currentStage: string, currentState: string, t: Translate) {



  const stages = [



    { key: 'host', label: t('\u5bbf\u4e3b\u542f\u52a8', 'Host Launch') },



    { key: 'plugin', label: t('\u63d2\u4ef6\u6302\u8f7d', 'Plugin Load') },



    { key: 'bridge', label: t('\u6865\u63a5\u4e0a\u7ebf', 'Bridge Online') },



    { key: 'frame', label: t('\u9996\u5e27\u5230\u8fbe', 'First Frame') },



  ];



  const order = new Map(stages.map((item, index) => [item.key, index]));



  const currentIndex = order.get(currentStage) ?? 0;



  return stages.map((item, index) => ({



    ...item,



    state: index < currentIndex ? 'ready' : index === currentIndex ? currentState : 'idle',



  }));



}







export const DCC_PANEL_ZH_BY_EN: Record<string, string> = {



  'Quick Check': '\u5feb\u901f\u68c0\u67e5',



  'Reinstall': '\u91cd\u65b0\u5b89\u88c5',



  'Rebuild': '\u91cd\u5efa',



  'Detect': '\u68c0\u6d4b',



  'Connect': '\u8fde\u63a5',



  'Start Unreal': '\u542f\u52a8 Unreal',



  'Open Project': '\u6253\u5f00\u9879\u76ee',



  'Install': '\u5b89\u88c5',



  'Update': '\u66f4\u65b0',



  'Cleanup': '\u6e05\u7406',



  'Remove': '\u79fb\u9664',



  'Rollback': '\u56de\u9000',



  'Ready': '\u5c31\u7eea',



  'Completed': '\u5df2\u5b8c\u6210',



  'Failed': '\u5931\u8d25',



  'Running': '\u8fd0\u884c\u4e2d',



  'Queued': '\u6392\u961f\u4e2d',



  'Pending': '\u7b49\u5f85\u4e2d',



  'Error': '\u9519\u8bef',



  'Warn': '\u8b66\u544a',



  'Info': '\u4fe1\u606f',



  'Plugin': '\u63d2\u4ef6',



  'Duplicate install detected': '\u68c0\u6d4b\u5230\u91cd\u590d\u5b89\u88c5',



  'Backup copies still visible': '\u4ecd\u6709\u5907\u4efd\u526f\u672c\u6b8b\u7559',



  'Stale receipts need cleanup': '\u9700\u8981\u6e05\u7406\u8fc7\u671f\u56de\u6267',



  'Enabled': '\u5df2\u542f\u7528',



  'Copied, enable in Unreal': '\u5df2\u590d\u5236\uff0c\u8bf7\u5728 Unreal \u4e2d\u542f\u7528',



  'Not installed': '\u672a\u5b89\u88c5',



  'Host': '\u5bbf\u4e3b',



  'Project open': '\u9879\u76ee\u5df2\u6253\u5f00',



  'Editor open, project not ready': '\u7f16\u8f91\u5668\u5df2\u6253\u5f00\uff0c\u9879\u76ee\u5c1a\u672a\u5c31\u7eea',



  'Not running': '\u672a\u8fd0\u884c',



  'Bridge': '\u6865\u63a5',



  'Preview ready': '\u9884\u89c8\u5c31\u7eea',



  'Online, waiting for camera': '\u5728\u7ebf\uff0c\u7b49\u5f85\u6444\u50cf\u673a',



  'Offline': '\u79bb\u7ebf',



  'Keep one install only': '\u53ea\u4fdd\u7559\u4e00\u4e2a\u5b89\u88c5\u4f4d\u7f6e',



  'Duplicate install conflict detected': '\u68c0\u6d4b\u5230\u91cd\u590d\u5b89\u88c5\u51b2\u7a81',



  'Cleanup leftover scan copies': '\u6e05\u7406\u6b8b\u7559\u626b\u63cf\u526f\u672c',



  'Leftover plugin copies detected': '\u68c0\u6d4b\u5230\u6b8b\u7559\u63d2\u4ef6\u526f\u672c',



  'Cleanup stale receipts': '\u6e05\u7406\u8fc7\u671f\u56de\u6267',



  'Stale build receipts detected': '\u68c0\u6d4b\u5230\u8fc7\u671f\u6784\u5efa\u56de\u6267',



  'DCC Environment Manager': 'DCC \u73af\u5883\u7ba1\u7406\u5668',



  'Environment manager + adapters + job/log runtime': '\u73af\u5883\u7ba1\u7406\u5668 + \u9002\u914d\u5668 + job/log \u8fd0\u884c\u65f6',



  'Refresh': '\u5237\u65b0',



  'Jobs': '\u4efb\u52a1',



  'Done': '\u5b8c\u6210',



  'Loading plugin status...': '\u6b63\u5728\u52a0\u8f7d\u63d2\u4ef6\u72b6\u6001...',



  'handles detect, connect, install, reinstall, rebuild, quick checks, cleanup, and rollback.': '\u652f\u6301\u68c0\u6d4b\u3001\u8fde\u63a5\u3001\u5b89\u88c5\u3001\u91cd\u88c5\u3001\u91cd\u5efa\u3001\u5feb\u901f\u68c0\u67e5\u3001\u6e05\u7406\u548c\u56de\u9000\u3002',



  'Target Project': '\u76ee\u6807\u9879\u76ee',



  'Engine Root': '\u5f15\u64ce\u6839\u76ee\u5f55',



  'Auto-build the engine-level precompiled Unreal plugin during install / reinstall': '\u5b89\u88c5 / \u91cd\u88c5\u65f6\u81ea\u52a8\u6784\u5efa\u5f15\u64ce\u7ea7\u9884\u7f16\u8bd1 Unreal \u63d2\u4ef6',



  'Disabled': '\u5df2\u7981\u7528',



  'Current project: ': '\u5f53\u524d\u9879\u76ee\uff1a',



  'No .uproject selected': '\u672a\u9009\u62e9 .uproject',

  'No engine detected': '\u672a\u68c0\u6d4b\u5230\u5f15\u64ce',

  'No engine root selected': '\u672a\u9009\u62e9\u5f15\u64ce\u6839\u76ee\u5f55',

  'Select a Unreal project first': '\u8bf7\u5148\u9009\u62e9 Unreal \u9879\u76ee',

  'Connect needs a specific .uproject. Pick the target project first, then open that same project in Unreal.': '\u8fde\u63a5\u9700\u8981\u660e\u786e\u7684 .uproject\u3002\u8bf7\u5148\u9009\u62e9\u76ee\u6807\u9879\u76ee\uff0c\u518d\u5728 Unreal \u91cc\u6253\u5f00\u540c\u4e00\u4e2a\u9879\u76ee\u3002',

  'Detected engine': '\u5df2\u8bc6\u522b\u5f15\u64ce',

  'Open the selected project before connecting': '\u8fde\u63a5\u524d\u5148\u6253\u5f00\u9009\u4e2d\u9879\u76ee',

  'The Unreal editor is not running yet. Open the selected project in a visible Unreal window first, then come back and connect.': '\u5f53\u524d Unreal \u7f16\u8f91\u5668\u8fd8\u6ca1\u6709\u8fd0\u884c\u3002\u8bf7\u5148\u5728\u53ef\u89c1\u7684 Unreal \u7a97\u53e3\u4e2d\u6253\u5f00\u9009\u4e2d\u9879\u76ee\uff0c\u7136\u540e\u518d\u56de\u6765\u8fde\u63a5\u3002',

  'Target project': '\u76ee\u6807\u9879\u76ee',

  'Expected engine': '\u9884\u671f\u5f15\u64ce',

  'Wait until Unreal finishes opening the project': '\u7b49\u5f85 Unreal \u628a\u9879\u76ee\u6253\u5f00\u5b8c\u6574',

  'Unreal has started, but the selected project is not fully open yet. Wait for the project window and level to finish loading, then click Connect again.': 'Unreal \u5df2\u7ecf\u542f\u52a8\uff0c\u4f46\u9009\u4e2d\u9879\u76ee\u8fd8\u6ca1\u6709\u5b8c\u5168\u6253\u5f00\u3002\u8bf7\u7b49\u9879\u76ee\u7a97\u53e3\u548c\u573a\u666f\u52a0\u8f7d\u5b8c\u6210\u540e\uff0c\u518d\u70b9\u51fb\u8fde\u63a5\u3002',

  'Detected editor': '\u5df2\u8bc6\u522b\u7f16\u8f91\u5668',

  'Unreal is starting': 'Unreal \u6b63\u5728\u542f\u52a8',

  'Confirm Unreal plugin install': '\u786e\u8ba4\u5b89\u88c5 Unreal \u63d2\u4ef6',

  'Confirm Unreal plugin reinstall': '\u786e\u8ba4\u91cd\u65b0\u5b89\u88c5 Unreal \u63d2\u4ef6',

  'This will prepare the shared HMDao Unreal plugin for the selected Unreal version.': '\u8fd9\u5c06\u4e3a\u9009\u4e2d\u7684 Unreal \u7248\u672c\u51c6\u5907\u4e00\u4efd\u53ef\u5171\u7528\u7684 HMDao \u63d2\u4ef6\u3002',

  'This will copy HMDao Unreal Capture only into the selected project.': '\u8fd9\u6b21\u53ea\u4f1a\u628a HMDao Unreal Capture \u590d\u5236\u5230\u5f53\u524d\u9009\u4e2d\u9879\u76ee\u4e2d\u3002',

  'Unreal version': 'Unreal \u7248\u672c',

  'Engine root': '\u5f15\u64ce\u6839\u76ee\u5f55',

  'Install target': '\u5b89\u88c5\u76ee\u6807',

  'Selected Unreal version': '\u5f53\u524d\u9009\u4e2d\u7684 Unreal \u7248\u672c',

  'Install now': '\u7acb\u5373\u5b89\u88c5',

  'Reinstall now': '\u7acb\u5373\u91cd\u88c5',

  'Cancel': '\u53d6\u6d88',

  'Close': '\u5173\u95ed',

  'Continue': '\u7ee7\u7eed',

  'Current install target': '\u5f53\u524d\u5b89\u88c5\u76ee\u6807',

  'Engine-level install is selected. HMDao will prepare one shared plugin copy for the selected Unreal version.': '\u5f53\u524d\u9009\u4e2d\u7684\u662f\u5f15\u64ce\u7ea7\u5b89\u88c5\u3002HMDao \u4f1a\u4e3a\u8fd9\u4e2a Unreal \u7248\u672c\u51c6\u5907\u4e00\u4efd\u53ef\u5171\u7528\u7684\u63d2\u4ef6\u3002',

  'Project-only install is selected. HMDao will copy the plugin only into this project and will not touch other Unreal versions.': '\u5f53\u524d\u9009\u4e2d\u7684\u662f\u9879\u76ee\u7ea7\u5b89\u88c5\u3002HMDao \u53ea\u4f1a\u628a\u63d2\u4ef6\u590d\u5236\u5230\u8fd9\u4e2a\u9879\u76ee\uff0c\u4e0d\u4f1a\u52a8\u5176\u4ed6 Unreal \u7248\u672c\u3002',

  'Detected Unreal version': '\u5df2\u8bc6\u522b\u7684 Unreal \u7248\u672c',

  'Project plugin folder': '\u9879\u76ee\u63d2\u4ef6\u76ee\u5f55',

  'Engine plugin folder': '\u5f15\u64ce\u63d2\u4ef6\u76ee\u5f55',

  'Target Version': '\u76ee\u6807\u7248\u672c',


  'Install / remove all detected Blender profiles': '\u5b89\u88c5 / \u79fb\u9664\u6240\u6709\u68c0\u6d4b\u5230\u7684 Blender \u914d\u7f6e',



  'All Versions': '\u6240\u6709\u7248\u672c',



  'Single Version': '\u5355\u4e2a\u7248\u672c',



  'Run Quick Check': '\u8fd0\u884c\u5feb\u901f\u68c0\u67e5',



  'One-Click Runtime Cleanup': '\u4e00\u952e\u6e05\u7406\u8fd0\u884c\u65f6',



  'Cleanup Runtime': '\u6e05\u7406\u8fd0\u884c\u65f6',
  'Runs one fast health check for ports, processes, Zen/runtime state, and bridge readiness without reinstall or rebuild work.': '\u5bf9\u7aef\u53e3\u3001\u8fdb\u7a0b\u3001Zen/\u8fd0\u884c\u72b6\u6001\u548c\u6865\u63a5\u5c31\u7eea\u60c5\u51b5\u6267\u884c\u4e00\u6b21\u5feb\u901f\u68c0\u67e5\uff0c\u4e0d\u4f1a\u89e6\u53d1\u91cd\u88c5\u6216\u91cd\u5efa\u3002',
  'Clears safe temp files, stale jobs, and runtime residue before reconnecting Blender or Unreal. Installed plugins stay untouched.': '\u5728\u91cd\u65b0\u8fde\u63a5 Blender \u6216 Unreal \u4e4b\u524d\uff0c\u6e05\u7406\u5b89\u5168\u4e34\u65f6\u6587\u4ef6\u3001\u8fc7\u671f\u4efb\u52a1\u548c\u8fd0\u884c\u6b8b\u7559\uff0c\u4e0d\u4f1a\u52a8\u5230\u5df2\u5b89\u88c5\u7684\u63d2\u4ef6\u3002',


  'Actions': '\u64cd\u4f5c',



  'Status Layers': '\u72b6\u6001\u5c42',



  'Recent Jobs': '\u6700\u8fd1\u4efb\u52a1',



  'items': '\u9879',



  'Expand': '\u5c55\u5f00',



  'Job': '\u4efb\u52a1',



  'No environment job history yet.': '\u6682\u65e0\u73af\u5883\u4efb\u52a1\u8bb0\u5f55\u3002',



  'Recent Logs': '\u6700\u8fd1\u65e5\u5fd7',



  'Scope': '\u8303\u56f4',



  'No environment log history yet.': '\u6682\u65e0\u73af\u5883\u65e5\u5fd7\u8bb0\u5f55\u3002',



  'Loading status...': '\u6b63\u5728\u52a0\u8f7d\u72b6\u6001...',



  'No project detected': '\u672a\u68c0\u6d4b\u5230\u9879\u76ee',






  'No Blender installation detected': '\u672a\u68c0\u6d4b\u5230 Blender \u5b89\u88c5',



  ' (running)': '\uff08\u8fd0\u884c\u4e2d\uff09',



  ' (plugin installed)': '\uff08\u5df2\u5b89\u88c5\u63d2\u4ef6\uff09',



  ' (safe sidecar)': '\uff08\u5b89\u5168\u65c1\u8def\uff09',



  'HMDao direct bridge is online, but Unreal has not enumerated any camera or view source yet. Bring the level viewport and active camera timeline back to the foreground, then connect once more to resume the real preview.': '\u0048\u004d\u0044\u0061\u006f\u0020\u76f4\u8fde\u6865\u5df2\u5728\u7ebf\uff0c\u4f46\u0020\u0055\u006e\u0072\u0065\u0061\u006c\u0020\u8fd8\u6ca1\u6709\u679a\u4e3e\u5230\u4efb\u4f55\u6444\u50cf\u673a\u6216\u89c6\u53e3\u6e90\u3002\u8bf7\u5c06\u5173\u5361\u89c6\u53e3\u548c\u5f53\u524d\u955c\u5934\u65f6\u95f4\u7ebf\u5207\u56de\u524d\u53f0\uff0c\u7136\u540e\u518d\u6b21\u70b9\u51fb\u8fde\u63a5\u4ee5\u6062\u590d\u5b9e\u65f6\u9884\u89c8\u3002',



  'HMDao Blender Capture has been copied into the add-ons folder, but the current visible Blender session has not loaded it yet. Enable HMDao Blender Capture in Preferences > Add-ons, then open the HMDao sidebar and click Start HMDao Capture Service.': 'HMDao Blender Capture \u5df2\u590d\u5236\u5230 add-ons \u76ee\u5f55\uff0c\u4f46\u5f53\u524d\u53ef\u89c1\u7684 Blender \u4f1a\u8bdd\u8fd8\u6ca1\u6709\u52a0\u8f7d\u5b83\u3002\u8bf7\u5728 Preferences > Add-ons \u4e2d\u542f\u7528 HMDao Blender Capture\uff0c\u7136\u540e\u6253\u5f00 HMDao \u4fa7\u680f\u5e76\u70b9\u51fb Start HMDao Capture Service\u3002',



  'HMDao Unreal Capture has been copied into the project, but it has not been enabled manually in the Unreal plugin list yet. Open Plugins, check HMDao Unreal Capture, and restart Unreal once.': 'HMDao Unreal Capture \u5df2\u590d\u5236\u5230\u9879\u76ee\u4e2d\uff0c\u4f46\u8fd8\u6ca1\u6709\u5728 Unreal \u63d2\u4ef6\u5217\u8868\u91cc\u624b\u52a8\u542f\u7528\u3002\u8bf7\u6253\u5f00 Plugins\uff0c\u52fe\u9009 HMDao Unreal Capture\uff0c\u5e76\u91cd\u542f\u4e00\u6b21 Unreal\u3002',



  'Runs a fast, non-destructive health check for ports, processes, Zen/runtime state, and bridge readiness without triggering reinstall or rebuild work.': '\u6267\u884c\u4e00\u6b21\u5feb\u901f\u3001\u65e0\u7834\u574f\u6027\u7684\u5065\u5eb7\u68c0\u67e5\uff0c\u8986\u76d6\u7aef\u53e3\u3001\u8fdb\u7a0b\u3001Zen/\u8fd0\u884c\u65f6\u72b6\u6001\u548c\u6865\u63a5\u5c31\u7eea\u60c5\u51b5\uff0c\u4e0d\u4f1a\u89e6\u53d1\u91cd\u88c5\u6216\u91cd\u5efa\u3002',



  'Clears safe caches, temp files, and stale jobs before reconnecting Blender or Unreal. Installed plugins remain untouched.': '\u5728\u91cd\u65b0\u8fde\u63a5 Blender \u6216 Unreal \u4e4b\u524d\uff0c\u6e05\u7406\u5b89\u5168\u7f13\u5b58\u3001\u4e34\u65f6\u6587\u4ef6\u548c\u8fc7\u671f\u4efb\u52a1\uff0c\u4e0d\u4f1a\u52a8\u5230\u5df2\u5b89\u88c5\u7684\u63d2\u4ef6\u3002',



};







export const DCC_PANEL_ZH_REGEX: Array<[RegExp, string]> = [



  [/^(\d+) leftover HMDao backup copy\/copies are still inside Unreal's plugin scan roots\. Clean them up before the next connect or recording check\.$/, '\u4ecd\u6709 $1 \u4e2a HMDao \u5907\u4efd\u526f\u672c\u6b8b\u7559\u5728 Unreal \u7684\u63d2\u4ef6\u626b\u63cf\u8def\u5f84\u4e2d\u3002\u8bf7\u5728\u4e0b\u4e00\u6b21\u8fde\u63a5\u6216\u5f55\u5236\u68c0\u67e5\u524d\u5148\u6e05\u7406\u3002'],



  [/^The project still contains (\d+) stale HMDao build receipt file\(s\)\. Cleanup first so Unreal no longer mixes old plugin residue into startup checks\.$/, '\u9879\u76ee\u4e2d\u4ecd\u6709 $1 \u4e2a\u8fc7\u671f\u7684 HMDao \u6784\u5efa\u56de\u6267\u6587\u4ef6\u3002\u8bf7\u5148\u6e05\u7406\uff0c\u907f\u514d Unreal \u5728\u542f\u52a8\u68c0\u67e5\u65f6\u7ee7\u7eed\u6df7\u5165\u65e7\u63d2\u4ef6\u6b8b\u7559\u3002'],



];







export function translateDccPanelText(language: Language, zh: string, en: string) {



  if (language === 'en') return en;



  const normalizedZh = String(zh || '').trim();



  if (normalizedZh && !isBrokenDccText(normalizedZh)) return normalizedZh;



  if (DCC_PANEL_ZH_BY_EN[en]) return DCC_PANEL_ZH_BY_EN[en];



  for (const [pattern, replacement] of DCC_PANEL_ZH_REGEX) {



    if (pattern.test(en)) return en.replace(pattern, replacement);



  }



  const mapped = localizeDccDynamicText(en, 'zh', '');



  if (mapped && mapped !== en) return mapped;



  return en;



}











export function isStaleOnlineActionMessage(



  engine: DccEngine,



  status: DccPluginStatusResponse['engines']['unreal'] | DccPluginStatusResponse['engines']['blender'] | null,



  message: string,



) {



  const normalized = String(message || '').trim().toLowerCase();



  if (!normalized || !status) return false;



  if (engine === 'unreal' && status.id === 'unreal') {



    const offline = !status.host.targetProjectRunning || !status.plugin.directBridgeReadyForTargetProject;



    if (!offline) return false;



    return /already online|direct bridge is ready|launch pid:|streaming real camera data|accepted the hmdao on-demand connect request|hmdao direct bridge is online/.test(normalized);



  }



  if (engine === 'blender' && status.id === 'blender') {



    const offline = !status.plugin.serviceReachable || !status.plugin.readyForLiveCapture;



    if (!offline) return false;



    return /capture service is now online|real preview is ready|started hmdao capture|accepted the hmdao on-demand start request|running blender session started hmdao capture/.test(normalized);



  }



  return false;



}







export function isUnrealCompatOnlyText(value: string | undefined | null) {



  return /pixel streaming|remote control|sequencer|movie render queue|mrq|official capture|official unreal capture|compatibility[- ]mode offline export/i.test(String(value || ''));



}







export function shouldShowUnrealLayer(layer: DccPluginLayer, engine: DccEngine) {



  if (engine !== 'unreal' || SHOW_UNREAL_COMPAT_MODE) return true;



  return !UNREAL_COMPAT_LAYER_KEYS.has(String(layer.key || ''))



    && !isUnrealCompatOnlyText(layer.label)



    && !isUnrealCompatOnlyText(layer.detail);



}







export function shouldShowUnrealNote(note: string, engine: DccEngine) {



  if (engine !== 'unreal' || SHOW_UNREAL_COMPAT_MODE) return true;



  return !isUnrealCompatOnlyText(note);



}







export function getUnrealRuntimeBadges(



  status: UnrealPluginStatus | null,



  t: Translate,



) {



  if (!status) return [];



  const hasDuplicateInstall = Boolean(status.plugin.duplicateInstall);



  const hasShadowCopies = Number(status.plugin.engineShadowCopies || 0) > 0;



  const staleReceiptCount = Array.isArray(status.plugin.staleTargetReceiptFiles)



    ? status.plugin.staleTargetReceiptFiles.length



    : 0;



  return [



    {



      key: 'plugin',



      label: t('', 'Plugin'),



      state: status.plugin.installed



        ? (hasDuplicateInstall || hasShadowCopies || staleReceiptCount > 0 ? 'warning' : status.plugin.enabledInProject ? 'ready' : 'warning')



        : 'warning',



      value: status.plugin.installed



        ? hasDuplicateInstall



          ? t('', 'Duplicate install detected')



          : hasShadowCopies



            ? t('', 'Backup copies still visible')



            : staleReceiptCount > 0



              ? t('', 'Stale receipts need cleanup')



              : status.plugin.enabledInProject



                ? t('', 'Enabled')



                : t('', 'Copied, enable in Unreal')



        : t('', 'Not installed'),



    },



    {



      key: 'host',



      label: t('', 'Host'),



      state: status.host.targetProjectRunning ? 'ready' : 'warning',



      value: status.host.targetProjectRunning



        ? t('', 'Project open')



        : status.host.hostProcessRunning



          ? t('', 'Editor open, project not ready')



          : t('', 'Not running'),



    },



    {



      key: 'bridge',



      label: t('', 'Bridge'),



      state: status.plugin.directBridgeReadyForTargetProject ? 'ready' : 'warning',



      value: status.plugin.directBridgeReadyForTargetProject



        ? t('', 'Preview ready')



        : status.plugin.directBridgeOnline



          ? t('', 'Online, waiting for camera')



          : t('', 'Offline'),



    },



  ];



}







export function getUnrealInstallIssue(



  status: UnrealPluginStatus | null,



  t: Translate,



) {



  if (!status) return null;







  if (status.plugin.duplicateInstall) {



    return {



      action: 'reinstall' as const,



      buttonLabel: t('', 'Keep one install only'),



      detail: t(



        '',



        'HMDao Unreal Capture exists in both the project and engine scan paths. Keep only one scan location, otherwise Epic Games launch, bridge connect, and status detection can become inconsistent.',



      ),



      title: t('', 'Duplicate install conflict detected'),



    };



  }







  const shadowCopyCount = Number(status.plugin.engineShadowCopies || 0);



  if (shadowCopyCount > 0) {



    return {



      action: 'cleanup' as const,



      buttonLabel: t('', 'Cleanup leftover scan copies'),



      detail: t(



        '',



        `${shadowCopyCount} leftover HMDao backup copy/copies are still inside Unreal's plugin scan roots. Clean them up before the next connect or recording check.`,



      ),



      title: t('', 'Leftover plugin copies detected'),



    };



  }







  const staleReceiptCount = Array.isArray(status.plugin.staleTargetReceiptFiles)



    ? status.plugin.staleTargetReceiptFiles.length



    : 0;



  if (staleReceiptCount > 0) {



    return {



      action: 'cleanup' as const,



      buttonLabel: t('', 'Cleanup stale receipts'),



      detail: t(



        '',



        `The project still contains ${staleReceiptCount} stale HMDao build receipt file(s). Cleanup first so Unreal no longer mixes old plugin residue into startup checks.`,



      ),



      title: t('', 'Stale build receipts detected'),



    };



  }







  return null;



}







