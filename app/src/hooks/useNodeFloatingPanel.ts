import { useCallback } from 'react';
import { useCanvasStore } from '@/store/useCanvasStore';

type PanelOpenState = boolean | ((open: boolean) => boolean);

function resolvePanelOpenState(current: boolean, next: PanelOpenState) {
  return typeof next === 'function' ? next(current) : next;
}

export function useNodeFloatingPanel<Kind extends string>(
  nodeId: string,
  focusNode?: () => void,
) {
  const floatingPanel = useCanvasStore((state) => state.floatingPanel);
  const openFloatingPanel = useCanvasStore((state) => state.openFloatingPanel);
  const closeFloatingPanel = useCanvasStore((state) => state.closeFloatingPanel);

  const activeKind = floatingPanel?.nodeId === nodeId
    ? (floatingPanel.kind as Kind)
    : null;

  const isOpen = useCallback((kind: Kind) => activeKind === kind, [activeKind]);

  const setOpen = useCallback((kind: Kind, next: PanelOpenState) => {
    const current = activeKind === kind;
    const shouldOpen = resolvePanelOpenState(current, next);
    if (shouldOpen) {
      focusNode?.();
      openFloatingPanel({ nodeId, kind });
      return;
    }
    closeFloatingPanel(nodeId, kind);
  }, [activeKind, closeFloatingPanel, focusNode, nodeId, openFloatingPanel]);

  const open = useCallback((kind: Kind) => {
    focusNode?.();
    openFloatingPanel({ nodeId, kind });
  }, [focusNode, nodeId, openFloatingPanel]);

  const close = useCallback((kind?: Kind) => {
    closeFloatingPanel(nodeId, kind);
  }, [closeFloatingPanel, nodeId]);

  return {
    activeKind,
    isOpen,
    setOpen,
    open,
    close,
  };
}
