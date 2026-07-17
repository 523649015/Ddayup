import { useCallback, useMemo, type HTMLAttributes } from 'react';
import { useCanvasStore } from '@/store/useCanvasStore';

type InteractionEvent = { stopPropagation: () => void };

export type GuardedPanelInteractionProps = Pick<
  HTMLAttributes<HTMLDivElement>,
  | 'onPointerDownCapture'
  | 'onPointerUpCapture'
  | 'onMouseDownCapture'
  | 'onMouseUpCapture'
  | 'onTouchStartCapture'
  | 'onPointerDown'
  | 'onPointerUp'
  | 'onMouseDown'
  | 'onMouseUp'
  | 'onTouchStart'
  | 'onClick'
  | 'onWheel'
>;

function keepNodeSelected(nodeId: string, durationMs = 320) {
  const store = useCanvasStore.getState();
  store.setSelectionGuard?.(durationMs);
  const selectedNodeIds = Array.isArray(store.selectedNodeIds) ? store.selectedNodeIds : [];
  if (selectedNodeIds.length === 1 && selectedNodeIds[0] === nodeId) {
    return;
  }
  store.setSelectedNodeIds([nodeId]);
}

export function useGuardedFloatingPanelInteraction(nodeId: string) {
  const ensureFocused = useCallback((durationMs = 320) => {
    keepNodeSelected(nodeId, durationMs);
  }, [nodeId]);

  const markInteraction = useCallback((durationMs = 320) => {
    keepNodeSelected(nodeId, durationMs);
  }, [nodeId]);

  const sustainInteraction = useCallback((durationMs = 320) => {
    keepNodeSelected(nodeId, durationMs);
    window.setTimeout(() => keepNodeSelected(nodeId, durationMs), 0);
    window.setTimeout(() => keepNodeSelected(nodeId, durationMs), 72);
  }, [nodeId]);

  const stopInteraction = useCallback((event: InteractionEvent, durationMs = 320) => {
    keepNodeSelected(nodeId, durationMs);
    event.stopPropagation();
  }, [nodeId]);

  const panelInteractionProps = useMemo<GuardedPanelInteractionProps>(() => ({
    onPointerDownCapture: stopInteraction,
    onPointerUpCapture: stopInteraction,
    onMouseDownCapture: stopInteraction,
    onMouseUpCapture: stopInteraction,
    onTouchStartCapture: stopInteraction,
    onPointerDown: stopInteraction,
    onPointerUp: stopInteraction,
    onMouseDown: stopInteraction,
    onMouseUp: stopInteraction,
    onTouchStart: stopInteraction,
    onClick: stopInteraction,
    onWheel: stopInteraction,
  }), [stopInteraction]);

  return {
    ensureFocused,
    markInteraction,
    sustainInteraction,
    stopInteraction,
    panelInteractionProps,
  };
}
