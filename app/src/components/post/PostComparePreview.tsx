import { Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

export interface PostComparePreviewProps {
  mediaKind: 'image' | 'video';
  beforeUrl: string;
  afterUrl?: string;
  beforeLabel?: string;
  afterLabel?: string;
  beforeStyle?: CSSProperties;
  afterStyle?: CSSProperties;
  beforeOverlay?: ReactNode;
  afterOverlay?: ReactNode;
  className?: string;
  containerTestId?: string;
  dividerTestId?: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function PostComparePreview({
  mediaKind,
  beforeUrl,
  afterUrl,
  beforeLabel = '原始素材',
  afterLabel = '效果预览',
  beforeStyle,
  afterStyle,
  beforeOverlay,
  afterOverlay,
  className = '',
  containerTestId,
  dividerTestId,
}: PostComparePreviewProps) {
  const [ratio, setRatio] = useState(0.56);
  const [paused, setPaused] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const beforeVideoRef = useRef<HTMLVideoElement | null>(null);
  const afterVideoRef = useRef<HTMLVideoElement | null>(null);

  const canCompare = Boolean(beforeUrl && (afterUrl || afterStyle || afterOverlay));
  const dividerStyle = useMemo(() => ({ left: `${ratio * 100}%` }), [ratio]);
  const afterClipStyle = useMemo(() => ({ clipPath: `inset(0 0 0 ${ratio * 100}%)` }), [ratio]);

  useEffect(() => {
    if (mediaKind !== 'video') return;
    const videos = [beforeVideoRef.current, afterVideoRef.current].filter(Boolean) as HTMLVideoElement[];
    if (videos.length === 0) return;
    if (paused) {
      videos.forEach((video) => video.pause());
      return;
    }
    videos.forEach((video) => {
      void video.play().catch(() => undefined);
    });
  }, [afterUrl, beforeUrl, mediaKind, paused]);

  function updateRatio(clientX: number) {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    if (!rect.width) return;
    setRatio(clamp((clientX - rect.left) / rect.width, 0.04, 0.96));
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    updateRatio(event.clientX);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    updateRatio(event.clientX);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const baseMediaClass = 'h-full w-full object-cover';

  return (
    <div ref={hostRef} className={`relative overflow-hidden rounded-[20px] bg-[#111] ${className}`} data-testid={containerTestId}>
      {mediaKind === 'video' ? (
        <>
          <video
            ref={beforeVideoRef}
            src={beforeUrl}
            className={baseMediaClass}
            style={beforeStyle}
            muted
            playsInline
            autoPlay={!paused}
            loop
            preload="metadata"
          />
          {canCompare ? (
            <div className="pointer-events-none absolute inset-0" style={afterClipStyle}>
              <video
                ref={afterVideoRef}
                src={afterUrl || beforeUrl}
                className={baseMediaClass}
                style={afterStyle}
                muted
                playsInline
                autoPlay={!paused}
                loop
                preload="metadata"
              />
            </div>
          ) : null}
        </>
      ) : (
        <>
          <img src={beforeUrl} alt={beforeLabel} className={baseMediaClass} style={beforeStyle} />
          {canCompare ? (
            <div className="pointer-events-none absolute inset-0" style={afterClipStyle}>
              <img src={afterUrl || beforeUrl} alt={afterLabel} className={baseMediaClass} style={afterStyle} />
            </div>
          ) : null}
        </>
      )}

      {beforeOverlay ? <div className="pointer-events-none absolute inset-0">{beforeOverlay}</div> : null}
      {canCompare && afterOverlay ? <div className="pointer-events-none absolute inset-0" style={afterClipStyle}>{afterOverlay}</div> : null}

      <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white">
        {beforeLabel}
      </div>
      <div className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white">
        {afterLabel}
      </div>

      {mediaKind === 'video' ? (
        <button
          type="button"
          className="nodrag absolute bottom-3 left-3 z-30 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/66 px-3 py-1.5 text-[11px] font-medium text-white backdrop-blur transition hover:bg-black/78"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setPaused((current) => !current);
          }}
          data-testid="post-compare-play-toggle"
        >
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          {paused ? '继续预览' : '暂停预览'}
        </button>
      ) : null}

      {canCompare ? (
        <>
          <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.12)]" style={dividerStyle} />
          <div
            role="slider"
            aria-label="post-compare-divider"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(ratio * 100)}
            data-testid={dividerTestId}
            className="nodrag absolute inset-y-0 z-30 w-10 -translate-x-1/2 cursor-ew-resize"
            style={dividerStyle}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            <div className="absolute left-1/2 top-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/68 text-xs font-semibold text-white shadow-xl backdrop-blur">
              对比
            </div>
          </div>
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[11px] text-[#f5f5f5]">
            拖动中线查看处理前后差异
          </div>
        </>
      ) : null}
    </div>
  );
}
