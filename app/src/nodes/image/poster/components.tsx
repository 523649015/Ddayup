import type { CSSProperties } from 'react';
import type { GuardedPanelInteractionProps } from '@/hooks/useGuardedFloatingPanelInteraction';
import { toRenderableAssetUrl } from '@/services/generation';
import type { PosterLayoutConfig } from './types';
import {
  getPosterElementFrameStyle,
  getPosterElementPaintStyle,
  getPosterElementText,
  getPosterOverlayShadeClass,
  normalizePosterEditorState,
} from './utils';

function stopCanvasInteraction(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

export function PosterLayoutPanel({
  layout,
  onChange,
  onOpenEditor,
  panelInteractionProps,
  onInteract,
}: {
  layout: PosterLayoutConfig;
  onChange: (patch: Partial<PosterLayoutConfig>) => void;
  onOpenEditor: () => void;
  panelInteractionProps: GuardedPanelInteractionProps;
  onInteract: (event: { stopPropagation: () => void }) => void;
}) {
  return (
    <div
      className="mx-4 mb-3 rounded-xl border border-[#404040] bg-[#202020] p-3 nodrag nopan nowheel"
      {...panelInteractionProps}
      onPointerDown={panelInteractionProps.onPointerDown || onInteract}
      onMouseDown={panelInteractionProps.onMouseDown || onInteract}
      onTouchStart={panelInteractionProps.onTouchStart || onInteract}
      onWheel={panelInteractionProps.onWheel || onInteract}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[#f3f3f3]">可编辑海报层</div>
          <div className="mt-1 text-xs leading-5 text-[#a9a9a9]">
            生成无字全幅底图，中文标题和排版作为独立图层保留，可导出 SVG 后导入 Figma 继续编辑。
          </div>
        </div>
        <label className="flex shrink-0 items-center gap-2 rounded-full bg-[#303030] px-3 py-1 text-xs text-[#d8d8d8]">
          <input
            data-testid="image-poster-enabled"
            type="checkbox"
            checked={layout.enabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
          />
          开启
        </label>
      </div>

      {layout.enabled ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-[#3d3d3d] bg-[#171717] px-3 py-2">
          <div className="text-xs text-[#aeb5bc]">点击打开新窗口，直接拖拽调整文字、Logo、角标位置，保存后可继续导出 SVG 到 Figma。</div>
          <button type="button" onClick={onOpenEditor} className="rounded-md border border-[#4b4b4b] px-3 py-1.5 text-xs text-white hover:bg-[#2c2c2c]" data-testid="image-poster-open-editor">打开编辑器</button>
        </div>
      ) : null}

      {layout.enabled ? (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <label className="grid gap-1 text-xs text-[#d9d9d9] md:col-span-2">
            <span>主标题</span>
            <input
              data-testid="image-poster-title"
              value={layout.title}
              onChange={(event) => onChange({ title: event.target.value })}
              className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1.5 outline-none"
            />
          </label>
          <label className="grid gap-1 text-xs text-[#d9d9d9]">
            <span>副标题</span>
            <input
              value={layout.subtitle}
              onChange={(event) => onChange({ subtitle: event.target.value })}
              className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1.5 outline-none"
            />
          </label>
          <label className="grid gap-1 text-xs text-[#d9d9d9]">
            <span>眉标</span>
            <input
              value={layout.tagline}
              onChange={(event) => onChange({ tagline: event.target.value })}
              className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1.5 outline-none"
            />
          </label>
          <label className="grid gap-1 text-xs text-[#d9d9d9]">
            <span>底部信息</span>
            <input
              value={layout.footer}
              onChange={(event) => onChange({ footer: event.target.value })}
              className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1.5 outline-none"
            />
          </label>
          <label className="grid gap-1 text-xs text-[#d9d9d9]">
            <span>Logo 文案</span>
            <input
              data-testid="image-poster-logo"
              value={layout.logoText}
              onChange={(event) => onChange({ logoText: event.target.value })}
              className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1.5 outline-none"
            />
          </label>
          <label className="grid gap-1 text-xs text-[#d9d9d9]">
            <span>右上徽章</span>
            <input
              data-testid="image-poster-badge"
              value={layout.badgeText}
              onChange={(event) => onChange({ badgeText: event.target.value })}
              className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1.5 outline-none"
            />
          </label>
          <label className="grid gap-1 text-xs text-[#d9d9d9]">
            <span>角标编号</span>
            <input
              data-testid="image-poster-corner"
              value={layout.cornerText}
              onChange={(event) => onChange({ cornerText: event.target.value })}
              className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1.5 outline-none"
            />
          </label>
          <label className="grid gap-1 text-xs text-[#d9d9d9]">
            <span>排版位置</span>
            <select
              value={layout.align}
              onChange={(event) => onChange({ align: event.target.value as PosterLayoutConfig["align"] })}
              className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1.5 outline-none"
            >
              <option value="left">左对齐</option>
              <option value="center">居中</option>
              <option value="right">右对齐</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs text-[#d9d9d9]">
            <span>文字主题</span>
            <select
              value={layout.theme}
              onChange={(event) => onChange({ theme: event.target.value as PosterLayoutConfig["theme"] })}
              className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1.5 outline-none"
            >
              <option value="cinematic">电影暗色</option>
              <option value="bright">亮底深字</option>
              <option value="minimal">极简透明</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-2 text-xs text-[#d9d9d9] md:col-span-2">
            <label className="flex items-center gap-2 rounded-md border border-[#444] px-2.5 py-1.5">
              <input type="checkbox" checked={layout.showLogo} onChange={(event) => onChange({ showLogo: event.target.checked })} />
              Logo 可编辑层
            </label>
            <label className="flex items-center gap-2 rounded-md border border-[#444] px-2.5 py-1.5">
              <input type="checkbox" checked={layout.showBadge} onChange={(event) => onChange({ showBadge: event.target.checked })} />
              右上徽章
            </label>
            <label className="flex items-center gap-2 rounded-md border border-[#444] px-2.5 py-1.5">
              <input type="checkbox" checked={layout.showDecor} onChange={(event) => onChange({ showDecor: event.target.checked })} />
              角标与装饰线
            </label>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PosterOverlay({ layout, previewHeight = 360 }: { layout: PosterLayoutConfig; previewHeight?: number }) {
  const editor = normalizePosterEditorState(layout.editor, layout);
  const shadeClass = getPosterOverlayShadeClass(layout.theme);
  return (
    <div className={`pointer-events-none absolute inset-0 ${shadeClass}`} data-testid="image-poster-overlay">
      {editor.elements.map((element) => {
        if (!element.visible) return null;
        const style = {
          ...getPosterElementFrameStyle(element, previewHeight),
          ...getPosterElementPaintStyle(element),
        } satisfies CSSProperties;
        const text = getPosterElementText(layout, element.key, element);
        if (element.kind === 'line') {
          return <div key={element.key} style={{ ...style, height: Math.max(2, element.strokeWidth || 3), backgroundColor: element.color, borderRadius: 999 }} />;
        }
        if (element.kind === 'image' && element.assetUrl) {
          return <img key={element.key} src={toRenderableAssetUrl(element.assetUrl, 'image')} alt="" style={{ ...style, height: `${element.height || 12}%`, objectFit: 'contain' }} draggable={false} />;
        }
        if (element.key === 'logo') {
          return (
            <div key={element.key} style={style} className="flex items-center gap-2 font-black">
              <span className="flex h-6 w-6 items-center justify-center rounded-full border border-current text-[10px] font-black">{text.slice(0, 1) || 'H'}</span>
              <span>{text}</span>
            </div>
          );
        }
        if (element.key === 'badge') {
          return (
            <div key={element.key} style={style} className="rounded-full border border-current px-3 py-1 font-semibold">
              {text}
            </div>
          );
        }
        if (element.key === 'corner') {
          return (
            <div key={element.key} style={style} className="flex h-8 w-8 items-center justify-center rounded-md border border-current font-black">
              {text}
            </div>
          );
        }
        const className = element.key === 'title'
          ? 'font-black leading-none tracking-[-0.04em] drop-shadow'
          : element.key === 'subtitle'
            ? 'mt-3 font-medium'
            : element.key === 'tagline'
              ? 'font-semibold uppercase'
              : '';
        return (
          <div key={element.key} style={style} className={className}>
            {text}
          </div>
        );
      })}
    </div>
  );
}
