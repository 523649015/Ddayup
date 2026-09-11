import { StrictMode } from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from '@/App';
import { GlobalErrorBoundary } from '@/components/GlobalErrorBoundary';
import { startAutoRefresh } from '@/services/authService';
import {
  ensureDebugBridgeStateElement,
  patchDebugBridge,
  publishDebugBridgeState,
  readDebugBridgePublicState,
  setDebugBridgeBootstrapState,
} from '@/services/debugBridge';
import { allowsLocalCanvasDemoAccess, getActiveHmdaoDemoMode } from '@/utils/demoMode';
import type { ReferenceSettingsValue } from '@/lib/nodeReferenceGraph';
import type { CanvasNode, NodeData } from '@/types';

startAutoRefresh();

// 这些模块已被业务组件静态广泛引用，必然进入初始主包。
// 此处改用静态 import 并包装为已 resolved 的 Promise，消除 Rollup 的
// "dynamic import will not move module into another chunk" 冗余告警（伪懒加载）。
import * as apiKeyStoreModule from '@/store/useApiKeyStore';
import * as canvasStoreModule from '@/store/useCanvasStore';
import * as assetStoreModule from '@/store/useAssetStore';
import * as workflowModule from '@/services/workflow/index';
import * as localMediaRegistryModule from '@/services/localMediaRegistry';
import * as generationModule from '@/services/generation';
import * as regionContractsModule from '@/services/regionContracts';
import * as nodeReferenceGraphModule from '@/lib/nodeReferenceGraph';

function loadApiKeyStoreModule() {
  return Promise.resolve(apiKeyStoreModule);
}

function loadCanvasStoreModule() {
  return Promise.resolve(canvasStoreModule);
}

function loadAssetStoreModule() {
  return Promise.resolve(assetStoreModule);
}

function loadWorkflowModule() {
  return Promise.resolve(workflowModule);
}

function loadLocalMediaRegistryModule() {
  return Promise.resolve(localMediaRegistryModule);
}

function loadGenerationModule() {
  return Promise.resolve(generationModule);
}

function loadRegionContractsModule() {
  return Promise.resolve(regionContractsModule);
}

function loadNodeReferenceGraphModule() {
  return Promise.resolve(nodeReferenceGraphModule);
}

function isAuthRoute(pathname?: string) {
  const path = String(pathname || '').trim().toLowerCase();
  return path === '/login' || path === '/register' || path === '/forgot-password';
}

async function bootstrapLocalDemoApiKeys() {
  if (!allowsLocalCanvasDemoAccess()) return;

  const demoMode = getActiveHmdaoDemoMode();
  if (demoMode !== 'tagging-contract') return;

  const { useApiKeyStore, isUnusableProviderKeyStatus } = await loadApiKeyStoreModule();
  const apiKeyStore = useApiKeyStore.getState();
  const hasImageAccess = Object.values(apiKeyStore.keys).some((entry) => (
    entry
    && entry.mode === 'image'
    // 任务 AL：invalid 与 expired 同为不可用，避免已失效 key 让引导流误判已有图像权限。
    && !isUnusableProviderKeyStatus(entry.status)
    && (entry.apiKey || entry.metadataOnly)
  ));
  if (hasImageAccess) return;

  await apiKeyStore.setKey({
    provider: 'volcengine',
    maskedKey: '骞冲彴浠ｇ',
    mode: 'image',
    model: 'doubao-seedream-5-0-lite',
    source: 'platform',
    metadataOnly: true,
  });
  await apiKeyStore.setKey({
    provider: 'openai',
    maskedKey: '骞冲彴浠ｇ',
    mode: 'image',
    model: 'gpt-image-2',
    source: 'platform',
    metadataOnly: true,
  });
}

async function bootstrapSystemHealthCheck() {
  if (typeof window === 'undefined' || isAuthRoute(window.location.pathname)) return;
  try {
    const { runSystemHealthCheck } = await import('@/services/healthCheck');
    const report = await runSystemHealthCheck();
    if (!report.allPassed) {
      console.warn('[HMDao] System health check reported warnings. Some capabilities may be limited.');
    }
  } catch (error) {
    console.warn('[HMDao] System health check bootstrap failed.', error);
  }
}

const shouldExposeDebugBridge = (() => {
  if (typeof window === 'undefined') return false;
  if (allowsLocalCanvasDemoAccess()) return true;
  if (isAuthRoute(window.location.pathname)) return false;
  const hostname = String(window.location.hostname || '').trim().toLowerCase();
  if (import.meta.env.DEV || hostname === '127.0.0.1' || hostname === 'localhost') return true;
  const url = new URL(window.location.href);
  return url.searchParams.has('hmdao-demo');
})();

const DEBUG_BRIDGE_EVENT_NAME = 'hmdao:debug-command';

async function buildEffectiveDebugNode(node: CanvasNode | null | undefined) {
  if (!node) return null;

  const [{ useCanvasStore }, { collectConnectedReferenceInputs }, { buildRegionContractMediaInputs, collectConnectedRegionContracts }] = await Promise.all([
    loadCanvasStoreModule(),
    loadNodeReferenceGraphModule(),
    loadRegionContractsModule(),
  ]);

  const canvas = useCanvasStore.getState().canvas;
  if (!canvas) return node;
  if (node.type !== 'video' && node.type !== 'image' && node.type !== 'dcc') return node;

  const currentData = node.data as NodeData;
  const currentParams = currentData?.params && typeof currentData.params === 'object'
    ? currentData.params as Record<string, unknown>
    : {};
  const referenceSettings = currentParams.referenceSettings && typeof currentParams.referenceSettings === 'object'
    ? currentParams.referenceSettings as Record<string, ReferenceSettingsValue>
    : {};
  const regionContractEntry = node.type === 'video' || node.type === 'image'
    ? collectConnectedRegionContracts(canvas, node.id, node.type)[0] || null
    : null;
  const activeRegionContract = regionContractEntry?.contract || null;
  const connectedInputs = activeRegionContract
    ? buildRegionContractMediaInputs(activeRegionContract)
    : collectConnectedReferenceInputs(canvas, node.id, node.type, referenceSettings);
  const primaryInput = connectedInputs.find((item) => item.channel === 'primary' && item.enabled !== false && item.url);
  const imageReference = connectedInputs.find((item) => item.channel !== 'primary' && item.enabled !== false && item.type === 'image' && item.url);
  const videoReference = connectedInputs.find((item) => item.channel !== 'primary' && item.enabled !== false && item.type === 'video' && item.url);

  return {
    ...node,
    data: {
      ...currentData,
      inputs: connectedInputs,
      params: {
        ...currentParams,
        sourceUrl: typeof currentParams.sourceUrl === 'string' && currentParams.sourceUrl
          ? currentParams.sourceUrl
          : primaryInput?.url,
        sourceMediaType: typeof currentParams.sourceMediaType === 'string' && currentParams.sourceMediaType
          ? currentParams.sourceMediaType
          : primaryInput?.type,
        referenceImageUrl: typeof currentParams.referenceImageUrl === 'string' && currentParams.referenceImageUrl
          ? currentParams.referenceImageUrl
          : imageReference?.url,
        referenceVideoUrl: typeof currentParams.referenceVideoUrl === 'string' && currentParams.referenceVideoUrl
          ? currentParams.referenceVideoUrl
          : videoReference?.url,
        regionContract: activeRegionContract || currentParams.regionContract,
        contractMode: Boolean(activeRegionContract) || Boolean(currentParams.contractMode),
        regionContractSourceNodeId: regionContractEntry?.sourceNodeId || currentParams.regionContractSourceNodeId,
      },
    },
  } as CanvasNode;
}

async function buildDebugBridgePayload() {
  const [{ useApiKeyStore }, { useAssetStore }, { useCanvasStore }, { getWorkflowClient }, { registerLocalMedia }] = await Promise.all([
    loadApiKeyStoreModule(),
    loadAssetStoreModule(),
    loadCanvasStoreModule(),
    loadWorkflowModule(),
    loadLocalMediaRegistryModule(),
  ]);

  const readCanvasSnapshot = async () => {
    const { scanCanvasMigrationIssues } = await loadGenerationModule();
    const state = useCanvasStore.getState();
    const selectedNodeIds = [...state.selectedNodeIds];
    const selectedNodes = state.canvas?.nodes.filter((node) => selectedNodeIds.includes(node.id)) || [];
    return {
      selectedNodeIds,
      nodeCount: state.canvas?.nodes.length || 0,
      migrationIssues: scanCanvasMigrationIssues(state.canvas?.nodes),
      selectedNodes: selectedNodes.map((node) => ({
        id: node.id,
        type: node.type,
        status: node.data?.status,
        prompt: node.data?.prompt,
        model: node.data?.model,
        provider: node.data?.provider,
        imageUrl: node.data?.imageUrl,
        videoUrl: node.data?.videoUrl,
        outputCount: Array.isArray(node.data?.outputs) ? node.data.outputs.length : 0,
        params: node.data?.params || {},
        error: node.data?.error,
      })),
    };
  };

  const buildSelectedGenerationBodies = async () => {
    const { buildDebugGenerationBodyFromNode } = await loadGenerationModule();
    const state = useCanvasStore.getState();
    const selectedNodeIds = [...state.selectedNodeIds];
    const selectedNodes = state.canvas?.nodes.filter((node) => selectedNodeIds.includes(node.id)) || [];
    return Promise.all(selectedNodes.map(async (node) => ({
      id: node.id,
      type: node.type,
      label: node.data?.label,
      body: buildDebugGenerationBodyFromNode(await buildEffectiveDebugNode(node)),
    })));
  };

  const buildGenerationBodyForNode = async (nodeId: string) => {
    const { buildDebugGenerationBodyFromNode } = await loadGenerationModule();
    const state = useCanvasStore.getState();
    const node = state.canvas?.nodes.find((item) => item.id === String(nodeId || '')) || null;
    return buildDebugGenerationBodyFromNode(await buildEffectiveDebugNode(node));
  };

  return {
    apiKeyStore: useApiKeyStore,
    assetStore: useAssetStore,
    canvasStore: useCanvasStore,
    workflowClient: getWorkflowClient(),
    readCanvasSnapshot,
    buildSelectedGenerationBodies,
    buildGenerationBodyForNode,
    registerLocalMedia,
  };
}

function writeDebugBridgeResponse(payload: Record<string, unknown>) {
  const element = ensureDebugBridgeStateElement();
  if (!element) return;
  element.dataset.requestId = String(payload.requestId || '');
  element.dataset.ok = String(Boolean(payload.ok));
  element.dataset.updatedAt = String(Date.now());
  element.textContent = JSON.stringify(payload);
}

function sanitizeNodeForBridge(node: CanvasNode) {
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    data: node.data,
  };
}

async function runDebugBridgeCommand(command: string, args?: Record<string, unknown>) {
  const bridge = await buildDebugBridgePayload();
  const { useCanvasStore } = await loadCanvasStoreModule();
  const canvasState = useCanvasStore.getState();

  switch (String(command || '')) {
    case 'bridge:ping':
      return {
        ok: true,
        hasDebug: true,
        selectedNodeIds: [...canvasState.selectedNodeIds],
        nodeCount: canvasState.canvas?.nodes.length || 0,
      };
    case 'bridge:readState':
      return readDebugBridgePublicState();
    case 'canvas:readSnapshot':
      return bridge.readCanvasSnapshot();
    case 'canvas:createCanvas': {
      canvasState.createCanvas(typeof args?.title === 'string' ? args.title : undefined);
      return {
        ok: true,
        selectedNodeIds: [...useCanvasStore.getState().selectedNodeIds],
        nodeCount: useCanvasStore.getState().canvas?.nodes.length || 0,
      };
    }
    case 'canvas:addNode': {
      const type = String(args?.type || '').trim() as Parameters<typeof canvasState.addNode>[0];
      const position = (args?.position && typeof args.position === 'object') ? args.position as Parameters<typeof canvasState.addNode>[1] : undefined;
      return { nodeId: canvasState.addNode(type, position) };
    }
    case 'canvas:updateNodeData': {
      canvasState.updateNodeData(String(args?.nodeId || ''), (args?.patch && typeof args.patch === 'object') ? args.patch as Record<string, unknown> : {});
      return { ok: true };
    }
    case 'canvas:addEdge': {
      canvasState.addEdge(String(args?.source || ''), String(args?.target || ''), (args?.options && typeof args.options === 'object') ? args.options as Record<string, unknown> : {});
      return { ok: true };
    }
    case 'canvas:setSelectedNodeIds': {
      const nodeIds = Array.isArray(args?.nodeIds) ? args.nodeIds.map((item) => String(item || '')).filter(Boolean) : [];
      canvasState.setSelectedNodeIds(nodeIds);
      return { ok: true, selectedNodeIds: nodeIds };
    }
    case 'canvas:getNode': {
      const node = canvasState.getNodeById(String(args?.nodeId || ''));
      return node ? sanitizeNodeForBridge(node) : null;
    }
    case 'canvas:buildGenerationBody': {
      const nodeId = String(args?.nodeId || '').trim();
      if (!nodeId) throw new Error('nodeId is required');
      return bridge.buildGenerationBodyForNode(nodeId);
    }
    case 'canvas:listNodes': {
      const nodes = canvasState.canvas?.nodes || [];
      return nodes.map((node) => sanitizeNodeForBridge(node));
    }
    case 'apiKey:setMockVideoKey': {
      const { useApiKeyStore } = await loadApiKeyStoreModule();
      const apiKeyState = useApiKeyStore.getState();
      const now = Date.now();
      void apiKeyState.setKey({
        provider: String(args?.provider || 'siliconflow'),
        apiKey: String(args?.apiKey || 'sk-mock-video-tagging'),
        maskedKey: String(args?.maskedKey || args?.apiKey || 'sk-mock-video-tagging'),
        mode: 'video',
        model: String(args?.model || 'Wan-AI/Wan2.2-I2V-A14B'),
        activatedAt: now,
        expiresAt: now + 86400000,
        refreshAfter: now + 43200000,
        lastValidatedAt: now,
        source: 'byok',
        metadataOnly: false,
      });
      return { ok: true };
    }
    default:
      throw new Error(`Unsupported debug bridge command: ${command}`);
  }
}

function attachDebugCommandBridge() {
  if (!shouldExposeDebugBridge || typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.dataset.hmdaoDebugBridgeAttached === 'true') return;
  root.dataset.hmdaoDebugBridgeAttached = 'true';
  ensureDebugBridgeStateElement();
  publishDebugBridgeState();
  document.addEventListener(DEBUG_BRIDGE_EVENT_NAME, (event) => {
    const customEvent = event as CustomEvent<{ requestId?: string; command?: string; args?: Record<string, unknown> }>;
    const detail = customEvent.detail || {};
    const requestId = String(detail.requestId || '');
    Promise.resolve()
      .then(() => runDebugBridgeCommand(String(detail.command || ''), detail.args))
      .then((result) => {
        writeDebugBridgeResponse({ requestId, ok: true, result });
      })
      .catch((error) => {
        writeDebugBridgeResponse({
          requestId,
          ok: false,
          error: String(error instanceof Error ? error.message : error || 'unknown-debug-bridge-error'),
        });
      });
  });
}

async function hydrateDebugBridge() {
  if (!shouldExposeDebugBridge || typeof window === 'undefined') return;
  try {
    patchDebugBridge(await buildDebugBridgePayload());
    publishDebugBridgeState();
  } catch (error) {
    console.warn('[HMDao] Debug bridge hydration failed.', error);
  }
}

function exposeDebugBridgeSynchronously() {
  if (!shouldExposeDebugBridge || typeof window === 'undefined') return;
  setDebugBridgeBootstrapState('started');
  try {
    patchDebugBridge({});
    attachDebugCommandBridge();
    setDebugBridgeBootstrapState('ready');
  } catch (error) {
    setDebugBridgeBootstrapState('error', String(error instanceof Error ? error.message : error || 'unknown-debug-bridge-error'));
    console.warn('[HMDao] Debug bridge bootstrap failed.', error);
  }
}

export function bootstrapMainApp() {
  void bootstrapLocalDemoApiKeys();
  exposeDebugBridgeSynchronously();
  void hydrateDebugBridge();
  ReactDOMClient.createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <GlobalErrorBoundary>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </GlobalErrorBoundary>
    </StrictMode>,
  );
  queueMicrotask(() => {
    void bootstrapSystemHealthCheck();
    void hydrateDebugBridge();
  });
}
