import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent as ReactDragEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  BackgroundVariant,
  SelectionMode,
  applyNodeChanges,
  useReactFlow,
  useNodesInitialized,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type OnConnectStart,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { z } from 'zod';
import { importReferencedLocalAsset } from '@/api/assetLibrary';
import { nodeTypes } from '@/nodes';
import { preloadAllNodeChunks } from '@/nodes/lazyLoad';
import { ComfyUiStatusBanner } from './comfyui/ComfyUiStatusBanner';
import { patchDebugBridge } from '@/services/debugBridge';
import { scanCanvasMigrationIssues, type CanvasMigrationIssue } from '@/services/generation';
import { collectConnectedReferenceInputs } from '@/lib/nodeReferenceGraph';
import { registerLocalMedia, resolveLocalMediaUrl, revokeLocalMedia } from '@/services/localMediaRegistry';
import { enqueueLocalAssetPersistence } from '@/services/localAssetPersistenceQueue';
import { clipVideoLocallyStable, cropVideoLocally, enhanceVideoLocally, parseVideoLocallyEnhanced, removeSubtitleLocally, splitVideoAudioLocally } from '@/services/ffmpegPipeline';
import { useAssetStore } from '@/store/useAssetStore';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useDonationStore } from '@/store/useDonationStore';
import { useIsMobile } from '@/hooks/use-mobile';
import { useModelCatalogSync } from '@/hooks/useModelCatalogSync';
import { useUILanguage } from '@/i18n/ui';
import type { NodeData, NodeType, RegionPackContract } from '@/types';
import { Toolbar } from './Toolbar';
import { Sidebar } from './Sidebar';
import { SmartAgent } from './SmartAgent';
import { NodeGeneratePanel } from './AIPanel';
import { GenerationQueuePlaceholder } from './GenerationQueuePlaceholder';
import { GenerationNodePulse } from './GenerationNodePulse';
import { requestUngroup } from '@/lib/canvasGroupAnimation';
import { DonationPanel } from './DonationPanel';
import { WorldChannel } from './WorldChannel';
import { ShortcutsDialog } from './ShortcutsDialog';
import { ViewportHint } from './ViewportHint';
import { ComplianceNotice } from './ComplianceNotice';
import { GroupToolbar } from './GroupToolbar';
import { CanvasGroupLayer, getGroupBounds } from './CanvasGroupLayer';

/* ===== Clipboard Node Schema ===== */
import {
  buildDebugFixtureImageUrl,
  clipboardNodeSchema,
  cloneNodeData,
  DEBUG_REMOTE_IMAGE_URL,
  DEBUG_REMOTE_VIDEO_URL,
  DEBUG_TAGGING_BASE_IMAGE_URL,
  DEBUG_TAGGING_LIGHTING_IMAGE_URL,
  DEBUG_TAGGING_SUBJECT_IMAGE_URL,
  DEBUG_VIDEO_DEMO_URL,
  FLOW_PAN_ON_DRAG,
  FLOW_VIEWPORT_STYLE,
  getDragVersion,
  getIsDragging,
  getMediaNodeType,
  getMediaNodeTypeFromPath,
  isLikelyLocalMediaPath,
  normalizeClipboardLocalPath,
  readImageMetadata,
  readVideoMetadata,
  setDragging,
  subscribeDragTick,
  uploadComfyTempUrl,
  type CachedRfNode,
} from './CanvasBoard.shared';
import {
  blurActiveEditableElement,
  hasMountedRenderableEdgeHandles,
  MigrationIssuesBanner,
  MigrationIssuesToggle,
  normalizeRenderableEdgeHandle,
  orderNodeIdsByCanvas,
  resolveRenderableEdgeStyle,
  sameNodeIdArray,
  type MigrationIssueFilter,
} from './CanvasBoard.parts';
interface FlowCanvasProps {
  isFlowViewportReady: boolean;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onEdgeClick: (event: React.MouseEvent, edge: Edge) => void;
  onConnect: (connection: Connection) => void;
  onNodeClick: (event: React.MouseEvent, node: Node) => void;
  onPaneClick: () => void;
  onNodeContextMenu?: (event: React.MouseEvent, node: Node) => void;
  onConnectStart?: OnConnectStart;
  onConnectEnd?: (event: MouseEvent | TouchEvent) => void;
  onSelectionChange: (params?: { nodes?: Node[] | null }) => void;
  onMove: () => void;
  syncDraggedNodeGroups: (node: Node) => void;
  commitMoveHistory: () => void;
  autoEditGroupId: string | null;
  onAutoEditHandled: (groupId: string) => void;
  flowAriaLabelConfig: React.ComponentProps<typeof ReactFlow>['ariaLabelConfig'];
}

// 独立的轻量画布组件：拖拽节点时通过外部 dragStore（useSyncExternalStore）订阅位置覆盖，
// 每帧只重渲染本组件 + ReactFlow，而不触发外层巨型 CanvasFlow 组件，
// 从而避免 Toolbar/Sidebar/各种 Panel 等重型子树随拖拽每帧重渲染造成的卡顿。
function FlowCanvasImpl(props: FlowCanvasProps) {
  const canvas = useCanvasStore((s) => s.canvas);
  const canvasVersion = canvas?.updatedAt || 0;
  // 订阅拖动状态回流（供 CanvasGroupLayer 在拖动期间跳过包围盒重算）；getIsDragging 仅在
  // onNodeDragStart/Stop 时翻转，纯点击（无移动）不会置 true —— 即「按住左键不松且移动」才算拖动。
  useSyncExternalStore(subscribeDragTick, getDragVersion);
  const dragging = getIsDragging();

  const rfNodeCacheRef = useRef(new Map<string, CachedRfNode>());
  // 拖拽进行中的标志（ref，避免进入 React 依赖）：拖拽期间即使全局 canvas 引用因其他
  // 写入而变化，也绝不把 rfNodes 重置回旧坐标 —— 否则节点会被每帧拽回起点，表现为不跟手。
  const draggingRef = useRef(false);

  // 从全局 canvas 构建 ReactFlow 节点数组，带 data 引用记忆化：node.data 未变时复用旧对象，
  // 避免节点内部（视频/图片预览等重型组件）重渲染。拖拽期间的实时位置不走这里，而是由本地
  // rfNodes state + applyNodeChanges 驱动（见 onNodesChange）。
  const buildRfNodesFromCanvas = useCallback((): Node[] => {
    if (!canvas) {
      rfNodeCacheRef.current.clear();
      return [];
    }
    const cache = rfNodeCacheRef.current;
    const seen = new Set<string>();
    const built = canvas.nodes.map((n) => {
      seen.add(n.id);
      const prev = cache.get(n.id);
      const data =
        prev && prev.dataSrc === n.data
          ? prev.node.data
          : ({ ...n.data, __nodeType: n.type, __src: n.data } as Record<string, unknown>);
      // data 引用与位置都未变 → 复用旧节点对象引用，ReactFlow 不重测/不重渲该节点
      if (prev && prev.dataSrc === n.data && prev.posX === n.position.x && prev.posY === n.position.y) {
        return prev.node as Node;
      }
      const node = {
        id: n.id,
        type: n.type,
        className: `hmdao-node hmdao-node-${n.type}`,
        position: n.position,
        selectable: true,
        draggable: true,
        data,
      };
      cache.set(n.id, { node, dataSrc: n.data, posX: n.position.x, posY: n.position.y });
      return node as Node;
    });
    for (const id of Array.from(cache.keys())) {
      if (!seen.has(id)) cache.delete(id);
    }
    return built;
  }, [canvas, canvasVersion]);

  // 本地受控节点 state —— ReactFlow 官方标准受控用法。拖拽时 onNodesChange 用 applyNodeChanges
  // 同步更新本地 state，ReactFlow 立即用新位置渲染节点 wrapper transform → 实时跟随鼠标。
  const [rfNodes, setRfNodes] = useState<Node[]>(() => buildRfNodesFromCanvas());
  const rfNodesRef = useRef(rfNodes);
  rfNodesRef.current = rfNodes;

  // 全局 canvas 变化（新增/删除节点、data 更新、外部改位置）时重建本地节点。
  // 拖拽期间用 draggingRef 直接跳过重建（即使 canvas 引用因其他写入变化也不重置），
  // 本地 state 完全由 applyNodeChanges 驱动，位置不会被拉回起点。
  useEffect(() => {
    if (draggingRef.current) return;
    setRfNodes(buildRfNodesFromCanvas());
  }, [buildRfNodesFromCanvas]);

  const rfEdges = useMemo(() => {
    if (!canvas) return [];
    const nodeIds = new Set(canvas.nodes.map((node) => node.id));
    return canvas.edges.reduce<Edge[]>((edges, e) => {
      if (e.pending || !hasMountedRenderableEdgeHandles(e)) {
        return edges;
      }
      if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) {
        return edges;
      }
      const sourceHandle = normalizeRenderableEdgeHandle(e.sourceHandle, 'source');
      const targetHandle = normalizeRenderableEdgeHandle(e.targetHandle, 'target');
      const style = resolveRenderableEdgeStyle(targetHandle);
      edges.push({
        id: e.id,
        source: e.source,
        target: e.target,
        ...(sourceHandle ? { sourceHandle } : {}),
        ...(targetHandle ? { targetHandle } : {}),
        type: 'smoothstep',
        animated: Boolean(targetHandle && (targetHandle.startsWith('image-reference') || targetHandle.startsWith('video-image-reference') || targetHandle.startsWith('video-video-reference'))),
        style,
      });
      return edges;
    }, []);
  }, [canvas, canvasVersion]);

  // ReactFlow 受控模式下拖拽跟手的官方标准写法：所有节点变更（拖拽位置、选中、删除等）
  // 用 applyNodeChanges 同步应用到本地 rfNodes state。setRfNodes 触发的重渲染只发生在
  // 本 FlowCanvas 组件内（已 memo，与 CanvasFlow 解耦），因此既实时跟手又不卡顿。
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // remove 变更同时同步到全局 store（持久化删除）
    const removeNode = useCanvasStore.getState().removeNode;
    for (const c of changes) {
      if (c.type === 'remove') removeNode(c.id);
    }
    setRfNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  // 仅在指针真正移动（超过 ReactFlow 拖拽阈值）后才算拖动 —— 纯点击不会触发本回调，
  // 因此 isDragging 不会在点击时被置位，天然区分「按住左键拖动」与「点击」。
  const onNodeDragStart = useCallback((_event: MouseEvent | TouchEvent, _node: Node) => {
    draggingRef.current = true;
    setDragging(true);
  }, []);

  const onNodeDragStopEnhanced = useCallback((_event: MouseEvent | TouchEvent, node: Node) => {
    draggingRef.current = false;
    // 松手时把本地 rfNodes 中位置已变化的节点一次性写回全局 store（持久化拖拽结果）。
    const canvasNodes = useCanvasStore.getState().canvas?.nodes || [];
    const posMap = new Map(canvasNodes.map((n) => [n.id, n.position]));
    const overrides: Record<string, { x: number; y: number }> = {};
    for (const rn of rfNodesRef.current) {
      const prev = posMap.get(rn.id);
      if (prev && (prev.x !== rn.position.x || prev.y !== rn.position.y)) {
        overrides[rn.id] = { x: rn.position.x, y: rn.position.y };
      }
    }
    if (Object.keys(overrides).length > 0) {
      useCanvasStore.getState().moveNodes(overrides);
    }
    props.syncDraggedNodeGroups(node);
    props.commitMoveHistory();
    setDragging(false);
  }, [props.syncDraggedNodeGroups, props.commitMoveHistory]);

  if (!props.isFlowViewportReady) {
    return <div className="absolute inset-0 bg-[#0d1117]" aria-hidden="true" />;
  }

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={props.onEdgesChange}
      onEdgeClick={props.onEdgeClick}
      onConnect={props.onConnect}
      onNodeClick={props.onNodeClick}
      onPaneClick={props.onPaneClick}
      onNodeContextMenu={props.onNodeContextMenu}
      onConnectStart={props.onConnectStart}
      onConnectEnd={props.onConnectEnd}
      onNodeDragStop={onNodeDragStopEnhanced}
      onNodeDragStart={onNodeDragStart}
      onSelectionChange={props.onSelectionChange}
      onMove={props.onMove}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.1}
      maxZoom={2}
      elevateNodesOnSelect={false}
      panOnScroll={true}
      panOnDrag={FLOW_PAN_ON_DRAG}
      selectionOnDrag={true}
      selectionMode={SelectionMode.Partial}
      multiSelectionKeyCode="Shift"
      deleteKeyCode={null}
      zoomOnDoubleClick={false}
      selectNodesOnDrag={true}
      className="bg-[#0d1117] touch-none"
      style={FLOW_VIEWPORT_STYLE}
      ariaLabelConfig={props.flowAriaLabelConfig}
    >
      <CanvasGroupLayer autoEditGroupId={props.autoEditGroupId} onAutoEditHandled={props.onAutoEditHandled} isDragging={dragging} />
      <Background color="#21262d" gap={20} size={1} variant={BackgroundVariant.Dots} />
      <Controls className="!bg-[#161b22] !border-[#30363d]" showInteractive={false} />
    </ReactFlow>
  );
}

// 用 memo 包裹：FlowCanvas 的内部拖拽重渲染由 dragStore（useSyncExternalStore）驱动，
// 与外部父组件 CanvasFlow 的解耦进一步加固 —— 即使 CanvasFlow 因 selectedNodeIds /
// autoEditGroupId 等状态变化而重渲染，也不会级联重渲染整个 ReactFlow 画布。
const FlowCanvas = memo(FlowCanvasImpl);

function CanvasFlow() {
  useModelCatalogSync();
  const { t } = useUILanguage();
  // Use narrow store selectors to avoid full-canvas rerenders on every Zustand update.
  const canvas = useCanvasStore((s) => s.canvas);
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);
  const pendingViewportFocusNodeId = useCanvasStore((s) => s.pendingViewportFocusNodeId);
  const pendingViewportFocusNonce = useCanvasStore((s) => s.pendingViewportFocusNonce);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const moveNodes = useCanvasStore((s) => s.moveNodes);
  const deselectAll = useCanvasStore((s) => s.deselectAll);
  const setSelectedNodeIds = useCanvasStore((s) => s.setSelectedNodeIds);
  const consumeViewportFocus = useCanvasStore((s) => s.consumeViewportFocus);
  const removeEdge = useCanvasStore((s) => s.removeEdge);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const addConnectedNode = useCanvasStore((s) => s.addConnectedNode);
  const removeNodes = useCanvasStore((s) => s.removeNodes);
  const addNode = useCanvasStore((s) => s.addNode);
  const setCanvasViewport = useCanvasStore((s) => s.setCanvasViewport);
  const createCanvas = useCanvasStore((s) => s.createCanvas);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const commitMoveHistory = useCanvasStore((s) => s.commitMoveHistory);
  const createGroup = useCanvasStore((s) => s.createGroup);
  const groups = useCanvasStore((s) => s.groups);
  const safeDeselectAll = useCallback(() => {
    const selectionGuardUntil = Number(useCanvasStore.getState().selectionGuardUntil || 0);
    if (Date.now() < selectionGuardUntil) {
      return;
    }
    deselectAll();
  }, [deselectAll]);
  const addNodesToGroup = useCanvasStore((s) => s.addNodesToGroup);
  const removeNodesFromGroup = useCanvasStore((s) => s.removeNodesFromGroup);
  const ungroup = useCanvasStore((s) => s.ungroup);
  const saveWorkflow = useCanvasStore((s) => s.saveWorkflow);
  const exportCanvas = useCanvasStore((s) => s.exportCanvas);
  const showShortcuts = useCanvasStore((s) => s.showShortcuts);
  const setShowShortcuts = useCanvasStore((s) => s.setShowShortcuts);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const addAssetItem = useAssetStore((s) => s.addItem);
  const syncPersistedItems = useAssetStore((s) => s.syncPersistedItems);
  const { fitView, getViewport, screenToFlowPosition, setCenter, setNodes: setFlowNodes } = useReactFlow();
  const lastDeleteRef = useRef(0);

  // DEV-only 测试桥：供 scripts/test-canvas-animation.mjs 在真实浏览器里稳定驱动选中/成组。
  // 无头环境下合成鼠标无法触发 React Flow 的框选/节点拖拽；直接写 store 的 selectedNodeIds
  // （应用真正的选中真源，组工具条与打组均读它），避免改 React Flow 受控 nodes 被 store 回写覆盖。
  // 仅 DEV 挂载，生产构建（import.meta.env.DEV=false）完全不暴露，零运行时成本。
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const api = {
      selectAll: () => {
        const st = useCanvasStore.getState();
        const ids = (st.canvas?.nodes || []).map((n) => n.id);
        st.setSelectedNodeIds(ids);
      },
    };
    (window as unknown as { __hmdaoCanvas?: unknown }).__hmdaoCanvas = api;
    return () => {
      delete (window as unknown as { __hmdaoCanvas?: unknown }).__hmdaoCanvas;
    };
  }, []);
  const lastSelectionChangeRef = useRef(0);
  const suppressNodeInteractionUntilRef = useRef(0);
  const lastClipboardPasteHandledAtRef = useRef(0);
  const DELETE_THROTTLE_MS = 200;
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const flowHostRef = useRef<HTMLDivElement | null>(null);
  const [isFlowViewportReady, setIsFlowViewportReady] = useState(false);
  const debugSeedRunningRef = useRef(false);
  const debugSeedQueryHandledRef = useRef(false);
  const syncCanvasViewport = useCallback((viewport?: { x: number; y: number; zoom: number }) => {
    const nextViewport = viewport || getViewport();
    const host = flowHostRef.current;
    setCanvasViewport({
      x: nextViewport.x,
      y: nextViewport.y,
      zoom: nextViewport.zoom,
      width: host?.clientWidth || undefined,
      height: host?.clientHeight || undefined,
    });
  }, [getViewport, setCanvasViewport]);

  // 视口/尺寸同步做防抖：避免在平移、缩放、面板切换触发的 resize 期间每帧写回 zustand，
  // 否则 canvas 引用每帧变化会强制所有订阅 state.canvas 的节点组件重渲染，造成拖拽/平移卡顿。
  const viewportSyncTimerRef = useRef<number | null>(null);
  const scheduleViewportSync = useCallback(() => {
    if (viewportSyncTimerRef.current != null) return;
    viewportSyncTimerRef.current = window.setTimeout(() => {
      viewportSyncTimerRef.current = null;
      syncCanvasViewport();
    }, 180);
  }, [syncCanvasViewport]);

  useEffect(() => {
    if (!isFlowViewportReady) return;
    syncCanvasViewport();
    const host = flowHostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      scheduleViewportSync();
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [isFlowViewportReady, syncCanvasViewport, scheduleViewportSync]);

  // 预加载所有节点 chunk，避免画布首次铺开大量节点时再逐个等动态 import 阻塞。
  useEffect(() => {
    preloadAllNodeChunks();
  }, []);
  const [collapsedMigrationSignature, setCollapsedMigrationSignature] = useState('');
  const [migrationCursor, setMigrationCursor] = useState(0);
  const [migrationIssueFilter, setMigrationIssueFilter] = useState<MigrationIssueFilter>('all');
  const [migrationReuploadQueueNodeIds, setMigrationReuploadQueueNodeIds] = useState<string[]>([]);
  const [migrationReuploadProgress, setMigrationReuploadProgress] = useState<{ total: number; current: number } | null>(null);
  const [autoEditingGroupId, setAutoEditingGroupId] = useState<string | null>(null);
  const nodesInitialized = useNodesInitialized();
  const canvasVersion = canvas?.updatedAt || 0;

  // RF 节点/边及其拖拽位置覆盖已迁移到独立的 <FlowCanvas> 组件（见文件顶部 dragStore），
  // 通过 useSyncExternalStore 订阅拖拽位置，使拖拽每帧只重渲染 FlowCanvas 而非整个 CanvasFlow。
  const pendingCanvasEdges = useMemo(
    () => (canvas?.edges || []).filter((edge) => edge.pending),
    [canvas?.edges],
  );
  const unmountedRenderableEdges = useMemo(
    () => (canvas?.edges || []).filter((edge) => !edge.pending && !hasMountedRenderableEdgeHandles(edge)),
    [canvas?.edges],
  );
  const derivedEdgeRepairs = useMemo(() => {
    if (!canvas) return [];
    const nodeById = new Map(canvas.nodes.map((node) => [node.id, node]));
    const repairs: Array<{ source: string; target: string; sourceHandle: string; targetHandle: string }> = [];
    for (const node of canvas.nodes) {
      const params = node.data?.params as Record<string, unknown> | undefined;
      const appendRepair = (targetIdRaw: unknown, targetHandle: string) => {
        const targetId = String(targetIdRaw || '').trim();
        if (!targetId || targetId === node.id) return;
        const targetNode = nodeById.get(targetId);
        if (!targetNode) return;
        repairs.push({
          source: node.id,
          target: targetId,
          sourceHandle: 'media-output',
          targetHandle,
        });
      };
      appendRepair(params?.localVideoDerivedNodeId, 'video-main');
      appendRepair(params?.localAudioDerivedNodeId, 'audio-input');
      appendRepair(params?.localAudioVocalNodeId, 'audio-input');
      appendRepair(params?.localAudioAccompanimentNodeId, 'audio-input');
    }
    return repairs;
  }, [canvas]);
  useEffect(() => {
    if (!canvas || derivedEdgeRepairs.length === 0) return;
    const existingPairs = new Set(canvas.edges.map((edge) => `${edge.source}::${edge.target}`));
    for (const repair of derivedEdgeRepairs) {
      const pairKey = `${repair.source}::${repair.target}`;
      if (existingPairs.has(pairKey)) continue;
      addEdge(repair.source, repair.target, {
        sourceHandle: repair.sourceHandle,
        targetHandle: repair.targetHandle,
      });
    }
  }, [addEdge, canvas, derivedEdgeRepairs]);
  useEffect(() => {
    if (!canvas || unmountedRenderableEdges.length === 0) return;
    for (const edge of unmountedRenderableEdges) {
      addEdge(edge.source, edge.target, {
        sourceHandle: edge.sourceHandle || null,
        targetHandle: edge.targetHandle || null,
      });
    }
  }, [addEdge, canvas, unmountedRenderableEdges]);
  useEffect(() => {
    if (!canvas || pendingCanvasEdges.length === 0) return;
    for (const edge of pendingCanvasEdges) {
      addEdge(edge.source, edge.target, {
        sourceHandle: edge.sourceHandle || null,
        targetHandle: edge.targetHandle || null,
      });
    }
  }, [addEdge, canvas, pendingCanvasEdges]);
  // 拖动每帧都会产生新的 canvas.nodes 引用，但迁移扫描只关心节点结构与参数（不关心坐标）；
  // 用忽略坐标的稳定签名作为依赖，避免 drag 过程中每帧都跑一遍全量扫描。
  const canvasNodesRef = useRef(canvas?.nodes);
  canvasNodesRef.current = canvas?.nodes;
  const migrationScanKey = useMemo(() => {
    const nodes = canvasNodesRef.current || [];
    return nodes
      .map((n) => `${n.id}|${n.type}|${JSON.stringify((n.data as unknown as Record<string, unknown>)?.params ?? n.data ?? '')}`)
      .join('|');
  }, [canvas?.nodes]);
  const migrationIssues = useMemo(() => scanCanvasMigrationIssues(canvasNodesRef.current), [migrationScanKey]);
  const migrationExpiredCount = useMemo(
    () => migrationIssues.filter((issue) => issue.category === 'remote-asset-expired').length,
    [migrationIssues],
  );
  const migrationLegacyCount = useMemo(
    () => migrationIssues.filter((issue) => issue.category === 'legacy-blob').length,
    [migrationIssues],
  );
  const filteredMigrationIssues = useMemo(() => {
    if (migrationIssueFilter === 'all') return migrationIssues;
    return migrationIssues.filter((issue) => issue.category === migrationIssueFilter);
  }, [migrationIssueFilter, migrationIssues]);
  const migrationIssueNodeIds = useMemo(
    () => Array.from(new Set(filteredMigrationIssues.map((issue) => issue.nodeId))),
    [filteredMigrationIssues],
  );
  const migrationSignature = useMemo(
    () => migrationIssues
      .map((issue) => `${issue.nodeId}:${issue.category}:${issue.assetKind}:${issue.assetUrl || ''}`)
      .sort()
      .join('|'),
    [migrationIssues],
  );
  const migrationPanelCollapsed = migrationIssues.length > 0 && collapsedMigrationSignature === migrationSignature;
  const showMigrationBanner = migrationIssues.length > 0 && !migrationPanelCollapsed;
  const showMigrationToggle = migrationIssues.length > 0 && migrationPanelCollapsed;
  const batchRegenerateEligibleNodeIds = useMemo(() => {
    const uniqueIds = new Set(migrationIssueNodeIds);
    return Array.from(uniqueIds).filter((nodeId) => {
      const node = canvas?.nodes.find((item) => item.id === nodeId);
      const prompt = String(node?.data?.prompt || '').trim();
      return Boolean(node && (node.type === 'image' || node.type === 'video') && prompt);
    });
  }, [canvas?.nodes, migrationIssueNodeIds]);
  const batchReuploadEligibleNodeIds = useMemo(() => {
    const uniqueIds = new Set(migrationIssueNodeIds);
    return Array.from(uniqueIds).filter((nodeId) => {
      const node = canvas?.nodes.find((item) => item.id === nodeId);
      const prompt = String(node?.data?.prompt || '').trim();
      return Boolean(node && (node.type === 'image' || node.type === 'video') && !prompt);
    });
  }, [canvas?.nodes, migrationIssueNodeIds]);
  const batchReuploadActive = Boolean(migrationReuploadProgress && migrationReuploadProgress.total > 0);
  const batchReuploadDisplayCount = batchReuploadActive ? migrationReuploadQueueNodeIds.length : batchReuploadEligibleNodeIds.length;
  const batchReuploadCurrentIndex = migrationReuploadProgress?.current || 0;
  const batchReuploadTotalCount = migrationReuploadProgress?.total || 0;
  const selectedGroupIds = useMemo(() => {
    if (selectedNodeIds.length === 0) return [];
    const selectedSet = new Set(selectedNodeIds);
    return groups
      .filter((group) => group.nodeIds.some((nodeId) => selectedSet.has(nodeId)))
      .map((group) => group.id);
  }, [groups, selectedNodeIds]);

  useEffect(() => {
    setMigrationCursor((current) => (current === 0 ? current : 0));
  }, [migrationSignature]);

  useEffect(() => {
    if (migrationIssueFilter === 'remote-asset-expired' && migrationExpiredCount === 0) {
      setMigrationIssueFilter('all');
      return;
    }
    if (migrationIssueFilter === 'legacy-blob' && migrationLegacyCount === 0) {
      setMigrationIssueFilter('all');
    }
  }, [migrationExpiredCount, migrationIssueFilter, migrationLegacyCount]);

  useEffect(() => {
    setMigrationReuploadQueueNodeIds((current) => {
      const next = current.filter((nodeId) => batchReuploadEligibleNodeIds.includes(nodeId));
      return sameNodeIdArray(current, next) ? current : next;
    });
    setMigrationReuploadProgress((current) => {
      if (!current) return null;
      if (batchReuploadEligibleNodeIds.length === 0) return null;
      const clampedCurrent = Math.min(current.current, current.total);
      return { total: Math.max(current.total, clampedCurrent), current: clampedCurrent };
    });
  }, [batchReuploadEligibleNodeIds]);

  const applyFlowSelection = useCallback((nodeIds: string[]) => {
    const orderedIds = orderNodeIdsByCanvas(canvas?.nodes, nodeIds);
    lastSelectionChangeRef.current = Date.now();
    setSelectedNodeIds(orderedIds);
  }, [canvas?.nodes, setSelectedNodeIds]);

  useEffect(() => {
    if (!isFlowViewportReady || !pendingViewportFocusNodeId) return;
    const targetNode = canvas?.nodes.find((node) => node.id === pendingViewportFocusNodeId);
    if (!targetNode) return;
    const viewport = getViewport();
    const focusX = targetNode.position.x + 260;
    const focusY = targetNode.position.y + 180;
    applyFlowSelection([targetNode.id]);
    const rafId = window.requestAnimationFrame(() => {
      setCenter(focusX, focusY, {
        zoom: Math.max(viewport.zoom || 1, 0.9),
        duration: 280,
      });
      consumeViewportFocus(targetNode.id);
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [
    applyFlowSelection,
    canvas?.nodes,
    consumeViewportFocus,
    getViewport,
    isFlowViewportReady,
    pendingViewportFocusNodeId,
    pendingViewportFocusNonce,
    setCenter,
  ]);



  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const c of changes) { if (c.type === 'remove') removeEdge(c.id); }
  }, [removeEdge]);

  const onEdgeClick = useCallback((event: React.MouseEvent, edge: Edge) => {
    if (!event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    removeEdge(edge.id);
  }, [removeEdge]);

  const onConnect = useCallback((conn: Connection) => {
    if (conn.source && conn.target) {
      addEdge(conn.source, conn.target, {
        sourceHandle: conn.sourceHandle,
        targetHandle: conn.targetHandle,
      });
    }
  }, [addEdge]);

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    if (Date.now() < suppressNodeInteractionUntilRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    blurActiveEditableElement();
    if (event.altKey) {
      const nextIds = orderNodeIdsByCanvas(canvas?.nodes, selectedNodeIds.filter((id) => id !== node.id));
      applyFlowSelection(nextIds);
      return;
    }
    if (event.shiftKey) {
      const nextIds = orderNodeIdsByCanvas(canvas?.nodes, [...selectedNodeIds, node.id]);
      applyFlowSelection(nextIds);
      return;
    }
    applyFlowSelection([node.id]);
  }, [applyFlowSelection, canvas?.nodes, selectedNodeIds]);

  const onPaneClick = useCallback((event?: React.MouseEvent) => {
    event?.preventDefault();
    blurActiveEditableElement();
    safeDeselectAll();
  }, [safeDeselectAll]);

  // === 右键节点菜单（删除/复制/重命名） ===
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault();
    event.stopPropagation();
    setNodeMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
  }, []);

  // === 拖连接器到空白：弹"选一个兼容节点"面板 ===
  const [connectMenu, setConnectMenu] = useState<{
    x: number; y: number; sourceNodeId: string; sourceType: string;
    dropX: number; dropY: number;
  } | null>(null);
  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent) => {
    // ReactFlow 在没拖到有效 handle 时不会触发 onConnect；onConnectEnd 给我们最后一次拖放位置。
    // 我们无法直接判断是否落在有效 handle 上（ReactFlow 不传 connection），
    // 因此统一弹出候选面板：用户取消则相当于放弃，挑选则继续。
    const target = event.target as HTMLElement | null;
    if (!target) return;
    // 落在 handle 上 ReactFlow 会自己处理连线，此处仅处理"空白处松手"
    if (target.closest('.react-flow__handle')) return;
    if (target.closest('.react-flow__node')) return; // 也排除节点上
    // 找当前正在拖动的 source：从 window.__hmdao_pendingSource 读取（拖动开始时写入）
    const src = (window as any).__hmdao_pendingSource as
      | { nodeId: string; type: string; handle: string | null } | undefined;
    if (!src) return;
    const cx = 'clientX' in event ? event.clientX : (event as TouchEvent).changedTouches?.[0]?.clientX ?? 0;
    const cy = 'clientY' in event ? event.clientY : (event as TouchEvent).changedTouches?.[0]?.clientY ?? 0;
    // 边界钳制：保证候选面板完整落在视口内（菜单宽 240、预估高 ~220）
    const MENU_W = 240, MENU_H = 230;
    const x = Math.min(Math.max(cx, 8), window.innerWidth - MENU_W - 8);
    const y = Math.min(Math.max(cy, 8), window.innerHeight - MENU_H - 8);
    setConnectMenu({ x, y, sourceNodeId: src.nodeId, sourceType: src.type, dropX: cx, dropY: cy });
  }, []);

  // 记录拖动开始的 source（让 onConnectEnd 知道从哪个 handle 出发）
  const onConnectStart = useCallback<OnConnectStart>((_event, payload) => {
    if (payload.handleType !== 'source') return;
    const node = canvas?.nodes.find((n) => n.id === payload.nodeId);
    (window as any).__hmdao_pendingSource = {
      nodeId: payload.nodeId,
      type: node?.type || 'unknown',
      handle: payload.handleId,
    };
  }, [canvas?.nodes]);

  // 全局点击/滚动/ESC 关闭菜单
  useEffect(() => {
    if (!nodeMenu && !connectMenu) return;
    const onDocClick = () => { setNodeMenu(null); setConnectMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setNodeMenu(null); setConnectMenu(null); } };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [nodeMenu, connectMenu]);

  const importMediaFile = useCallback(async (file: File, position?: { x: number; y: number }) => {
    const nodeType = getMediaNodeType(file);
    if (!nodeType) return null;

    const localHandle = registerLocalMedia(file);
    const renderUrl = resolveLocalMediaUrl(localHandle) || localHandle;
    let assetUrl = localHandle;
    let assetThumbnail = localHandle;
    let assetId = '';
    let persistedAsset = null as null | {
      id: string;
      url: string;
      thumbnail: string;
      width?: number;
      height?: number;
      duration?: number;
    };
    const nodeId = addNode(nodeType, position);
    applyFlowSelection([nodeId]);

    if (nodeType === 'image') {
      const metadata = await readImageMetadata(renderUrl);
      try {
        const persistedImport = await enqueueLocalAssetPersistence(file, {
          folderId: 'root',
          width: metadata?.width,
          height: metadata?.height,
          sourceUrl: file.name,
        });
        syncPersistedItems([persistedImport.item]);
        persistedAsset = {
          id: persistedImport.item.id,
          url: persistedImport.item.url,
          thumbnail: persistedImport.item.thumbnail || persistedImport.item.url,
          width: persistedImport.item.width,
          height: persistedImport.item.height,
        };
        assetId = persistedImport.item.id;
        assetUrl = persistedImport.item.url;
        assetThumbnail = persistedImport.item.thumbnail || persistedImport.item.url;
      } catch {
        persistedAsset = null;
      }
      if (persistedAsset) {
        revokeLocalMedia(localHandle);
      }
      if (!persistedAsset) {
        addAssetItem({
          name: file.name,
          type: 'image',
          url: assetUrl,
          thumbnail: assetThumbnail,
          folderId: 'root',
          size: file.size,
          width: metadata?.width,
          height: metadata?.height,
          tags: [],
          smartCategories: [],
          source: 'upload',
        });
      }

      updateNodeData(nodeId, {
        imageUrl: assetUrl,
        status: 'completed',
        aspectRatio: (persistedAsset?.width || metadata?.width || 0) >= (persistedAsset?.height || metadata?.height || 0) ? '16:9' : '9:16',
        params: {
          sourceAssetId: assetId || undefined,
          sourcePersistedAssetId: assetId || undefined,
          sourceUrl: assetUrl,
          originalUrl: localHandle,
          imageMeta: {
            width: persistedAsset?.width || metadata?.width,
            height: persistedAsset?.height || metadata?.height,
          },
        },
        outputs: [
          {
            id: `drop-image-${Date.now()}`,
            type: 'image',
            url: assetUrl,
            metadata: {
              source: 'upload',
              name: file.name,
              size: file.size,
              sourceAssetId: assetId || undefined,
              persistedAssetId: assetId || undefined,
              originalUrl: localHandle,
              managedUrl: !persistedAsset,
              width: persistedAsset?.width || metadata?.width,
              height: persistedAsset?.height || metadata?.height,
            },
          },
        ],
      });
      return nodeId;
    }

    const metadata = await readVideoMetadata(renderUrl);
    try {
      const persistedImport = await enqueueLocalAssetPersistence(file, {
        folderId: 'root',
        width: metadata?.width,
        height: metadata?.height,
        duration: metadata?.duration,
        sourceUrl: file.name,
      });
      syncPersistedItems([persistedImport.item]);
      persistedAsset = {
        id: persistedImport.item.id,
        url: persistedImport.item.url,
        thumbnail: persistedImport.item.thumbnail || persistedImport.item.url,
        width: persistedImport.item.width,
        height: persistedImport.item.height,
        duration: persistedImport.item.duration,
      };
      assetId = persistedImport.item.id;
      assetUrl = persistedImport.item.url;
      assetThumbnail = persistedImport.item.thumbnail || persistedImport.item.url;
    } catch {
      persistedAsset = null;
    }
    if (persistedAsset) {
      revokeLocalMedia(localHandle);
    }
    if (!persistedAsset) {
      addAssetItem({
        name: file.name,
        type: 'video',
        url: assetUrl,
        thumbnail: assetThumbnail,
        folderId: 'root',
        size: file.size,
        width: metadata?.width,
        height: metadata?.height,
        duration: metadata?.duration,
        tags: [],
        smartCategories: [],
        source: 'upload',
      });
    }

    updateNodeData(nodeId, {
      videoUrl: assetUrl,
      status: 'completed',
      aspectRatio: (persistedAsset?.width || metadata?.width || 0) >= (persistedAsset?.height || metadata?.height || 0) ? '16:9' : '9:16',
      duration: Math.max(1, Math.round(persistedAsset?.duration || metadata?.duration || 5)),
      params: {
        sourceAssetId: assetId || undefined,
        sourcePersistedAssetId: assetId || undefined,
        sourceUrl: assetUrl,
        originalUrl: localHandle,
        videoMeta: {
          width: persistedAsset?.width || metadata?.width,
          height: persistedAsset?.height || metadata?.height,
          duration: persistedAsset?.duration || metadata?.duration,
        },
        videoMimeType: file.type || undefined,
      },
      outputs: [
        {
          id: `drop-video-${Date.now()}`,
          type: 'video',
          url: assetUrl,
          thumbnail: assetThumbnail,
          metadata: {
            source: 'upload',
            name: file.name,
            size: file.size,
            sourceAssetId: assetId || undefined,
            persistedAssetId: assetId || undefined,
            originalUrl: localHandle,
            width: persistedAsset?.width || metadata?.width,
            height: persistedAsset?.height || metadata?.height,
            duration: persistedAsset?.duration || metadata?.duration,
            mimeType: file.type || undefined,
            managedUrl: !persistedAsset,
          },
        },
      ],
    });
    return nodeId;
  }, [addAssetItem, addNode, applyFlowSelection, syncPersistedItems, updateNodeData]);

  const importLocalPathToCanvas = useCallback(async (rawPath: string, position?: { x: number; y: number }) => {
    const normalizedPath = normalizeClipboardLocalPath(rawPath);
    const nodeType = getMediaNodeTypeFromPath(normalizedPath);
    if (!normalizedPath || !nodeType) return null;

    const persistedImport = await importReferencedLocalAsset(normalizedPath, {
      folderId: 'root',
      type: nodeType,
      sourceUrl: normalizedPath,
    });
    syncPersistedItems([persistedImport.item]);

    const nodeId = addNode(nodeType, position);
    applyFlowSelection([nodeId]);

    if (nodeType === 'image') {
      updateNodeData(nodeId, {
        label: persistedImport.item.name,
        imageUrl: persistedImport.item.url,
        status: 'completed',
        aspectRatio: (persistedImport.item.width || 0) >= (persistedImport.item.height || 0) ? '16:9' : '9:16',
        params: {
          sourceAssetId: persistedImport.item.id,
          sourcePersistedAssetId: persistedImport.item.id,
          sourceUrl: persistedImport.item.url,
          originalUrl: normalizedPath,
          imageMeta: {
            width: persistedImport.item.width,
            height: persistedImport.item.height,
          },
        },
        outputs: [{
          id: `paste-image-${Date.now()}`,
          type: 'image',
          url: persistedImport.item.url,
          thumbnail: persistedImport.item.thumbnail || persistedImport.item.url,
          metadata: {
            source: 'clipboard-path',
            sourceAssetId: persistedImport.item.id,
            persistedAssetId: persistedImport.item.id,
            originalUrl: normalizedPath,
            width: persistedImport.item.width,
            height: persistedImport.item.height,
          },
        }],
      });
      return nodeId;
    }

    updateNodeData(nodeId, {
      label: persistedImport.item.name,
      videoUrl: persistedImport.item.url,
      status: 'completed',
      aspectRatio: (persistedImport.item.width || 0) >= (persistedImport.item.height || 0) ? '16:9' : '9:16',
      duration: Math.max(1, Math.round(persistedImport.item.duration || 5)),
      params: {
        sourceAssetId: persistedImport.item.id,
        sourcePersistedAssetId: persistedImport.item.id,
        sourceUrl: persistedImport.item.url,
        originalUrl: normalizedPath,
        videoMeta: {
          width: persistedImport.item.width,
          height: persistedImport.item.height,
          duration: persistedImport.item.duration,
        },
      },
      outputs: [{
        id: `paste-video-${Date.now()}`,
        type: 'video',
        url: persistedImport.item.url,
        thumbnail: persistedImport.item.thumbnail || persistedImport.item.url,
          metadata: {
            source: 'clipboard-path',
            sourceAssetId: persistedImport.item.id,
            persistedAssetId: persistedImport.item.id,
            originalUrl: normalizedPath,
          width: persistedImport.item.width,
          height: persistedImport.item.height,
          duration: persistedImport.item.duration,
        },
      }],
    });
    return nodeId;
  }, [addNode, applyFlowSelection, syncPersistedItems, updateNodeData]);

  const seedCanvasMigrationDemo = useCallback(async (options?: { resetCanvas?: boolean }) => {
    if (options?.resetCanvas) {
      createCanvas('历史素材迁移演示');
    }

    const fixtures = [
      {
        label: '历史待重传图片 A',
        prompt: '',
        position: { x: 120, y: 160 },
        imageUrl: 'blob:legacy-missing-image-a',
        source: 'legacy-blob',
      },
      {
        label: '历史待重传图片 B',
        prompt: '',
        position: { x: 420, y: 160 },
        imageUrl: 'blob:legacy-missing-image-b',
        source: 'legacy-blob',
      },
      {
        label: '过期待重生图片',
        prompt: '请重新生成海报主视觉',
        position: { x: 720, y: 160 },
        imageUrl: 'https://example.com/historical-expired.png?X-Amz-Expires=1&Signature=expired',
        source: 'remote-asset-expired',
      },
    ] as const;

    const createdNodeIds: string[] = [];
    for (const fixture of fixtures) {
      const nodeId = addNode('image', fixture.position);
      createdNodeIds.push(nodeId);
      updateNodeData(nodeId, {
        label: fixture.label,
        prompt: fixture.prompt,
        status: 'completed',
        aspectRatio: '16:9',
        imageUrl: fixture.imageUrl,
        params: {
          legacyBlobInvalid: fixture.source === 'legacy-blob',
          imageMeta: { width: 1280, height: 720 },
        },
        outputs: [
          {
            id: `migration-demo-${fixture.source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: 'image',
            url: fixture.imageUrl,
            metadata: { source: fixture.source },
          },
        ],
      });
    }

    applyFlowSelection([createdNodeIds[0]].filter(Boolean));
    return { success: true as const, nodeIds: createdNodeIds };
  }, [addNode, applyFlowSelection, createCanvas, updateNodeData]);

  const seedLocalVideoEditDemo = useCallback(async (options?: { resetCanvas?: boolean }) => {
    if (debugSeedRunningRef.current) {
      return { success: false as const, error: '\u672c\u5730\u6f14\u793a\u6b63\u5728\u751f\u6210\u4e2d\uff0c\u8bf7\u7a0d\u5019\u3002' };
    }

    debugSeedRunningRef.current = true;
    try {
      if (options?.resetCanvas) {
        createCanvas('\u672c\u5730\u89c6\u9891\u88c1\u526a\u526a\u8f91\u6f14\u793a');
      }

      const response = await fetch(DEBUG_VIDEO_DEMO_URL);
      if (!response.ok) {
        throw new Error(`\u65e0\u6cd5\u4e0b\u8f7d\u6f14\u793a\u89c6\u9891\uff1aHTTP ${response.status}`);
      }

      const sourceBlob = await response.blob();
      const sourceHandle = registerLocalMedia(sourceBlob);
      const sourceRenderUrl = resolveLocalMediaUrl(sourceHandle) || sourceHandle;
      const sourceMeta = await readVideoMetadata(sourceRenderUrl) || { width: 960, height: 540, duration: 5 };

      const baseX = 160;
      const baseY = 180;
      const sourceNodeId = addNode('video', { x: baseX, y: baseY });
      const sourceLabel = '\u89c6\u9891\u8282\u70b9';

      updateNodeData(sourceNodeId, {
        label: sourceLabel,
        provider: 'fal',
        model: 'seedance-v2',
        status: 'completed',
        aspectRatio: sourceMeta.width >= sourceMeta.height ? '16:9' : '9:16',
        duration: Math.max(1, Math.round(sourceMeta.duration || 5)),
        videoUrl: sourceHandle,
        params: {
          videoMeta: sourceMeta,
          videoMimeType: sourceBlob.type || 'video/mp4',
        },
        outputs: [{
          id: `debug-source-${Date.now()}`,
          type: 'video',
          url: sourceHandle,
          thumbnail: sourceHandle,
          metadata: {
            source: 'debug-demo',
            name: 'hmdao-debug-source.mp4',
            managedUrl: true,
            mimeType: sourceBlob.type || 'video/mp4',
            width: sourceMeta.width,
            height: sourceMeta.height,
            duration: sourceMeta.duration,
          },
        }],
      });

      const cropConfig = {
        tool: 'crop',
        x: 4,
        y: 4,
        widthPercent: 92,
        heightPercent: 92,
        appliedToAsset: true,
      };
      const cropResult = await cropVideoLocally(sourceHandle, {
        x: cropConfig.x,
        y: cropConfig.y,
        width: cropConfig.widthPercent,
        height: cropConfig.heightPercent,
      });
      if (!cropResult.success || !cropResult.data) {
        throw new Error(cropResult.error || '\u672c\u5730\u88c1\u526a\u6f14\u793a\u751f\u6210\u5931\u8d25\u3002');
      }

      const cropped = cropResult.data;
      const cropHandle = cropped.blob ? registerLocalMedia(cropped.blob) : cropped.url;
      if (!cropHandle) throw new Error('本地裁剪结果地址为空。');

      const cropLabel = `${sourceLabel} \u00b7 \u88c1\u526a`;
      const cropNodeId = addConnectedNode({
        type: 'video',
        position: { x: baseX + 420, y: baseY + 12 },
        sourceId: sourceNodeId,
        sourceHandle: 'media-output',
        targetHandle: 'video-main',
        data: {
          label: cropLabel,
          provider: 'fal',
          model: 'seedance-v2',
          status: 'completed',
          aspectRatio: cropped.width >= cropped.height ? '16:9' : '9:16',
          duration: Math.max(1, Math.round(cropped.duration || 5)),
          videoUrl: cropHandle,
          params: {
            videoTool: 'crop',
            videoToolOperation: 'ffmpeg_pixel_crop_cropper',
            videoToolConfig: cropConfig,
            videoMeta: {
              width: cropped.width,
              height: cropped.height,
              duration: cropped.duration,
            },
            videoMimeType: cropped.mimeType || 'video/webm',
            localVideoEditTool: 'crop',
          },
          outputs: [{
            id: `debug-crop-${Date.now()}`,
            type: 'video',
            url: cropHandle,
            thumbnail: cropHandle,
            metadata: {
              source: 'debug-demo-crop',
              localTool: 'crop',
              name: 'hmdao-debug-crop.webm',
              managedUrl: true,
              mimeType: cropped.mimeType || 'video/webm',
              width: cropped.width,
              height: cropped.height,
              duration: cropped.duration,
            },
          }],
        },
      });
      updateNodeData(sourceNodeId, {
        params: {
          videoMeta: sourceMeta,
          videoMimeType: sourceBlob.type || 'video/mp4',
          videoTool: 'crop',
          videoToolOperation: 'ffmpeg_pixel_crop_cropper',
          videoToolConfig: cropConfig,
          localVideoDerivedNodeId: cropNodeId,
          localVideoDerivedTool: 'crop',
          localVideoDerivedLabel: cropLabel,
        },
      });

      const clipConfig = {
        tool: 'clip',
        startTime: 1,
        endTime: 2,
        selectedSegmentIndex: 0,
        clipSegments: [{
          id: 'segment-1',
          startTime: 1,
          endTime: 2,
          label: '\u7247\u6bb5 1',
        }],
        appliedToAsset: true,
      };
      const clipResult = await clipVideoLocallyStable(cropHandle, [{
        startTime: clipConfig.startTime,
        endTime: clipConfig.endTime,
      }]);
      if (!clipResult.success || !clipResult.data) {
        throw new Error(clipResult.error || '\u672c\u5730\u526a\u8f91\u6f14\u793a\u751f\u6210\u5931\u8d25\u3002');
      }

      const clipped = clipResult.data;
      const clipHandle = clipped.blob ? registerLocalMedia(clipped.blob) : clipped.url;
      if (!clipHandle) throw new Error('本地剪辑结果地址为空。');

      const clipLabel = `${cropLabel} \u00b7 \u526a\u8f91`;
      const clipNodeId = addConnectedNode({
        type: 'video',
        position: { x: baseX + 840, y: baseY + 24 },
        sourceId: cropNodeId,
        sourceHandle: 'media-output',
        targetHandle: 'video-main',
        data: {
          label: clipLabel,
          provider: 'fal',
          model: 'seedance-v2',
          status: 'completed',
          aspectRatio: clipped.width >= clipped.height ? '16:9' : '9:16',
          duration: Math.max(1, Math.round(clipped.duration || 1)),
          videoUrl: clipHandle,
          params: {
            videoTool: 'clip',
            videoToolOperation: 'ffmpeg_lossless_trim_wavesurfer',
            videoToolConfig: {
              ...clipConfig,
              startTime: 0,
              endTime: clipped.duration,
              clipSegments: [{
                id: 'segment-1',
                startTime: 0,
                endTime: clipped.duration,
                label: '\u7247\u6bb5 1',
              }],
            },
            videoMeta: {
              width: clipped.width,
              height: clipped.height,
              duration: clipped.duration,
            },
            videoMimeType: clipped.mimeType || 'video/webm',
            localVideoEditTool: 'clip',
          },
          outputs: [{
            id: `debug-clip-${Date.now()}`,
            type: 'video',
            url: clipHandle,
            thumbnail: clipHandle,
            metadata: {
              source: 'debug-demo-clip',
              localTool: 'clip',
              name: 'hmdao-debug-clip.webm',
              managedUrl: true,
              mimeType: clipped.mimeType || 'video/webm',
              width: clipped.width,
              height: clipped.height,
              duration: clipped.duration,
            },
          }],
        },
      });
      updateNodeData(cropNodeId, {
        params: {
          videoTool: 'clip',
          videoToolOperation: 'ffmpeg_lossless_trim_wavesurfer',
          videoToolConfig: clipConfig,
          videoMeta: {
            width: cropped.width,
            height: cropped.height,
            duration: cropped.duration,
          },
          videoMimeType: cropped.mimeType || 'video/webm',
          localVideoDerivedNodeId: clipNodeId,
          localVideoDerivedTool: 'clip',
          localVideoDerivedLabel: clipLabel,
        },
      });

      const hdConfig = {
        tool: 'hd',
        scale: 2,
        interpolate60fps: false,
        targetFps: 24,
        detailStrength: 0.66,
        sharpenStrength: 0.36,
        appliedToAsset: true,
      };
      const hdResult = await enhanceVideoLocally(clipHandle, hdConfig);
      if (!hdResult.success || !hdResult.data) {
        throw new Error(hdResult.error || '\u672c\u5730\u9ad8\u6e05\u589e\u5f3a\u6f14\u793a\u751f\u6210\u5931\u8d25\u3002');
      }

      const enhanced = hdResult.data;
      const hdHandle = enhanced.blob ? registerLocalMedia(enhanced.blob) : enhanced.url;
      if (!hdHandle) throw new Error('本地高清结果地址为空。');

      const hdLabel = `${clipLabel} \u00b7 HD\u9ad8\u6e05`;
      const hdNodeId = addConnectedNode({
        type: 'video',
        position: { x: baseX + 1260, y: baseY + 36 },
        sourceId: clipNodeId,
        sourceHandle: 'media-output',
        targetHandle: 'video-main',
        data: {
          label: hdLabel,
          provider: 'fal',
          model: 'seedance-v2',
          status: 'completed',
          aspectRatio: enhanced.width >= enhanced.height ? '16:9' : '9:16',
          duration: Math.max(1, Math.round(enhanced.duration || clipped.duration || 1)),
          videoUrl: hdHandle,
          params: {
            videoTool: 'hd',
            videoToolOperation: 'real_cugan_rife_codeformer_enhance',
            videoToolConfig: hdConfig,
            videoMeta: {
              width: enhanced.width,
              height: enhanced.height,
              duration: enhanced.duration,
            },
            videoMimeType: enhanced.mimeType || 'video/webm',
            localVideoEditTool: 'hd',
          },
          outputs: [{
            id: `debug-hd-${Date.now()}`,
            type: 'video',
            url: hdHandle,
            thumbnail: hdHandle,
            metadata: {
              source: 'debug-demo-hd',
              localTool: 'hd',
              name: 'hmdao-debug-hd.webm',
              managedUrl: true,
              mimeType: enhanced.mimeType || 'video/webm',
              width: enhanced.width,
              height: enhanced.height,
              duration: enhanced.duration,
            },
          }],
        },
      });
      updateNodeData(clipNodeId, {
        params: {
          videoTool: 'hd',
          videoToolOperation: 'real_cugan_rife_codeformer_enhance',
          videoToolConfig: hdConfig,
          videoMeta: {
            width: clipped.width,
            height: clipped.height,
            duration: clipped.duration,
          },
          videoMimeType: clipped.mimeType || 'video/webm',
          localVideoDerivedNodeId: hdNodeId,
          localVideoDerivedTool: 'hd',
          localVideoDerivedLabel: hdLabel,
        },
      });

      const parseConfig = {
        tool: 'parse',
        sampleFps: 5,
        sceneDetect: false,
        sceneEngine: 'auto',
        semanticEngine: 'clip-interrogator',
        exportStoryboard: true,
      };
      const parseResult = await parseVideoLocallyEnhanced(hdHandle, parseConfig);
      if (!parseResult.success || !parseResult.data) {
        throw new Error(parseResult.error || '\u672c\u5730\u89e3\u6790\u6f14\u793a\u751f\u6210\u5931\u8d25\u3002');
      }

      const parseResultData = parseResult.data as {
        summary?: string;
        parseRows?: Array<Record<string, unknown>>;
      };
      const parseRows = Array.isArray(parseResultData.parseRows)
        ? parseResultData.parseRows
        : [];
      const parseLabel = `${hdLabel} \u00b7 \u89e3\u6790\u5206\u955c`;
      const parseNodeId = addConnectedNode({
        type: 'storyboard',
        position: { x: baseX + 1680, y: baseY - 120 },
        sourceId: hdNodeId,
        sourceHandle: 'media-output',
        data: {
          label: parseLabel,
          status: 'completed',
          content: parseResultData.summary,
          outputs: [{
            id: `debug-parse-${Date.now()}`,
            type: 'text',
            url: `hmdao-parse://${Date.now()}`,
            metadata: {
              source: 'debug-demo-parse',
              parseSummary: parseResult.data.summary,
              parseRows,
              analysisEngine: parseResult.data.analysisEngine || '',
              sourceNodeId: hdNodeId,
            },
          }],
          params: {
            sourceNodeId: hdNodeId,
            sourceNodeType: 'video',
            videoTool: 'parse',
            videoToolOperation: 'scene_detect_parse_analysis',
            videoToolConfig: parseConfig,
            parseSummary: parseResult.data.summary,
            analysisEngine: parseResult.data.analysisEngine || '',
            parseRows,
            parseShots: parseRows,
            parseCreatedAt: Date.now(),
          },
        },
      });
      updateNodeData(hdNodeId, {
        params: {
          videoTool: 'parse',
          videoToolOperation: 'scene_detect_parse_analysis',
          videoToolConfig: parseConfig,
          videoMeta: {
            width: enhanced.width,
            height: enhanced.height,
            duration: enhanced.duration,
          },
          videoMimeType: enhanced.mimeType || 'video/webm',
          localVideoEditTool: 'parse',
          localVideoEditAt: Date.now(),
          localVideoAnalysis: {
            ...parseResult.data,
            parseRows,
          },
          localVideoAnalysisSummary: parseResult.data.summary,
          localVideoAnalysisEngine: parseResult.data.analysisEngine || '',
          localVideoDerivedNodeId: parseNodeId,
          localVideoDerivedTool: 'parse',
          localVideoDerivedLabel: parseLabel,
          localParseStoryboardNodeId: parseNodeId,
          localParseScriptNodeId: '',
          localParseKeyframeNodeIds: [],
          localParseKeyframeCount: parseRows.filter((item) => String(item.keyframeImageBase64 || '').trim().length > 0).length,
        },
      });

      const removeConfig = {
        tool: 'removeSubtitle',
        subtitleEngine: 'opencv-telea',
        detectionMode: 'manual',
        maskFeather: 11,
        temporalConsistency: true,
        regionX: 12,
        regionY: 80,
        regionWidth: 76,
        regionHeight: 12,
        appliedToAsset: true,
      };
      const removeResult = await removeSubtitleLocally(hdHandle, removeConfig);
      if (!removeResult.success || !removeResult.data) {
        throw new Error(removeResult.error || '\u672c\u5730\u53bb\u5b57\u5e55\u6f14\u793a\u751f\u6210\u5931\u8d25\u3002');
      }

      const cleaned = removeResult.data;
      const removeHandle = cleaned.blob ? registerLocalMedia(cleaned.blob) : cleaned.url;
      if (!removeHandle) throw new Error('本地去字幕结果地址为空。');

      const removeLabel = `${hdLabel} \u00b7 \u53bb\u5b57\u5e55`;
      const removeNodeId = addConnectedNode({
        type: 'video',
        position: { x: baseX + 1680, y: baseY + 48 },
        sourceId: hdNodeId,
        sourceHandle: 'media-output',
        targetHandle: 'video-main',
        data: {
          label: removeLabel,
          provider: 'fal',
          model: 'seedance-v2',
          status: 'completed',
          aspectRatio: cleaned.width >= cleaned.height ? '16:9' : '9:16',
          duration: Math.max(1, Math.round(cleaned.duration || enhanced.duration || 1)),
          videoUrl: removeHandle,
          params: {
            videoTool: 'removeSubtitle',
            videoToolOperation: 'opencv_telea_subtitle_remove',
            videoToolConfig: removeConfig,
            videoMeta: {
              width: cleaned.width,
              height: cleaned.height,
              duration: cleaned.duration,
            },
            videoMimeType: cleaned.mimeType || 'video/webm',
            localVideoEditTool: 'removeSubtitle',
          },
          outputs: [{
            id: `debug-remove-subtitle-${Date.now()}`,
            type: 'video',
            url: removeHandle,
            thumbnail: removeHandle,
            metadata: {
              source: 'debug-demo-remove-subtitle',
              localTool: 'removeSubtitle',
              name: 'hmdao-debug-remove-subtitle.webm',
              managedUrl: true,
              mimeType: cleaned.mimeType || 'video/webm',
              width: cleaned.width,
              height: cleaned.height,
              duration: cleaned.duration,
            },
          }],
        },
      });
      const audioSplitConfig = {
        tool: 'audioSplit',
        stemModel: 'Demucs-v4',
        keepVocalInVideo: true,
        exportToWorkflow: true,
        appliedToAsset: true,
      };
      const audioSplitResult = await splitVideoAudioLocally(removeHandle, audioSplitConfig);
      if (!audioSplitResult.success || !audioSplitResult.data) {
        throw new Error(audioSplitResult.error || '\u672c\u5730\u97f3\u9891\u5206\u79bb\u6f14\u793a\u751f\u6210\u5931\u8d25\u3002');
      }

      const splitOutput = audioSplitResult.data.video;
      const splitAudio = audioSplitResult.data.audio;
      const splitVocal = audioSplitResult.data.vocal;
      const splitAccompaniment = audioSplitResult.data.accompaniment;
      const splitVideoHandle = splitOutput.blob ? registerLocalMedia(splitOutput.blob) : splitOutput.url;
      const fullAudioHandle = splitAudio.blob ? registerLocalMedia(splitAudio.blob) : splitAudio.url;
      const vocalAudioHandle = splitVocal.blob ? registerLocalMedia(splitVocal.blob) : splitVocal.url;
      const accompanimentAudioHandle = splitAccompaniment.blob ? registerLocalMedia(splitAccompaniment.blob) : splitAccompaniment.url;
      if (!splitVideoHandle || !fullAudioHandle || !vocalAudioHandle || !accompanimentAudioHandle) {
        throw new Error('本地音频分离结果地址不完整。');
      }

      const splitVideoLabel = `${removeLabel} \u00b7 \u97f3\u9891\u5206\u79bb`;
      const splitVideoNodeId = addConnectedNode({
        type: 'video',
        position: { x: baseX + 2100, y: baseY + 48 },
        sourceId: removeNodeId,
        sourceHandle: 'media-output',
        targetHandle: 'video-main',
        data: {
          label: splitVideoLabel,
          provider: 'fal',
          model: 'seedance-v2',
          status: 'completed',
          aspectRatio: splitOutput.width >= splitOutput.height ? '16:9' : '9:16',
          duration: Math.max(1, Math.round(splitOutput.duration || cleaned.duration || 1)),
          videoUrl: splitVideoHandle,
          params: {
            videoTool: 'audioSplit',
            videoToolOperation: 'demucs_v4_audio_split',
            videoToolConfig: audioSplitConfig,
            videoMeta: {
              width: splitOutput.width,
              height: splitOutput.height,
              duration: splitOutput.duration,
            },
            videoMimeType: splitOutput.mimeType || 'video/webm',
            localVideoEditTool: 'audioSplit',
          },
          outputs: [{
            id: `debug-audio-split-${Date.now()}`,
            type: 'video',
            url: splitVideoHandle,
            thumbnail: splitVideoHandle,
            metadata: {
              source: 'debug-demo-audio-split',
              localTool: 'audioSplit',
              name: 'hmdao-debug-audio-split.webm',
              managedUrl: true,
              mimeType: splitOutput.mimeType || 'video/webm',
              width: splitOutput.width,
              height: splitOutput.height,
              duration: splitOutput.duration,
            },
          }],
        },
      });
      const fullAudioLabel = `${removeLabel} \u00b7 \u5b8c\u6574\u97f3\u8f68`;
      const fullAudioNodeId = addConnectedNode({
        type: 'audio',
        position: { x: baseX + 2100, y: baseY + 280 },
        sourceId: removeNodeId,
        sourceHandle: 'media-output',
        data: {
          label: fullAudioLabel,
          status: 'completed',
          outputs: [{
            id: `debug-audio-full-${Date.now()}`,
            type: 'audio',
            url: fullAudioHandle,
            metadata: {
              source: 'debug-demo-audio-split',
              localTool: 'audioSplit',
              managedUrl: true,
              size: splitAudio.size,
              mimeType: splitAudio.mimeType || 'audio/mpeg',
              duration: splitAudio.duration,
              format: splitAudio.format,
              sampleRate: splitAudio.sampleRate,
              channels: splitAudio.channels,
              branchLabel: '\u5b8c\u6574\u97f3\u8f68',
            },
          }],
          params: {
            audioMeta: {
              duration: splitAudio.duration,
              format: splitAudio.format,
              sampleRate: splitAudio.sampleRate,
              channels: splitAudio.channels,
            },
            sourceUrl: fullAudioHandle,
            sourceMediaType: 'audio',
            audioBranchLabel: '\u5b8c\u6574\u97f3\u8f68',
          },
        },
      });

      updateNodeData(removeNodeId, {
        params: {
          videoTool: 'audioSplit',
          videoToolOperation: 'demucs_v4_audio_split',
          videoToolConfig: audioSplitConfig,
          videoMeta: {
            width: cleaned.width,
            height: cleaned.height,
            duration: cleaned.duration,
          },
          videoMimeType: cleaned.mimeType || 'video/webm',
          localVideoEditTool: 'audioSplit',
          localVideoEditAt: Date.now(),
          localVideoDerivedNodeId: splitVideoNodeId,
          localVideoDerivedTool: 'audioSplit',
          localVideoDerivedLabel: splitVideoLabel,
          localAudioSourceUrl: fullAudioHandle,
          localAudioDerivedNodeId: fullAudioNodeId,
          localAudioDerivedLabel: fullAudioLabel,
          localAudioVocalSourceUrl: vocalAudioHandle,
          localAudioAccompanimentSourceUrl: accompanimentAudioHandle,
          localVideoProcessingEngine: audioSplitResult.data.processingEngine || '',
        },
      });

    applyFlowSelection([removeNodeId]);
      fitView({ padding: 0.18, duration: 320 });

      return {
        success: true as const,
        sourceNodeId,
        cropNodeId,
        clipNodeId,
        hdNodeId,
        parseNodeId,
        removeNodeId,
        splitVideoNodeId,
        fullAudioNodeId,
        sourceMeta,
        cropMeta: { width: cropped.width, height: cropped.height, duration: cropped.duration },
        clipMeta: { width: clipped.width, height: clipped.height, duration: clipped.duration },
        hdMeta: { width: enhanced.width, height: enhanced.height, duration: enhanced.duration },
        removeMeta: { width: cleaned.width, height: cleaned.height, duration: cleaned.duration },
      };
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : '\u672c\u5730\u6f14\u793a\u751f\u6210\u5931\u8d25\u3002',
      };
    } finally {
      debugSeedRunningRef.current = false;
    }
  }, [addEdge, addNode, applyFlowSelection, createCanvas, fitView, updateNodeData]);

  const seedMediaProxyDemo = useCallback(async (options?: { resetCanvas?: boolean }) => {
    const waitFrame = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    if (options?.resetCanvas) {
      createCanvas('媒体代理验收');
      await waitFrame();
    }

    const imageNodeId = addNode('image', { x: 180, y: 180 });
    updateNodeData(imageNodeId, {
      label: '远程图片 / media-proxy',
      status: 'completed',
      aspectRatio: '16:9',
      imageUrl: DEBUG_REMOTE_IMAGE_URL,
      params: {
        imageMeta: {
          width: 1280,
          height: 720,
        },
      },
      outputs: [{
        id: `debug-remote-image-${Date.now()}`,
        type: 'image',
        url: DEBUG_REMOTE_IMAGE_URL,
        metadata: {
          source: 'debug-media-proxy',
          name: 'remote-image.jpg',
          width: 1280,
          height: 720,
        },
      }],
    });
    await waitFrame();

    const videoNodeId = addNode('video', { x: 620, y: 180 });
    updateNodeData(videoNodeId, {
      label: '远程视频 / media-proxy',
      provider: 'fal',
      model: 'seedance-v2',
      status: 'completed',
      aspectRatio: '16:9',
      duration: 5,
      videoUrl: DEBUG_REMOTE_VIDEO_URL,
      params: {
        videoMeta: {
          width: 1280,
          height: 720,
          duration: 5,
        },
      },
      outputs: [{
        id: `debug-remote-video-${Date.now()}`,
        type: 'video',
        url: DEBUG_REMOTE_VIDEO_URL,
        metadata: {
          source: 'debug-media-proxy',
          name: 'remote-video.mp4',
          width: 1280,
          height: 720,
          duration: 5,
        },
      }],
    });
    await waitFrame();

    applyFlowSelection([imageNodeId, videoNodeId]);
    fitView({ padding: 0.2, duration: 280 });
    return { success: true as const, imageNodeId, videoNodeId };
  }, [addEdge, addNode, applyFlowSelection, createCanvas, fitView, updateNodeData]);

  const seedTaggingContractDemo = useCallback(async (options?: { resetCanvas?: boolean }) => {
    const waitFrame = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    if (options?.resetCanvas) {
      createCanvas('DDUp Tagging Contract');
      await waitFrame();
    }

    const createDebugImageNode = (
      label: string,
      url: string,
      position: { x: number; y: number },
    ) => {
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

    const baseNodeId = createDebugImageNode('DCC 构图基底 / 捕获截图', DEBUG_TAGGING_BASE_IMAGE_URL, { x: 120, y: 220 });
    const subjectNodeId = createDebugImageNode('主体参考 / 老爷车', DEBUG_TAGGING_SUBJECT_IMAGE_URL, { x: 120, y: 560 });
    const lightingNodeId = createDebugImageNode('背景光影参考', DEBUG_TAGGING_LIGHTING_IMAGE_URL, { x: 120, y: 900 });

    const taggingNodeId = addNode('region', { x: 760, y: 300 });
    const regionContract: RegionPackContract = {
      version: 'region-contract-v1',
      source: {
        nodeId: baseNodeId,
        nodeLabel: 'DCC 构图基底 / 捕获截图',
        url: DEBUG_TAGGING_BASE_IMAGE_URL,
        mediaType: 'image',
        width: 1280,
        height: 720,
      },
      regions: [
        {
          regionId: 'region-subject-veteran-car',
          label: '主体老爷车',
          geometry: {
            rect: { x: 0.28, y: 0.24, width: 0.34, height: 0.5 },
          },
          targetKind: 'subject',
          editIntent: 'replace_subject',
          description: '把这里替换成参考图里的老爷车，保留车身比例、镀铬反射、轮毂和漆面细节，只做落位与边缘融合。',
          strictness: 'exact_transfer',
          bindingMode: 'reference_required',
          bindings: [{
            slotId: 'slot-subject-veteran-car',
            sourceNodeId: subjectNodeId,
            sourceAssetUrl: DEBUG_TAGGING_SUBJECT_IMAGE_URL,
            sourceMediaType: 'image',
            bindingRole: 'subject-reference',
            preserveDetail: true,
            weight: 96,
            sourceLabel: '主体参考 / 老爷车',
            description: '主体替换参考',
          }],
          enabled: true,
        },
        {
          regionId: 'region-background-lighting',
          label: '背景光影',
          geometry: {
            rect: { x: 0.02, y: 0.04, width: 0.96, height: 0.9 },
          },
          targetKind: 'background',
          editIntent: 'background_fuse',
          description: '背景替换为参考光影图的氛围和布光，只影响背景层，保持主体透视、景深和空间关系一致。',
          strictness: 'harmonize_only',
          bindingMode: 'reference_required',
          bindings: [{
            slotId: 'slot-background-lighting',
            sourceNodeId: lightingNodeId,
            sourceAssetUrl: DEBUG_TAGGING_LIGHTING_IMAGE_URL,
            sourceMediaType: 'image',
            bindingRole: 'background-reference',
            preserveDetail: true,
            weight: 88,
            sourceLabel: '背景光影参考',
            description: '背景氛围参考',
          }],
          enabled: true,
        },
      ],
      bindings: [],
      executionPlan: {
        orderedRegionIds: ['region-subject-veteran-car', 'region-background-lighting'],
        strategy: 'region-contract-v1',
      },
      consistencyRequirements: [
        'preserve_composition',
        'preserve_subject_detail',
        'background_depth_consistency',
        'reference_detail_lock',
      ],
      fallbackPolicy: 'reject',
      summary: '图片打标签 · 2 个标签 · 主体老爷车 / 背景光影',
      generatedAt: Date.now(),
    };

    updateNodeData(taggingNodeId, {
      label: '打标签节点 / 老爷车合同',
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
      label: '图片节点 / 读取打标签合同',
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

    applyFlowSelection([taggingNodeId, imageNodeId]);
    fitView({ padding: 0.18, duration: 320 });
    return { success: true as const, baseNodeId, subjectNodeId, lightingNodeId, taggingNodeId, imageNodeId };
  }, [addEdge, addNode, applyFlowSelection, createCanvas, fitView, updateNodeData]);

  const seedReferenceConsistencyDemo = useCallback(async (options?: { resetCanvas?: boolean }) => {
    const referenceConsistencyDebugV2Enabled = true;
    const waitFrame = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    if (options?.resetCanvas) {
      createCanvas('DDUp Reference Consistency');
      await waitFrame();
    }

    if (referenceConsistencyDebugV2Enabled) {
      const imagePrimaryUrlV2 = buildDebugFixtureImageUrl('图片主素材', '#14532d');
      const imageSubjectUrlV2 = buildDebugFixtureImageUrl('图片主体参考', '#0f766e');
      const imageOmniUrlV2 = buildDebugFixtureImageUrl('图片全能参考', '#9a3412');
      const videoSubjectUrlV2 = buildDebugFixtureImageUrl('视频主体参考', '#be123c');
      const videoOmniUrlV2 = buildDebugFixtureImageUrl('视频全能参考', '#1d4ed8');

      const createDebugImageNodeV2 = (
        label: string,
        url: string,
        position: { x: number; y: number },
        accent: string,
      ) => {
        const nodeId = addNode('image', position);
        updateNodeData(nodeId, {
          label,
          status: 'completed',
          aspectRatio: '16:9',
          imageUrl: url,
          params: {
            imageMeta: {
              width: 960,
              height: 640,
            },
            debugAccent: accent,
          },
          outputs: [{
            id: `debug-${nodeId}-image`,
            type: 'image',
            url,
            metadata: {
              source: 'reference-consistency-demo',
              width: 960,
              height: 640,
              accent,
            },
          }],
        });
        return nodeId;
      };

      const createDebugVideoNodeV2 = (
        label: string,
        url: string,
        position: { x: number; y: number },
      ) => {
        const nodeId = addNode('video', position);
        updateNodeData(nodeId, {
          label,
          status: 'completed',
          aspectRatio: '16:9',
          quality: '480p',
          duration: 5,
          videoUrl: url,
          params: {
            sourceUrl: url,
            sourceMediaType: 'video',
            videoMeta: {
              width: 1280,
              height: 720,
              duration: 5,
            },
          },
          outputs: [{
            id: `debug-${nodeId}-video`,
            type: 'video',
            url,
            metadata: {
              source: 'reference-consistency-demo',
              width: 1280,
              height: 720,
              duration: 5,
            },
          }],
        });
        return nodeId;
      };

      const imagePrimaryNodeIdV2 = createDebugImageNodeV2('图片主素材 / 构图基底', imagePrimaryUrlV2, { x: 120, y: 120 }, '#14532d');
      const imageSubjectNodeIdV2 = createDebugImageNodeV2('图片主体参考 / 老爷车产品', imageSubjectUrlV2, { x: 120, y: 420 }, '#0f766e');
      const imageOmniNodeIdV2 = createDebugImageNodeV2('图片全能参考 / 光影氛围', imageOmniUrlV2, { x: 120, y: 720 }, '#9a3412');
      const videoPrimaryNodeIdV2 = createDebugVideoNodeV2('视频主素材 / 运镜基底', DEBUG_VIDEO_DEMO_URL, { x: 120, y: 1120 });
      const videoSubjectNodeIdV2 = createDebugImageNodeV2('视频主体参考 / 老爷车产品', videoSubjectUrlV2, { x: 120, y: 1420 }, '#be123c');
      const videoOmniNodeIdV2 = createDebugImageNodeV2('视频全能参考 / 风格氛围', videoOmniUrlV2, { x: 120, y: 1720 }, '#1d4ed8');

      const imageNodeIdV2 = addNode('image', { x: 760, y: 360 });
      updateNodeData(imageNodeIdV2, {
        label: '图片保构图换主体',
        status: 'idle',
        prompt: '保留主素材的机位、构图布局、景深和版式，仅把主体替换成参考里的老爷车产品，并吸收全能参考里的光影、材质和场景氛围。',
        model: 'gpt-image-2',
        provider: 'openai',
        aspectRatio: '16:9',
        quality: '720p',
        inputs: [
          {
            id: `${imagePrimaryNodeIdV2}:image-main:image`,
            type: 'image',
            url: imagePrimaryUrlV2,
            label: '图片主素材 / 构图基底',
            role: 'primary',
            weight: 100,
            enabled: true,
            sourceNodeId: imagePrimaryNodeIdV2,
            sourceNodeType: 'image',
            handleId: 'image-main',
            channel: 'primary',
          },
          {
            id: `${imageSubjectNodeIdV2}:image-subject-reference-0:image`,
            type: 'image',
            url: imageSubjectUrlV2,
            label: '图片主体参考 / 老爷车产品',
            role: 'subject',
            weight: 94,
            enabled: true,
            sourceNodeId: imageSubjectNodeIdV2,
            sourceNodeType: 'image',
            handleId: 'image-subject-reference-0',
            channel: 'image-reference',
          },
          {
            id: `${imageOmniNodeIdV2}:image-lighting-reference-0:image`,
            type: 'image',
            url: imageOmniUrlV2,
            label: '图片全能参考 / 光影氛围',
            role: 'omni',
            weight: 82,
            enabled: true,
            sourceNodeId: imageOmniNodeIdV2,
            sourceNodeType: 'image',
            handleId: 'image-lighting-reference-0',
            channel: 'image-reference',
          },
        ],
        params: {
          sourceUrl: imagePrimaryUrlV2,
          sourceMediaType: 'image',
          referenceImageUrl: imageSubjectUrlV2,
          promptStrategy: 'preserve-composition-replace-subject',
          generationMode: 'referenceConditionedImageEdit',
          aspectRatio: '16:9',
          quality: '720p',
          count: 1,
          imageMeta: {
            width: 960,
            height: 640,
          },
        },
      });

      const videoNodeIdV2 = addNode('video', { x: 760, y: 1460 });
      updateNodeData(videoNodeIdV2, {
        label: '视频保构图换主体',
        status: 'idle',
        prompt: '保留主素材视频的运镜、构图、节奏和镜头语言，仅把主体替换成参考里的老爷车产品，并用全能参考统一风格、光影和场景完成度。',
        model: 'kling-o3',
        provider: 'kling',
        aspectRatio: '16:9',
        quality: '480p',
        duration: 5,
        inputs: [
          {
            id: `${videoPrimaryNodeIdV2}:video-main:video`,
            type: 'video',
            url: DEBUG_VIDEO_DEMO_URL,
            label: '视频主素材 / 运镜基底',
            role: 'primary',
            weight: 100,
            enabled: true,
            sourceNodeId: videoPrimaryNodeIdV2,
            sourceNodeType: 'video',
            handleId: 'video-main',
            channel: 'primary',
          },
          {
            id: `${videoSubjectNodeIdV2}:video-image-reference-0:image`,
            type: 'image',
            url: videoSubjectUrlV2,
            label: '视频主体参考 / 老爷车产品',
            role: 'subject',
            weight: 92,
            enabled: true,
            sourceNodeId: videoSubjectNodeIdV2,
            sourceNodeType: 'image',
            handleId: 'video-image-reference-0',
            channel: 'image-reference',
          },
          {
            id: `${videoOmniNodeIdV2}:video-image-reference-1:image`,
            type: 'image',
            url: videoOmniUrlV2,
            label: '视频全能参考 / 风格氛围',
            role: 'omni',
            weight: 84,
            enabled: true,
            sourceNodeId: videoOmniNodeIdV2,
            sourceNodeType: 'image',
            handleId: 'video-image-reference-1',
            channel: 'image-reference',
          },
        ],
        params: {
          sourceUrl: DEBUG_VIDEO_DEMO_URL,
          sourceMediaType: 'video',
          referenceImageUrl: videoSubjectUrlV2,
          promptStrategy: 'preserve-camera-motion-replace-subject',
          generationMode: 'referenceVideo',
          referenceWeight: 0.84,
          consistencyStrength: 0.88,
          aspectRatio: '16:9',
          quality: '480p',
          count: 1,
          videoMeta: {
            width: 1280,
            height: 720,
            duration: 5,
          },
        },
      });

      await waitFrame();

      addEdge(imagePrimaryNodeIdV2, imageNodeIdV2, {
        sourceHandle: 'media-output',
        targetHandle: 'image-main',
      });
      addEdge(imageSubjectNodeIdV2, imageNodeIdV2, {
        sourceHandle: 'media-output',
        targetHandle: 'image-subject-reference-0',
      });
      addEdge(imageOmniNodeIdV2, imageNodeIdV2, {
        sourceHandle: 'media-output',
        targetHandle: 'image-lighting-reference-0',
      });
      addEdge(videoPrimaryNodeIdV2, videoNodeIdV2, {
        sourceHandle: 'media-output',
        targetHandle: 'video-main',
      });
      addEdge(videoSubjectNodeIdV2, videoNodeIdV2, {
        sourceHandle: 'media-output',
        targetHandle: 'video-image-reference-0',
      });
      addEdge(videoOmniNodeIdV2, videoNodeIdV2, {
        sourceHandle: 'media-output',
        targetHandle: 'video-image-reference-1',
      });

      await waitFrame();

      applyFlowSelection([imageNodeIdV2]);
      fitView({ padding: 0.18, duration: 320 });
      return { success: true as const, imageNodeId: imageNodeIdV2, videoNodeId: videoNodeIdV2 };
    }

    return { success: false as const, error: 'reference-consistency-demo-disabled' };
  }, [addEdge, addNode, applyFlowSelection, createCanvas, fitView, updateNodeData]);

  useEffect(() => {
    const host = flowHostRef.current;
    if (!host) return;

    const syncViewportReady = () => {
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        setIsFlowViewportReady(true);
      }
    };

    syncViewportReady();

    if (typeof ResizeObserver === 'undefined') {
      const timer = window.setInterval(syncViewportReady, 200);
      return () => window.clearInterval(timer);
    }

    const observer = new ResizeObserver(syncViewportReady);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const flowAriaLabelConfig = useMemo(() => ({
    'controls.ariaLabel': t('画布控制', 'Canvas controls'),
    'controls.zoomIn.ariaLabel': t('放大', 'Zoom in'),
    'controls.zoomOut.ariaLabel': t('缩小', 'Zoom out'),
    'controls.fitView.ariaLabel': t('适配视图', 'Fit view'),
  }), [t]);

  const onCanvasDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsFileDragOver(true);
  }, []);

  const onCanvasDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) {
      return;
    }
    setIsFileDragOver(false);
  }, []);

  const onCanvasDrop = useCallback(async (event: ReactDragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer.files).filter((file) => getMediaNodeType(file));
    if (files.length === 0) {
      setIsFileDragOver(false);
      return;
    }

    event.preventDefault();
    setIsFileDragOver(false);

    const basePosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    for (const [index, file] of files.entries()) {
      const nodeId = await importMediaFile(file, {
        x: basePosition.x + index * 36,
        y: basePosition.y + index * 28,
      });
      if (!nodeId) continue;
      // 拖放素材自动生成临时 URL，供 ComfyUI 工作流远程注入（不传本地路径）
      uploadComfyTempUrl(file)
        .then((tmpUrl) => {
          if (tmpUrl) updateNodeData(nodeId, { comfyTempUrl: tmpUrl });
        })
        .catch(() => {});
    }
  }, [importMediaFile, screenToFlowPosition, updateNodeData]);

  const writeMigrationDebugState = useCallback((patch: Record<string, unknown>) => {
    if (typeof window === 'undefined') return;
    patchDebugBridge(patch);
  }, []);

  const focusMigrationNode = useCallback((nodeId: string) => {
    const targetNode = canvas?.nodes.find((node) => node.id === nodeId);
    if (!targetNode) return;
    applyFlowSelection([nodeId]);
    setCenter(targetNode.position.x + 260, targetNode.position.y + 180, {
      zoom: Math.max(getViewport().zoom || 1, 0.9),
      duration: 280,
    });
    writeMigrationDebugState({
      lastMigrationFocusAction: {
        nodeId,
        at: Date.now(),
      },
    });
  }, [applyFlowSelection, canvas?.nodes, getViewport, setCenter, writeMigrationDebugState]);

  const openMigrationNodePanel = useCallback((nodeId: string, mode: 'panel' | 'reupload' = 'panel') => {
    const targetNode = canvas?.nodes.find((node) => node.id === nodeId);
    if (!targetNode) return;
    writeMigrationDebugState({
      lastMigrationPanelAction: {
        nodeId,
        mode,
        at: Date.now(),
      },
    });
    focusMigrationNode(nodeId);
    if (targetNode.type === 'image' || targetNode.type === 'video') {
      const params = targetNode.data?.params && typeof targetNode.data.params === 'object'
        ? targetNode.data.params as Record<string, unknown>
        : {};
      const panelToken = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `migration-panel-${Date.now()}`;
      updateNodeData(nodeId, {
        params: {
          ...params,
          migrationOpenPanelToken: panelToken,
          migrationOpenPanelMode: mode,
          migrationOpenPanelRequestedAt: Date.now(),
        },
      });
      queueMicrotask(() => {
        applyFlowSelection([nodeId]);
      });
      writeMigrationDebugState({
        lastMigrationPanelAction: {
          nodeId,
          mode,
          panelToken,
          at: Date.now(),
        },
      });
    }
  }, [applyFlowSelection, canvas?.nodes, focusMigrationNode, updateNodeData, writeMigrationDebugState]);

  const selectAllMigrationNodes = useCallback(() => {
    if (migrationIssueNodeIds.length === 0) return;
    applyFlowSelection(migrationIssueNodeIds);
    const firstNode = canvas?.nodes.find((node) => node.id === migrationIssueNodeIds[0]);
    if (!firstNode) return;
    setCenter(firstNode.position.x + 260, firstNode.position.y + 180, {
      zoom: Math.max(getViewport().zoom || 1, 0.8),
      duration: 280,
    });
    writeMigrationDebugState({
      lastMigrationSelectionAction: {
        nodeIds: migrationIssueNodeIds,
        at: Date.now(),
      },
    });
  }, [applyFlowSelection, canvas?.nodes, getViewport, migrationIssueNodeIds, setCenter, writeMigrationDebugState]);

  const focusNextMigrationNode = useCallback(() => {
    if (migrationIssueNodeIds.length === 0) return;
    const nextIndex = migrationCursor % migrationIssueNodeIds.length;
    const nextNodeId = migrationIssueNodeIds[nextIndex];
    setMigrationCursor((current) => (current + 1) % Math.max(1, migrationIssueNodeIds.length));
    focusMigrationNode(nextNodeId);
  }, [focusMigrationNode, migrationCursor, migrationIssueNodeIds]);

  const exportMigrationIssues = useCallback((format: 'json' | 'csv') => {
    if (filteredMigrationIssues.length === 0) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `canvas-migration-issues-${timestamp}.${format}`;
    const rows = filteredMigrationIssues.map((issue) => ({
      nodeId: issue.nodeId,
      nodeLabel: issue.nodeLabel,
      nodeType: issue.nodeType,
      assetKind: issue.assetKind,
      category: issue.category,
      summary: issue.summary,
      detail: issue.detail,
      provider: issue.provider || '',
      assetUrl: issue.assetUrl || '',
      expiresAt: issue.expiresAt ? new Date(issue.expiresAt).toISOString() : '',
    }));
    const content = format === 'json'
      ? JSON.stringify({
          exportedAt: new Date().toISOString(),
          issueCount: rows.length,
          issues: rows,
        }, null, 2)
      : [
          ['nodeId', 'nodeLabel', 'nodeType', 'assetKind', 'category', 'summary', 'detail', 'provider', 'assetUrl', 'expiresAt'].join(','),
          ...rows.map((row) => [
            row.nodeId,
            row.nodeLabel,
            row.nodeType,
            row.assetKind,
            row.category,
            row.summary,
            row.detail,
            row.provider,
            row.assetUrl,
            row.expiresAt,
          ].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')),
        ].join('\n');
    const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    writeMigrationDebugState({
      lastMigrationExport: {
        format,
        filename,
        issueCount: rows.length,
        at: Date.now(),
      },
    });
  }, [filteredMigrationIssues, writeMigrationDebugState]);

  const batchRegenerateMigrationNodes = useCallback(() => {
    if (batchRegenerateEligibleNodeIds.length === 0) return;
    const batchToken = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `migration-batch-${Date.now()}`;
    const requestedAt = Date.now();
    for (const nodeId of batchRegenerateEligibleNodeIds) {
      const node = canvas?.nodes.find((item) => item.id === nodeId);
      if (!node) continue;
      const params = node.data?.params && typeof node.data.params === 'object'
        ? node.data.params as Record<string, unknown>
        : {};
      updateNodeData(nodeId, {
        params: {
          ...params,
          migrationBatchRegenerateToken: batchToken,
          migrationBatchRegenerateRequestedAt: requestedAt,
          migrationBatchRegenerateSource: 'canvas-migration-banner',
        },
      });
    }
    applyFlowSelection(batchRegenerateEligibleNodeIds);
    const firstNode = canvas?.nodes.find((item) => item.id === batchRegenerateEligibleNodeIds[0]);
    if (!firstNode) return;
    setCenter(firstNode.position.x + 260, firstNode.position.y + 180, {
      zoom: Math.max(getViewport().zoom || 1, 0.85),
      duration: 280,
    });
    writeMigrationDebugState({
      lastMigrationBatchRegenerate: {
        batchToken,
        nodeIds: batchRegenerateEligibleNodeIds,
        requestedAt,
      },
    });
  }, [applyFlowSelection, batchRegenerateEligibleNodeIds, canvas?.nodes, getViewport, setCenter, updateNodeData, writeMigrationDebugState]);

  const batchReuploadMigrationNodes = useCallback(() => {
    if (batchReuploadEligibleNodeIds.length === 0) return;
    const continuing = migrationReuploadQueueNodeIds.length > 0 && Boolean(migrationReuploadProgress);
    const nextQueue = continuing
      ? migrationReuploadQueueNodeIds.filter((nodeId) => batchReuploadEligibleNodeIds.includes(nodeId))
      : batchReuploadEligibleNodeIds;
    const nextNodeId = nextQueue[0];
    if (!nextNodeId) return;
    setMigrationReuploadQueueNodeIds(nextQueue.slice(1));
    setMigrationReuploadProgress((current) => {
      if (!continuing || !current) {
        return { total: nextQueue.length, current: 1 };
      }
      return {
        total: Math.max(current.total, current.current),
        current: Math.min(current.total, current.current + 1),
      };
    });
    openMigrationNodePanel(nextNodeId, 'reupload');
    writeMigrationDebugState({
      lastMigrationReuploadAction: {
        nodeId: nextNodeId,
        remainingNodeIds: nextQueue.slice(1),
        at: Date.now(),
      },
    });
  }, [batchReuploadEligibleNodeIds, migrationReuploadProgress, migrationReuploadQueueNodeIds, openMigrationNodePanel, writeMigrationDebugState]);

  const syncDraggedNodeGroups = useCallback((node: Node) => {
    if (!canvas) return;
    const draggedIds = selectedNodeIds.includes(node.id) ? selectedNodeIds : [node.id];
    for (const nodeId of draggedIds) {
      const canvasNode = canvas.nodes.find((item) => item.id === nodeId);
      if (!canvasNode) continue;
      const center = { x: canvasNode.position.x + 260, y: canvasNode.position.y + 180 };
      const currentGroup = groups.find((group) => group.nodeIds.includes(nodeId));
      if (currentGroup) {
        const bounds = getGroupBounds(currentGroup, canvas.nodes);
        if (bounds && (center.x < bounds.x || center.x > bounds.x + bounds.width || center.y < bounds.y || center.y > bounds.y + bounds.height)) {
          removeNodesFromGroup(currentGroup.id, [nodeId]);
        }
      } else {
        const target = groups.find((group) => {
          const bounds = getGroupBounds(group, canvas.nodes);
          return bounds && center.x >= bounds.x && center.x <= bounds.x + bounds.width && center.y >= bounds.y && center.y <= bounds.y + bounds.height;
        });
        if (target) addNodesToGroup(target.id, [nodeId]);
      }
    }
  }, [addNodesToGroup, canvas, groups, removeNodesFromGroup, selectedNodeIds]);

  // 稳定的回调，避免作为 prop 传入 memo(FlowCanvas) 时因引用变化导致画布每帧重渲染。
  const handleAutoEditHandled = useCallback((groupId: string) => {
    setAutoEditingGroupId((current) => (current === groupId ? null : current));
  }, [setAutoEditingGroupId]);

  // Persist move history on drag end so we do not push snapshots for every pixel movement.
  const onNodeDragStop = useCallback(() => {
    commitMoveHistory();
  }, [commitMoveHistory]);



  const onSelectionChange = useCallback((params?: { nodes?: Node[] | null }) => {
    const selected = Array.isArray(params?.nodes) ? params.nodes : [];
    const nextIds = orderNodeIdsByCanvas(canvas?.nodes, selected.map((n) => n.id).filter(Boolean));
    const canvasState = useCanvasStore.getState();
    const latestSelectedIds = canvasState.selectedNodeIds;
    const selectionGuardUntil = Number(canvasState.selectionGuardUntil || 0);
    if (nextIds.length === 0 && latestSelectedIds.length > 0 && Date.now() < selectionGuardUntil) {
      return;
    }
    if (sameNodeIdArray(nextIds, latestSelectedIds)) {
      return;
    }
    lastSelectionChangeRef.current = Date.now();
    if (nextIds.length > 1) {
      suppressNodeInteractionUntilRef.current = Date.now() + 260;
      blurActiveEditableElement();
      setAutoEditingGroupId(null);
    }
    setSelectedNodeIds(nextIds);
  }, [canvas?.nodes, setSelectedNodeIds]);

  const handleGroupSelection = useCallback((name?: string, color = '#00d4aa') => {
    if (selectedNodeIds.length < 2) return;
    const nextName = String(name || '').trim() || `分组 ${groups.length + 1}`;
    const groupId = createGroup([...selectedNodeIds], nextName, color);
    suppressNodeInteractionUntilRef.current = 0;
    setAutoEditingGroupId(groupId);
  }, [createGroup, groups.length, selectedNodeIds]);

  const handleUngroupSelection = useCallback(() => {
    if (selectedNodeIds.length === 0 || groups.length === 0) return;
    const selectedSet = new Set(selectedNodeIds);
    for (const group of groups) {
      const matchedNodeIds = group.nodeIds.filter((nodeId) => selectedSet.has(nodeId));
      if (matchedNodeIds.length === 0) continue;
      if (matchedNodeIds.length === group.nodeIds.length) {
        // 与组框上的「解组」按钮走同一封装：先播放退场动画再真正移除（G04）。
        requestUngroup(group.id, () => ungroup(group.id));
      } else {
        removeNodesFromGroup(group.id, matchedNodeIds);
      }
    }
  }, [groups, removeNodesFromGroup, selectedNodeIds, ungroup]);

  // Keyboard shortcuts with throttle
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isEditing = Boolean(target?.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select');
      if (isEditing) return;
      // Delete / Backspace
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        const isEditing = Boolean(target?.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select');
        if (isEditing) return;
        const currentSelectedIds = useCanvasStore.getState().selectedNodeIds;
        if (currentSelectedIds.length === 0) return;
        const now = Date.now();
        if (now - lastDeleteRef.current < DELETE_THROTTLE_MS) return;
        lastDeleteRef.current = now;
        e.preventDefault();
        e.stopPropagation();
        removeNodes([...currentSelectedIds]);
        return;
      }

      // Ctrl+C
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (selectedNodeIds.length === 0) return;
        e.preventDefault();
        const selectedNodes = canvas?.nodes.filter(n => selectedNodeIds.includes(n.id)) || [];
        const clipboardData = JSON.stringify(selectedNodes.map(n => ({ type: n.type, position: n.position, data: n.data })));
        navigator.clipboard.writeText(clipboardData).catch(() => {});
        return;
      }

      // Ctrl+A
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        const allIds = canvas?.nodes.map(n => n.id) || [];
        if (allIds.length > 0) {
          applyFlowSelection(allIds);
        }
        return;
      }

      // Ctrl+Z
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // Ctrl+Shift+Z / Ctrl+Y
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }

      // Ctrl+S
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        const json = exportCanvas();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${canvas?.title || 'canvas'}.json`;
        a.click();
        URL.revokeObjectURL(url);
        return;
      }

      // Ctrl+D duplicates selected nodes near their original position.
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        if (selectedNodeIds.length === 0) return;
        e.preventDefault();
        const selectedNodes = canvas?.nodes.filter(n => selectedNodeIds.includes(n.id)) || [];
        selectedNodes.forEach((n) => {
          const nodeId = addNode(n.type, { x: n.position.x + 50, y: n.position.y + 50 });
          updateNodeData(nodeId, cloneNodeData(n.data));
        });
        return;
      }

      // Ctrl+G / Ctrl+Shift+G
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        if (e.shiftKey) {
          handleUngroupSelection();
        } else {
          handleGroupSelection();
        }
        return;
      }

      // Escape clears the current selection.
      if (e.key === 'Escape') {
        if (selectedNodeIds.length > 0) {
          e.preventDefault();
          deselectAll();
        }
        return;
      }

      // Ctrl+0 fits the current canvas into view.
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        fitView({ padding: 0.2, duration: 300 });
        return;
      }

      // ? toggles the shortcuts dialog.
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setShowShortcuts(!showShortcuts);
        return;
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [addNode, applyFlowSelection, canvas, deselectAll, exportCanvas, fitView, handleGroupSelection, handleUngroupSelection, redo, removeNodes, safeDeselectAll, selectedNodeIds, setShowShortcuts, showShortcuts, undo, updateNodeData]);



  const getCanvasPastePosition = useCallback((index = 0) => {
    const host = flowHostRef.current;
    if (!host) return undefined;
    const bounds = host.getBoundingClientRect();
    const base = screenToFlowPosition({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    });
    return {
      x: base.x + index * 42,
      y: base.y + index * 28,
    };
  }, [screenToFlowPosition]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isEditing = Boolean(target?.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select');
      if (isEditing) return;

      const mediaFiles = Array.from(event.clipboardData?.files || []).filter((file) => getMediaNodeType(file));
      if (mediaFiles.length > 0) {
        lastClipboardPasteHandledAtRef.current = Date.now();
        event.preventDefault();
        void (async () => {
          for (const [index, file] of mediaFiles.entries()) {
            await importMediaFile(file, getCanvasPastePosition(index));
          }
        })();
        return;
      }

      const plainText = String(event.clipboardData?.getData('text/plain') || '').trim();
      if (!plainText) return;
      try {
        const parsed = JSON.parse(plainText);
        const nodePayload = z.array(clipboardNodeSchema).safeParse(parsed);
        if (nodePayload.success) {
          lastClipboardPasteHandledAtRef.current = Date.now();
          event.preventDefault();
          nodePayload.data.forEach((item) => {
            const nodeId = addNode(item.type as NodeType, {
              x: item.position.x + 50,
              y: item.position.y + 50,
            });
            if (item.data) {
              updateNodeData(nodeId, cloneNodeData(item.data));
            }
          });
          return;
        }
      } catch {
        // Ignore non-node clipboard text and continue as local path paste.
      }
      const uriListText = String(event.clipboardData?.getData('text/uri-list') || '').trim();
      const candidateText = [plainText, uriListText].filter(Boolean).join('\n');
      const localPaths = candidateText
        .split(/\r?\n/)
        .map((entry) => normalizeClipboardLocalPath(entry))
        .filter((entry) => isLikelyLocalMediaPath(entry));
      if (localPaths.length === 0) return;

      lastClipboardPasteHandledAtRef.current = Date.now();
      event.preventDefault();
      void (async () => {
        for (const [index, entry] of localPaths.entries()) {
          try {
            await importLocalPathToCanvas(entry, getCanvasPastePosition(index));
          } catch {
            // Ignore individual path paste failures and continue with remaining items.
          }
        }
      })();
    };

    window.addEventListener('paste', handlePaste, true);
    return () => window.removeEventListener('paste', handlePaste, true);
  }, [addNode, getCanvasPastePosition, importLocalPathToCanvas, importMediaFile, updateNodeData]);

  useEffect(() => {
    const handlePasteShortcutFallback = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || String(event.key || '').toLowerCase() !== 'v') return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isEditing = Boolean(target?.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select');
      if (isEditing) return;

      window.setTimeout(() => {
        if (Date.now() - lastClipboardPasteHandledAtRef.current < 320) return;
        const clipboardApi = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
        if (!clipboardApi) return;

        void (async () => {
          try {
            if (typeof clipboardApi.read === 'function') {
              const items = await clipboardApi.read();
              const mediaFiles: File[] = [];
              const textPayloads: string[] = [];
              for (const item of items) {
                for (const type of item.types) {
                  if (type.startsWith('image/') || type.startsWith('video/')) {
                    const blob = await item.getType(type);
                    const ext = type.split('/')[1] || (type.startsWith('video/') ? 'mp4' : 'png');
                    mediaFiles.push(new File([blob], `clipboard-${Date.now()}-${mediaFiles.length}.${ext}`, { type }));
                    continue;
                  }
                  if (type === 'text/plain' || type === 'text/uri-list') {
                    const blob = await item.getType(type);
                    textPayloads.push(await blob.text());
                  }
                }
              }
              if (mediaFiles.length > 0) {
                lastClipboardPasteHandledAtRef.current = Date.now();
                for (const [index, file] of mediaFiles.entries()) {
                  await importMediaFile(file, getCanvasPastePosition(index));
                }
                return;
              }
              const combinedText = textPayloads.filter(Boolean).join('\n');
              const localPaths = combinedText
                .split(/\r?\n/)
                .map((entry) => normalizeClipboardLocalPath(entry))
                .filter((entry) => isLikelyLocalMediaPath(entry));
              if (localPaths.length > 0) {
                lastClipboardPasteHandledAtRef.current = Date.now();
                for (const [index, entry] of localPaths.entries()) {
                  await importLocalPathToCanvas(entry, getCanvasPastePosition(index));
                }
                return;
              }
            }
            if (typeof clipboardApi.readText === 'function') {
              const text = await clipboardApi.readText();
              const localPaths = String(text || '')
                .split(/\r?\n/)
                .map((entry) => normalizeClipboardLocalPath(entry))
                .filter((entry) => isLikelyLocalMediaPath(entry));
              if (localPaths.length > 0) {
                lastClipboardPasteHandledAtRef.current = Date.now();
                for (const [index, entry] of localPaths.entries()) {
                  await importLocalPathToCanvas(entry, getCanvasPastePosition(index));
                }
              }
            }
          } catch {
            // Ignore clipboard permission / platform failures and keep native paste behavior.
          }
        })();
      }, 120);
    };

    window.addEventListener('keydown', handlePasteShortcutFallback, true);
    return () => window.removeEventListener('keydown', handlePasteShortcutFallback, true);
  }, [getCanvasPastePosition, importLocalPathToCanvas, importMediaFile]);

  useEffect(() => {
    if (typeof window === 'undefined' || debugSeedQueryHandledRef.current) return;
    const hostname = String(window.location.hostname || '').trim().toLowerCase();
    const allowLocalDemoSeed = import.meta.env.DEV || hostname === '127.0.0.1' || hostname === 'localhost';
    if (!allowLocalDemoSeed) return;
    const url = new URL(window.location.href);
    const demo = String(url.searchParams.get('hmdao-demo') || '').trim().toLowerCase();
    if (demo !== 'video-local-edit' && demo !== 'media-proxy' && demo !== 'canvas-migration' && demo !== 'reference-consistency' && demo !== 'tagging-contract') return;
    debugSeedQueryHandledRef.current = true;
    const resetCanvas = ['1', 'true', 'yes'].includes(String(url.searchParams.get('hmdao-demo-reset') || '').trim().toLowerCase());
    const runSeed = demo === 'media-proxy'
      ? seedMediaProxyDemo({ resetCanvas })
      : demo === 'canvas-migration'
        ? seedCanvasMigrationDemo({ resetCanvas })
        : demo === 'tagging-contract'
          ? seedTaggingContractDemo({ resetCanvas })
        : demo === 'reference-consistency'
          ? seedReferenceConsistencyDemo({ resetCanvas })
          : seedLocalVideoEditDemo({ resetCanvas });
    void runSeed;
  }, [seedCanvasMigrationDemo, seedLocalVideoEditDemo, seedMediaProxyDemo, seedReferenceConsistencyDemo, seedTaggingContractDemo]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hostname = String(window.location.hostname || '').trim().toLowerCase();
    const allowLocalDebugBridge = import.meta.env.DEV
      || hostname === '127.0.0.1'
      || hostname === 'localhost';
    if (!allowLocalDebugBridge) return;
    patchDebugBridge({
      canvasStore: useCanvasStore,
      collectConnectedReferenceInputs: (nodeId: string, nodeType: NodeType, settings?: Record<string, unknown>) => {
        const state = useCanvasStore.getState();
        return collectConnectedReferenceInputs(state.canvas || null, String(nodeId || ''), nodeType, (settings || {}) as never);
      },
      readCanvasSnapshot: () => {
        const state = useCanvasStore.getState();
        const nextCanvas = state.canvas;
        const selectedNodes = nextCanvas?.nodes.filter((node) => state.selectedNodeIds.includes(node.id)) || [];
        return {
          nodeCount: nextCanvas?.nodes.length || 0,
          edgeCount: nextCanvas?.edges.length || 0,
          selectedNodeIds: [...state.selectedNodeIds],
          selectedNodes: selectedNodes.map((node) => ({
            id: node.id,
            type: node.type,
            label: node.data?.label || '',
          })),
          edges: (nextCanvas?.edges || []).map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            sourceHandle: edge.sourceHandle,
            targetHandle: edge.targetHandle,
          })),
        };
      },
      reactFlow: {
        fitView,
        getViewport,
        setCenter,
      },
      seedReferenceConsistencyDemo,
      seedTaggingContractDemo,
      seedCanvasMigrationDemo,
      seedLocalVideoEditDemo,
      seedMediaProxyDemo,
      scanCanvasMigrationIssues: () => scanCanvasMigrationIssues(useCanvasStore.getState().canvas?.nodes),
      openMigrationNodePanel,
      focusMigrationNode,
      selectAllMigrationNodes,
      batchReuploadMigrationNodes,
    });
    // Keep the debug bridge stable across StrictMode effect replays and callback refreshes.
    // Headless verification can poll the bridge during cleanup/re-run windows, so tearing
    // properties off the shared global object introduces nondeterministic false negatives.
    return undefined;
  }, [batchReuploadMigrationNodes, fitView, focusMigrationNode, getViewport, openMigrationNodePanel, seedCanvasMigrationDemo, seedLocalVideoEditDemo, seedMediaProxyDemo, seedReferenceConsistencyDemo, seedTaggingContractDemo, selectAllMigrationNodes, setCenter]);

  if (!canvas) return null;

  return (
    <>
      <div
        ref={flowHostRef}
        className="absolute inset-0 min-h-[1px] min-w-[1px] overflow-hidden"
        onDragOver={onCanvasDragOver}
        onDragLeave={onCanvasDragLeave}
        onDrop={onCanvasDrop}
      >
      {isFlowViewportReady ? (
      <FlowCanvas
        isFlowViewportReady={isFlowViewportReady}
        onEdgesChange={onEdgesChange}
        onEdgeClick={onEdgeClick}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onNodeContextMenu={onNodeContextMenu}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onSelectionChange={onSelectionChange}
        onMove={scheduleViewportSync}
        syncDraggedNodeGroups={syncDraggedNodeGroups}
        commitMoveHistory={commitMoveHistory}
        autoEditGroupId={autoEditingGroupId}
        onAutoEditHandled={handleAutoEditHandled}
        flowAriaLabelConfig={flowAriaLabelConfig}
      />
      ) : (
        <div className="absolute inset-0 bg-[#0d1117]" aria-hidden="true" />
      )}
      {isFileDragOver ? (
        <div className="pointer-events-none absolute inset-4 z-20 flex items-center justify-center rounded-2xl border border-dashed border-[#00d4aa] bg-[#0d1117]/72 text-sm font-medium text-[#d7fff4] backdrop-blur-sm">
          拖拽图片或视频到画布导入
        </div>
      ) : null}
      {<ComfyUiStatusBanner />}
      {showMigrationBanner ? (
        <MigrationIssuesBanner
          issues={filteredMigrationIssues}
          allIssueCount={migrationIssues.length}
          expiredCount={migrationExpiredCount}
          legacyCount={migrationLegacyCount}
          filter={migrationIssueFilter}
          onFilterChange={setMigrationIssueFilter}
          onDismiss={() => setCollapsedMigrationSignature(migrationSignature)}
          onFocusNode={focusMigrationNode}
          onOpenNodePanel={openMigrationNodePanel}
          onFocusNext={focusNextMigrationNode}
          onSelectAll={selectAllMigrationNodes}
          onExportJson={() => exportMigrationIssues('json')}
          onExportCsv={() => exportMigrationIssues('csv')}
          onBatchRegenerate={batchRegenerateMigrationNodes}
          onBatchReupload={batchReuploadMigrationNodes}
          batchRegenerateCount={batchRegenerateEligibleNodeIds.length}
          batchReuploadCount={batchReuploadDisplayCount}
          batchReuploadActive={batchReuploadActive}
          batchReuploadCurrentIndex={batchReuploadCurrentIndex}
          batchReuploadTotalCount={batchReuploadTotalCount}
          onCollapse={() => setCollapsedMigrationSignature(migrationSignature)}
          t={t}
        />
      ) : null}
      {showMigrationToggle ? (
        <MigrationIssuesToggle
          count={migrationIssues.length}
          onExpand={() => setCollapsedMigrationSignature('')}
          t={t}
        />
      ) : null}
      </div>
      <ShortcutsDialog open={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <DonationPanel />
      <WorldChannel />
      <ViewportHint onFitView={() => fitView({ padding: 0.2, duration: 300 })} />
      {/* Show grouping tools when multiple nodes are selected. */}
      {selectedNodeIds.length > 0 && (
        <GroupToolbar
          selectedCount={selectedNodeIds.length}
          canUngroup={selectedGroupIds.length > 0}
          onDelete={() => removeNodes([...selectedNodeIds])}
          onGroup={handleGroupSelection}
          onUngroup={handleUngroupSelection}
          onArrange={(mode) => {
            if (!canvas) return;
            const selectedNodes = canvas.nodes.filter((node) => selectedNodeIds.includes(node.id));
            if (selectedNodes.length < 2) return;
            const left = Math.min(...selectedNodes.map((node) => node.position.x));
            const top = Math.min(...selectedNodes.map((node) => node.position.y));
            const gapX = 600;
            const gapY = 380;
            const cols = mode === 'grid' ? Math.ceil(Math.sqrt(selectedNodes.length)) : selectedNodes.length;
            const positions: Record<string, { x: number; y: number }> = {};
            selectedNodes.forEach((node, index) => {
              const col = mode === 'vertical' ? 0 : mode === 'horizontal' ? index : index % cols;
              const row = mode === 'horizontal' ? 0 : mode === 'vertical' ? index : Math.floor(index / cols);
              positions[node.id] = { x: left + col * gapX, y: top + row * gapY };
            });
            moveNodes(positions);
            commitMoveHistory();
          }}
          onSaveWorkflow={(name, desc) => saveWorkflow(name, desc)}
          onDeselect={safeDeselectAll}
        />
      )}
      {/* Compliance notice pinned to the canvas footer. */}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10">
        <ComplianceNotice mode="footer" minimal />
      </div>
      {/* === 右键节点菜单 === */}
      {nodeMenu && createPortal(
        <div
          className="fixed z-[9999] min-w-[160px] rounded-lg border border-[#30363d] bg-[#161b22]/95 shadow-2xl backdrop-blur-sm py-1 text-sm"
          style={{ left: nodeMenu.x, top: nodeMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-[#e6edf3] hover:bg-[#21262d]"
            onClick={() => {
              navigator.clipboard?.writeText?.(nodeMenu.nodeId).catch(() => {});
              setNodeMenu(null);
            }}
          >复制节点 ID</button>
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-[#e6edf3] hover:bg-[#21262d]"
            onClick={() => {
              removeNodes([nodeMenu.nodeId]);
              setNodeMenu(null);
            }}
          >删除节点</button>
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-[#e6edf3] hover:bg-[#21262d]"
            onClick={() => { setNodeMenu(null); }}
          >取消</button>
        </div>,
        document.body,
      )}
      {/* === 连线拖到空白：弹兼容节点面板 === */}
      {connectMenu && createPortal(
        <div
          className="fixed z-[9999] w-[240px] rounded-lg border border-[#30363d] bg-[#161b22]/95 shadow-2xl backdrop-blur-sm p-2"
          style={{ left: connectMenu.x, top: connectMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(() => {
            const META: Record<string, { icon: string; label: string }> = {
              video: { icon: '🎬', label: '视频' },
              image: { icon: '🖼️', label: '图片' },
              audio: { icon: '🔊', label: '音频' },
              text:  { icon: '📝', label: '文本' },
            };
            // 常见下游推荐：把最匹配的排在前面并标记
            const RECOMMEND: Record<string, string> = {
              video: 'image',
              image: 'text',
              audio: 'text',
              text:  'image',
            };
            const rec = RECOMMEND[connectMenu.sourceType];
            const list = (['video','image','audio','text'] as const)
              .filter((t) => t !== connectMenu.sourceType)
              .sort((a, b) => (a === rec ? -1 : b === rec ? 1 : 0));
            return (
              <>
                <div className="px-2 py-1 text-xs text-[#6e7681]">连接到</div>
                {list.map((t) => {
                  return (
                    <button
                      key={t}
                      type="button"
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[#e6edf3] hover:bg-[#21262d] ${t === rec ? 'bg-[#1f2d3d]' : ''}`}
                      onClick={() => {
                        const src = canvas?.nodes.find((n) => n.id === connectMenu.sourceNodeId);
                        if (!src) { setConnectMenu(null); return; }
                        // 新节点落在松手处（避免固定偏移跑到屏幕外）
                        const p = screenToFlowPosition({ x: connectMenu.dropX, y: connectMenu.dropY });
                        const id = addNode(t, { x: p.x + 60, y: p.y - 20 });
                        setConnectMenu(null);
                        if (id && t) {
                          setTimeout(() => {
                            addEdge(connectMenu.sourceNodeId, id, { sourceHandle: 'media-output', targetHandle: `${t}-main` });
                          }, 0);
                        }
                      }}
                    >
                      <span className="text-base">{META[t].icon}</span>
                      <span className="flex-1">新建 {META[t].label} 节点</span>
                      {t === rec && <span className="rounded bg-[#1f6feb] px-1 text-[10px] text-white">推荐</span>}
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="mt-1 block w-full rounded-md px-2 py-1.5 text-left text-[#8b949e] hover:bg-[#21262d]"
                  onClick={() => { setConnectMenu(null); (window as any).__hmdao_pendingSource = null; }}
                >取消</button>
              </>
            );
          })()}
        </div>,
        document.body,
      )}
    </>
  );
}

export function CanvasBoard() {
  const isMobile = useIsMobile();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const canvasShellRef = useRef<HTMLDivElement | null>(null);

  // 默认不自动弹出「需求共建 / 世界频道」面板，仅用户点击工具栏按钮时打开。
  useEffect(() => {
    useDonationStore.getState().setShowDonationPanel(false);
    useDonationStore.getState().setShowWorldChannel(false);
  }, []);

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0d1117] overflow-hidden">
      <Toolbar onMobileMenuToggle={() => setMobileSidebarOpen((v) => !v)} isMobile={isMobile} />
      <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        {/* Desktop keeps a fixed sidebar; mobile uses an overlay drawer. */}
        {isMobile ? (
          mobileSidebarOpen && (
            <div className="fixed inset-0 z-50 flex">
              <div
                className="absolute inset-0 bg-black/60"
                onClick={() => setMobileSidebarOpen(false)}
                role="presentation"
              />
              <div className="relative z-10 h-full">
                <Sidebar />
              </div>
            </div>
          )
        ) : (
          <Sidebar />
        )}
        <div ref={canvasShellRef} className="flex-1 min-h-0 min-w-0 relative">
          <ReactFlowProvider>
            <CanvasFlow />
          </ReactFlowProvider>
          {/* 左下角「N 个生成中的任务」占位卡（G09），仅当有任务在跑时常驻。 */}
          <GenerationQueuePlaceholder />
          {/* 生成中节点的呼吸微光（G14），本身不渲染任何 DOM。 */}
          <GenerationNodePulse />
          {/* 右侧常驻 AI 生成面板（G05）：受 showAIPanel 控制，由顶栏开关切换。 */}
          <NodeGeneratePanel docked />
          <SmartAgent isMobile={isMobile} canvasHostRef={canvasShellRef} />
        </div>
      </div>
    </div>
  );
}


