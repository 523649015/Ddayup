import { type ReactNode, useEffect, useMemo, useState } from 'react';



import {



  AlertTriangle,



  Bot,



  Box,



  ChevronRight,



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



  fetchDccEnvironmentJobs,



  fetchDccEnvironmentLogs,



  fetchDccPluginManagerStatus,



  runDccPluginManagerAction,



  type DccEnvironmentJob,



  type DccEnvironmentLogEntry,



  type DccPluginAction,



  type DccPluginLayer,



  type DccPluginStatusResponse,



} from '@/api/dccPluginManager';



import { useUILanguage } from '@/i18n/ui';



import { isUnrealLegacyPreviewEnabled, type DccEngine } from '@/services/dcc/types';



import { isBrokenDccText as sharedIsBrokenDccText, normalizeDccRuntimePresentation, sanitizeDccVisibleText } from '@/services/dcc/runtimeState';

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';






type Language = 'zh' | 'en';



type Translate = (zh: string, en: string) => string;







const SHOW_UNREAL_COMPAT_MODE = isUnrealLegacyPreviewEnabled();



const UNREAL_COMPAT_LAYER_KEYS = new Set([



  'official-capture',



  'remote-control',



  'remote-control-startup-policy',



  'pixel-streaming',



]);



const DCC_ENVIRONMENT_MONITOR_EVENT = 'hmdao:dcc-environment-monitor';







const ENGINE_META: Record<DccEngine, { labelZh: string; labelEn: string; icon: typeof Box; accent: string }> = {



  blender: { labelZh: 'Blender', labelEn: 'Blender', icon: Box, accent: '#f59e0b' },



  unreal: { labelZh: '\u865a\u5e7b\u5f15\u64ce', labelEn: 'Unreal Engine', icon: Gamepad2, accent: '#22c55e' },



};







type UnrealPluginStatus = DccPluginStatusResponse['engines']['unreal'];



type BlenderPluginStatus = DccPluginStatusResponse['engines']['blender'];



type AnyPluginStatus = UnrealPluginStatus | BlenderPluginStatus | null;

type UnrealActionGuardState = {
  action: 'connect' | 'install' | 'reinstall';
  mode: 'info' | 'confirm';
  title: string;
  description: string;
  details: string[];
  confirmLabel?: string;
};

type DiagnosticPanelItem = {


  key: string;



  label: string;



  state: 'ready' | 'warning' | 'error' | 'waiting' | 'idle';



  summary: string;



  detail: string;



  nextStep?: string;



  action?: DccPluginAction | null;



  actionLabel?: string;



};



type StatusActionBanner = {



  tone: 'ready' | 'warning' | 'error' | 'waiting' | 'idle';



  reason: string;



  nextStep?: string;



  action?: DccPluginAction | null;



  actionLabel?: string;



};







const EXACT_ZH_MAP: Record<string, string> = {



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







const REGEX_REPLACEMENTS: Array<[RegExp, string]> = [



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







function isBrokenDccText(value: string | undefined | null) {



  return sharedIsBrokenDccText(value);



}







function localizeDccDynamicText(value: string | undefined | null, language: Language, fallback = '') {



  const raw = String(value || '').trim();



  if (!raw) return fallback;



  const normalized = raw.replace(/^"|"$/g, '').trim();



  if (language === 'en') return isBrokenDccText(normalized) ? fallback : normalized;



  const mapped = EXACT_ZH_MAP[normalized] || REGEX_REPLACEMENTS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), normalized);



  if (mapped && !isBrokenDccText(mapped)) return mapped;



  if (!isBrokenDccText(normalized)) return normalized;



  return fallback;



}







function getEngineDisplayLabel(engine: DccEngine, t: Translate) {



  const meta = ENGINE_META[engine];



  return t(meta.labelZh, meta.labelEn);



}







function getAdapterFallbackLabel(engine: DccEngine, t: Translate) {



  return engine === 'unreal' ? t('', 'Unreal Plugin Adapter') : t('', 'Blender Plugin Adapter');



}







function localizeAdapterLabel(value: string | undefined | null, engine: DccEngine, language: Language, t: Translate) {



  const raw = String(value || '').trim();



  const fallback = getAdapterFallbackLabel(engine, t);



  if (!raw || isBrokenDccText(raw)) return fallback;



  if (/dcc-environment-manager/i.test(raw)) return t('', 'DCC Environment Manager');



  if (/unrealpluginadapter/i.test(raw)) return t('', 'Unreal Plugin Adapter');



  if (/blenderpluginadapter/i.test(raw)) return t('', 'Blender Plugin Adapter');



  return localizeDccDynamicText(raw, language, fallback);



}







function getUnrealSummaryFallback(status: UnrealPluginStatus | null, t: Translate) {

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







function getBlenderSummaryFallback(status: BlenderPluginStatus | null, t: Translate) {



  if (!status) return t('', 'Loading status...');



  if (status.plugin.readyForLiveCapture) return t('', 'Blender capture service is ready for live preview.');



  if (status.plugin.serviceReachable) return t('', 'Blender capture service is online and waiting for live capture readiness.');



  if ((status.host.runningHosts?.length || 0) > 0) return t('', 'Blender is running and waiting for HMDao Capture Service to start.');



  if (status.plugin.installedVersions.length > 0) return t('', 'The Blender plugin is installed. Start Blender and connect.');



  return t('', 'Blender plugin install was not detected yet. Install first.');



}







function getEngineSummaryFallback(engine: DccEngine, status: AnyPluginStatus, t: Translate) {



  return engine === 'unreal' ? getUnrealSummaryFallback(status && status.id === 'unreal' ? status : null, t) : getBlenderSummaryFallback(status && status.id === 'blender' ? status : null, t);



}







function sanitizeOptionLabel(label: string | undefined | null, fallback: string, language: Language) {

  return localizeDccDynamicText(label, language, fallback) || fallback;

}

function normalizeWindowsPathKey(value: string | undefined | null) {

  return String(value || '').replace(/\//g, '\\').trim().toLowerCase();

}

function getParentWindowsPath(filePath: string | undefined | null) {

  const normalized = String(filePath || '').trim();

  return normalized ? normalized.replace(/[\\/][^\\/]+$/, '') : '';

}

function pluginLevelClasses(level: string) {


  if (level === 'ready') return 'border-[#2f6f4f] bg-[#123021] text-[#baf4ce]';



  if (level === 'error') return 'border-[#6a3737] bg-[#2a1717] text-[#ffd0d0]';



  return 'border-[#5d4d2b] bg-[#241f13] text-[#f6df9a]';



}







function pluginLayerDotClasses(state: string) {



  if (state === 'ready') return 'bg-[#4ade80]';



  if (state === 'error') return 'bg-[#f87171]';



  return 'bg-[#facc15]';



}







function pluginActionLabel(action: string, t: Translate) {

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



function pluginActionDescription(action: string, t: Translate) {

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


function pluginActionIcon(action: DccPluginAction) {



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







function jobStatusClasses(status: string) {



  if (status === 'completed') return 'border-[#2f6f4f] bg-[#123021] text-[#baf4ce]';



  if (status === 'failed') return 'border-[#6a3737] bg-[#2a1717] text-[#ffd0d0]';



  if (status === 'running') return 'border-[#365269] bg-[#172532] text-[#c8e7ff]';



  return 'border-[#4e4327] bg-[#241f13] text-[#f6df9a]';



}







function jobStatusLabel(status: string, t: Translate) {



  if (status === 'completed') return t('', 'Completed');



  if (status === 'failed') return t('', 'Failed');



  if (status === 'running') return t('', 'Running');



  if (status === 'queued') return t('', 'Queued');



  if (status === 'pending') return t('', 'Pending');



  return status;



}







function logLevelClasses(level: string) {



  if (level === 'error') return 'text-[#ffcbcb]';



  if (level === 'warn') return 'text-[#f6df9a]';



  return 'text-[#c9f2de]';



}







function logLevelLabel(level: string, t: Translate) {



  if (level === 'error') return t('', 'Error');



  if (level === 'warn') return t('', 'Warn');



  if (level === 'info') return t('', 'Info');



  return level.toUpperCase();



}







function formatEnvironmentTime(value: string | undefined | null, language: Language) {



  if (!value) return '';



  const date = new Date(value);



  if (Number.isNaN(date.getTime())) return value;



  return date.toLocaleString(language === 'en' ? 'en-US' : 'zh-CN', { hour12: false });



}







function formatLogContext(context?: Record<string, unknown> | null) {



  if (!context) return '';



  try {



    return JSON.stringify(context, null, 2);



  } catch {



    return String(context);



  }



}











function dedupeRuntimeItems<T extends { dedupeKey?: string | null; id: string }>(items: T[]) {



  const seen = new Set<string>();



  return items.filter((item) => {



    const key = String(item.dedupeKey || item.id);



    if (seen.has(key)) return false;



    seen.add(key);



    return true;



  });



}







function runtimeStageToneClasses(state: string) {



  if (state === 'ready') return 'border-[#2f6f4f] bg-[#123021] text-[#baf4ce]';



  if (state === 'error') return 'border-[#6a3737] bg-[#2a1717] text-[#ffd0d0]';



  if (state === 'warning') return 'border-[#5d4d2b] bg-[#241f13] text-[#f6df9a]';



  if (state === 'waiting') return 'border-[#365269] bg-[#172532] text-[#c8e7ff]';



  return 'border-[#30363d] bg-[#161b22] text-[#9da7b3]';



}







function runtimeStageStateLabel(state: string, t: Translate) {



  if (state === 'ready') return t('\u5df2\u5b8c\u6210', 'Completed');



  if (state === 'error') return t('\u5f02\u5e38', 'Issue');



  if (state === 'warning') return t('\u9700\u5904\u7406', 'Attention');



  if (state === 'waiting') return t('\u8fdb\u884c\u4e2d', 'In Progress');



  return t('\u5f85\u68c0\u67e5', 'Pending');



}







function normalizeDiagnosticState(value: string | undefined | null): DiagnosticPanelItem['state'] {



  if (value === 'ready' || value === 'warning' || value === 'error' || value === 'waiting') return value;



  return 'idle';



}







function diagnosticStateLabel(state: DiagnosticPanelItem['state'], t: Translate) {



  if (state === 'ready') return t('\u5df2\u7a33\u5b9a', 'Ready');



  if (state === 'warning') return t('\u9700\u5904\u7406', 'Attention');



  if (state === 'error') return t('\u5f02\u5e38', 'Issue');



  if (state === 'waiting') return t('\u7b49\u5f85\u4e2d', 'Waiting');



  return t('\u5f85\u68c0\u67e5', 'Pending');



}







function findLayerByKey(layers: DccPluginLayer[] | undefined, keys: string[]) {



  return (layers || []).find((layer) => keys.includes(String(layer.key || ''))) || null;



}







function localizeLayerDetail(layer: DccPluginLayer | null, language: Language, fallback: string) {



  return localizeDccDynamicText(layer?.detail, language, fallback) || fallback;



}







function getUnrealStartupDiagnostics(
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
function getBlenderStartupDiagnostics(

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



function diagnosticStateRank(state: DiagnosticPanelItem['state']) {



  if (state === 'error') return 0;



  if (state === 'warning') return 1;



  if (state === 'waiting') return 2;



  if (state === 'ready') return 3;



  return 4;



}







function getTopStatusBanner({



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







function runtimeStageSteps(_engine: DccEngine, currentStage: string, currentState: string, t: Translate) {



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







const DCC_PANEL_ZH_BY_EN: Record<string, string> = {



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







const DCC_PANEL_ZH_REGEX: Array<[RegExp, string]> = [



  [/^(\d+) leftover HMDao backup copy\/copies are still inside Unreal's plugin scan roots\. Clean them up before the next connect or recording check\.$/, '\u4ecd\u6709 $1 \u4e2a HMDao \u5907\u4efd\u526f\u672c\u6b8b\u7559\u5728 Unreal \u7684\u63d2\u4ef6\u626b\u63cf\u8def\u5f84\u4e2d\u3002\u8bf7\u5728\u4e0b\u4e00\u6b21\u8fde\u63a5\u6216\u5f55\u5236\u68c0\u67e5\u524d\u5148\u6e05\u7406\u3002'],



  [/^The project still contains (\d+) stale HMDao build receipt file\(s\)\. Cleanup first so Unreal no longer mixes old plugin residue into startup checks\.$/, '\u9879\u76ee\u4e2d\u4ecd\u6709 $1 \u4e2a\u8fc7\u671f\u7684 HMDao \u6784\u5efa\u56de\u6267\u6587\u4ef6\u3002\u8bf7\u5148\u6e05\u7406\uff0c\u907f\u514d Unreal \u5728\u542f\u52a8\u68c0\u67e5\u65f6\u7ee7\u7eed\u6df7\u5165\u65e7\u63d2\u4ef6\u6b8b\u7559\u3002'],



];







function translateDccPanelText(language: Language, zh: string, en: string) {



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











function isStaleOnlineActionMessage(



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







function isUnrealCompatOnlyText(value: string | undefined | null) {



  return /pixel streaming|remote control|sequencer|movie render queue|mrq|official capture|official unreal capture|compatibility[- ]mode offline export/i.test(String(value || ''));



}







function shouldShowUnrealLayer(layer: DccPluginLayer, engine: DccEngine) {



  if (engine !== 'unreal' || SHOW_UNREAL_COMPAT_MODE) return true;



  return !UNREAL_COMPAT_LAYER_KEYS.has(String(layer.key || ''))



    && !isUnrealCompatOnlyText(layer.label)



    && !isUnrealCompatOnlyText(layer.detail);



}







function shouldShowUnrealNote(note: string, engine: DccEngine) {



  if (engine !== 'unreal' || SHOW_UNREAL_COMPAT_MODE) return true;



  return !isUnrealCompatOnlyText(note);



}







function getUnrealRuntimeBadges(



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







function getUnrealInstallIssue(



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







export function DccEnvironmentPanel() {



  const { language } = useUILanguage();



  const t = useMemo<Translate>(() => (zh, en) => translateDccPanelText(language, zh, en), [language]);



  const [selectedEngine, setSelectedEngine] = useState<DccEngine>('unreal');



  const [pluginStatus, setPluginStatus] = useState<DccPluginStatusResponse | null>(null);



  const [pluginStatusLoading, setPluginStatusLoading] = useState(false);



  const [pluginStatusError, setPluginStatusError] = useState('');



  const [pluginActionLoading, setPluginActionLoading] = useState<DccPluginAction | ''>('');



  const [pluginActionMessage, setPluginActionMessage] = useState('');



  const [pluginActionMessageEngine, setPluginActionMessageEngine] = useState<DccEngine | null>(null);



  const [environmentJobs, setEnvironmentJobs] = useState<DccEnvironmentJob[]>([]);



  const [environmentLogs, setEnvironmentLogs] = useState<DccEnvironmentLogEntry[]>([]);



  const [selectedUnrealProjectPath, setSelectedUnrealProjectPath] = useState('');



  const [selectedUnrealEngineRoot, setSelectedUnrealEngineRoot] = useState('');



  const [selectedBlenderVersion, setSelectedBlenderVersion] = useState('');



  const [blenderAllVersions, setBlenderAllVersions] = useState(false);



  const [unrealAutoBuild, setUnrealAutoBuild] = useState(false);

  const [unrealActionGuard, setUnrealActionGuard] = useState<UnrealActionGuardState | null>(null);

  const [hasLoadedStatus, setHasLoadedStatus] = useState(false);


  const [statusWatchUntil, setStatusWatchUntil] = useState(0);

  const [runtimeDetailsExpanded, setRuntimeDetailsExpanded] = useState(false);

  const [statusLayersExpanded, setStatusLayersExpanded] = useState(false);

  const [startupDiagnosticsExpanded, setStartupDiagnosticsExpanded] = useState(false);






  const selectedStatus = pluginStatus?.engines[selectedEngine] || null;



  const manager = pluginStatus?.manager || null;







  const engineJobs = useMemo(



    () => dedupeRuntimeItems(environmentJobs.filter((item) => item.engine === selectedEngine)),



    [environmentJobs, selectedEngine],



  );



  const engineLogs = useMemo(



    () => dedupeRuntimeItems(environmentLogs.filter((item) => !item.engine || item.engine === selectedEngine)),



    [environmentLogs, selectedEngine],



  );







  useEffect(() => {



    const unrealStatus = pluginStatus?.engines.unreal;

    if (!unrealStatus) return;

    const preferredEngineRoot = unrealStatus.host.resolvedEngineRoot || unrealStatus.host.engineInstalls[0]?.engineRoot || '';


    if (!selectedUnrealProjectPath) {



      setSelectedUnrealProjectPath(unrealStatus.project?.path || unrealStatus.projects[0]?.path || '');



    } else if (!unrealStatus.projects.some((item) => item.path === selectedUnrealProjectPath) && unrealStatus.project?.path) {



      setSelectedUnrealProjectPath(unrealStatus.project.path);



    }



    if (!selectedUnrealEngineRoot) {



      setSelectedUnrealEngineRoot(preferredEngineRoot);


    } else if (!unrealStatus.host.engineInstalls.some((item) => item.engineRoot === selectedUnrealEngineRoot)) {



      setSelectedUnrealEngineRoot(preferredEngineRoot);

    } else if (

      unrealStatus.host.targetProjectRunning

      && preferredEngineRoot

      && normalizeWindowsPathKey(selectedUnrealEngineRoot) !== normalizeWindowsPathKey(preferredEngineRoot)

    ) {



      setSelectedUnrealEngineRoot(preferredEngineRoot);

    }


  }, [pluginStatus?.engines.unreal, selectedUnrealEngineRoot, selectedUnrealProjectPath]);






  useEffect(() => {



    const blenderStatus = pluginStatus?.engines.blender;



    if (!blenderStatus) return;



    if (!selectedBlenderVersion) {



      setSelectedBlenderVersion(blenderStatus.host.versions[0]?.version || blenderStatus.host.installations[0]?.version || '');



    } else if (



      !blenderStatus.host.versions.some((item) => item.version === selectedBlenderVersion)



      && !blenderStatus.host.installations.some((item) => item.version === selectedBlenderVersion)



    ) {



      setSelectedBlenderVersion(blenderStatus.host.versions[0]?.version || blenderStatus.host.installations[0]?.version || '');



    }



  }, [pluginStatus?.engines.blender, selectedBlenderVersion]);







  useEffect(() => {



    if (pluginActionLoading || !pluginActionMessage || pluginActionMessageEngine !== selectedEngine) return;



    if (isStaleOnlineActionMessage(selectedEngine, selectedStatus, pluginActionMessage)) {



      setPluginActionMessage('');



      setPluginActionMessageEngine(null);



    }



  }, [pluginActionLoading, pluginActionMessage, pluginActionMessageEngine, selectedEngine, selectedStatus]);







  async function loadPluginManagerSnapshot(force = false, engine: DccEngine = selectedEngine) {


    setPluginStatusLoading(true);



    setPluginStatusError('');



    setHasLoadedStatus(true);



    try {



      const [next, jobs, logs] = await Promise.all([



        fetchDccPluginManagerStatus(force, engine),


        fetchDccEnvironmentJobs(),



        fetchDccEnvironmentLogs(),



      ]);



      setPluginStatus(next);



      setEnvironmentJobs(jobs);



      setEnvironmentLogs(logs);



    } catch (error) {



      setPluginStatusError(error instanceof Error ? error.message : String(error));



    } finally {



      setPluginStatusLoading(false);



    }



  }







  async function requestStatusProbe(options?: { force?: boolean; watchMs?: number; engine?: DccEngine }) {

    const force = Boolean(options?.force);

    const watchMs = Number(options?.watchMs || 0);

    const probeEngine = options?.engine || selectedEngine;

    if (options?.engine) {


      setSelectedEngine(options.engine);



    }

    setStatusWatchUntil(watchMs > 0 ? Date.now() + watchMs : 0);

    await loadPluginManagerSnapshot(force, probeEngine);


  }







  useEffect(() => {



    if (statusWatchUntil <= Date.now()) return undefined;



    const timer = window.setInterval(() => {



      if (Date.now() >= statusWatchUntil) {



        setStatusWatchUntil(0);



        window.clearInterval(timer);



        return;



      }



      void loadPluginManagerSnapshot(false, selectedEngine);


    }, 5000);



    return () => window.clearInterval(timer);



  }, [selectedEngine, statusWatchUntil]);






  useEffect(() => {



    if (typeof window === 'undefined') return undefined;



    const handleMonitor = (event: Event) => {



      const detail = (event as CustomEvent<{ engine?: DccEngine; reason?: 'connect' | 'failure' }>).detail || {};



      const nextEngine = detail.engine === 'blender' ? 'blender' : detail.engine === 'unreal' ? 'unreal' : undefined;



      const failed = detail.reason === 'failure';



      if (failed) {

        setRuntimeDetailsExpanded(true);

        setStatusLayersExpanded(true);

        setStartupDiagnosticsExpanded(true);

      }


      void requestStatusProbe({



        force: failed,



        watchMs: failed ? 24000 : 18000,



        engine: nextEngine,



      });



    };



    window.addEventListener(DCC_ENVIRONMENT_MONITOR_EVENT, handleMonitor as EventListener);



    return () => window.removeEventListener(DCC_ENVIRONMENT_MONITOR_EVENT, handleMonitor as EventListener);



  }, []);







  async function refreshPluginManager(force = true) {

    await requestStatusProbe({ force, watchMs: 18000 });

  }

  useEffect(() => {

    if (hasLoadedStatus) return;

    void requestStatusProbe({ force: true, watchMs: 12000, engine: selectedEngine });

  }, [hasLoadedStatus, selectedEngine]);

  async function executeRunAction(action: DccPluginAction) {


    setPluginActionLoading(action);



    setPluginStatusError('');



    setPluginActionMessage('');



    setPluginActionMessageEngine(null);



    try {



      const actionEngine = selectedEngine;



      const payload: Parameters<typeof runDccPluginManagerAction>[0] = selectedEngine === 'unreal'



        ? {



          engine: selectedEngine,



          action,



          projectPath: selectedUnrealProjectPath || undefined,



          engineRoot: selectedUnrealEngineRoot || undefined,



          build: action === 'rebuild'



            ? true



            : (action === 'install' || action === 'reinstall')



              ? unrealAutoBuild



              : undefined,



          installScope: action === 'rebuild'



            ? (selectedUnrealEngineRoot ? 'engine' : 'project')



            : (action === 'install' || action === 'reinstall')



              ? (unrealAutoBuild && selectedUnrealEngineRoot ? 'engine' : 'project')



              : undefined,



          engineLevel: action === 'rebuild'



            ? Boolean(selectedUnrealEngineRoot)



            : (action === 'install' || action === 'reinstall')



              ? Boolean(unrealAutoBuild && selectedUnrealEngineRoot)



              : undefined,



        }



        : {



          engine: selectedEngine,



          action,



          version: selectedBlenderVersion || undefined,



          allVersions: blenderAllVersions,



        };



      const result = await runDccPluginManagerAction(payload);



      setPluginStatus(result.status);



      setPluginActionMessage(result.message);



      setPluginActionMessageEngine(actionEngine);



      const [jobs, logs] = await Promise.all([



        fetchDccEnvironmentJobs(),



        fetchDccEnvironmentLogs(),



      ]);



      setEnvironmentJobs(jobs);



      setEnvironmentLogs(logs);



      if (action === 'connect') {



        setHasLoadedStatus(true);



        setStatusWatchUntil(Date.now() + 18000);



      }



    } catch (error) {



      const message = error instanceof Error ? error.message : String(error);



      setPluginStatusError(message);



      setPluginActionMessage(message);



      setPluginActionMessageEngine(selectedEngine);



      if (action === 'connect') {



        setRuntimeDetailsExpanded(true);



        setStatusLayersExpanded(true);



        setHasLoadedStatus(true);



        setStatusWatchUntil(Date.now() + 24000);



      }



    } finally {



      setPluginActionLoading('');



    }



  }

  function openUnrealActionGuard(guard: UnrealActionGuardState) {

    setUnrealActionGuard(guard);
    setPluginActionMessage(guard.description);
    setPluginActionMessageEngine('unreal');
    setPluginStatusError(guard.mode === 'info' ? guard.description : '');

    if (guard.action === 'connect') {

      setRuntimeDetailsExpanded(true);
      setStatusLayersExpanded(true);

    }

  }

  async function handleRunAction(action: DccPluginAction) {

    if (selectedEngine !== 'unreal' || !unrealStatus) {

      await executeRunAction(action);
      return;

    }

    if (action === 'connect') {

      if (!selectedUnrealProjectPath) {

        openUnrealActionGuard({
          action,
          mode: 'info',
          title: t('', 'Select a Unreal project first'),
          description: t('', 'Connect needs a specific .uproject. Pick the target project first, then open that same project in Unreal.'),
          details: [
            `${t('', 'Current project')}: ${t('', 'No .uproject selected')}`,
            `${t('', 'Detected engine')}: ${selectedUnrealEngineInstall?.version || selectedUnrealEngineInstall?.label || t('', 'No engine detected')}`,
          ],
        });
        return;

      }

      if (!unrealStatus.host.hostProcessRunning) {

        openUnrealActionGuard({
          action,
          mode: 'info',
          title: t('', 'Open the selected project before connecting'),
          description: t('', 'The Unreal editor is not running yet. Open the selected project in a visible Unreal window first, then come back and connect.'),
          details: [
            `${t('', 'Target project')}: ${selectedUnrealProjectPath}`,
            `${t('', 'Expected engine')}: ${selectedUnrealEngineInstall?.version || selectedUnrealEngineInstall?.label || t('', 'No engine detected')}`,
          ],
        });
        return;

      }

      if (!unrealStatus.host.targetProjectRunning) {

        openUnrealActionGuard({
          action,
          mode: 'info',
          title: t('', 'Wait until Unreal finishes opening the project'),
          description: t('', 'Unreal has started, but the selected project is not fully open yet. Wait for the project window and level to finish loading, then click Connect again.'),
          details: [
            `${t('', 'Target project')}: ${selectedUnrealProjectPath}`,
            `${t('', 'Detected editor')}: ${unrealStatus.host.resolvedEngineVersion || selectedUnrealEngineInstall?.version || selectedUnrealEngineInstall?.label || t('', 'Unreal is starting')}`,
          ],
        });
        return;

      }

    }

    if (action === 'install' || action === 'reinstall') {

      openUnrealActionGuard({
        action,
        mode: 'confirm',
        title: action === 'install'
          ? t('', 'Confirm Unreal plugin install')
          : t('', 'Confirm Unreal plugin reinstall'),
        description: unrealInstallScope === 'engine'
          ? t('', 'This will prepare the shared HMDao Unreal plugin for the selected Unreal version.')
          : t('', 'This will copy HMDao Unreal Capture only into the selected project.'),
        details: unrealInstallScope === 'engine'
          ? [
            `${t('', 'Unreal version')}: ${selectedUnrealEngineInstall?.version || selectedUnrealEngineInstall?.label || t('', 'No engine detected')}`,
            `${t('', 'Engine root')}: ${selectedUnrealEngineRoot || t('', 'No engine root selected')}`,
            `${t('', 'Install target')}: ${unrealEnginePluginTarget}`,
          ]
          : [
            `${t('', 'Target project')}: ${selectedUnrealProjectPath || t('', 'No .uproject selected')}`,
            `${t('', 'Install target')}: ${unrealProjectPluginTarget}`,
            `${t('', 'Selected Unreal version')}: ${selectedUnrealEngineInstall?.version || selectedUnrealEngineInstall?.label || t('', 'No engine detected')}`,
          ],
        confirmLabel: action === 'install' ? t('', 'Install now') : t('', 'Reinstall now'),
      });
      return;

    }

    await executeRunAction(action);

  }






  const layers = selectedStatus?.layers || [];



  const notes = selectedStatus?.notes || [];



  const actionButtons = selectedStatus?.actions || ['detect', 'connect', 'install', 'reinstall', 'rebuild', 'repair', 'cleanup', 'remove', 'rollback'];



  const cleanupAvailable = actionButtons.includes('cleanup');



  const repairAvailable = actionButtons.includes('repair');



  const primaryActionButtons = actionButtons.filter((action) => action !== 'cleanup' && action !== 'repair');



  const unrealStatus = selectedEngine === 'unreal' && selectedStatus?.id === 'unreal' ? selectedStatus : null;



  const blenderStatus = selectedEngine === 'blender' && selectedStatus?.id === 'blender' ? selectedStatus : null;







  const localizedLayers = useMemo(



    () => layers



      .filter((layer) => shouldShowUnrealLayer(layer, selectedEngine))



      .map((layer) => ({



        ...layer,



        label: localizeDccDynamicText(layer.label, language, layer.key),



        detail: localizeDccDynamicText(layer.detail, language, ''),



      })),



    [language, layers, selectedEngine],



  );



  const localizedNotes = useMemo(



    () => notes



      .filter((note) => shouldShowUnrealNote(note, selectedEngine))



      .map((note) => localizeDccDynamicText(note, language, ''))



      .filter(Boolean),



    [language, notes, selectedEngine],



  );



  const selectedEngineDataAttributes = useMemo<Record<string, string | undefined>>(() => {
    if (selectedEngine === 'unreal') {
      return {
        'data-direct-bridge-online': String(Boolean(unrealStatus?.plugin.directBridgeOnline)),
        'data-direct-bridge-ready': String(Boolean(unrealStatus?.plugin.directBridgeReadyForTargetProject)),
        'data-camera-count': String(unrealStatus?.plugin.cameraCount || 0),
        'data-plugin-installed': String(Boolean(unrealStatus?.plugin.installed)),
        'data-plugin-enabled': String(Boolean(unrealStatus?.plugin.enabledInProject)),
        'data-duplicate-install': String(Boolean(unrealStatus?.plugin.duplicateInstall)),
        'data-engine-shadow-copies': String(Number(unrealStatus?.plugin.engineShadowCopies || 0)),
        'data-stale-receipts': String(Array.isArray(unrealStatus?.plugin.staleTargetReceiptFiles) ? unrealStatus.plugin.staleTargetReceiptFiles.length : 0),
        'data-host-running': String(Boolean(unrealStatus?.host.hostProcessRunning)),
        'data-target-project-running': String(Boolean(unrealStatus?.host.targetProjectRunning)),
        'data-startup-probe-category': String(unrealStatus?.host.startupProbe?.category || ''),
        'data-startup-probe-ran': String(Boolean(unrealStatus?.host.startupProbe?.category || unrealStatus?.host.startupProbe?.reason || unrealStatus?.host.startupProbe?.detail)),
      };
    }

    return {
      'data-service-reachable': String(Boolean(blenderStatus?.plugin.serviceReachable)),
      'data-ready-for-live-capture': String(Boolean(blenderStatus?.plugin.readyForLiveCapture)),
      'data-addon-enabled-in-running-host': String(Boolean(blenderStatus?.plugin.addonEnabledInRunningHost)),
      'data-addon-enabled-in-headless-host': String(Boolean(blenderStatus?.plugin.addonEnabledInHeadlessHost)),
      'data-startup-probe-category': String(blenderStatus?.host.startupProbe?.category || ''),
      'data-startup-probe-ran': String(Boolean(blenderStatus?.host.startupProbe?.ran)),
    };
  }, [blenderStatus, selectedEngine, unrealStatus]);
  const projectOptions = unrealStatus?.projects.length



    ? unrealStatus.projects.map((item) => ({



      value: item.path,



      label: item.running



        ? `${sanitizeOptionLabel(item.name, item.path, language)}${t('', ' (running)')}`



        : item.source === 'hmdao-sidecar'



          ? `${sanitizeOptionLabel(item.name, item.path, language)}${t('', ' (safe sidecar)')}`



          : sanitizeOptionLabel(item.name, item.path, language),



    }))



    : [{ value: selectedUnrealProjectPath || '', label: selectedUnrealProjectPath || t('', 'No project detected') }];



  const engineOptions = unrealStatus?.host.engineInstalls.length

    ? unrealStatus.host.engineInstalls.map((item) => ({


      value: item.engineRoot,



      label: sanitizeOptionLabel(item.version || item.label, item.engineRoot, language),



    }))


    : [{ value: selectedUnrealEngineRoot || '', label: selectedUnrealEngineRoot || t('', 'No engine detected') }];

  const selectedUnrealEngineInstall = useMemo(

    () => unrealStatus?.host.engineInstalls.find((item) => normalizeWindowsPathKey(item.engineRoot) === normalizeWindowsPathKey(selectedUnrealEngineRoot))
      || unrealStatus?.host.engineInstalls.find((item) => normalizeWindowsPathKey(item.engineRoot) === normalizeWindowsPathKey(unrealStatus.host.resolvedEngineRoot))
      || unrealStatus?.host.engineInstalls[0]
      || null,

    [selectedUnrealEngineRoot, unrealStatus],

  );

  const selectedUnrealProjectFolder = getParentWindowsPath(selectedUnrealProjectPath);

  const unrealInstallScope = unrealAutoBuild && selectedUnrealEngineRoot ? 'engine' : 'project';

  const unrealProjectPluginTarget = selectedUnrealProjectFolder
    ? `${selectedUnrealProjectFolder}\\Plugins\\HMDaoUnrealCapture`
    : '<ProjectFolder>\\Plugins\\HMDaoUnrealCapture';

  const unrealEnginePluginTarget = selectedUnrealEngineRoot
    ? `${selectedUnrealEngineRoot}\\Engine\\Plugins\\HMDaoUnrealCapture`
    : '<EngineRoot>\\Engine\\Plugins\\HMDaoUnrealCapture';

  const blenderOptions = blenderStatus?.host.versions.length


    ? blenderStatus.host.versions.map((item) => ({



      value: item.version,



      label: item.installed ? `${item.version}${t('', ' (plugin installed)')}` : item.version,



    }))



    : blenderStatus?.host.installations.length



      ? blenderStatus.host.installations.map((item) => ({



        value: item.version || item.label,



        label: item.version



          ? `${item.version} (${sanitizeOptionLabel(item.label, item.version, language)})`



          : sanitizeOptionLabel(item.label, item.version || t('Blender', 'Blender'), language),



      }))



      : [{ value: selectedBlenderVersion || '', label: selectedBlenderVersion || t('', 'No Blender installation detected') }];







  const directBridgeOnline = Boolean(unrealStatus?.plugin?.directBridgeOnline ?? unrealStatus?.integration?.directBridgeOnline);



  const directBridgeCameraCount = Number(unrealStatus?.plugin?.cameraCount ?? 0);



  const showDirectBridgeHint = Boolean(unrealStatus && directBridgeOnline && directBridgeCameraCount <= 0);



  const unrealManualEnablePending = Boolean(unrealStatus?.plugin?.installed && !unrealStatus?.plugin?.enabledInProject);



  const unrealInstallIssue = useMemo(() => getUnrealInstallIssue(unrealStatus, t), [unrealStatus, t]);



  const unrealRuntimeBadges = useMemo(() => getUnrealRuntimeBadges(unrealStatus, t), [unrealStatus, t]);



  const blenderManualEnablePending = Boolean(



    blenderStatus



    && blenderStatus.plugin.installedVersions.length > 0



    && (blenderStatus.host.runningHosts?.length || 0) > 0



    && !blenderStatus.plugin.addonEnabledInRunningHost,



  );



  const startupDiagnostics = useMemo(



    () => selectedEngine === 'unreal'



      ? getUnrealStartupDiagnostics(unrealStatus, language, t)



      : getBlenderStartupDiagnostics(blenderStatus, language, t),



    [blenderStatus, language, selectedEngine, t, unrealStatus],



  );







  const selectedRuntimeState = normalizeDccRuntimePresentation(selectedEngine, selectedStatus?.runtimeState || null);



  const topStatusBanner = useMemo(



    () => getTopStatusBanner({



      engine: selectedEngine,



      runtimeState: selectedRuntimeState,



      diagnostics: startupDiagnostics,



      pluginStatusError,



      hasLoadedStatus,



      t,



    }),



    [hasLoadedStatus, pluginStatusError, selectedEngine, selectedRuntimeState, startupDiagnostics, t],



  );



  const runtimeSteps = useMemo(



    () => runtimeStageSteps(selectedEngine, selectedRuntimeState.stage, selectedRuntimeState.state, t),



    [selectedEngine, selectedRuntimeState.stage, selectedRuntimeState.state, t],



  );







  return (



    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="dcc-environment-panel">



      <div className="border-b border-[#21262d] px-4 py-3">



        <div className="flex flex-wrap items-start justify-between gap-3">



          <div className="min-w-0 flex-1">



            <div className="flex items-center gap-2 text-sm font-semibold text-[#e6edf3]">



              <Bot className="h-4 w-4 shrink-0 text-[#98f0d3]" />



              <span className="break-words">{t('', 'DCC Environment Manager')}</span>



            </div>



            <p className="mt-1 max-w-full break-words text-xs leading-5 text-[#8b949e]">



              {t('', 'Environment manager + adapters + job/log runtime')}



            </p>



          </div>



          <button



            type="button"



            onClick={() => { void refreshPluginManager(true); }}



            data-testid="dcc-environment-refresh"



            className="inline-flex min-h-[38px] shrink-0 items-center gap-1 rounded-lg border border-[#30363d] px-2.5 py-1.5 text-xs text-[#c9d1d9] transition-colors hover:bg-[#21262d]"



          >



            {pluginStatusLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}



            {t('', 'Refresh')}



          </button>



        </div>







        {manager?.jobSummary ? (



          <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] md:grid-cols-4">



            <StatTile label={t('', 'Jobs')} value={String(manager.jobSummary.total)} valueClassName="text-white" />



            <StatTile label={t('', 'Running')} value={String(manager.jobSummary.running)} valueClassName="text-[#c8e7ff]" />



            <StatTile label={t('', 'Done')} value={String(manager.jobSummary.completed)} valueClassName="text-[#baf4ce]" />



            <StatTile label={t('', 'Failed')} value={String(manager.jobSummary.failed)} valueClassName="text-[#ffd0d0]" />



          </div>



        ) : null}



        <Dialog open={Boolean(unrealActionGuard)} onOpenChange={(open) => { if (!open) setUnrealActionGuard(null); }}>
          <DialogContent className="max-w-[min(92vw,560px)] border-[#30363d] bg-[#0d1117] text-[#e6edf3]">
            <DialogHeader>
              <DialogTitle>{unrealActionGuard?.title || ''}</DialogTitle>
              <DialogDescription className="text-[#9fb1c5]">
                {unrealActionGuard?.description || ''}
              </DialogDescription>
            </DialogHeader>
            {unrealActionGuard?.details.length ? (
              <div className="space-y-2 rounded-lg border border-[#21262d] bg-[#11161d] px-3 py-3 text-sm leading-6 text-[#d0d7de]">
                {unrealActionGuard.details.map((detail) => (
                  <div key={detail} className="break-words">{detail}</div>
                ))}
              </div>
            ) : null}
            <DialogFooter className="mt-2 gap-2">
              <button
                type="button"
                className="inline-flex min-h-[40px] items-center justify-center rounded-xl border border-[#30363d] bg-[#161b22] px-4 py-2 text-sm text-[#c9d1d9] transition-colors hover:bg-[#21262d]"
                onClick={() => setUnrealActionGuard(null)}
              >
                {unrealActionGuard?.mode === 'confirm' ? t('', 'Cancel') : t('', 'Close')}
              </button>
              {unrealActionGuard?.mode === 'confirm' ? (
                <button
                  type="button"
                  className="inline-flex min-h-[40px] items-center justify-center rounded-xl border border-[#2f6f59] bg-[#123126] px-4 py-2 text-sm font-semibold text-[#d7ffef] transition-colors hover:bg-[#184333]"
                  onClick={() => {
                    const guardedAction = unrealActionGuard.action;
                    setUnrealActionGuard(null);
                    void executeRunAction(guardedAction);
                  }}
                >
                  {unrealActionGuard.confirmLabel || t('', 'Continue')}
                </button>
              ) : null}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>






      <div className="flex-1 overflow-y-auto px-4 py-4">



        <div className="grid grid-cols-2 gap-3">


          {(['unreal', 'blender'] as DccEngine[]).map((engine) => {



            const engineStatus = pluginStatus?.engines[engine];



            const meta = ENGINE_META[engine];



            const EngineIcon = meta.icon;



            const isActive = selectedEngine === engine;



            return (



              <button



                key={engine}



                type="button"



                onClick={() => setSelectedEngine(engine)}



                data-testid={`dcc-environment-engine-${engine}`}



                data-engine={engine}



                data-selected={isActive ? 'true' : 'false'}



                data-level={engineStatus?.level || 'warning'}



                data-recommended-action={engineStatus?.recommendedAction || 'detect'}



                className={`min-w-0 rounded-xl border px-3 py-3 text-left transition-colors ${isActive ? 'border-[#00d4aa] bg-[#12201c]' : 'border-[#30363d] bg-[#161b22] hover:bg-[#1b222c]'}`}


              >



                <div className="flex min-w-0 flex-col gap-2">



                  <div className="min-w-0 flex-1">



                    <div className="flex items-center gap-2 text-sm font-semibold text-[#e6edf3]">



                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${meta.accent}22`, color: meta.accent }}>



                        <EngineIcon className="h-4 w-4" />



                      </span>



                      <span className="break-words">{getEngineDisplayLabel(engine, t)}</span>



                    </div>



                    <p className="mt-2 break-words text-xs leading-5 text-[#9da7b3] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] overflow-hidden">



                      {hasLoadedStatus



                        ? (localizeDccDynamicText(engineStatus?.summary, language) || t('', 'Loading status...'))



                        : t('\u70b9\u51fb\u8fde\u63a5\u6216\u5237\u65b0\u540e\u68c0\u6d4b\u5f53\u524d\u73af\u5883\u3002', 'Connect or refresh to inspect the current runtime.')}



                    </p>



                  </div>



                  <span className={`self-end max-w-[7rem] shrink-0 rounded-full px-2 py-1 text-center text-[10px] font-semibold leading-4 ${pluginLevelClasses(engineStatus?.level || 'warning')}`}>



                    {localizeDccDynamicText(engineStatus?.recommendedAction || '', language) || pluginActionLabel(engineStatus?.recommendedAction || 'detect', t)}



                  </span>



                </div>



              </button>



            );



          })}



        </div>







        <div



          className="mt-4 rounded-xl border border-[#30363d] bg-[#161b22]"



          data-testid="dcc-environment-active-engine"



          data-engine={selectedEngine}



          data-level={selectedStatus?.level || 'warning'}



          {...selectedEngineDataAttributes}



        >



          <div className="border-b border-[#21262d] px-4 py-3">



            <div className="text-sm font-semibold text-[#e6edf3]">{getEngineDisplayLabel(selectedEngine, t)}</div>



            <div className="mt-1 break-words text-xs leading-5 text-[#8b949e]">



              {`${localizeAdapterLabel(selectedStatus?.adapter?.label, selectedEngine, language, t)} ${t('', 'handles detect, connect, install, reinstall, rebuild, quick checks, cleanup, and rollback.')}`}



            </div>



          </div>







          <div className="px-4 py-4">



            <div



              className={`rounded-lg border px-3 py-2 text-xs ${runtimeStageToneClasses(topStatusBanner?.tone || (selectedStatus?.level === 'ready' ? 'ready' : 'warning'))}`}



              data-testid="dcc-environment-summary"



              data-engine={selectedEngine}



              data-level={selectedStatus?.level || 'warning'}



            >



              <div className="flex flex-wrap items-start gap-2.5">


                <div className="flex min-w-0 flex-1 items-start gap-2">



                  {(topStatusBanner?.tone || selectedStatus?.level) === 'ready' ? <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}



                  <div className="min-w-0 flex-1">



                    <div className="break-words font-semibold leading-5">{topStatusBanner?.reason || sanitizeDccVisibleText(



                      selectedRuntimeState.message,



                      hasLoadedStatus



                        ? (localizeDccDynamicText(selectedStatus?.summary, language) || t('', 'Loading plugin status...'))



                        : t('\u5c1a\u672a\u5f00\u59cb\u68c0\u6d4b\u5f53\u524d DCC \u73af\u5883\u3002\u70b9\u51fb\u8fde\u63a5\u6216\u5237\u65b0\u540e\u518d\u67e5\u770b\u72b6\u6001\u5c42\u3002', 'No status scan has run yet. Connect or refresh to inspect the environment.'),



                    )}</div>



                    {topStatusBanner?.nextStep ? <div className="mt-1 break-words text-[11px] leading-5 opacity-90">{topStatusBanner.nextStep}</div> : null}



                  </div>



                </div>



                {topStatusBanner?.action ? (



                  <button



                    type="button"



                    onClick={() => { void handleRunAction(topStatusBanner.action!); }}



                    disabled={Boolean(pluginActionLoading)}



                    className="ml-auto inline-flex min-h-[34px] shrink-0 items-center justify-center rounded-lg border border-current/20 px-3 py-1.5 text-[11px] font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"


                  >



                    {pluginActionLoading === topStatusBanner.action ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}



                    <span className={`${pluginActionLoading === topStatusBanner.action ? 'ml-1.5' : ''} whitespace-normal break-keep text-center`}>{topStatusBanner.actionLabel || pluginActionLabel(topStatusBanner.action, t)}</span>


                  </button>



                ) : null}



              </div>



            </div>







            <div className="hidden mt-3 overflow-hidden rounded-xl border border-[#30363d] bg-[#0d1117] p-3" data-testid="dcc-environment-startup-diagnostics">


              <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-[#8b949e]">



                {t('\u542f\u52a8\u8bca\u65ad', 'Startup Diagnostics')}



              </div>



              <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2">


                {startupDiagnostics.map((item) => (



                  <div



                    key={item.key}



                    className={`min-w-0 rounded-lg border px-3 py-2 ${runtimeStageToneClasses(item.state)}`}


                    data-diagnostic-key={item.key}



                    data-diagnostic-state={item.state}



                  >



                    <div className="flex items-start justify-between gap-2">



                      <div className="min-w-0 break-words text-[11px] font-semibold tracking-[0.08em] opacity-85">{item.label}</div>


                      <span className="shrink-0 rounded-full border border-current/20 px-2 py-0.5 text-[10px] font-semibold opacity-90">



                        {diagnosticStateLabel(item.state, t)}



                      </span>



                    </div>



                    <div className="mt-2 break-words text-xs font-semibold leading-5">{item.summary}</div>


                    <div className="mt-1 break-words text-[11px] leading-5 opacity-90">{item.detail}</div>


                    {item.nextStep ? <div className="mt-2 rounded-lg border border-current/15 bg-black/10 px-2.5 py-2 text-[11px] leading-5 opacity-95">{item.nextStep}</div> : null}



                    {item.action ? (



                      <button



                        type="button"



                        onClick={() => { void handleRunAction(item.action!); }}



                        disabled={Boolean(pluginActionLoading)}



                        className="mt-2 inline-flex min-h-[36px] w-full items-center justify-center rounded-lg border border-current/25 px-3 py-1.5 text-center text-[11px] font-semibold leading-5 transition-opacity hover:opacity-90 disabled:opacity-50"


                      >



                        {pluginActionLoading === item.action ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}



                        <span className={pluginActionLoading === item.action ? 'ml-1.5' : ''}>{item.actionLabel || pluginActionLabel(item.action, t)}</span>



                      </button>



                    ) : null}



                  </div>



                ))}



              </div>



            </div>







            <div className="hidden mt-3">


              <CollapsiblePanel



                title={t('\u8fd0\u884c\u9636\u6bb5', 'Runtime Details')}



                count={runtimeSteps.length}



                countLabel={t('\u6b65', 'steps')}



                open={runtimeDetailsExpanded}



                onToggle={setRuntimeDetailsExpanded}



              >



                <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2" data-testid="dcc-environment-runtime-steps">


                  {runtimeSteps.map((item) => (



                    <div key={item.key} className={`min-w-0 rounded-lg border px-3 py-2 text-[11px] ${runtimeStageToneClasses(item.state)}`}>


                      <div className="break-words tracking-[0.08em] opacity-80">{item.label}</div>


                      <div className="mt-1 break-words font-semibold">{item.key === selectedRuntimeState.stage ? selectedRuntimeState.label : runtimeStageStateLabel(item.state, t)}</div>


                    </div>



                  ))}



                </div>



              </CollapsiblePanel>



            </div>







            {unrealInstallIssue ? (



              <div



                className="mt-3 rounded-lg border border-[#6a3737] bg-[#2a1717] px-3 py-3 text-xs text-[#ffd0d0]"



                data-testid="dcc-environment-unreal-install-issue"



              >



                <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">



                  <div className="min-w-0">



                    <div className="font-semibold text-[#ffe1e1]">{unrealInstallIssue.title}</div>



                    <div className="mt-1 break-words leading-5 text-[#ffcbcb]">{unrealInstallIssue.detail}</div>



                  </div>



                  <button



                    type="button"



                    onClick={() => { void handleRunAction(unrealInstallIssue.action); }}



                    disabled={Boolean(pluginActionLoading)}



                    className="inline-flex min-h-[38px] shrink-0 items-center justify-center rounded-lg border border-[#8d4a4a] bg-[#4a2323] px-3 py-2 text-xs font-semibold text-[#ffe1e1] transition-colors hover:bg-[#5c2b2b] disabled:opacity-50"



                  >



                    {unrealInstallIssue.buttonLabel}



                  </button>



                </div>



              </div>



            ) : null}







            {unrealRuntimeBadges.length ? (



              <div className="mt-3 grid grid-cols-3 gap-2" data-testid="dcc-environment-unreal-runtime-badges">



                {unrealRuntimeBadges.map((item) => (



                  <div



                    key={item.key}



                    className="rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2"



                    data-runtime-key={item.key}



                    data-runtime-state={item.state}



                  >



                    <div className="text-[11px] uppercase tracking-[0.12em] text-[#8b949e]">{item.label}</div>



                    <div className={`mt-1 text-xs font-semibold ${pluginLevelClasses(item.state)}`}>{item.value}</div>



                  </div>



                ))}



              </div>



            ) : null}







            {showDirectBridgeHint ? (



              <div className="mt-3 rounded-lg border border-[#5d4d2b] bg-[#241f13] px-3 py-2 text-xs leading-5 text-[#f6df9a]">



                {t(



                  '\u0048\u004d\u0044\u0061\u006f\u0020\u76f4\u8fde\u6865\u5df2\u5728\u7ebf\uff0c\u4f46\u0020\u0055\u006e\u0072\u0065\u0061\u006c\u0020\u8fd8\u6ca1\u6709\u679a\u4e3e\u5230\u4efb\u4f55\u6444\u50cf\u673a\u6216\u89c6\u53e3\u6e90\u3002\u8bf7\u5c06\u5173\u5361\u89c6\u53e3\u548c\u5f53\u524d\u955c\u5934\u65f6\u95f4\u7ebf\u5207\u56de\u524d\u53f0\uff0c\u7136\u540e\u518d\u6b21\u70b9\u51fb\u8fde\u63a5\u4ee5\u6062\u590d\u5b9e\u65f6\u9884\u89c8\u3002',



                  'HMDao direct bridge is online, but Unreal has not enumerated any camera or view source yet. Bring the level viewport and active camera timeline back to the foreground, then connect once more to resume the real preview.',



                )}



                {false ? (



                  <div className="rounded-lg border border-[#5d4d2b] bg-[#241f13] px-3 py-2 text-[11px] leading-5 text-[#f6df9a]">



                    {t(



                      '',



                      'HMDao Blender Capture has been copied into the add-ons folder, but the current visible Blender session has not loaded it yet. Enable HMDao Blender Capture in Preferences > Add-ons, then open the HMDao sidebar and click Start HMDao Capture Service.',



                    )}



                  </div>



                ) : null}



              </div>



            ) : null}







            {unrealStatus ? (



              <>



                <div className="mt-3 grid grid-cols-1 gap-2 xl:grid-cols-2">



                  <PanelSelect



                    label={t('', 'Target Project')}



                    value={selectedUnrealProjectPath || projectOptions[0]?.value || ''}



                    onChange={setSelectedUnrealProjectPath}



                    options={projectOptions}



                  />



                  <PanelSelect



                    label={t('', 'Engine Root')}



                    value={selectedUnrealEngineRoot || engineOptions[0]?.value || ''}



                    onChange={setSelectedUnrealEngineRoot}



                    options={engineOptions}



                  />



                </div>



                <div className="mt-2 flex flex-col gap-2 rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2 text-xs text-[#c9d1d9] xl:flex-row xl:items-center xl:justify-between">



                  <span className="min-w-0 break-words leading-5">



                    {t('', 'Auto-build the engine-level precompiled Unreal plugin during install / reinstall')}



                  </span>



                  <TogglePill



                    active={unrealAutoBuild}



                    activeLabel={t('', 'Enabled')}



                    inactiveLabel={t('', 'Disabled')}



                    onClick={() => setUnrealAutoBuild((current) => !current)}



                  />



                </div>



                <div className="mt-2 rounded-lg bg-[#0d1117] px-3 py-2 text-[11px] leading-5 text-[#8b949e]">

                  {t('', 'Current project: ')}

                  <span className="ml-1 break-all text-[#e6edf3]">{selectedUnrealProjectPath || t('', 'No .uproject selected')}</span>

                </div>

                <div className="mt-2 rounded-lg border border-[#30363d] bg-[#11161d] px-3 py-3 text-[11px] leading-5 text-[#9fb1c5]">
                  <div className="font-semibold text-[#e6edf3]">{t('', 'Current install target')}</div>
                  <div className="mt-1">
                    {unrealInstallScope === 'engine'
                      ? t('', 'Engine-level install is selected. HMDao will prepare one shared plugin copy for the selected Unreal version.')
                      : t('', 'Project-only install is selected. HMDao will copy the plugin only into this project and will not touch other Unreal versions.')}
                  </div>
                  <div className="mt-2 break-words">
                    {t('', 'Detected Unreal version')}: <span className="text-[#e6edf3]">{selectedUnrealEngineInstall?.version || selectedUnrealEngineInstall?.label || t('', 'No engine detected')}</span>
                  </div>
                  <div className="mt-1 break-words">
                    {t('', 'Project plugin folder')}: <span className="text-[#e6edf3]">{unrealProjectPluginTarget}</span>
                  </div>
                  <div className="mt-1 break-words">
                    {t('', 'Engine plugin folder')}: <span className="text-[#e6edf3]">{unrealEnginePluginTarget}</span>
                  </div>
                </div>


                {unrealManualEnablePending ? (



                  <div className="mt-2 rounded-lg border border-[#5d4d2b] bg-[#241f13] px-3 py-2 text-[11px] leading-5 text-[#f6df9a]">



                    {t(



                      '',



                      'HMDao Unreal Capture has been copied into the project, but it has not been enabled manually in the Unreal plugin list yet. Open Plugins, check HMDao Unreal Capture, and restart Unreal once.',



                    )}



                  </div>



                ) : null}



              </>



            ) : null}







            {blenderStatus ? (



              <div className="mt-3 grid grid-cols-1 gap-2 xl:grid-cols-2">



                <PanelSelect



                  label={t('', 'Target Version')}



                  value={selectedBlenderVersion || blenderOptions[0]?.value || ''}



                  disabled={blenderAllVersions}



                  onChange={setSelectedBlenderVersion}



                  options={blenderOptions}



                />



                <div className="flex flex-col gap-2 rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2 text-xs text-[#c9d1d9] xl:flex-row xl:items-center xl:justify-between">



                  <span className="min-w-0 break-words leading-5">



                    {t('', 'Install / remove all detected Blender profiles')}



                  </span>



                  <TogglePill



                    active={blenderAllVersions}



                    activeLabel={t('', 'All Versions')}



                    inactiveLabel={t('', 'Single Version')}



                    onClick={() => setBlenderAllVersions((current) => !current)}



                  />



                </div>



                {blenderManualEnablePending ? (



                  <div className="rounded-lg border border-[#5d4d2b] bg-[#241f13] px-3 py-2 text-[11px] leading-5 text-[#f6df9a]">



                    {t(



                      '',



                      'HMDao Blender Capture has been copied into the add-ons folder, but the current visible Blender session has not loaded it yet. Enable HMDao Blender Capture in Preferences > Add-ons, then open the HMDao sidebar and click Start HMDao Capture Service.',



                    )}



                  </div>



                ) : null}



              </div>



            ) : null}







            {(repairAvailable || cleanupAvailable) ? (



              <div className="hidden mt-3 grid auto-rows-fr grid-cols-[repeat(auto-fit,minmax(260px,1fr))] items-stretch gap-3 overflow-hidden">


                {repairAvailable ? (



                  <ActionFeatureCard



                    icon={Wrench}



                    testId="dcc-environment-repair-card"



                    buttonTestId="dcc-environment-action-repair"
                    buttonDataEngine={selectedEngine}



                    title={t('', 'Quick Check')}



                    description={t(



                      '',



                      'Runs a fast, non-destructive health check for ports, processes, Zen/runtime state, and bridge readiness without triggering reinstall or rebuild work.',



                    )}



                    buttonLabel={t('', 'Run Quick Check')}



                    loading={pluginActionLoading === 'repair'}



                    disabled={Boolean(pluginActionLoading)}



                    tone="repair"



                    onClick={() => { void handleRunAction('repair'); }}



                  />



                ) : null}



                {cleanupAvailable ? (



                  <ActionFeatureCard



                    icon={Trash2}



                    testId="dcc-environment-cleanup-card"



                    buttonTestId="dcc-environment-action-cleanup"
                    buttonDataEngine={selectedEngine}



                    title={t('', 'One-Click Runtime Cleanup')}



                    description={t(



                      '',



                      'Clears safe caches, temp files, and stale jobs before reconnecting Blender or Unreal. Installed plugins remain untouched.',



                    )}



                    buttonLabel={t('', 'Cleanup Runtime')}



                    loading={pluginActionLoading === 'cleanup'}



                    disabled={Boolean(pluginActionLoading)}



                    tone="cleanup"



                    onClick={() => { void handleRunAction('cleanup'); }}



                  />



                ) : null}



              </div>



            ) : null}







            <div className="mt-3 overflow-hidden rounded-xl border border-[#30363d] bg-[#0d1117] p-3" data-testid="dcc-environment-actions">

              <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-[#8b949e]">

                {t('', 'Actions')}

              </div>

              <div className="grid grid-cols-[repeat(auto-fit,minmax(44px,56px))] justify-start gap-2">

                {primaryActionButtons.map((action) => {

                  const ActionIcon = pluginActionIcon(action);

                  const active = pluginActionLoading === action;

                  const label = pluginActionLabel(action, t);

                  const description = pluginActionDescription(action, t);

                  return (

                    <StealthActionButton

                      key={action}

                      icon={ActionIcon}

                      label={label}

                      description={description}

                      loading={active}

                      disabled={Boolean(pluginActionLoading)}

                      onClick={() => { void handleRunAction(action); }}

                      testId={`dcc-environment-action-${action}`}

                      buttonDataEngine={selectedEngine}

                      action={action}

                    />

                  );

                })}

              </div>

              <div className="mt-2 text-[10px] leading-5 text-[#6e7681]">

                {t('\u8fd9\u4e9b\u64cd\u4f5c\u9ed8\u8ba4\u5f31\u5316\u663e\u793a\uff0c\u9f20\u6807\u60ac\u505c\u56fe\u6807\u53ef\u67e5\u770b\u7528\u9014\u8bf4\u660e\u3002', 'These actions stay tucked away by default. Hover an icon to see what it does.')}

              </div>

            </div>

            {(repairAvailable || cleanupAvailable) ? (

              <div className="mt-3 grid auto-rows-fr grid-cols-[repeat(auto-fit,minmax(280px,1fr))] items-stretch gap-3 overflow-hidden">

                {repairAvailable ? (

                  <ActionFeatureCard

                    icon={Wrench}

                    testId="dcc-environment-repair-card-inline"

                    buttonTestId="dcc-environment-action-repair-inline"
                    buttonDataEngine={selectedEngine}

                    title={t('', 'Quick Check')}

                    description={t(

                      '',

                      'Runs one fast health check for ports, processes, Zen/runtime state, and bridge readiness without reinstall or rebuild work.',

                    )}

                    buttonLabel={t('', 'Run Quick Check')}

                    loading={pluginActionLoading === 'repair'}

                    disabled={Boolean(pluginActionLoading)}

                    tone="repair"

                    onClick={() => { void handleRunAction('repair'); }}

                  />

                ) : null}

                {cleanupAvailable ? (

                  <ActionFeatureCard

                    icon={Trash2}

                    testId="dcc-environment-cleanup-card-inline"

                    buttonTestId="dcc-environment-action-cleanup-inline"
                    buttonDataEngine={selectedEngine}

                    title={t('', 'Cleanup Runtime')}

                    description={t(

                      '',

                      'Clears safe temp files, stale jobs, and runtime residue before reconnecting Blender or Unreal. Installed plugins stay untouched.',

                    )}

                    buttonLabel={t('', 'Cleanup Runtime')}

                    loading={pluginActionLoading === 'cleanup'}

                    disabled={Boolean(pluginActionLoading)}

                    tone="cleanup"

                    onClick={() => { void handleRunAction('cleanup'); }}

                  />

                ) : null}

              </div>

            ) : null}






            {pluginStatusError && !topStatusBanner ? (



              <div className="mt-3 rounded-lg border border-[#6a3a3a] bg-[#2a1818] px-3 py-2 text-xs leading-5 text-[#ffcbcb]" data-testid="dcc-environment-error-message">



                {sanitizeDccVisibleText(pluginStatusError, selectedRuntimeState.message)}



              </div>



            ) : null}



            {!pluginStatusError && pluginActionMessage && pluginActionMessageEngine === selectedEngine ? (



              <div className="mt-3 rounded-lg border border-[#33453d] bg-[#16221d] px-3 py-2 text-xs leading-5 text-[#c4f4da]" data-testid="dcc-environment-action-message">



                {sanitizeDccVisibleText(pluginActionMessage, selectedRuntimeState.message)}



              </div>



            ) : null}







            <div className="mt-3" data-testid="dcc-environment-layers">


              <CollapsiblePanel



                title={t('', 'Status Layers')}



                count={localizedLayers.length}



                countLabel={t('', 'items')}



                open={statusLayersExpanded}



                onToggle={setStatusLayersExpanded}



              >



                {localizedLayers.length ? (



                  <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">



                    {localizedLayers.map((layer: DccPluginLayer) => (



                      <div



                        key={layer.key}



                        className="rounded-lg border border-[#21262d] bg-[#161b22] px-3 py-2"



                        data-testid={`dcc-environment-layer-${layer.key}`}



                        data-layer-key={layer.key}



                        data-layer-state={layer.state}



                      >



                        <div className="flex items-start gap-2 text-xs font-semibold text-[#ececec]">



                          <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${pluginLayerDotClasses(layer.state)}`} />



                          <span className="break-words leading-5">{layer.label}</span>



                        </div>



                        <div className="mt-1 break-words text-[11px] leading-5 text-[#a9a9a9]">{layer.detail}</div>



                      </div>



                    ))}



                  </div>



                ) : (



                  <div className="rounded-lg border border-[#21262d] bg-[#161b22] px-3 py-2 text-[11px] text-[#8b949e]">



                    {t('\u70b9\u51fb\u8fde\u63a5\u6216\u5237\u65b0\u540e\u663e\u793a\u72b6\u6001\u5c42\u3002', 'Status layers appear after the first connect or refresh.')}



                  </div>



                )}



              </CollapsiblePanel>



            </div>

            <div className="mt-3">

              <CollapsiblePanel

                title={t('\u542f\u52a8\u8bca\u65ad', 'Startup Diagnostics')}

                count={startupDiagnostics.length}

                countLabel={t('', 'items')}

                open={startupDiagnosticsExpanded}

                onToggle={setStartupDiagnosticsExpanded}

              >

                <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-2" data-testid="dcc-environment-startup-diagnostics-relocated">

                  {startupDiagnostics.map((item) => (

                    <div

                      key={item.key}

                      className={`min-w-0 rounded-lg border px-3 py-2 ${runtimeStageToneClasses(item.state)}`}

                      data-diagnostic-key={item.key}

                      data-diagnostic-state={item.state}

                    >

                      <div className="flex items-start justify-between gap-2">

                        <div className="min-w-0 break-words text-[11px] font-semibold tracking-[0.08em] opacity-85">{item.label}</div>

                        <span className="shrink-0 rounded-full border border-current/20 px-2 py-0.5 text-[10px] font-semibold opacity-90">

                          {diagnosticStateLabel(item.state, t)}

                        </span>

                      </div>

                      <div className="mt-2 break-words text-xs font-semibold leading-5">{item.summary}</div>

                      <div className="mt-1 break-words text-[11px] leading-5 opacity-90">{item.detail}</div>

                      {item.nextStep ? <div className="mt-2 rounded-lg border border-current/15 bg-black/10 px-2.5 py-2 text-[11px] leading-5 opacity-95">{item.nextStep}</div> : null}

                      {item.action ? (

                        <button

                          type="button"

                          onClick={() => { void handleRunAction(item.action!); }}

                          disabled={Boolean(pluginActionLoading)}

                          className="mt-2 inline-flex min-h-[36px] w-full items-center justify-center rounded-lg border border-current/25 px-3 py-1.5 text-center text-[11px] font-semibold leading-5 transition-opacity hover:opacity-90 disabled:opacity-50"

                        >

                          {pluginActionLoading === item.action ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}

                          <span className={`${pluginActionLoading === item.action ? 'ml-1.5' : ''} whitespace-normal break-keep text-center`}>{item.actionLabel || pluginActionLabel(item.action, t)}</span>

                        </button>

                      ) : null}

                    </div>

                  ))}

                </div>

              </CollapsiblePanel>

            </div>

            <div className="mt-3">

              <CollapsiblePanel

                title={t('\u8fd0\u884c\u9636\u6bb5', 'Runtime Details')}

                count={runtimeSteps.length}

                countLabel={t('\u6b65', 'steps')}

                open={runtimeDetailsExpanded}

                onToggle={setRuntimeDetailsExpanded}

              >

                <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2" data-testid="dcc-environment-runtime-steps-relocated">

                  {runtimeSteps.map((item) => (

                    <div key={item.key} className={`min-w-0 rounded-lg border px-3 py-2 text-[11px] ${runtimeStageToneClasses(item.state)}`}>

                      <div className="break-words tracking-[0.08em] opacity-80">{item.label}</div>

                      <div className="mt-1 break-words font-semibold">{item.key === selectedRuntimeState.stage ? selectedRuntimeState.label : runtimeStageStateLabel(item.state, t)}</div>

                    </div>

                  ))}

                </div>

              </CollapsiblePanel>

            </div>






            {localizedNotes.length ? (



              <div className="mt-3 rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-[11px] leading-5 text-[#9e9e9e]">



                {localizedNotes.map((note) => (



                  <div key={note} className="flex items-start gap-2">



                    <span className="text-[#76e7c9]">-</span>



                    <span className="break-words">{note}</span>



                  </div>



                ))}



              </div>



            ) : null}







            <div className="mt-3 grid grid-cols-1 gap-3">



              <CollapsiblePanel



                title={t('', 'Recent Jobs')}



                count={engineJobs.length}



                countLabel={t('', 'items')}



              >



                {engineJobs.length ? engineJobs.map((job) => (



                  <details key={job.id} className={`group rounded-lg border text-[11px] ${jobStatusClasses(job.status)}`}>



                    <summary className="flex cursor-pointer list-none flex-col gap-2 px-3 py-2">



                      <div className="flex items-start justify-between gap-2">



                        <div className="flex min-w-0 items-start gap-2">



                          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />



                          <span className="break-words font-semibold leading-5">{pluginActionLabel(job.action, t)}</span>



                        </div>



                        <span className="shrink-0">{jobStatusLabel(job.status, t)}</span>



                      </div>



                      <div className="break-words leading-5 opacity-90 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">



                        {sanitizeDccVisibleText(job.shortMessage || job.runtimeState?.message || job.message || job.title || job.id, job.title || job.id)}



                      </div>



                      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] opacity-80">



                        <span>{formatEnvironmentTime(job.endedAt || job.startedAt || job.createdAt, language)}</span>



                        <span>{t('', 'Expand')}</span>



                      </div>



                    </summary>



                    <div className="border-t border-current/20 px-3 py-3">



                      <div className="break-words leading-5">



                        {sanitizeDccVisibleText(job.message || job.runtimeState?.message || job.title || job.id, job.title || job.id)}



                      </div>



                      <div className="mt-2 break-all text-[10px] opacity-80">



                        {t('', 'Job')}: {job.id}



                      </div>



                    </div>



                  </details>



                )) : (



                  <div className="rounded-lg border border-[#21262d] bg-[#161b22] px-3 py-2 text-[11px] text-[#9e9e9e]">



                    {t('', 'No environment job history yet.')}



                  </div>



                )}



              </CollapsiblePanel>







              <CollapsiblePanel



                title={t('', 'Recent Logs')}



                count={engineLogs.length}



                countLabel={t('', 'items')}



              >



                {engineLogs.length ? engineLogs.map((entry) => {



                  const contextText = formatLogContext(entry.context);



                  return (



                    <details key={entry.id} className="group rounded-lg border border-[#21262d] bg-[#161b22] text-[11px]">



                      <summary className="cursor-pointer list-none px-3 py-2">



                        <div className="flex items-start justify-between gap-2">



                          <div className="flex min-w-0 items-center gap-2">



                            <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#8f8f8f] transition-transform group-open:rotate-90" />



                            <span className={`font-semibold ${logLevelClasses(entry.level)}`}>{logLevelLabel(entry.level, t)}</span>



                          </div>



                          <span className="shrink-0 text-[#8f8f8f]">{formatEnvironmentTime(entry.timestamp, language)}</span>



                        </div>



                        <div className="mt-1 flex items-start justify-between gap-2">



                          <div className="min-w-0 flex-1 break-words text-[#d9d9d9] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">



                            {sanitizeDccVisibleText(entry.shortMessage || entry.runtimeState?.message || entry.message, entry.message)}



                          </div>



                          <div className="shrink-0 text-[10px] text-[#8f8f8f]">{t('', 'Expand')}</div>



                        </div>



                        <div className="mt-1 break-all text-[10px] text-[#8f8f8f]">



                          {localizeAdapterLabel(entry.scope, entry.engine || selectedEngine, language, t)}



                          {entry.jobId ? ` | ${entry.jobId}` : ''}



                        </div>



                      </summary>



                      <div className="border-t border-[#21262d] px-3 py-3">



                        <div className="break-words text-[#d9d9d9]">{sanitizeDccVisibleText(entry.message, entry.shortMessage || entry.id)}</div>



                        <div className="mt-2 break-all text-[10px] text-[#8f8f8f]">



                          {t('', 'Scope')}: {localizeAdapterLabel(entry.scope, entry.engine || selectedEngine, language, t)}



                          {entry.jobId ? ` | ${t('', 'Job')}: ${entry.jobId}` : ''}



                        </div>



                        {contextText ? (



                          <pre className="mt-2 overflow-x-auto rounded-lg bg-[#0d1117] px-3 py-2 text-[10px] leading-5 text-[#b7c3d1]">{contextText}</pre>



                        ) : null}



                      </div>



                    </details>



                  );



                }) : (



                  <div className="rounded-lg border border-[#21262d] bg-[#161b22] px-3 py-2 text-[11px] text-[#9e9e9e]">



                    {t('', 'No environment log history yet.')}



                  </div>



                )}



              </CollapsiblePanel>



            </div>



          </div>



        </div>



      </div>



    </div>



  );



}







function StealthActionButton({

  icon: Icon,

  label,

  description,

  loading,

  disabled,

  onClick,

  testId,

  buttonDataEngine,

  action,

  accent = 'neutral',

}: {

  icon: typeof Wrench;

  label: string;

  description: string;

  loading: boolean;

  disabled: boolean;

  onClick: () => void;

  testId?: string;

  buttonDataEngine?: DccEngine;

  action?: string;

  accent?: 'neutral' | 'repair' | 'cleanup';

}) {

  const surfaceClasses = accent === 'repair'

    ? 'border-[#5f4a1d] bg-[#2b210b] text-[#f4d98f] hover:border-[#8d7331] hover:bg-[#382b10]'

    : accent === 'cleanup'

      ? 'border-[#275b49] bg-[#0f241d] text-[#baf7e4] hover:border-[#3d8a71] hover:bg-[#163228]'

      : 'border-[#2d333b] bg-[#0f141a] text-[#c9d1d9] hover:border-[#4b5563] hover:bg-[#18202a]';

  const iconClasses = accent === 'repair'

    ? 'text-[#f0c762]'

    : accent === 'cleanup'

      ? 'text-[#76e7c9]'

      : 'text-[#9fb1c1]';

  return (

    <Tooltip>

      <TooltipTrigger asChild>

        <button

          type="button"

          onClick={onClick}

          disabled={disabled}

          aria-label={label}

          title={label}

          data-testid={testId}

          data-engine={buttonDataEngine}

          data-action={action}

          data-loading={loading ? 'true' : 'false'}

          className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-all duration-200 hover:-translate-y-0.5 hover:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-35 ${surfaceClasses} ${loading ? 'opacity-100' : 'opacity-50'}`}

        >

          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className={`h-4 w-4 ${iconClasses}`} />}

        </button>

      </TooltipTrigger>

      <TooltipContent side="top" align="center" className="max-w-[280px] rounded-lg border border-[#30363d] bg-[#11161c] px-3 py-2 text-[#e6edf3] shadow-2xl">

        <div className="text-[11px] font-semibold leading-5 text-[#f0f6fc]">{label}</div>

        <div className="mt-1 text-[11px] leading-5 text-[#9fb0c0]">{description}</div>

      </TooltipContent>

    </Tooltip>

  );

}



function ActionFeatureCard({

  icon: Icon,

  testId,

  buttonTestId,
  buttonDataEngine,

  title,

  description,

  buttonLabel,

  loading,

  disabled,

  tone,

  onClick,

}: {

  icon: typeof Wrench;

  testId?: string;

  buttonTestId?: string;
  buttonDataEngine?: DccEngine;

  title: string;

  description: string;

  buttonLabel: string;

  loading: boolean;

  disabled: boolean;

  tone: 'repair' | 'cleanup';

  onClick: () => void;

}) {

  const cardClasses = tone === 'repair'

    ? 'border-[#4d3f1c] bg-[#191408]'

    : 'border-[#21483b] bg-[#0d1a16]';

  const titleClasses = tone === 'repair' ? 'text-[#fff2c7]' : 'text-[#d7ffef]';

  const descClasses = tone === 'repair' ? 'text-[#cdbb88]' : 'text-[#9ec7ba]';

  const iconClasses = tone === 'repair' ? 'text-[#f0c762]' : 'text-[#76e7c9]';

  return (

    <div className={`group h-full min-w-0 overflow-hidden rounded-xl border px-3 py-3 opacity-75 transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100 ${cardClasses}`} data-testid={testId} data-tone={tone}>

      <div className="flex min-h-0 items-start justify-between gap-3">

        <div className="min-w-0 flex-1">

          <div className={`flex items-start gap-2 text-sm font-semibold ${titleClasses}`}>

            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconClasses}`} />

            <span className="break-words leading-5">{title}</span>

          </div>

          <div className={`mt-1 max-h-0 overflow-hidden break-words text-[11px] leading-5 opacity-0 transition-all duration-200 group-hover:max-h-24 group-hover:opacity-100 group-focus-within:max-h-24 group-focus-within:opacity-100 ${descClasses}`}>{description}</div>

        </div>

        <StealthActionButton

          icon={Icon}

          label={buttonLabel}

          description={description}

          loading={loading}

          disabled={disabled}

          onClick={onClick}

          testId={buttonTestId}

          buttonDataEngine={buttonDataEngine}

          action={tone}

          accent={tone}

        />

      </div>

    </div>

  );

}



function CollapsiblePanel({



  title,



  count,



  countLabel,



  children,



  open,



  onToggle,



}: {



  title: string;



  count: number;



  countLabel: string;



  children: ReactNode;



  open?: boolean;



  onToggle?: (open: boolean) => void;



}) {



  const [internalOpen, setInternalOpen] = useState(Boolean(open));



  const expanded = typeof open === 'boolean' ? open : internalOpen;







  useEffect(() => {



    if (typeof open === 'boolean') {



      setInternalOpen(open);



    }



  }, [open]);







  return (



    <div className="rounded-lg border border-[#30363d] bg-[#0d1117]" data-expanded={expanded ? 'true' : 'false'}>



      <button



        type="button"



        onClick={() => {



          const next = !expanded;



          setInternalOpen(next);



          onToggle?.(next);



        }}



        className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-3 px-3 py-2 text-left"



      >



        <div className="flex min-w-0 items-center gap-2">



          <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[#8b949e] transition-transform ${expanded ? 'rotate-90' : ''}`} />



          <span className="break-words text-[11px] font-semibold tracking-[0.12em] text-[#8b949e]">{title}</span>



        </div>



        <span className="shrink-0 rounded-full border border-[#2a3138] bg-[#11161d] px-2 py-1 text-[10px] text-[#9fb0c0]">



          {count} {countLabel}



        </span>



      </button>



      {expanded ? (



        <div className="border-t border-[#21262d] px-3 py-3">



          <div className="space-y-2">{children}</div>



        </div>



      ) : null}



    </div>



  );



}







function StatTile({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {



  return (



    <div className="rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2 text-center text-[11px] text-[#cfcfcf]">



      <div className={`text-sm font-semibold ${valueClassName || ''}`}>{value}</div>



      <div className="break-words">{label}</div>



    </div>



  );



}







function TogglePill({



  active,



  activeLabel,



  inactiveLabel,



  onClick,



}: {



  active: boolean;



  activeLabel: string;



  inactiveLabel: string;



  onClick: () => void;



}) {



  return (



    <button



      type="button"



      onClick={onClick}



      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${active ? 'bg-[#1e4d39] text-[#bbf7d0]' : 'bg-[#30363d] text-[#d0d0d0]'}`}



    >



      {active ? activeLabel : inactiveLabel}



    </button>



  );



}







function PanelSelect({



  label,



  value,



  disabled,



  onChange,



  options,



}: {



  label: string;



  value: string;



  disabled?: boolean;



  onChange: (value: string) => void;



  options: Array<{ value: string; label: string }>;



}) {



  return (



    <label className="flex min-h-[82px] min-w-0 flex-col justify-center gap-1 rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2 text-xs text-[#c9d1d9]">



      <span className="flex items-start gap-1.5 font-semibold text-[#e8e8e8]">



        <ScanLine className="mt-0.5 h-3.5 w-3.5 shrink-0" />



        <span className="break-words leading-5">{label}</span>



      </span>



      <select



        value={value}



        disabled={disabled}



        onChange={(event) => onChange(event.target.value)}



        className="w-full min-w-0 bg-transparent text-xs leading-5 outline-none disabled:opacity-50"



      >



        {options.map((item) => (



          <option key={`${item.value}-${item.label}`} value={item.value} className="bg-[#242424] text-[#eeeeee]">



            {item.label}



          </option>



        ))}



      </select>



    </label>



  );



}













































