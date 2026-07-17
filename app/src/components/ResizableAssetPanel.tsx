import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import {
  X, Minus, Maximize, Minimize, ChevronLeft,
} from 'lucide-react';

/* ===== Types ===== */
type PanelState = 'normal' | 'fullscreen' | 'collapsed';
type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface DragInfo {
  edge: ResizeEdge;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  startLeft: number;
  startTop: number;
}

interface ResizableAssetPanelProps {
  children: ReactNode;
  isOpen: boolean;
  onClose: () => void;
  title?: string;
}

/* ===== Constants ===== */
const MIN_W = 420;
const MIN_H = 340;
const COLLAPSED_TAB_W = 40;
const SNAP_THRESHOLD = 0.78; // 78% → snap to fullscreen (approximately 4/5)
const TRANSITION_DURATION = 250;
const RESIZE_HANDLE_SIZE = 6; // edge handle thickness
const CORNER_HANDLE_SIZE = 14; // corner handle size
const COLLAPSED_TOP = 88;

export function ResizableAssetPanel({ children, isOpen, onClose, title = '资产库' }: ResizableAssetPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelState, setPanelState] = useState<PanelState>('normal');
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragInfo, setDragInfo] = useState<DragInfo | null>(null);
  const [prevNormal, setPrevNormal] = useState<{ w: number; h: number; x: number; y: number } | null>(null);

  // Initialize panel position & size
  useEffect(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.max(MIN_W, Math.round(vw * 0.7));
    const h = Math.max(MIN_H, Math.round(vh * 0.82));
    const x = Math.round((vw - w) / 2);
    const y = Math.round((vh - h) / 2);
    setSize({ w, h });
    setPos({ x, y });
  }, []);

  // Resize start handler
  const handleResizeStart = useCallback(
    (edge: ResizeEdge) => (e: React.MouseEvent | React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragInfo({
        edge,
        startX: e.clientX,
        startY: e.clientY,
        startW: size.w,
        startH: size.h,
        startLeft: pos.x,
        startTop: pos.y,
      });
    },
    [size, pos],
  );

  // Resize move & end
  useEffect(() => {
    if (!dragInfo) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragInfo.startX;
      const dy = e.clientY - dragInfo.startY;
      const { edge, startW, startH, startLeft, startTop } = dragInfo;

      let w = startW;
      let h = startH;
      let x = startLeft;
      let y = startTop;

      // Width
      if (edge.includes('e')) w = Math.max(MIN_W, startW + dx);
      if (edge.includes('w')) {
        const proposed = startW - dx;
        if (proposed >= MIN_W) {
          w = proposed;
          x = startLeft + dx;
        } else {
          w = MIN_W;
          x = startLeft + startW - MIN_W;
        }
      }

      // Height
      if (edge.includes('s')) h = Math.max(MIN_H, startH + dy);
      if (edge.includes('n')) {
        const proposed = startH - dy;
        if (proposed >= MIN_H) {
          h = proposed;
          y = startTop + dy;
        } else {
          h = MIN_H;
          y = startTop + startH - MIN_H;
        }
      }

      setSize({ w, h });
      setPos({ x, y });
    };

    const handleMouseUp = () => {
      setDragInfo(null);
      // Check fullscreen snap
      setSize((s) => {
        setPos((p) => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          if (s.w >= vw * SNAP_THRESHOLD && s.h >= vh * SNAP_THRESHOLD) {
            setPrevNormal({ w: s.w, h: s.h, x: p.x, y: p.y });
            setTimeout(() => setPanelState('fullscreen'), 0);
          }
          return p;
        });
        return s;
      });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragInfo]);

  // Toggle fullscreen
  const toggleFullscreen = useCallback(() => {
    if (panelState === 'fullscreen') {
      if (prevNormal) {
        setSize(prevNormal);
        setPos({ x: prevNormal.x, y: prevNormal.y });
      }
      setPanelState('normal');
    } else {
      setPrevNormal({ w: size.w, h: size.h, x: pos.x, y: pos.y });
      setPanelState('fullscreen');
    }
  }, [panelState, prevNormal, size, pos]);

  // Toggle collapse
  const toggleCollapse = useCallback(() => {
    if (panelState === 'collapsed') {
      if (prevNormal) {
        setSize(prevNormal);
        setPos({ x: prevNormal.x, y: prevNormal.y });
      }
      setPanelState('normal');
    } else {
      if (panelState === 'normal') {
        setPrevNormal({ w: size.w, h: size.h, x: pos.x, y: pos.y });
      }
      setPanelState('collapsed');
    }
  }, [panelState, prevNormal, size, pos]);

  // Handle Esc key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && panelState !== 'collapsed') {
        toggleCollapse();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, panelState, toggleCollapse]);

  // Window resize: keep panel in bounds
  useEffect(() => {
    const handleWindowResize = () => {
      if (panelState !== 'normal') return;
      setPos((p) => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        return {
          x: Math.max(0, Math.min(p.x, vw - COLLAPSED_TAB_W)),
          y: Math.max(0, Math.min(p.y, vh - 40)),
        };
      });
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [panelState]);

  const isTransitioning = !dragInfo;

  // Fullscreen position & size
  const fullscreenStyle = {
    left: 0,
    top: 0,
    width: '100vw',
    height: '100vh',
    borderRadius: 0,
  };

  // Collapsed position
  const collapsedStyle = {
    left: window.innerWidth - COLLAPSED_TAB_W,
    top: COLLAPSED_TOP,
    width: COLLAPSED_TAB_W,
    height: 48,
  };

  // Normal / active position
  const normalStyle = {
    left: pos.x,
    top: pos.y,
    width: size.w || 900,
    height: size.h || 680,
  };

  const getPanelStyle = (): React.CSSProperties => {
    switch (panelState) {
      case 'fullscreen':
        return fullscreenStyle;
      case 'collapsed':
        return collapsedStyle;
      default:
        return normalStyle;
    }
  };

  const panelStyle = getPanelStyle();

  // ---- Edge resize handles ----
  const edgeHandles: { edge: ResizeEdge; className: string }[] = [
    { edge: 'n', className: 'absolute top-0 left-2 right-2 cursor-ns-resize' },
    { edge: 's', className: 'absolute bottom-0 left-2 right-2 cursor-ns-resize' },
    { edge: 'e', className: 'absolute right-0 top-2 bottom-2 cursor-ew-resize' },
    { edge: 'w', className: 'absolute left-0 top-2 bottom-2 cursor-ew-resize' },
  ];

  const cornerHandles: { edge: ResizeEdge; className: string }[] = [
    { edge: 'nw', className: 'absolute top-0 left-0 cursor-nwse-resize' },
    { edge: 'ne', className: 'absolute top-0 right-0 cursor-nesw-resize' },
    { edge: 'sw', className: 'absolute bottom-0 left-0 cursor-nesw-resize' },
    { edge: 'se', className: 'absolute bottom-0 right-0 cursor-nwse-resize' },
  ];

  const transitionStyle: React.CSSProperties = isTransitioning
    ? { transition: `left ${TRANSITION_DURATION}ms ease-in-out, top ${TRANSITION_DURATION}ms ease-in-out, width ${TRANSITION_DURATION}ms ease-in-out, height ${TRANSITION_DURATION}ms ease-in-out, border-radius ${TRANSITION_DURATION}ms ease-in-out` }
    : {};

  return (
    <>
      {/* Backdrop - only in normal mode */}
      {isOpen && panelState === 'normal' && (
        <div
          className="fixed inset-0 bg-black/20 z-40"
          onClick={toggleCollapse}
          aria-hidden="true"
        />
      )}

      {/* Panel */}
      <div
        ref={panelRef}
        className={
          `fixed z-50 flex flex-col overflow-hidden shadow-2xl ` +
          `border border-[#21262d] ` +
          (panelState === 'fullscreen' ? 'rounded-none' : 'rounded-xl') +
          (panelState === 'collapsed' ? ' rounded-r-xl rounded-l-none' : '')
        }
        style={{
          ...panelStyle,
          ...transitionStyle,
          backgroundColor: '#0d1117',
          minWidth: panelState === 'collapsed' ? COLLAPSED_TAB_W : MIN_W,
          minHeight: panelState === 'collapsed' ? 48 : MIN_H,
          willChange: isTransitioning ? 'left, top, width, height' : undefined,
        }}
      >
        {/* Collapsed Tab */}
        {panelState === 'collapsed' ? (
          <button
            onClick={toggleCollapse}
            className="flex-1 flex items-center justify-center text-[#8b949e] hover:text-[#00d4aa] hover:bg-[#161b22] transition-colors rounded-r-xl"
            title="展开资产库"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        ) : (
          <>
            {/* Title Bar */}
            <div
              className="flex items-center justify-between px-4 py-2.5 border-b border-[#21262d] bg-[#0d1117] shrink-0 select-none cursor-grab active:cursor-grabbing"
              onMouseDown={(e) => {
                // Don't start drag when clicking buttons
                const target = e.target as HTMLElement;
                if (target.closest('button')) return;
                if (panelState === 'fullscreen') return;
                const startX = e.clientX;
                const startY = e.clientY;
                const startLeft = pos.x;
                const startTop = pos.y;

                const handleMove = (ev: MouseEvent) => {
                  setPos({
                    x: Math.max(-200, startLeft + ev.clientX - startX),
                    y: Math.max(0, startTop + ev.clientY - startY),
                  });
                };
                const handleUp = () => {
                  document.removeEventListener('mousemove', handleMove);
                  document.removeEventListener('mouseup', handleUp);
                };
                document.addEventListener('mousemove', handleMove);
                document.addEventListener('mouseup', handleUp);
              }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[#e6edf3] text-sm font-semibold truncate">{title}</span>
                {panelState === 'normal' && (
                  <span className="text-[#6e7681] text-[10px]">
                    {Math.round(size.w)}×{Math.round(size.h)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {/* Collapse */}
                <button
                  onClick={toggleCollapse}
                  className="w-7 h-7 rounded-lg hover:bg-[#21262d] flex items-center justify-center text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
                  title="收起面板"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                {/* Fullscreen Toggle */}
                <button
                  onClick={toggleFullscreen}
                  className="w-7 h-7 rounded-lg hover:bg-[#21262d] flex items-center justify-center text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
                  title={panelState === 'fullscreen' ? '退出全屏' : '全屏'}
                >
                  {panelState === 'fullscreen' ? (
                    <Minimize className="w-3.5 h-3.5" />
                  ) : (
                    <Maximize className="w-3.5 h-3.5" />
                  )}
                </button>
                {/* Close */}
                <button
                  onClick={onClose}
                  className="w-7 h-7 rounded-lg hover:bg-[#ef4444]/20 flex items-center justify-center text-[#8b949e] hover:text-[#ef4444] transition-colors"
                  title="关闭资产库"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-hidden min-w-0 min-h-0">
              {children}
            </div>

            {/* Edge Resize Handles (hidden in fullscreen) */}
            {panelState !== 'fullscreen' && (
              <>
                {edgeHandles.map(({ edge, className }) => (
                  <div
                    key={edge}
                    className={className}
                    style={{
                      height: edge === 'n' || edge === 's' ? RESIZE_HANDLE_SIZE : undefined,
                      width: edge === 'e' || edge === 'w' ? RESIZE_HANDLE_SIZE : undefined,
                      zIndex: 10,
                    }}
                    onMouseDown={handleResizeStart(edge)}
                  />
                ))}
                {cornerHandles.map(({ edge, className }) => (
                  <div
                    key={edge}
                    className={className}
                    style={{
                      width: CORNER_HANDLE_SIZE,
                      height: CORNER_HANDLE_SIZE,
                      zIndex: 10,
                    }}
                    onMouseDown={handleResizeStart(edge)}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
