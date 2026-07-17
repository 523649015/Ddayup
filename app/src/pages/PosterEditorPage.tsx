import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Move, Palette, Plus, Save, Trash2, Type, Upload, X } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toRenderableAssetUrl } from '@/services/generation';

type PosterEditorElementKey = 'logo' | 'badge' | 'corner' | 'tagline' | 'title' | 'subtitle' | 'footer' | (string & {});
type TextAlign = 'left' | 'center' | 'right';
type PosterTheme = 'cinematic' | 'bright' | 'minimal';
type PosterElementKind = 'text' | 'icon' | 'line' | 'image';

interface PosterEditorElement {
  key: PosterEditorElementKey;
  kind?: PosterElementKind;
  text?: string;
  icon?: string;
  assetUrl?: string;
  x: number;
  y: number;
  width: number;
  height?: number;
  fontSize: number;
  fontWeight: number;
  color: string;
  gradientFrom: string;
  gradientTo: string;
  gradientAngle: number;
  textAlign: TextAlign;
  visible: boolean;
  fontFamily: string;
  letterSpacing: number;
  opacity: number;
  strokeWidth?: number;
}

interface PosterEditorState { elements: PosterEditorElement[] }
interface PosterLayoutConfig {
  enabled: boolean;
  title: string;
  subtitle: string;
  tagline: string;
  footer: string;
  logoText: string;
  badgeText: string;
  cornerText: string;
  showLogo: boolean;
  showBadge: boolean;
  showDecor: boolean;
  align: TextAlign;
  theme: PosterTheme;
  editor: PosterEditorState;
}
interface PosterNodePayload {
  id: string;
  imageUrl: string;
  renderImageUrl: string;
  resolution: { width: number; height: number; label: string; aspectRatio: string };
  posterLayout: PosterLayoutConfig;
}

const POSTER_FONT_FAMILY = 'HarmonyOS Sans SC, Source Han Sans SC, Microsoft YaHei, sans-serif';
const FIXED_KEYS = new Set(['logo', 'badge', 'corner', 'tagline', 'title', 'subtitle', 'footer']);
const FIXED_ORDER: PosterEditorElementKey[] = ['logo', 'badge', 'corner', 'tagline', 'title', 'subtitle', 'footer'];
const ELEMENT_LABELS: Record<string, string> = {
  logo: 'Logo', badge: '徽章', corner: '角标', tagline: '眉标', title: '主标题', subtitle: '副标题', footer: '底部信息',
};

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, Number(next.toFixed(2))));
}
function color(value: unknown, fallback: string) {
  const next = String(value || '').trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(next) ? next : fallback;
}
function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取本地图片失败'));
    reader.readAsDataURL(file);
  });
}

function defaultLayout(): PosterLayoutConfig {
  return {
    enabled: true,
    title: '疾速未来', subtitle: '智能电驱性能海报', tagline: '720P 横版全幅构图', footer: 'DDUp 可编辑海报层',
    logoText: 'DDUp', badgeText: 'NEW ENERGY', cornerText: '01', showLogo: true, showBadge: true, showDecor: true,
    align: 'left', theme: 'cinematic', editor: { elements: [] },
  };
}
function defaultElements(layout: PosterLayoutConfig): PosterEditorElement[] {
  const alignX = layout.align === 'center' ? 50 : layout.align === 'right' ? 92 : 8;
  const width = layout.align === 'center' ? 78 : 60;
  const primary = layout.theme === 'bright' ? '#111111' : '#ffffff';
  const muted = layout.theme === 'bright' ? '#333333' : '#dbeafe';
  return [
    { key: 'logo', kind: 'text', x: 8, y: 10, width: 20, fontSize: 24, fontWeight: 800, color: primary, gradientFrom: primary, gradientTo: primary, gradientAngle: 90, textAlign: 'left', visible: layout.showLogo, fontFamily: POSTER_FONT_FAMILY, letterSpacing: 2.5, opacity: 1 },
    { key: 'badge', kind: 'text', x: 82.5, y: 10.5, width: 18, fontSize: 16, fontWeight: 700, color: primary, gradientFrom: primary, gradientTo: primary, gradientAngle: 90, textAlign: 'center', visible: layout.showBadge, fontFamily: POSTER_FONT_FAMILY, letterSpacing: 3, opacity: 1 },
    { key: 'corner', kind: 'text', x: 90.5, y: 82, width: 8, fontSize: 20, fontWeight: 800, color: primary, gradientFrom: primary, gradientTo: primary, gradientAngle: 90, textAlign: 'center', visible: layout.showDecor, fontFamily: POSTER_FONT_FAMILY, letterSpacing: 1, opacity: 1 },
    { key: 'tagline', kind: 'text', x: alignX, y: 18, width, fontSize: 21, fontWeight: 700, color: muted, gradientFrom: muted, gradientTo: muted, gradientAngle: 90, textAlign: layout.align, visible: true, fontFamily: POSTER_FONT_FAMILY, letterSpacing: 4, opacity: 1 },
    { key: 'title', kind: 'text', x: alignX, y: 63, width, fontSize: 76, fontWeight: 800, color: primary, gradientFrom: primary, gradientTo: primary, gradientAngle: 90, textAlign: layout.align, visible: true, fontFamily: POSTER_FONT_FAMILY, letterSpacing: -2, opacity: 1 },
    { key: 'subtitle', kind: 'text', x: alignX, y: 73, width, fontSize: 28, fontWeight: 500, color: muted, gradientFrom: muted, gradientTo: muted, gradientAngle: 90, textAlign: layout.align, visible: true, fontFamily: POSTER_FONT_FAMILY, letterSpacing: 1.5, opacity: 1 },
    { key: 'footer', kind: 'text', x: alignX, y: 91, width, fontSize: 17, fontWeight: 500, color: muted, gradientFrom: muted, gradientTo: muted, gradientAngle: 90, textAlign: layout.align, visible: true, fontFamily: POSTER_FONT_FAMILY, letterSpacing: 2, opacity: 1 },
  ];
}
function normalizeElement(raw: Partial<PosterEditorElement>, fallback: PosterEditorElement): PosterEditorElement {
  const kind = raw.kind === 'icon' || raw.kind === 'line' || raw.kind === 'image' || raw.kind === 'text' ? raw.kind : fallback.kind || 'text';
  const textAlign = raw.textAlign === 'center' || raw.textAlign === 'right' || raw.textAlign === 'left' ? raw.textAlign : fallback.textAlign;
  return {
    ...fallback,
    key: String(raw.key || fallback.key), kind,
    text: typeof raw.text === 'string' ? raw.text : fallback.text,
    icon: typeof raw.icon === 'string' ? raw.icon : fallback.icon,
    assetUrl: typeof raw.assetUrl === 'string' ? raw.assetUrl : fallback.assetUrl,
    x: clamp(raw.x, fallback.x, 0, 100), y: clamp(raw.y, fallback.y, 0, 100), width: clamp(raw.width, fallback.width, 4, 92),
    height: clamp(raw.height, fallback.height ?? 10, 1, 80), strokeWidth: clamp(raw.strokeWidth, fallback.strokeWidth ?? 3, 1, 24),
    fontSize: Math.round(clamp(raw.fontSize, fallback.fontSize, 10, 220)), fontWeight: Math.round(clamp(raw.fontWeight, fallback.fontWeight, 300, 900) / 100) * 100,
    color: color(raw.color, fallback.color), gradientFrom: color(raw.gradientFrom, fallback.gradientFrom), gradientTo: color(raw.gradientTo, fallback.gradientTo), gradientAngle: clamp(raw.gradientAngle, fallback.gradientAngle, 0, 360),
    textAlign, visible: raw.visible === undefined ? fallback.visible : Boolean(raw.visible), fontFamily: String(raw.fontFamily || fallback.fontFamily || POSTER_FONT_FAMILY),
    letterSpacing: clamp(raw.letterSpacing, fallback.letterSpacing, -2, 20), opacity: clamp(raw.opacity, fallback.opacity, 0.2, 1),
  };
}
function customFallback(raw: Partial<PosterEditorElement>): PosterEditorElement {
  const kind = raw.kind === 'icon' || raw.kind === 'line' || raw.kind === 'image' || raw.kind === 'text' ? raw.kind : 'text';
  return { key: String(raw.key || uid(kind)), kind, text: kind === 'text' ? '新文案' : undefined, icon: kind === 'icon' ? '✦' : undefined, x: 50, y: 50, width: kind === 'line' ? 32 : 20, height: kind === 'image' ? 18 : 10, fontSize: kind === 'icon' ? 48 : 28, fontWeight: 700, color: '#ffffff', gradientFrom: '#ffffff', gradientTo: '#ffffff', gradientAngle: 90, textAlign: 'center', visible: true, fontFamily: POSTER_FONT_FAMILY, letterSpacing: 0, opacity: 1, strokeWidth: 3 };
}
function normalizeEditor(raw: unknown, layout: PosterLayoutConfig): PosterEditorState {
  const defaults = defaultElements(layout);
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as { elements?: unknown[] } : {};
  const sourceElements = Array.isArray(source.elements) ? source.elements : [];
  const defaultElementsNext = defaults.map((fallback) => normalizeElement((sourceElements.find((item) => item && typeof item === 'object' && (item as { key?: string }).key === fallback.key) || {}) as Partial<PosterEditorElement>, fallback));
  const customElements = sourceElements.filter((item) => item && typeof item === 'object' && !FIXED_KEYS.has(String((item as { key?: string }).key || ''))).map((item) => normalizeElement(item as Partial<PosterEditorElement>, customFallback(item as Partial<PosterEditorElement>)));
  return { elements: [...defaultElementsNext, ...customElements] };
}
function textFor(layout: PosterLayoutConfig, element: PosterEditorElement) {
  if (element.text) return element.text;
  if (element.kind === 'icon') return element.icon || '✦';
  if (element.key === 'logo') return layout.logoText;
  if (element.key === 'badge') return layout.badgeText;
  if (element.key === 'corner') return layout.cornerText;
  if (element.key === 'tagline') return layout.tagline;
  if (element.key === 'title') return layout.title;
  if (element.key === 'subtitle') return layout.subtitle;
  if (element.key === 'footer') return layout.footer;
  return '';
}
function setFixedText(layout: PosterLayoutConfig, key: PosterEditorElementKey, value: string): PosterLayoutConfig {
  if (key === 'logo') return { ...layout, logoText: value };
  if (key === 'badge') return { ...layout, badgeText: value };
  if (key === 'corner') return { ...layout, cornerText: value };
  if (key === 'tagline') return { ...layout, tagline: value };
  if (key === 'title') return { ...layout, title: value };
  if (key === 'subtitle') return { ...layout, subtitle: value };
  if (key === 'footer') return { ...layout, footer: value };
  return layout;
}
function shade(theme: PosterTheme) {
  if (theme === 'minimal') return 'bg-gradient-to-br from-black/20 via-transparent to-black/20';
  if (theme === 'bright') return 'bg-gradient-to-br from-white/25 via-transparent to-white/10';
  return 'bg-gradient-to-br from-black/55 via-transparent to-black/45';
}
function escapeXml(value: string) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function buildSvg(imageHref: string, layout: PosterLayoutConfig, resolution: { width: number; height: number }) {
  const editor = normalizeEditor(layout.editor, layout);
  const items = editor.elements.filter((element) => element.visible).map((element) => {
    const x = (element.x / 100) * resolution.width;
    const y = (element.y / 100) * resolution.height;
    const w = (element.width / 100) * resolution.width;
    const h = ((element.height || 10) / 100) * resolution.height;
    const text = escapeXml(textFor(layout, element));
    if (element.kind === 'line') return `<line id="editable-${escapeXml(element.key)}" x1="${x}" y1="${y}" x2="${x + w}" y2="${y}" stroke="${escapeXml(element.color)}" stroke-width="${element.strokeWidth || 3}" stroke-linecap="round" opacity="${element.opacity}" />`;
    if (element.kind === 'image' && element.assetUrl) return `<image id="editable-${escapeXml(element.key)}" href="${escapeXml(element.assetUrl)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" opacity="${element.opacity}" />`;
    return `<text id="editable-${escapeXml(element.key)}" x="${x}" y="${y}" font-family="${escapeXml(element.fontFamily)}" font-size="${Math.round(element.fontSize * resolution.height / 720)}" font-weight="${element.fontWeight}" letter-spacing="${element.letterSpacing}" text-anchor="${element.textAlign === 'center' ? 'middle' : element.textAlign === 'right' ? 'end' : 'start'}" fill="${escapeXml(element.color)}" opacity="${element.opacity}">${text}</text>`;
  }).join('\n  ');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${resolution.width}" height="${resolution.height}" viewBox="0 0 ${resolution.width} ${resolution.height}">\n  <image href="${escapeXml(imageHref)}" width="${resolution.width}" height="${resolution.height}" preserveAspectRatio="xMidYMid slice" />\n  <rect width="${resolution.width}" height="${resolution.height}" fill="rgba(0,0,0,0.42)" />\n  ${items}\n</svg>`;
}
function readNodePayload(nodeId: string): PosterNodePayload | null {
  const win = window as typeof window & { opener?: Window & { __HMDAO_DEBUG__?: Record<string, unknown> } };
  const store = win.opener?.__HMDAO_DEBUG__?.canvasStore as { getState?: () => { canvas?: { nodes?: Array<{ id: string; data?: Record<string, unknown> }> } } } | undefined;
  const node = store?.getState?.()?.canvas?.nodes?.find((item) => item.id === nodeId) || readNodeFromLocalStorage(nodeId);
  if (!node) return null;
  const data = node.data || {};
  const params = data.params && typeof data.params === 'object' ? data.params as Record<string, unknown> : {};
  const layoutRaw = params.posterLayout && typeof params.posterLayout === 'object' ? params.posterLayout as PosterLayoutConfig : defaultLayout();
  const layout = { ...defaultLayout(), ...layoutRaw, enabled: true };
  layout.editor = normalizeEditor(layout.editor, layout);
  const meta = params.imageMeta && typeof params.imageMeta === 'object' ? params.imageMeta as Record<string, unknown> : {};
  const resolutionRaw = params.resolution && typeof params.resolution === 'object' ? params.resolution as Record<string, unknown> : {};
  const width = Number(meta.width || resolutionRaw.width || 1280);
  const height = Number(meta.height || resolutionRaw.height || 720);
  const imageUrl = String(data.imageUrl || '');
  return { id: nodeId, imageUrl, renderImageUrl: imageUrl, resolution: { width: Math.max(256, Math.round(width)), height: Math.max(256, Math.round(height)), label: `${width}x${height}`, aspectRatio: String(data.aspectRatio || '16:9') }, posterLayout: layout };
}
function readNodeFromLocalStorage(nodeId: string) {
  try { return (JSON.parse(localStorage.getItem('hmdao-canvas-store') || '{}') as { state?: { canvas?: { nodes?: Array<{ id: string; data?: Record<string, unknown> }> } } })?.state?.canvas?.nodes?.find((node) => node.id === nodeId) || null; }
  catch { return null; }
}
function saveLayoutToOpener(nodeId: string, layout: PosterLayoutConfig) {
  const win = window as typeof window & { opener?: Window & { __HMDAO_DEBUG__?: Record<string, unknown> } };
  win.opener?.postMessage({ source: 'hmdao-poster-editor', type: 'save', nodeId, layout }, window.location.origin);
  const store = win.opener?.__HMDAO_DEBUG__?.canvasStore as { getState?: () => { getNodeById?: (id: string) => { data?: Record<string, unknown> } | undefined; updateNodeData?: (id: string, patch: Record<string, unknown>) => void } } | undefined;
  const state = store?.getState?.();
  const node = state?.getNodeById?.(nodeId);
  if (node && typeof state?.updateNodeData === 'function') {
    const currentParams = node.data?.params && typeof node.data.params === 'object' ? node.data.params as Record<string, unknown> : {};
    state.updateNodeData(nodeId, { params: { ...currentParams, posterLayout: layout } });
  }
  return Boolean(win.opener);
}

export default function PosterEditorPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const nodeId = String(searchParams.get('nodeId') || '');
  const [payload, setPayload] = useState<PosterNodePayload | null>(null);
  const [layout, setLayout] = useState<PosterLayoutConfig | null>(null);
  const [selectedKey, setSelectedKey] = useState<PosterEditorElementKey>('title');
  const [message, setMessage] = useState('');
  const stageRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<{ key: PosterEditorElementKey; startX: number; startY: number; initialX: number; initialY: number } | null>(null);

  useEffect(() => {
    if (!nodeId) return;
    const next = readNodePayload(nodeId);
    setPayload(next);
    setLayout(next?.posterLayout || null);
  }, [nodeId]);

  const editor = useMemo(() => layout ? normalizeEditor(layout.editor, layout) : null, [layout]);
  const selectedElement = editor?.elements.find((element) => element.key === selectedKey) || null;
  const allKeys = editor ? editor.elements.map((element) => element.key) : [];
  const previewImageUrl = useMemo(
    () => toRenderableAssetUrl(payload?.renderImageUrl || payload?.imageUrl || '', 'image'),
    [payload?.imageUrl, payload?.renderImageUrl],
  );

  function setEditorElements(elements: PosterEditorElement[]) {
    if (!layout) return;
    setLayout({ ...layout, editor: { elements } });
  }
  function patchElement(patch: Partial<PosterEditorElement>) {
    if (!editor || !selectedElement) return;
    setEditorElements(editor.elements.map((element) => element.key === selectedElement.key ? normalizeElement({ ...element, ...patch }, element) : element));
  }
  function setText(value: string) {
    if (!layout || !editor || !selectedElement) return;
    if (FIXED_KEYS.has(selectedElement.key)) setLayout({ ...setFixedText(layout, selectedElement.key, value), editor: { elements: editor.elements } });
    else patchElement({ text: value, icon: selectedElement.kind === 'icon' ? value : selectedElement.icon });
  }
  function addLayer(kind: PosterElementKind) {
    if (!editor) return;
    const next = normalizeElement({ key: uid(kind), kind }, customFallback({ kind }));
    setSelectedKey(next.key);
    setEditorElements([...editor.elements, next]);
  }
  function deleteLayer() {
    if (!editor || !selectedElement) return;
    if (FIXED_KEYS.has(selectedElement.key)) patchElement({ visible: false });
    else {
      const next = editor.elements.filter((element) => element.key !== selectedElement.key);
      setSelectedKey(next[0]?.key || 'title');
      setEditorElements(next);
    }
  }
  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>, element: PosterEditorElement) {
    if (!stageRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedKey(element.key);
    dragRef.current = { key: element.key, startX: event.clientX, startY: event.clientY, initialX: element.x, initialY: element.y };
    const handleMove = (moveEvent: PointerEvent) => {
      if (!dragRef.current || !stageRef.current) return;
      const rect = stageRef.current.getBoundingClientRect();
      const dx = ((moveEvent.clientX - dragRef.current.startX) / Math.max(rect.width, 1)) * 100;
      const dy = ((moveEvent.clientY - dragRef.current.startY) / Math.max(rect.height, 1)) * 100;
      setLayout((current) => current ? { ...current, editor: { elements: normalizeEditor(current.editor, current).elements.map((item) => item.key === dragRef.current?.key ? { ...item, x: clamp(dragRef.current.initialX + dx, item.x, 0, 100), y: clamp(dragRef.current.initialY + dy, item.y, 0, 100) } : item) } } : current);
    };
    const handleUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }
  function handleDoubleClick(element: PosterEditorElement) {
    setSelectedKey(element.key);
    setTimeout(() => {
      textInputRef.current?.focus();
      textInputRef.current?.select();
    }, 0);
  }
  function handleSave() {
    if (!payload || !layout || !editor) return;
    const nextLayout = { ...layout, editor };
    const ok = saveLayoutToOpener(payload.id, nextLayout);
    setMessage(ok ? '已保存到图片节点。' : '未能连接到原画布，请从图片节点重新打开编辑器。');
  }
  function handleExportSvg() {
    if (!payload || !layout || !editor) return;
    const blob = new Blob([buildSvg(payload.renderImageUrl || payload.imageUrl, { ...layout, editor }, payload.resolution)], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hmdao-editable-poster.svg';
    a.click();
    URL.revokeObjectURL(url);
  }
  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !selectedElement) return;
    try {
      const url = await readFileAsDataUrl(file);
      patchElement({ kind: 'image', assetUrl: url, text: undefined, icon: undefined, width: selectedElement.width || 22, height: selectedElement.height || 16 });
      setMessage('本地图片层已替换，点击“保存到节点”后会随节点保存。');
    } catch {
      setMessage('本地图片读取失败，请换一张图片重试。');
    } finally {
      event.target.value = '';
    }
  }

  if (!payload || !layout || !editor) {
    return <div className='flex min-h-screen items-center justify-center bg-[#0d1117] text-[#e6edf3]'>未找到海报节点数据，请从图片节点重新打开。</div>;
  }

  return (
    <div className='min-h-screen bg-[#0d1117] text-[#e6edf3]'>
      <input ref={fileInputRef} type='file' accept='image/*,.svg' className='hidden' onChange={handleFile} />
      <div className='mx-auto flex max-w-[1500px] gap-6 px-6 py-6'>
        <main className='min-w-0 flex-1'>
          <div className='mb-4 flex items-center justify-between gap-3'>
            <div>
              <div className='text-2xl font-semibold'>可编辑海报层</div>
              <div className='mt-1 text-sm text-[#8b949e]'>双击文字直接编辑，拖拽任意图层改位置，可添加文案、图标、线条和本地图片层。</div>
            </div>
            <div className='flex items-center gap-2'>
              <button type='button' onClick={handleSave} className='inline-flex items-center gap-2 rounded-lg bg-[#00d4aa] px-4 py-2 text-sm font-medium text-[#04130f]'><Save className='h-4 w-4' />保存到节点</button>
              <button type='button' onClick={handleExportSvg} className='inline-flex items-center gap-2 rounded-lg border border-[#30363d] px-4 py-2 text-sm'><Download className='h-4 w-4' />导出 SVG</button>
              <button type='button' onClick={() => navigate('/')} className='inline-flex items-center gap-2 rounded-lg border border-[#30363d] px-4 py-2 text-sm'><X className='h-4 w-4' />返回画布</button>
            </div>
          </div>
          <div className='rounded-[28px] border border-[#30363d] bg-[#161b22] p-5 shadow-2xl'>
            <div ref={stageRef} className='relative mx-auto overflow-hidden rounded-[22px] bg-black ring-1 ring-white/10' style={{ width: '100%', aspectRatio: `${payload.resolution.width} / ${payload.resolution.height}` }}>
              <img src={previewImageUrl} alt='' className='absolute inset-0 h-full w-full object-cover' draggable={false} />
              <div className={`absolute inset-0 ${shade(layout.theme)}`} />
              {editor.elements.filter((element) => element.visible).map((element) => {
                const selected = element.key === selectedKey;
                const transform = element.textAlign === 'center' ? 'translateX(-50%)' : element.textAlign === 'right' ? 'translateX(-100%)' : 'none';
                const common = { left: `${element.x}%`, top: `${element.y}%`, width: `${element.width}%`, transform, opacity: element.opacity } as const;
                if (element.kind === 'line') return <div key={element.key} onPointerDown={(event) => handlePointerDown(event, element)} className={`absolute cursor-move ${selected ? 'ring-2 ring-[#00d4aa]' : ''}`} style={{ ...common, height: Math.max(2, element.strokeWidth || 3), backgroundColor: element.color, borderRadius: 999 }} />;
                if (element.kind === 'image' && element.assetUrl) return <img key={element.key} src={toRenderableAssetUrl(element.assetUrl, 'image')} alt='' draggable={false} onPointerDown={(event) => handlePointerDown(event, element)} className={`absolute cursor-move object-contain ${selected ? 'ring-2 ring-[#00d4aa]' : ''}`} style={{ ...common, height: `${element.height || 16}%` }} />;
                return <div key={element.key} onPointerDown={(event) => handlePointerDown(event, element)} onDoubleClick={() => handleDoubleClick(element)} className={`absolute cursor-move select-none rounded-lg border px-2 py-1 ${selected ? 'border-[#00d4aa] bg-black/25' : 'border-transparent hover:border-white/25'}`} style={{ ...common, color: element.gradientFrom !== element.gradientTo ? 'transparent' : element.color, backgroundImage: element.gradientFrom !== element.gradientTo ? `linear-gradient(${element.gradientAngle}deg, ${element.gradientFrom}, ${element.gradientTo})` : 'none', WebkitBackgroundClip: element.gradientFrom !== element.gradientTo ? 'text' : undefined, backgroundClip: element.gradientFrom !== element.gradientTo ? 'text' : undefined, textAlign: element.textAlign, fontFamily: element.fontFamily, fontSize: `${Math.max(12, Math.round((element.fontSize / 720) * 900))}px`, fontWeight: element.fontWeight, letterSpacing: `${element.letterSpacing}px` }}>{textFor(layout, element)}</div>;
              })}
            </div>
          </div>
          {message ? <div className='mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200'>{message}</div> : null}
        </main>
        <aside className='w-[390px] shrink-0 rounded-[24px] border border-[#30363d] bg-[#161b22] p-5'>
          <div className='text-lg font-semibold'>图层</div>
          <div className='mt-3 grid grid-cols-2 gap-2'>
            {allKeys.map((key) => <button key={key} type='button' onClick={() => setSelectedKey(key)} className={`rounded-lg border px-3 py-2 text-sm ${selectedKey === key ? 'border-[#00d4aa] bg-[#00d4aa]/10 text-white' : 'border-[#30363d] text-[#c9d1d9]'}`}>{ELEMENT_LABELS[key] || key}</button>)}
          </div>
          <div className='mt-4 grid grid-cols-2 gap-2'>
            <button type='button' onClick={() => addLayer('text')} className='rounded-lg border border-[#30363d] px-3 py-2 text-sm'><Plus className='mr-1 inline h-3.5 w-3.5' />文案</button>
            <button type='button' onClick={() => addLayer('icon')} className='rounded-lg border border-[#30363d] px-3 py-2 text-sm'><Plus className='mr-1 inline h-3.5 w-3.5' />图标</button>
            <button type='button' onClick={() => addLayer('line')} className='rounded-lg border border-[#30363d] px-3 py-2 text-sm'><Plus className='mr-1 inline h-3.5 w-3.5' />线条</button>
            <button type='button' onClick={() => { addLayer('image'); setTimeout(() => fileInputRef.current?.click(), 0); }} className='rounded-lg border border-[#30363d] px-3 py-2 text-sm'><Upload className='mr-1 inline h-3.5 w-3.5' />图片</button>
          </div>
          {selectedElement ? <div className='mt-5 space-y-4'>
            <label className='block text-sm'><div className='mb-1 text-[#8b949e]'>文案 / 图标</div><input ref={textInputRef} value={textFor(layout, selectedElement)} onChange={(event) => setText(event.target.value)} disabled={selectedElement.kind === 'line' || selectedElement.kind === 'image'} className='w-full rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[#e6edf3] outline-none disabled:opacity-50' /></label>
            <div className='grid grid-cols-2 gap-3'>
              <NumberField label='X' value={selectedElement.x} min={0} max={100} step={0.5} onChange={(value) => patchElement({ x: value })} />
              <NumberField label='Y' value={selectedElement.y} min={0} max={100} step={0.5} onChange={(value) => patchElement({ y: value })} />
              <NumberField label='宽度' value={selectedElement.width} min={4} max={92} step={0.5} onChange={(value) => patchElement({ width: value })} />
              <NumberField label='高度' value={selectedElement.height || 10} min={1} max={80} step={0.5} onChange={(value) => patchElement({ height: value })} />
              <NumberField label='字号' value={selectedElement.fontSize} min={10} max={220} step={1} onChange={(value) => patchElement({ fontSize: value })} />
              <NumberField label='字重' value={selectedElement.fontWeight} min={300} max={900} step={100} onChange={(value) => patchElement({ fontWeight: value })} />
              <NumberField label='字距' value={selectedElement.letterSpacing} min={-2} max={20} step={0.5} onChange={(value) => patchElement({ letterSpacing: value })} />
              <NumberField label='透明度' value={selectedElement.opacity} min={0.2} max={1} step={0.05} onChange={(value) => patchElement({ opacity: value })} />
              <NumberField label='渐变角度' value={selectedElement.gradientAngle} min={0} max={360} step={1} onChange={(value) => patchElement({ gradientAngle: value })} />
              <NumberField label='线宽' value={selectedElement.strokeWidth || 3} min={1} max={24} step={1} onChange={(value) => patchElement({ strokeWidth: value })} />
            </div>
            <div className='grid grid-cols-3 gap-3'><ColorField label='纯色' value={selectedElement.color} onChange={(value) => patchElement({ color: value })} /><ColorField label='渐变起点' value={selectedElement.gradientFrom} onChange={(value) => patchElement({ gradientFrom: value })} /><ColorField label='渐变终点' value={selectedElement.gradientTo} onChange={(value) => patchElement({ gradientTo: value })} /></div>
            <label className='block text-sm'><div className='mb-1 text-[#8b949e]'>字体</div><input value={selectedElement.fontFamily} onChange={(event) => patchElement({ fontFamily: event.target.value })} className='w-full rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[#e6edf3] outline-none' placeholder='例如 Microsoft YaHei, sans-serif' /></label>
            <select value={selectedElement.textAlign} onChange={(event) => patchElement({ textAlign: event.target.value as TextAlign })} className='w-full rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2'><option value='left'>左对齐</option><option value='center'>居中</option><option value='right'>右对齐</option></select>
            <div className='flex gap-2'><button type='button' onClick={() => fileInputRef.current?.click()} className='flex-1 rounded-lg border border-[#30363d] px-3 py-2 text-sm'>替换上层图片</button><button type='button' onClick={deleteLayer} className='rounded-lg border border-rose-500/40 px-3 py-2 text-sm text-rose-200'><Trash2 className='h-4 w-4' /></button></div>
          </div> : null}
        </aside>
      </div>
    </div>
  );
}
function NumberField({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return <label className='block text-sm'><div className='mb-1 text-[#8b949e]'>{label}</div><input type='number' value={String(value)} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value || value))} className='w-full rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[#e6edf3] outline-none' /></label>;
}
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className='block text-sm'><div className='mb-1 text-[#8b949e]'>{label}</div><input type='color' value={value} onChange={(event) => onChange(event.target.value)} className='h-10 w-full rounded-lg border border-[#30363d] bg-[#0d1117] p-1' /></label>;
}
