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






import {
  DCC_ENVIRONMENT_MONITOR_EVENT,
  dedupeRuntimeItems,
  diagnosticStateLabel,
  ENGINE_META,
  formatEnvironmentTime,
  formatLogContext,
  getBlenderStartupDiagnostics,
  getEngineDisplayLabel,
  getParentWindowsPath,
  getTopStatusBanner,
  getUnrealInstallIssue,
  getUnrealRuntimeBadges,
  getUnrealStartupDiagnostics,
  isBrokenDccText,
  isStaleOnlineActionMessage,
  jobStatusClasses,
  jobStatusLabel,
  localizeAdapterLabel,
  localizeDccDynamicText,
  logLevelClasses,
  logLevelLabel,
  normalizeWindowsPathKey,
  pluginActionDescription,
  pluginActionIcon,
  pluginActionLabel,
  pluginLayerDotClasses,
  pluginLevelClasses,
  runtimeStageStateLabel,
  runtimeStageSteps,
  runtimeStageToneClasses,
  sanitizeOptionLabel,
  shouldShowUnrealLayer,
  shouldShowUnrealNote,
  SHOW_UNREAL_COMPAT_MODE,
  translateDccPanelText,
  type AnyPluginStatus,
  type BlenderPluginStatus,
  type DiagnosticPanelItem,
  type Language,
  type StatusActionBanner,
  type Translate,
  type UnrealActionGuardState,
  type UnrealPluginStatus,
} from './DccEnvironmentPanel.shared';
export function DccEnvironmentPanel({ active = true }: { active?: boolean } = {}) {



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
    // ★面板不可见时停止轮询，避免切走后仍在后台重复请求
    if (!active) return undefined;



    const timer = window.setInterval(() => {



      if (Date.now() >= statusWatchUntil) {



        setStatusWatchUntil(0);



        window.clearInterval(timer);



        return;



      }



      void loadPluginManagerSnapshot(false, selectedEngine);


    }, 5000);



    return () => window.clearInterval(timer);



  }, [selectedEngine, statusWatchUntil, active]);






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

  // ★2026-09-14 按需探测（用户要求「常规状态不启动」）：
  //   已移除「挂载即自动探测」与「切换引擎即自动探测」。进入面板不再发起任何
  //   /api/dcc/* 请求，也不会长期停在“正在加载状态”；只有用户点击引擎卡片或
  //   「检测 / 刷新」按钮时，才探测对应引擎（见下方 onProbeEngine / refreshPluginManager）。

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



                onClick={() => { void requestStatusProbe({ force: true, watchMs: 12000, engine }); }}



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







import {
  ActionFeatureCard,
  CollapsiblePanel,
  PanelSelect,
  StatTile,
  StealthActionButton,
  TogglePill,
} from './DccEnvironmentPanel.parts';