export type PosterEditorElementKey = 'logo' | 'badge' | 'corner' | 'tagline' | 'title' | 'subtitle' | 'footer' | (string & {});
export type PosterEditorElementKind = 'text' | 'icon' | 'line' | 'image';

export interface PosterEditorElement {
  key: PosterEditorElementKey;
  kind?: PosterEditorElementKind;
  text?: string;
  icon?: string;
  assetUrl?: string;
  height?: number;
  strokeWidth?: number;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontWeight: number;
  color: string;
  gradientFrom: string;
  gradientTo: string;
  gradientAngle: number;
  textAlign: 'left' | 'center' | 'right';
  visible: boolean;
  fontFamily: string;
  letterSpacing: number;
  opacity: number;
}

export interface PosterEditorState {
  elements: PosterEditorElement[];
}

export interface PosterLayoutConfig {
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
  align: 'left' | 'center' | 'right';
  theme: 'cinematic' | 'bright' | 'minimal';
  editor: PosterEditorState;
}

export const POSTER_FONT_FAMILY = 'HarmonyOS Sans SC, Source Han Sans SC, Microsoft YaHei, sans-serif';

export const DEFAULT_POSTER_LAYOUT: PosterLayoutConfig = {
  enabled: false,
  title: '疾速未来',
  subtitle: '智能电驱性能海报',
  tagline: '720P 横版全幅构图',
  footer: 'DDUp 可编辑海报层',
  logoText: 'DDUp',
  badgeText: 'NEW ENERGY',
  cornerText: '01',
  showLogo: true,
  showBadge: true,
  showDecor: true,
  align: 'left',
  theme: 'cinematic',
  editor: { elements: [] },
};
