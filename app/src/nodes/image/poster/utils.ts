import type { CSSProperties } from 'react';
import type { PosterEditorElement, PosterEditorElementKey, PosterEditorState, PosterLayoutConfig } from './types';
import { DEFAULT_POSTER_LAYOUT, POSTER_FONT_FAMILY } from './types';

function clampPercentValue(value: unknown, fallback: number, min = 0, max = 100) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, Number(next.toFixed(2))));
}

function clampUnitInterval(value: unknown, fallback = 1) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(0.2, Math.min(1, Number(next.toFixed(2))));
}

function normalizeColorValue(value: unknown, fallback: string) {
  const next = String(value || '').trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(next) ? next : fallback;
}

export function looksLikePosterMojibake(value: string) {
  return /[€]/.test(value)
    || /(鐤鹃|鏅鸿|鎽勫儚|鍙紪|鎹曡幏|娴锋姤|妯増|闂傚|褰曞埗|鏋勫浘)/.test(value);
}

export function sanitizePosterText(value: unknown, fallback: string) {
  const next = String(value || '').trim();
  if (!next) return fallback;
  return looksLikePosterMojibake(next) ? fallback : next;
}

export function createDefaultPosterEditorState(layout: PosterLayoutConfig): PosterEditorState {
  const alignX = layout.align === 'center' ? 50 : layout.align === 'right' ? 92 : 8;
  const width = layout.align === 'center' ? 78 : 60;
  const primaryColor = layout.theme === 'bright' ? '#111111' : '#ffffff';
  const mutedColor = layout.theme === 'bright' ? '#333333' : '#dbeafe';
  return {
    elements: [
      { key: 'logo', x: 8, y: 10, width: 20, fontSize: 24, fontWeight: 800, color: primaryColor, gradientFrom: primaryColor, gradientTo: primaryColor, gradientAngle: 90, textAlign: 'left', visible: layout.showLogo, fontFamily: POSTER_FONT_FAMILY, letterSpacing: 2.5, opacity: 1 },
      { key: 'badge', x: 82.5, y: 10.5, width: 18, fontSize: 16, fontWeight: 700, color: primaryColor, gradientFrom: primaryColor, gradientTo: primaryColor, gradientAngle: 90, textAlign: 'center', visible: layout.showBadge, fontFamily: POSTER_FONT_FAMILY, letterSpacing: 3, opacity: 1 },
      { key: 'corner', x: 90.5, y: 82, width: 8, fontSize: 20, fontWeight: 800, color: primaryColor, gradientFrom: primaryColor, gradientTo: primaryColor, gradientAngle: 90, textAlign: 'center', visible: layout.showDecor, fontFamily: POSTER_FONT_FAMILY, letterSpacing: 1, opacity: 1 },
      { key: 'tagline', x: alignX, y: 18, width, fontSize: 21, fontWeight: 700, color: mutedColor, gradientFrom: mutedColor, gradientTo: mutedColor, gradientAngle: 90, textAlign: layout.align, visible: true, fontFamily: POSTER_FONT_FAMILY, letterSpacing: 4, opacity: 1 },
      { key: 'title', x: alignX, y: 63, width, fontSize: 76, fontWeight: 800, color: primaryColor, gradientFrom: primaryColor, gradientTo: primaryColor, gradientAngle: 90, textAlign: layout.align, visible: true, fontFamily: POSTER_FONT_FAMILY, letterSpacing: -2, opacity: 1 },
      { key: 'subtitle', x: alignX, y: 73, width, fontSize: 28, fontWeight: 500, color: mutedColor, gradientFrom: mutedColor, gradientTo: mutedColor, gradientAngle: 90, textAlign: layout.align, visible: true, fontFamily: POSTER_FONT_FAMILY, letterSpacing: 1.5, opacity: 1 },
      { key: 'footer', x: alignX, y: 91, width, fontSize: 17, fontWeight: 500, color: mutedColor, gradientFrom: mutedColor, gradientTo: mutedColor, gradientAngle: 90, textAlign: layout.align, visible: true, fontFamily: POSTER_FONT_FAMILY, letterSpacing: 2, opacity: 1 },
    ],
  };
}

export function normalizePosterEditorElement(source: Partial<PosterEditorElement>, fallback: PosterEditorElement): PosterEditorElement {
  const textAlign = source.textAlign === 'center' || source.textAlign === 'right' || source.textAlign === 'left' ? source.textAlign : fallback.textAlign;
  const kind = source.kind === 'icon' || source.kind === 'line' || source.kind === 'image' || source.kind === 'text' ? source.kind : fallback.kind || 'text';
  return {
    ...fallback,
    key: String(source.key || fallback.key),
    kind,
    text: typeof source.text === 'string' ? sanitizePosterText(source.text, fallback.text || '新文案') : fallback.text,
    icon: typeof source.icon === 'string' ? sanitizePosterText(source.icon, fallback.icon || '星形') : fallback.icon,
    assetUrl: typeof source.assetUrl === 'string' ? source.assetUrl : fallback.assetUrl,
    height: clampPercentValue(source.height, fallback.height ?? 8, 1, 80),
    strokeWidth: Math.max(1, Math.min(24, Number.isFinite(Number(source.strokeWidth)) ? Number(source.strokeWidth) : fallback.strokeWidth ?? 3)),
    x: clampPercentValue(source.x, fallback.x),
    y: clampPercentValue(source.y, fallback.y),
    width: clampPercentValue(source.width, fallback.width, 4, 92),
    fontSize: Math.max(10, Math.min(220, Math.round(Number.isFinite(Number(source.fontSize)) ? Number(source.fontSize) : fallback.fontSize))),
    fontWeight: Math.max(300, Math.min(900, Math.round((Number.isFinite(Number(source.fontWeight)) ? Number(source.fontWeight) : fallback.fontWeight) / 100) * 100)),
    color: normalizeColorValue(source.color, fallback.color),
    gradientFrom: normalizeColorValue(source.gradientFrom, fallback.gradientFrom),
    gradientTo: normalizeColorValue(source.gradientTo, fallback.gradientTo),
    gradientAngle: clampPercentValue(source.gradientAngle, fallback.gradientAngle, 0, 360),
    textAlign,
    visible: source.visible === undefined ? fallback.visible : Boolean(source.visible),
    fontFamily: String(source.fontFamily || fallback.fontFamily || POSTER_FONT_FAMILY),
    letterSpacing: Math.max(-2, Math.min(20, Number.isFinite(Number(source.letterSpacing)) ? Number(source.letterSpacing) : fallback.letterSpacing)),
    opacity: clampUnitInterval(source.opacity, fallback.opacity),
  };
}

export function createCustomPosterFallback(source: Partial<PosterEditorElement>): PosterEditorElement {
  const kind = source.kind === 'icon' || source.kind === 'line' || source.kind === 'image' || source.kind === 'text' ? source.kind : 'text';
  return {
    key: String(source.key || 'custom-' + Date.now()),
    kind,
    text: kind === 'text' ? '新文案' : undefined,
    icon: kind === 'icon' ? '星形' : undefined,
    assetUrl: undefined,
    x: 50,
    y: 50,
    width: kind === 'line' ? 32 : 20,
    height: kind === 'image' ? 16 : 8,
    strokeWidth: 3,
    fontSize: kind === 'icon' ? 48 : 28,
    fontWeight: 700,
    color: '#ffffff',
    gradientFrom: '#ffffff',
    gradientTo: '#ffffff',
    gradientAngle: 90,
    textAlign: 'center',
    visible: true,
    fontFamily: POSTER_FONT_FAMILY,
    letterSpacing: 0,
    opacity: 1,
  };
}

export function normalizePosterEditorState(raw: unknown, layout: PosterLayoutConfig): PosterEditorState {
  const defaults = createDefaultPosterEditorState(layout);
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as { elements?: unknown[] } : {};
  const sourceElements = Array.isArray(input.elements) ? input.elements : [];
  const defaultKeys = new Set(defaults.elements.map((element) => element.key));
  const normalizedDefaults = defaults.elements.map((fallback) => {
    const source = (sourceElements.find((item) => item && typeof item === 'object' && (item as { key?: string }).key === fallback.key) || {}) as Partial<PosterEditorElement>;
    return normalizePosterEditorElement(source, fallback);
  });
  const customElements = sourceElements
    .filter((item) => item && typeof item === 'object' && !defaultKeys.has(String((item as { key?: string }).key || '')))
    .map((item) => {
      const source = item as Partial<PosterEditorElement>;
      return normalizePosterEditorElement(source, createCustomPosterFallback(source));
    });
  return { elements: [...normalizedDefaults, ...customElements] };
}

export function findPosterEditorElement(editor: PosterEditorState, key: PosterEditorElementKey) {
  return editor.elements.find((element) => element.key === key);
}

export function getPosterElementText(layout: PosterLayoutConfig, key: PosterEditorElementKey, element?: PosterEditorElement) {
  if (element?.text) return element.text;
  if (element?.kind === 'icon') return element.icon || '?';
  switch (key) {
    case 'logo': return layout.logoText;
    case 'badge': return layout.badgeText;
    case 'corner': return layout.cornerText;
    case 'tagline': return layout.tagline;
    case 'title': return layout.title;
    case 'subtitle': return layout.subtitle;
    case 'footer': return layout.footer;
    default: return element?.text || '';
  }
}

export function getPosterElementPaintStyle(element: PosterEditorElement): CSSProperties {
  if (element.gradientFrom !== element.gradientTo) {
    return {
      backgroundImage: `linear-gradient(${element.gradientAngle}deg, ${element.gradientFrom}, ${element.gradientTo})`,
      WebkitBackgroundClip: 'text',
      backgroundClip: 'text',
      color: 'transparent',
    };
  }
  return { color: element.color };
}

export function getPosterElementFrameStyle(element: PosterEditorElement, previewHeight: number): CSSProperties {
  const transform = element.textAlign === 'center' ? 'translateX(-50%)' : element.textAlign === 'right' ? 'translateX(-100%)' : 'none';
  return {
    position: 'absolute',
    left: `${element.x}%`,
    top: `${element.y}%`,
    width: `${element.width}%`,
    transform,
    textAlign: element.textAlign,
    fontFamily: element.fontFamily,
    fontSize: `${Math.max(10, Math.round((element.fontSize / 720) * previewHeight))}px`,
    fontWeight: element.fontWeight,
    letterSpacing: `${element.letterSpacing}px`,
    opacity: element.opacity,
  };
}

export function getPosterOverlayShadeClass(theme: PosterLayoutConfig['theme']) {
  if (theme === 'minimal') return 'bg-gradient-to-br from-black/20 via-transparent to-black/20';
  if (theme === 'bright') return 'bg-gradient-to-br from-white/25 via-transparent to-white/10';
  return 'bg-gradient-to-br from-black/55 via-transparent to-black/45';
}

export function getPosterTextAnchor(align: PosterEditorElement['textAlign']) {
  if (align === 'center') return 'middle';
  if (align === 'right') return 'end';
  return 'start';
}

export function buildPosterSvgWithEditor(imageHref: string, posterLayout: PosterLayoutConfig, resolution: { width: number; height: number }) {
  const editor = normalizePosterEditorState(posterLayout.editor, posterLayout);
  const overlayOpacity = posterLayout.theme === 'minimal' ? 0.28 : posterLayout.theme === 'bright' ? 0.18 : 0.58;
  const gradients = editor.elements
    .filter((element) => element.visible && element.gradientFrom !== element.gradientTo)
    .map((element) => `    <linearGradient id="poster-gradient-${element.key}" gradientTransform="rotate(${element.gradientAngle})"><stop offset="0%" stop-color="${escapeXml(element.gradientFrom)}" /><stop offset="100%" stop-color="${escapeXml(element.gradientTo)}" /></linearGradient>`)
    .join('\n');
  const elements = editor.elements.map((element) => {
    if (!element.visible) return '';
    const text = escapeXml(getPosterElementText(posterLayout, element.key, element));
    const x = Number(((element.x / 100) * resolution.width).toFixed(2));
    const y = Number(((element.y / 100) * resolution.height).toFixed(2));
    const width = Number(((element.width / 100) * resolution.width).toFixed(2));
    const height = Number((((element.height || 10) / 100) * resolution.height).toFixed(2));
    const fontSize = Math.max(12, Math.round(element.fontSize * (resolution.height / 720)));
    const letterSpacing = Number((element.letterSpacing * (resolution.height / 720)).toFixed(2));
    const fill = element.gradientFrom !== element.gradientTo ? `url(#poster-gradient-${element.key})` : escapeXml(element.color);
    const base = `font-family="${escapeXml(element.fontFamily)}" font-size="${fontSize}" font-weight="${element.fontWeight}" letter-spacing="${letterSpacing}" opacity="${element.opacity}" fill="${fill}"`;
    if (element.kind === 'line') {
      return `  <line id="editable-${escapeXml(element.key)}" x1="${x}" y1="${y}" x2="${x + width}" y2="${y}" stroke="${escapeXml(element.color)}" stroke-width="${element.strokeWidth || 3}" stroke-linecap="round" opacity="${element.opacity}" />`;
    }
    if (element.kind === 'image' && element.assetUrl) {
      return `  <image id="editable-${escapeXml(element.key)}" href="${escapeXml(element.assetUrl)}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" opacity="${element.opacity}" />`;
    }
    if (element.key === 'logo') {
      const radius = Math.max(12, Math.round(18 * (resolution.height / 720)));
      return `  <g id="editable-logo"><circle cx="${x + radius}" cy="${y}" r="${radius}" fill="none" stroke="${escapeXml(element.color)}" stroke-width="2" opacity="${element.opacity}" /><text x="${x + radius}" y="${y + Math.round(fontSize * 0.16)}" text-anchor="middle" ${base}>${escapeXml(text.slice(0, 1) || 'H')}</text><text x="${x + radius + Math.round(radius * 1.8)}" y="${y + Math.round(fontSize * 0.16)}" ${base}>${text}</text></g>`;
    }
    if (element.key === 'badge') {
      const pillHeight = Math.max(Math.round(fontSize * 1.9), 34);
      return `  <g id="editable-badge"><rect x="${x - width / 2}" y="${y - pillHeight / 2}" width="${width}" height="${pillHeight}" rx="${Math.round(pillHeight / 2)}" fill="none" stroke="${escapeXml(element.color)}" stroke-width="2" opacity="${element.opacity}" /><text x="${x}" y="${y + Math.round(fontSize * 0.32)}" text-anchor="middle" ${base}>${text}</text></g>`;
    }
    if (element.key === 'corner') {
      const box = Math.max(Math.round(fontSize * 2.1), 38);
      return `  <g id="editable-corner"><rect x="${x - box / 2}" y="${y - box / 2}" width="${box}" height="${box}" rx="${Math.round(box * 0.14)}" fill="none" stroke="${escapeXml(element.color)}" stroke-width="2" opacity="${element.opacity}" /><text x="${x}" y="${y + Math.round(fontSize * 0.28)}" text-anchor="middle" ${base}>${text}</text></g>`;
    }
    return `  <text x="${x}" y="${y}" text-anchor="${getPosterTextAnchor(element.textAlign)}" dominant-baseline="hanging" ${base}>${text}</text>`;
  }).filter(Boolean).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${resolution.width}" height="${resolution.height}" viewBox="0 0 ${resolution.width} ${resolution.height}">\n  <defs>\n    <linearGradient id="hmdaoPosterShade" x1="0" y1="0" x2="1" y2="1">\n      <stop offset="0%" stop-color="#000000" stop-opacity="${overlayOpacity}" />\n      <stop offset="52%" stop-color="#000000" stop-opacity="0.06" />\n      <stop offset="100%" stop-color="#000000" stop-opacity="${overlayOpacity * 0.7}" />\n    </linearGradient>\n${gradients}\n  </defs>\n  <image href="${escapeXml(imageHref)}" width="${resolution.width}" height="${resolution.height}" preserveAspectRatio="xMidYMid slice" />\n  <rect width="${resolution.width}" height="${resolution.height}" fill="url(#hmdaoPosterShade)" />\n${elements}\n</svg>`;
}

export function readPosterLayoutConfig(params: Record<string, unknown>): PosterLayoutConfig {
  const raw = params.posterLayout && typeof params.posterLayout === 'object'
    ? params.posterLayout as Record<string, unknown>
    : {};
  const align = raw.align === 'center' || raw.align === 'right' ? raw.align : DEFAULT_POSTER_LAYOUT.align;
  const theme = raw.theme === 'bright' || raw.theme === 'minimal' ? raw.theme : DEFAULT_POSTER_LAYOUT.theme;
  const baseLayout: PosterLayoutConfig = {
    enabled: Boolean(raw.enabled),
    title: sanitizePosterText(raw.title, DEFAULT_POSTER_LAYOUT.title),
    subtitle: sanitizePosterText(raw.subtitle, DEFAULT_POSTER_LAYOUT.subtitle),
    tagline: sanitizePosterText(raw.tagline, DEFAULT_POSTER_LAYOUT.tagline),
    footer: sanitizePosterText(raw.footer, DEFAULT_POSTER_LAYOUT.footer),
    logoText: sanitizePosterText(raw.logoText, DEFAULT_POSTER_LAYOUT.logoText),
    badgeText: sanitizePosterText(raw.badgeText, DEFAULT_POSTER_LAYOUT.badgeText),
    cornerText: sanitizePosterText(raw.cornerText, DEFAULT_POSTER_LAYOUT.cornerText),
    showLogo: raw.showLogo === undefined ? DEFAULT_POSTER_LAYOUT.showLogo : Boolean(raw.showLogo),
    showBadge: raw.showBadge === undefined ? DEFAULT_POSTER_LAYOUT.showBadge : Boolean(raw.showBadge),
    showDecor: raw.showDecor === undefined ? DEFAULT_POSTER_LAYOUT.showDecor : Boolean(raw.showDecor),
    align,
    theme,
    editor: DEFAULT_POSTER_LAYOUT.editor,
  };
  const editor = normalizePosterEditorState(raw.editor, baseLayout);
  const logo = findPosterEditorElement(editor, 'logo');
  const badge = findPosterEditorElement(editor, 'badge');
  const corner = findPosterEditorElement(editor, 'corner');
  return {
    ...baseLayout,
    showLogo: logo?.visible ?? baseLayout.showLogo,
    showBadge: badge?.visible ?? baseLayout.showBadge,
    showDecor: corner?.visible ?? baseLayout.showDecor,
    editor,
  };
}

export function mergePosterLayoutPatch(layout: PosterLayoutConfig, patch: Partial<PosterLayoutConfig>): PosterLayoutConfig {
  const next = { ...layout, ...patch } as PosterLayoutConfig;
  const editor = patch.editor
    ? normalizePosterEditorState(patch.editor, next)
    : normalizePosterEditorState(layout.editor, next);
  return readPosterLayoutConfig({
    posterLayout: {
      ...next,
      editor,
    },
  });
}

export function createFreshPosterLayoutForGeneration(layout: PosterLayoutConfig): PosterLayoutConfig {
  return readPosterLayoutConfig({
    posterLayout: {
      ...DEFAULT_POSTER_LAYOUT,
      enabled: layout.enabled,
      align: layout.align,
      theme: layout.theme,
      editor: { elements: [] },
    },
  });
}

export function buildPosterSafePrompt(prompt: string, posterLayout: PosterLayoutConfig, resolution: { width: number; height: number }) {
  if (!posterLayout.enabled) return prompt;
  return [
    prompt,
    `Create a full-bleed ${resolution.width}x${resolution.height} landscape poster background only.`,
    'No text, no Chinese characters, no letters, no numbers, no logos, no watermarks, no credits.',
    'Do not place a vertical poster inside the frame. No black bars, no side mattes, no letterboxing, no borders.',
    'Use the entire 16:9 canvas edge to edge with clean composition and empty space reserved for editable overlay typography.',
  ].join('\n');
}

export function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildPosterSvg(imageHref: string, posterLayout: PosterLayoutConfig, resolution: { width: number; height: number }) {
  const width = resolution.width;
  const height = resolution.height;
  const anchor = posterLayout.align === 'center' ? 'middle' : posterLayout.align === 'right' ? 'end' : 'start';
  const x = posterLayout.align === 'center' ? width / 2 : posterLayout.align === 'right' ? width - width * 0.08 : width * 0.08;
  const titleY = height * 0.64;
  const fill = posterLayout.theme === 'bright' ? '#111111' : '#ffffff';
  const muted = posterLayout.theme === 'bright' ? '#333333' : '#dbeafe';
  const line = posterLayout.theme === 'bright' ? '#111111' : '#ffffff';
  const gradientOpacity = posterLayout.theme === 'minimal' ? 0.28 : posterLayout.theme === 'bright' ? 0.18 : 0.58;
  const logoGroup = posterLayout.showLogo
    ? `  <g id="editable-logo">\n    <circle cx="${width * 0.08}" cy="${height * 0.09}" r="${height * 0.027}" fill="none" stroke="${line}" stroke-width="2" />\n    <text x="${width * 0.115}" y="${height * 0.101}" font-family="HarmonyOS Sans SC, Source Han Sans SC, Microsoft YaHei, sans-serif" font-size="${Math.round(height * 0.027)}" font-weight="800" fill="${fill}">${escapeXml(posterLayout.logoText)}</text>\n  </g>\n`
    : '';
  const badgeGroup = posterLayout.showBadge
    ? `  <g id="editable-badge">\n    <rect x="${width * 0.73}" y="${height * 0.075}" width="${width * 0.19}" height="${height * 0.058}" rx="${height * 0.029}" fill="none" stroke="${line}" stroke-width="2" />\n    <text x="${width * 0.825}" y="${height * 0.112}" text-anchor="middle" font-family="HarmonyOS Sans SC, Source Han Sans SC, Microsoft YaHei, sans-serif" font-size="${Math.round(height * 0.021)}" letter-spacing="3" fill="${fill}">${escapeXml(posterLayout.badgeText)}</text>\n  </g>\n`
    : '';
  const decorGroup = posterLayout.showDecor
    ? `  <g id="editable-decor">\n    <line x1="${width * 0.08}" y1="${height * 0.84}" x2="${width * 0.24}" y2="${height * 0.84}" stroke="${line}" stroke-width="3" stroke-linecap="round" />\n    <rect x="${width * 0.89}" y="${height * 0.78}" width="${width * 0.038}" height="${width * 0.038}" rx="${width * 0.006}" fill="none" stroke="${line}" stroke-width="2" />\n    <text x="${width * 0.909}" y="${height * 0.82}" text-anchor="middle" font-family="HarmonyOS Sans SC, Source Han Sans SC, Microsoft YaHei, sans-serif" font-size="${Math.round(height * 0.027)}" font-weight="800" fill="${fill}">${escapeXml(posterLayout.cornerText)}</text>\n  </g>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n  <defs>\n    <linearGradient id="hmdaoPosterShade" x1="0" y1="0" x2="1" y2="1">\n      <stop offset="0%" stop-color="#000000" stop-opacity="${gradientOpacity}" />\n      <stop offset="52%" stop-color="#000000" stop-opacity="0.06" />\n      <stop offset="100%" stop-color="#000000" stop-opacity="${gradientOpacity * 0.7}" />\n    </linearGradient>\n  </defs>\n  <image href="${escapeXml(imageHref)}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" />\n  <rect width="${width}" height="${height}" fill="url(#hmdaoPosterShade)" />\n${logoGroup}${badgeGroup}${decorGroup}  <g id="editable-copy">\n  <text x="${x}" y="${height * 0.18}" text-anchor="${anchor}" font-family="HarmonyOS Sans SC, Source Han Sans SC, Microsoft YaHei, sans-serif" font-size="${Math.round(height * 0.03)}" letter-spacing="4" fill="${muted}">${escapeXml(posterLayout.tagline)}</text>\n  <text x="${x}" y="${titleY}" text-anchor="${anchor}" font-family="HarmonyOS Sans SC, Source Han Sans SC, Microsoft YaHei, sans-serif" font-size="${Math.round(height * 0.105)}" font-weight="800" fill="${fill}">${escapeXml(posterLayout.title)}</text>\n  <text x="${x}" y="${titleY + height * 0.078}" text-anchor="${anchor}" font-family="HarmonyOS Sans SC, Source Han Sans SC, Microsoft YaHei, sans-serif" font-size="${Math.round(height * 0.04)}" fill="${muted}">${escapeXml(posterLayout.subtitle)}</text>\n  <text x="${x}" y="${height * 0.91}" text-anchor="${anchor}" font-family="HarmonyOS Sans SC, Source Han Sans SC, Microsoft YaHei, sans-serif" font-size="${Math.round(height * 0.024)}" fill="${muted}">${escapeXml(posterLayout.footer)}</text>\n  </g>\n</svg>`;
}
