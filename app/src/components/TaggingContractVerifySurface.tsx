import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { taggingContractNodeTypes } from '@/nodes/taggingContractNodeTypes';
import { patchDebugBridge } from '@/services/debugBridge';
import { useCanvasStore } from '@/store/useCanvasStore';

const FLOW_VIEWPORT_STYLE: CSSProperties = { width: '100%', height: '100%', minWidth: '1px', minHeight: '1px' };

function TaggingContractVerifySurfaceFlow({ onReady }: { onReady?: () => void }) {
  const canvas = useCanvasStore((state) => state.canvas);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const pendingViewportFocusNodeId = useCanvasStore((state) => state.pendingViewportFocusNodeId);
  const pendingViewportFocusNonce = useCanvasStore((state) => state.pendingViewportFocusNonce);
  const consumeViewportFocus = useCanvasStore((state) => state.consumeViewportFocus);
  const removeNode = useCanvasStore((state) => state.removeNode);
  const moveNodes = useCanvasStore((state) => state.moveNodes);
  const deselectAll = useCanvasStore((state) => state.deselectAll);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);
  const removeEdge = useCanvasStore((state) => state.removeEdge);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const setCanvasViewport = useCanvasStore((state) => state.setCanvasViewport);
  const { fitView, getViewport, setCenter } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const canvasVersion = canvas?.updatedAt || 0;
  const flowHostRef = useRef<HTMLDivElement | null>(null);
  const pendingPositionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const moveFrameRef = useRef<number | null>(null);
  const [isFlowViewportReady, setIsFlowViewportReady] = useState(false);
  const readyPublishedRef = useRef(false);

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

  useEffect(() => {
    if (!isFlowViewportReady) return;
    syncCanvasViewport();
    const host = flowHostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      syncCanvasViewport();
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [isFlowViewportReady, syncCanvasViewport]);

  const rfNodes = useMemo(() => {
    if (!canvas) return [];
    return canvas.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      className: `hmdao-node hmdao-node-${node.type}`,
      position: node.position,
      selectable: true,
      draggable: true,
      data: { ...node.data, __nodeType: node.type },
    }));
  }, [canvas, canvasVersion]);

  const rfEdges = useMemo(() => {
    if (!canvas) return [];
    return canvas.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
      type: 'smoothstep',
      animated: Boolean(
        edge.targetHandle
        && (
          edge.targetHandle.startsWith('image-reference')
          || edge.targetHandle.startsWith('video-image-reference')
          || edge.targetHandle.startsWith('video-video-reference')
        ),
      ),
    } satisfies Edge));
  }, [canvas, canvasVersion]);
  const hasSeededCanvas = Boolean(canvas && rfNodes.length > 0);
  const surfaceReady = isFlowViewportReady || hasSeededCanvas;

  const applyFlowSelection = useCallback((nodeIds: string[]) => {
    setSelectedNodeIds(nodeIds);
  }, [setSelectedNodeIds]);

  useEffect(() => {
    if (!isFlowViewportReady || !pendingViewportFocusNodeId) return;
    const targetNode = canvas?.nodes.find((node) => node.id === pendingViewportFocusNodeId);
    if (!targetNode) return;
    applyFlowSelection([targetNode.id]);
    const viewport = getViewport();
    const rafId = window.requestAnimationFrame(() => {
      setCenter(targetNode.position.x + 260, targetNode.position.y + 180, {
        zoom: Math.max(viewport.zoom || 1, 0.9),
        duration: 220,
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

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === 'remove') removeNode(change.id);
      if (change.type === 'position' && change.position) {
        pendingPositionsRef.current[change.id] = change.position;
      }
    }
    if (Object.keys(pendingPositionsRef.current).length === 0 || moveFrameRef.current !== null) return;
    moveFrameRef.current = window.requestAnimationFrame(() => {
      moveFrameRef.current = null;
      const next = pendingPositionsRef.current;
      pendingPositionsRef.current = {};
      moveNodes(next);
    });
  }, [moveNodes, removeNode]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const change of changes) {
      if (change.type === 'remove') removeEdge(change.id);
    }
  }, [removeEdge]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    addEdge(connection.source, connection.target, {
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle,
    });
  }, [addEdge]);

  const onNodeClick = useCallback((event: ReactMouseEvent, node: Node) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) {
      applyFlowSelection([...selectedNodeIds, node.id]);
      return;
    }
    applyFlowSelection([node.id]);
  }, [applyFlowSelection, selectedNodeIds]);

  const onPaneClick = useCallback(() => {
    deselectAll();
  }, [deselectAll]);

  useEffect(() => {
    patchDebugBridge({
      reactFlow: {
        fitView,
        getViewport,
        setCenter,
      },
    });
  }, [fitView, getViewport, setCenter]);

  useEffect(() => {
    if (!nodesInitialized) return;
    setIsFlowViewportReady(true);
  }, [nodesInitialized]);

  useEffect(() => {
    if (!surfaceReady || readyPublishedRef.current) return;
    readyPublishedRef.current = true;
    onReady?.();
  }, [onReady, surfaceReady]);

  return (
    <div
      ref={flowHostRef}
      data-testid="tagging-contract-surface"
      data-ready={surfaceReady ? 'true' : 'false'}
      className="h-full w-full pt-12"
    >
      {canvas ? (
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={taggingContractNodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onMove={(_, viewport) => {
            syncCanvasViewport(viewport);
          }}
          onInit={() => {
            setIsFlowViewportReady(true);
            syncCanvasViewport();
          }}
          fitView
          minZoom={0.1}
          maxZoom={2.5}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          defaultViewport={canvas.viewport ? {
            x: canvas.viewport.x,
            y: canvas.viewport.y,
            zoom: canvas.viewport.zoom,
          } : undefined}
          style={FLOW_VIEWPORT_STYLE}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} color="rgba(255,255,255,0.08)" />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-[#9cb0bf]">
          Preparing tagging-contract canvas...
        </div>
      )}
    </div>
  );
}

export default function TaggingContractVerifySurface({ onReady }: { onReady?: () => void }) {
  return (
    <ReactFlowProvider>
      <TaggingContractVerifySurfaceFlow onReady={onReady} />
    </ReactFlowProvider>
  );
}
