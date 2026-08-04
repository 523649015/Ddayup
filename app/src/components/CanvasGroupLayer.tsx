import { useEffect, useMemo, useRef, useState } from 'react';
import { ViewportPortal } from '@xyflow/react';
import { Check, Grid3x3, Palette, Save, Ungroup, X } from 'lucide-react';
import { useCanvasStore } from '@/store/useCanvasStore';
import type { CanvasNode, NodeGroup, NodeType } from '@/types';

const GROUP_COLORS = ['#00d4aa', '#1a8cff', '#ff6b35', '#a855f7', '#fbbf24', '#ef4444', '#06b6d4', '#ec4899'];
const PAD = 34;

const NODE_SIZE: Record<NodeType, { width: number; height: number }> = {
  text: { width: 420, height: 220 },
  image: { width: 535, height: 380 },
  video: { width: 535, height: 380 },
  audio: { width: 360, height: 220 },
  post: { width: 560, height: 460 },
  storyboard: { width: 420, height: 260 },
  aiapp: { width: 360, height: 220 },
  threed: { width: 360, height: 300 },
  script: { width: 420, height: 260 },
  dcc: { width: 535, height: 380 },
  region: { width: 560, height: 460 },
  comfyui: { width: 420, height: 260 },
};

function nodeSize(node: CanvasNode) {
  const raw = node.data.params as Record<string, unknown> | undefined;
  const meta = raw?.imageMeta || raw?.videoMeta || raw?.captureMeta;
  if (meta && typeof meta === 'object') {
    const width = Number((meta as { width?: number }).width);
    const height = Number((meta as { height?: number }).height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      const max = node.type === 'video' || node.type === 'image' || node.type === 'dcc' || node.type === 'post' ? 535 : 420;
      const ratio = width / height;
      return ratio >= 1
        ? { width: max, height: Math.max(220, Math.round(max / ratio)) }
        : { width: Math.round(max * ratio), height: max };
    }
  }
  return NODE_SIZE[node.type];
}

export function getGroupBounds(group: NodeGroup, nodes: CanvasNode[]) {
  const members = nodes.filter((node) => group.nodeIds.includes(node.id));
  if (members.length === 0) return null;
  const left = Math.min(...members.map((node) => node.position.x));
  const top = Math.min(...members.map((node) => node.position.y));
  const right = Math.max(...members.map((node) => node.position.x + nodeSize(node).width));
  const bottom = Math.max(...members.map((node) => node.position.y + nodeSize(node).height));
  return {
    x: left - PAD,
    y: top - PAD - 18,
    width: right - left + PAD * 2,
    height: bottom - top + PAD * 2 + 18,
  };
}

interface CanvasGroupLayerProps {
  autoEditGroupId?: string | null;
  onAutoEditHandled?: (groupId: string) => void;
  /** 节点正在拖动时为 true：拖拽期间被拖节点位置尚未写回 store，重算分组包围盒无意义且浪费，故跳过。 */
  isDragging?: boolean;
}

interface DragState {
  groupId: string;
  startX: number;
  startY: number;
  originals: Record<string, { x: number; y: number }>;
  moved: boolean;
}

interface DragOffset {
  x: number;
  y: number;
}

export function CanvasGroupLayer({ autoEditGroupId = null, onAutoEditHandled, isDragging = false }: CanvasGroupLayerProps) {
  const canvas = useCanvasStore((state) => state.canvas);
  const groups = useCanvasStore((state) => state.groups);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const moveNodes = useCanvasStore((state) => state.moveNodes);
  const commitMoveHistory = useCanvasStore((state) => state.commitMoveHistory);
  const renameGroup = useCanvasStore((state) => state.renameGroup);
  const updateGroupColor = useCanvasStore((state) => state.updateGroupColor);
  const ungroup = useCanvasStore((state) => state.ungroup);
  const arrangeGroup = useCanvasStore((state) => state.arrangeGroup);
  const saveWorkflow = useCanvasStore((state) => state.saveWorkflow);
  const setSelectedNodeIds = useCanvasStore((state) => state.setSelectedNodeIds);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [colorGroupId, setColorGroupId] = useState<string | null>(null);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [dragPreviewOffset, setDragPreviewOffset] = useState<DragOffset>({ x: 0, y: 0 });
  const dragRef = useRef<DragState | null>(null);
  const dragPreviewOffsetRef = useRef<DragOffset>({ x: 0, y: 0 });
  const pendingOffsetRef = useRef<DragOffset | null>(null);
  const previewFrameRef = useRef<number | null>(null);

  // 计算每个分组的实际成员（按当前画布节点过滤，剔除 phantom ID），
  // 并把「真实成员数」带回 items，chip 直接使用 memberCount 显示，保证与主画布节点数严格同步。
  const items = useMemo(() => {
    const nodes = canvas?.nodes || [];
    const nodeIdSet = new Set(nodes.map((node) => node.id));
    return groups
      .map((group) => {
        const memberIds = group.nodeIds.filter((id) => nodeIdSet.has(id));
        if (memberIds.length === 0) return null;
        const bounds = getGroupBounds(group, nodes);
        if (!bounds) return null;
        return { group, bounds, memberCount: memberIds.length };
      })
      .filter((item): item is { group: NodeGroup; bounds: NonNullable<ReturnType<typeof getGroupBounds>>; memberCount: number } => item !== null);
  }, [canvas?.nodes, groups]);

  useEffect(() => {
    if (!autoEditGroupId) return;
    const targetGroup = groups.find((group) => group.id === autoEditGroupId);
    if (!targetGroup) return;
    setEditingGroupId(targetGroup.id);
    setDraftName(targetGroup.name);
    onAutoEditHandled?.(targetGroup.id);
  }, [autoEditGroupId, groups, onAutoEditHandled]);

  useEffect(() => () => {
    if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current);
    clearPreviewOffset(dragRef.current?.originals || null);
  }, []);

  if (!canvas) return null;

  function getNodeDom(nodeId: string) {
    return document.querySelector(`[data-id="${nodeId}"]`) as HTMLElement | null;
  }

  function applyPreviewOffset(originals: Record<string, { x: number; y: number }> | null, offset: DragOffset) {
    if (!originals) return;
    for (const nodeId of Object.keys(originals)) {
      const element = getNodeDom(nodeId);
      if (!element) continue;
      element.style.willChange = 'translate';
      element.style.translate = `${offset.x}px ${offset.y}px`;
    }
  }

  function clearPreviewOffset(originals: Record<string, { x: number; y: number }> | null) {
    if (!originals) return;
    for (const nodeId of Object.keys(originals)) {
      const element = getNodeDom(nodeId);
      if (!element) continue;
      element.style.translate = '';
      element.style.willChange = '';
    }
  }

  function flushPreviewOffset() {
    const dragState = dragRef.current;
    const offset = pendingOffsetRef.current;
    if (!dragState || !offset) return;
    applyPreviewOffset(dragState.originals, offset);
    dragPreviewOffsetRef.current = offset;
    setDragPreviewOffset(offset);
    pendingOffsetRef.current = null;
  }

  function schedulePreviewOffset(nextOffset: DragOffset) {
    pendingOffsetRef.current = nextOffset;
    if (previewFrameRef.current !== null) return;
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null;
      flushPreviewOffset();
    });
  }

  function beginDrag(event: React.PointerEvent, group: NodeGroup) {
    if (event.button !== 0) return;
    if (!canvas) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedNodeIds(group.nodeIds);

    const originals: Record<string, { x: number; y: number }> = {};
    for (const node of canvas.nodes) {
      if (group.nodeIds.includes(node.id)) {
        originals[node.id] = { ...node.position };
      }
    }

    dragRef.current = {
      groupId: group.id,
      startX: event.clientX,
      startY: event.clientY,
      originals,
      moved: false,
    };
    setDraggingGroupId(group.id);
    dragPreviewOffsetRef.current = { x: 0, y: 0 };
    setDragPreviewOffset({ x: 0, y: 0 });
  }

  function drag(event: React.PointerEvent) {
    const dragState = dragRef.current;
    if (!dragState) return;
    event.preventDefault();
    event.stopPropagation();

    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    dragState.moved = dragState.moved || Math.abs(dx) > 1 || Math.abs(dy) > 1;
    schedulePreviewOffset({ x: dx, y: dy });
  }

  function endDrag() {
    const dragState = dragRef.current;
    if (!dragState) return;

    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    const finalOffset = pendingOffsetRef.current || dragPreviewOffsetRef.current;
    pendingOffsetRef.current = null;
    clearPreviewOffset(dragState.originals);
    dragRef.current = null;
    setDraggingGroupId(null);
    dragPreviewOffsetRef.current = { x: 0, y: 0 };
    setDragPreviewOffset({ x: 0, y: 0 });
    if (dragState.moved) {
      const positions: Record<string, { x: number; y: number }> = {};
      for (const [nodeId, position] of Object.entries(dragState.originals)) {
        positions[nodeId] = { x: position.x + finalOffset.x, y: position.y + finalOffset.y };
      }
      moveNodes(positions);
      commitMoveHistory();
    }
  }

  function startRename(group: NodeGroup) {
    setEditingGroupId(group.id);
    setDraftName(group.name);
  }

  function commitRename(groupId: string) {
    const next = draftName.trim();
    if (next) renameGroup(groupId, next);
    setEditingGroupId(null);
  }

  // 节点拖动期间：被拖节点位置尚未写回 store，分组包围盒无法跟随，重算无意义；
  // 且能顺带避免分组层在拖拽起止时的额外 DOM 协调。纯点击（isDragging=false）不受影响。
  if (isDragging) return null;

  return (
    <ViewportPortal>
      {items.map(({ group, bounds, memberCount }) => {
        const selectedInGroup = selectedNodeIds.some((id) => group.nodeIds.includes(id));
        const isDragging = draggingGroupId === group.id;
        const dragCursor = isDragging ? 'cursor-grabbing' : 'cursor-grab';
        const offsetX = isDragging ? dragPreviewOffset.x : 0;
        const offsetY = isDragging ? dragPreviewOffset.y : 0;

        return (
          <div
            key={group.id}
            className={`nodrag absolute rounded-[28px] border border-dashed transition-[box-shadow,border-color] duration-150 ${
              selectedInGroup ? 'shadow-[0_0_0_3px_rgba(255,255,255,0.06)]' : ''
            }`}
            style={{
              transform: `translate(${bounds.x + offsetX}px, ${bounds.y + offsetY}px)`,
              width: bounds.width,
              height: bounds.height,
              borderColor: group.color,
              background: 'transparent',
              pointerEvents: 'none',
            }}
          >
            <div
              className={`pointer-events-auto absolute left-0 right-0 top-[-8px] h-4 ${dragCursor}`}
              onPointerDown={(event) => beginDrag(event, group)}
              onPointerMove={drag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
            />
            <div
              className={`pointer-events-auto absolute bottom-[-8px] left-0 right-0 h-4 ${dragCursor}`}
              onPointerDown={(event) => beginDrag(event, group)}
              onPointerMove={drag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
            />
            <div
              className={`pointer-events-auto absolute bottom-4 left-[-8px] top-4 w-4 ${dragCursor}`}
              onPointerDown={(event) => beginDrag(event, group)}
              onPointerMove={drag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
            />
            <div
              className={`pointer-events-auto absolute bottom-4 right-[-8px] top-4 w-4 ${dragCursor}`}
              onPointerDown={(event) => beginDrag(event, group)}
              onPointerMove={drag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
            />

            <div
              className={`pointer-events-auto absolute left-4 top-[-18px] flex min-h-9 max-w-[calc(100%-32px)] items-center gap-2 rounded-xl border border-white/10 bg-[#161b22]/96 px-2.5 py-1.5 text-xs text-[#e6edf3] shadow-xl backdrop-blur ${dragCursor}`}
              onPointerDown={(event) => beginDrag(event, group)}
              onPointerMove={drag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
              onDoubleClick={() => startRename(group)}
              title="拖动整组，双击重命名"
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: group.color }} />
              {editingGroupId === group.id ? (
                <input
                  data-testid={`canvas-group-name-input-${group.id}`}
                  className="w-28 rounded-md border border-[#3d444d] bg-[#0d1117] px-1.5 py-0.5 text-xs outline-none"
                  value={draftName}
                  autoFocus
                  onChange={(event) => setDraftName(event.target.value)}
                  onBlur={() => commitRename(group.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename(group.id);
                    if (event.key === 'Escape') setEditingGroupId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  data-testid={`canvas-group-chip-${group.id}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setSelectedNodeIds(group.nodeIds)}
                  className="max-w-32 truncate font-semibold"
                >
                  {group.name}
                </button>
              )}
              <span
                className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-[#b8c0cc]"
                data-testid={`canvas-group-count-${group.id}`}
                title={group.nodeIds.length !== memberCount
                  ? `${memberCount} 个有效节点（已过滤 ${group.nodeIds.length - memberCount} 个失效 ID）`
                  : `${memberCount} 个节点`}
              >
                {memberCount}
              </span>
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setColorGroupId(colorGroupId === group.id ? null : group.id)}
                title="调整颜色"
                className="rounded-md p-1 hover:bg-white/10"
              >
                <Palette className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => arrangeGroup(group.id, 'grid')}
                title="自动排列"
                className="rounded-md p-1 hover:bg-white/10"
              >
                <Grid3x3 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  setSelectedNodeIds(group.nodeIds);
                  queueMicrotask(() => saveWorkflow(group.name, '由组内节点保存的工作流'));
                }}
                title="保存为工作流"
                className="rounded-md p-1 hover:bg-white/10"
              >
                <Save className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => ungroup(group.id)}
                title="解组"
                className="rounded-md p-1 hover:bg-white/10"
              >
                <Ungroup className="h-3.5 w-3.5" />
              </button>
              {colorGroupId === group.id ? (
                <div className="absolute left-0 top-11 grid grid-cols-4 gap-1 rounded-xl border border-[#30363d] bg-[#161b22] p-2 shadow-2xl">
                  {GROUP_COLORS.map((color) => (
                    <button
                      type="button"
                      key={color}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => {
                        updateGroupColor(group.id, color);
                        setColorGroupId(null);
                      }}
                      className="h-5 w-5 rounded-full transition-transform hover:scale-110"
                      style={{ background: color }}
                      title={color}
                    />
                  ))}
                </div>
              ) : null}
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setColorGroupId(null)}
                title={colorGroupId === group.id ? '确认颜色' : '关闭颜色面板'}
                className="rounded-md p-1 hover:bg-white/10"
              >
                {colorGroupId === group.id ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        );
      })}
    </ViewportPortal>
  );
}
