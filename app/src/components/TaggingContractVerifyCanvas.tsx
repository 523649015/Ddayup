import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ensureDebugBridgeStateElement,
  patchDebugBridge,
  publishDebugBridgeState,
  readDebugBridgePublicState,
  setDebugBridgeBootstrapState,
} from '@/services/debugBridge';
import { useCanvasStore } from '@/store/useCanvasStore';
import type { CanvasNode, NodeData, NodeType, RegionPackContract } from '@/types';
import TaggingContractVerifySurface from '@/components/TaggingContractVerifySurface';
const DEBUG_TAGGING_BASE_IMAGE_URL = new URL('../../tmp-main-compressed.jpg', import.meta.url).toString();
const DEBUG_TAGGING_SUBJECT_IMAGE_URL = new URL('../../tmp-subject-compressed.jpg', import.meta.url).toString();
const DEBUG_TAGGING_LIGHTING_IMAGE_URL = new URL('../../tmp-omni-compressed.jpg', import.meta.url).toString();
const DEBUG_BRIDGE_EVENT_NAME = 'hmdao:debug-command';


let buildDebugGenerationBodyForNodeResolved: null | ((nodeId: string) => unknown) = null;

async function warmBuildGenerationBodyForNode() {
  if (buildDebugGenerationBodyForNodeResolved) return buildDebugGenerationBodyForNodeResolved;
  const [
    generationModule,
    referenceGraphModule,
    regionContractsModule,
  ] = await Promise.all([
    import('@/services/generation'),
    import('@/lib/nodeReferenceGraph'),
    import('@/services/regionContracts'),
  ]);
  buildDebugGenerationBodyForNodeResolved = (nodeId: string) => {
    const state = useCanvasStore.getState();
    const node = state.canvas?.nodes.find((item) => item.id === String(nodeId || '')) || null;
    if (!node) return generationModule.buildDebugGenerationBodyFromNode(null);
    const canvas = state.canvas;
    if (!canvas || (node.type !== 'video' && node.type !== 'image' && node.type !== 'dcc')) {
      return generationModule.buildDebugGenerationBodyFromNode(node);
    }
    const currentData = node.data as NodeData;
    const currentParams = currentData?.params && typeof currentData.params === 'object'
      ? currentData.params as Record<string, unknown>
      : {};
    const referenceSettings = currentParams.referenceSettings && typeof currentParams.referenceSettings === 'object'
      ? currentParams.referenceSettings as Record<string, unknown>
      : {};
    const regionContractEntry = node.type === 'video' || node.type === 'image'
      ? regionContractsModule.collectConnectedRegionContracts(canvas, node.id, node.type)[0] || null
      : null;
    const activeRegionContract = regionContractEntry?.contract || null;
    const connectedInputs = activeRegionContract
      ? regionContractsModule.buildRegionContractMediaInputs(activeRegionContract)
      : referenceGraphModule.collectConnectedReferenceInputs(canvas, node.id, node.type, referenceSettings as never);
    const primaryInput = connectedInputs.find((item) => item.channel === 'primary' && item.enabled !== false && item.url);
    const imageReference = connectedInputs.find((item) => item.channel !== 'primary' && item.enabled !== false && item.type === 'image' && item.url);
    const videoReference = connectedInputs.find((item) => item.channel !== 'primary' && item.enabled !== false && item.type === 'video' && item.url);
    return generationModule.buildDebugGenerationBodyFromNode({
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
    } satisfies CanvasNode);
  };
  return buildDebugGenerationBodyForNodeResolved;
}

function sanitizeNodeForBridge(node: CanvasNode) {
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    data: node.data,
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

function TaggingContractVerifyShell() {
  const canvas = useCanvasStore((state) => state.canvas);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const addNode = useCanvasStore((state) => state.addNode);
  const createCanvas = useCanvasStore((state) => state.createCanvas);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const bridgeInitializedRef = useRef(false);
  const demoSeedHandledRef = useRef(false);
  const [surfaceReady, setSurfaceReady] = useState(false);
  const showSurface = true;

  const readCanvasSnapshot = useCallback(() => {
    const state = useCanvasStore.getState();
    const nextCanvas = state.canvas;
    const nextSelectedNodes = nextCanvas?.nodes.filter((node) => state.selectedNodeIds.includes(node.id)) || [];
    return {
      nodeCount: nextCanvas?.nodes.length || 0,
      edgeCount: nextCanvas?.edges.length || 0,
      selectedNodeIds: [...state.selectedNodeIds],
      selectedNodes: nextSelectedNodes.map((node) => ({
        id: node.id,
        type: node.type,
        label: node.data?.label || '',
      })),
    };
  }, []);

  const focusNode = useCallback((nodeId: string) => {
    const targetNode = useCanvasStore.getState().canvas?.nodes.find((node) => node.id === nodeId);
    if (!targetNode) return;
    useCanvasStore.getState().setSelectedNodeIds([nodeId]);
  }, []);

  const openNodePanel = useCallback((nodeId: string, mode: 'panel' | 'reupload' = 'panel') => {
    const targetNode = useCanvasStore.getState().canvas?.nodes.find((node) => node.id === nodeId);
    if (!targetNode) return;
    focusNode(nodeId);
    if (targetNode.type !== 'image' && targetNode.type !== 'video') return;
    const params = targetNode.data?.params && typeof targetNode.data.params === 'object'
      ? targetNode.data.params as Record<string, unknown>
      : {};
    const panelToken = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `verify-panel-${Date.now()}`;
    updateNodeData(nodeId, {
      params: {
        ...params,
        migrationOpenPanelToken: panelToken,
        migrationOpenPanelMode: mode,
        migrationOpenPanelRequestedAt: Date.now(),
      },
    });
    queueMicrotask(() => {
      setSelectedNodeIds([nodeId]);
    });
  }, [focusNode, setSelectedNodeIds, updateNodeData]);

  const buildGenerationBodyForNode = useCallback((nodeId: string) => {
    if (!buildDebugGenerationBodyForNodeResolved) {
      throw new Error('Generation helpers are still warming up.');
    }
    return buildDebugGenerationBodyForNodeResolved(nodeId);
  }, []);

  const seedTaggingContractDemo = useCallback(async (options?: { resetCanvas?: boolean }) => {
    const waitFrame = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    if (options?.resetCanvas || !useCanvasStore.getState().canvas) {
      createCanvas('DDUp Tagging Contract Verify');
      await waitFrame();
    }

    const createDebugImageNode = (label: string, url: string, position: { x: number; y: number }) => {
      const nodeId = addNode('image', position);
      updateNodeData(nodeId, {
        label,
        status: 'completed',
        aspectRatio: '16:9',
        imageUrl: url,
        params: {
          imageMeta: {
            width: 1280,
            height: 720,
          },
        },
        outputs: [{
          id: `debug-${nodeId}-image`,
          type: 'image',
          url,
          metadata: {
            source: 'tagging-contract-demo',
            width: 1280,
            height: 720,
          },
        }],
      });
      return nodeId;
    };

    const baseNodeId = createDebugImageNode('DCC 鏋勫浘鍩哄簳 / 鎹曡幏鎴浘', DEBUG_TAGGING_BASE_IMAGE_URL, { x: 120, y: 220 });
    const subjectNodeId = createDebugImageNode('涓讳綋鍙傝€?/ 瑙掕壊涓讳綋', DEBUG_TAGGING_SUBJECT_IMAGE_URL, { x: 120, y: 560 });
    const lightingNodeId = createDebugImageNode('鑳屾櫙鍏夊奖鍙傝€?/ 娓呮櫒娴疯竟', DEBUG_TAGGING_LIGHTING_IMAGE_URL, { x: 120, y: 900 });

    const taggingNodeId = addNode('region', { x: 760, y: 300 });
    const regionContract: RegionPackContract = {
      version: 'region-contract-v1',
      source: {
        nodeId: baseNodeId,
        nodeLabel: 'DCC 鏋勫浘鍩哄簳 / 鎹曡幏鎴浘',
        url: DEBUG_TAGGING_BASE_IMAGE_URL,
        mediaType: 'image',
        width: 1280,
        height: 720,
      },
      regions: [
        {
          regionId: 'region-subject-target',
          label: '主体角色',
          geometry: {
            rect: { x: 0.28, y: 0.2, width: 0.34, height: 0.56 },
          },
          targetKind: 'subject',
          editIntent: 'replace_subject',
          description: '只替换黄色跳舞角色为参考角色，保留动作、镜头、时序和其他人物物体。',
          strictness: 'exact_transfer',
          bindingMode: 'reference_required',
          bindings: [{
            slotId: 'slot-subject-target',
            sourceNodeId: subjectNodeId,
            sourceAssetUrl: DEBUG_TAGGING_SUBJECT_IMAGE_URL,
            sourceMediaType: 'image',
            bindingRole: 'subject-reference',
            preserveDetail: true,
            weight: 98,
            sourceLabel: '主体参考 / 角色主体',
            description: '主体替换参考',
          }],
          enabled: true,
        },
        {
          regionId: 'region-background-morning-beach',
          label: '背景清晨海边',
          geometry: {
            rect: { x: 0.02, y: 0.04, width: 0.96, height: 0.9 },
          },
          targetKind: 'background',
          editIntent: 'background_fuse',
          description: '只替换背景为清晨海边沙滩，保留主体和前景物体的透视关系。',
          strictness: 'harmonize_only',
          bindingMode: 'reference_required',
          bindings: [{
            slotId: 'slot-background-morning-beach',
            sourceNodeId: lightingNodeId,
            sourceAssetUrl: DEBUG_TAGGING_LIGHTING_IMAGE_URL,
            sourceMediaType: 'image',
            bindingRole: 'background-reference',
            preserveDetail: true,
            weight: 90,
            sourceLabel: '背景参考 / 清晨海边',
            description: '背景氛围参考',
          }],
          enabled: true,
        },
      ],
      bindings: [],
      executionPlan: {
        orderedRegionIds: ['region-subject-target', 'region-background-morning-beach'],
        strategy: 'region-contract-v1',
      },
      consistencyRequirements: [
        'preserve_composition',
        'preserve_subject_detail',
        'preserve_motion',
        'background_depth_consistency',
      ],
      fallbackPolicy: 'reject',
      summary: '视频打标签合同：主体角色替换 + 清晨海边背景',
      generatedAt: Date.now(),
    };

    updateNodeData(taggingNodeId, {
      label: '打标签节点 / 视频换角合同',
      status: 'completed',
      imageUrl: DEBUG_TAGGING_BASE_IMAGE_URL,
      content: regionContract.summary,
      outputs: [{
        id: `region-pack-${taggingNodeId}`,
        type: 'text',
        url: `region-pack://${taggingNodeId}`,
        metadata: {
          regionContract,
        },
      }],
      params: {
        sourceMediaType: 'image',
        regionContract,
      },
    });

    const imageNodeId = addNode('image', { x: 1420, y: 360 });
    updateNodeData(imageNodeId, {
      label: '图片节点 / 合同预览',
      status: 'idle',
      prompt: '',
      model: 'gpt-image-2',
      provider: 'openai',
      aspectRatio: '16:9',
      quality: '720p',
    });

    await waitFrame();

    addEdge(baseNodeId, taggingNodeId, {
      sourceHandle: 'media-output',
      targetHandle: 'region-main',
    });
    addEdge(subjectNodeId, taggingNodeId, {
      sourceHandle: 'media-output',
      targetHandle: 'region-image-reference',
    });
    addEdge(lightingNodeId, taggingNodeId, {
      sourceHandle: 'media-output',
      targetHandle: 'region-image-reference',
    });
    addEdge(taggingNodeId, imageNodeId, {
      sourceHandle: 'region-output',
      targetHandle: 'image-contract',
    });

    await waitFrame();
    setSelectedNodeIds([taggingNodeId, imageNodeId]);
    return { success: true as const, baseNodeId, subjectNodeId, lightingNodeId, taggingNodeId, imageNodeId };
  }, [addEdge, addNode, createCanvas, setSelectedNodeIds, updateNodeData]);

  const runDebugBridgeCommand = useCallback((command: string, args?: Record<string, unknown>) => {
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
        return readCanvasSnapshot();
      case 'canvas:createCanvas':
        canvasState.createCanvas(typeof args?.title === 'string' ? args.title : undefined);
        return {
          ok: true,
          selectedNodeIds: [...useCanvasStore.getState().selectedNodeIds],
          nodeCount: useCanvasStore.getState().canvas?.nodes.length || 0,
        };
      case 'canvas:addNode': {
        const type = String(args?.type || '').trim() as Parameters<typeof canvasState.addNode>[0];
        const position = (args?.position && typeof args.position === 'object') ? args.position as Parameters<typeof canvasState.addNode>[1] : undefined;
        return { nodeId: canvasState.addNode(type, position) };
      }
      case 'canvas:updateNodeData':
        canvasState.updateNodeData(String(args?.nodeId || ''), (args?.patch && typeof args.patch === 'object') ? args.patch as Record<string, unknown> : {});
        return { ok: true };
      case 'canvas:addEdge':
        canvasState.addEdge(String(args?.source || ''), String(args?.target || ''), (args?.options && typeof args.options === 'object') ? args.options as Record<string, unknown> : {});
        return { ok: true };
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
        return buildGenerationBodyForNode(nodeId);
      }
      case 'canvas:listNodes':
        return (canvasState.canvas?.nodes || []).map((node) => sanitizeNodeForBridge(node));
      case 'apiKey:setMockVideoKey':
        return import('@/store/useApiKeyStore').then(({ useApiKeyStore }) => {
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
        });
      default:
        throw new Error(`Unsupported debug bridge command: ${command}`);
    }
  }, [buildGenerationBodyForNode, readCanvasSnapshot]);

  useEffect(() => {
    if (typeof window === 'undefined' || demoSeedHandledRef.current) return;
    const url = new URL(window.location.href);
    const demo = String(url.searchParams.get('hmdao-demo') || '').trim().toLowerCase();
    if (demo !== 'tagging-contract') return;
    demoSeedHandledRef.current = true;
    const resetCanvas = ['1', 'true', 'yes'].includes(String(url.searchParams.get('hmdao-demo-reset') || '').trim().toLowerCase());
    void seedTaggingContractDemo({ resetCanvas });
  }, [seedTaggingContractDemo]);

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      void warmBuildGenerationBodyForNode().catch(() => {});
    }, 0);
    return () => window.clearTimeout(timerId);
  }, []);


  useEffect(() => {
    patchDebugBridge({
      canvasStore: useCanvasStore,
      readCanvasSnapshot,
      buildGenerationBodyForNode,
      seedTaggingContractDemo,
      collectConnectedReferenceInputs: () => [],
      reactFlow: {
        fitView: () => {},
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        setCenter: () => {},
      },
      focusMigrationNode: focusNode,
      openMigrationNodePanel: openNodePanel,
    });

    if (typeof document !== 'undefined' && !bridgeInitializedRef.current) {
      bridgeInitializedRef.current = true;
      document.documentElement.dataset.hmdaoDebugBridgeAttached = 'true';
      ensureDebugBridgeStateElement();
      publishDebugBridgeState();
      const handler = (event: Event) => {
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
      };
      document.addEventListener(DEBUG_BRIDGE_EVENT_NAME, handler);
    }

    setDebugBridgeBootstrapState('ready');
    return undefined;
  }, [buildGenerationBodyForNode, focusNode, openNodePanel, readCanvasSnapshot, runDebugBridgeCommand, seedTaggingContractDemo]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#0d1117]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(10,214,176,0.12),transparent_38%),linear-gradient(180deg,#0d1117_0%,#0a1015_100%)]" />
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between border-b border-white/6 bg-[#0b1016]/88 px-5 py-3 text-xs text-[#9cb0bf] backdrop-blur">
        <div data-testid="tagging-contract-shell-status">{surfaceReady ? 'verify shell ready' : 'verify shell booting'}</div>
        <div data-testid="tagging-contract-surface-status">{surfaceReady ? 'surface ready' : 'surface booting'}</div>
        <div>nodes: {canvas?.nodes.length || 0} 路 selected: {selectedNodeIds.length}</div>
      </div>
      {showSurface ? (
        <TaggingContractVerifySurface onReady={() => setSurfaceReady(true)} />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-[#c8d2dc]">姝ｅ湪鍒濆鍖?tagging-contract 楠岃瘉澹?..</div>
      )}
    </div>
  );
}

export function TaggingContractVerifyCanvas() {
  return <TaggingContractVerifyShell />;
}


