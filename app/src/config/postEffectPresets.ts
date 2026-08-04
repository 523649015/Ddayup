export type PostEffectId = 'color' | 'upscale' | 'bloom' | 'dof' | 'grain' | 'matting' | 'tracking' | 'motionBlur';

export type PostMediaKind = 'image' | 'video';

export interface PostCurvePoint {
  x: number;
  y: number;
}

export interface PostColorConfig {
  enabled: boolean;
  preset: 'neutral' | 'cinematic' | 'product' | 'night-neon' | 'custom';
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  lift: number;
  offset: number;
  gamma: number;
  gain: number;
  vibrance: number;
  hue: number;
  liftColor: string;
  gammaColor: string;
  gainColor: string;
  offsetColor: string;
  liftAmount: number;
  gammaAmount: number;
  gainAmount: number;
  offsetAmount: number;
  colorSpaceIn: 'sRGB' | 'Rec.709' | 'ACEScg';
  colorSpaceOut: 'sRGB' | 'Rec.709' | 'DCI-P3';
  lutAssetUrl: string;
  lutAssetName: string;
  ocioView: 'default' | 'filmic' | 'aces';
  ocioConfig: 'builtin' | 'aces-1.3' | 'custom-file';
  ocioConfigAssetUrl: string;
  ocioConfigAssetName: string;
  ocioDisplay: 'web-srgb' | 'rec709-monitor' | 'p3-cinema';
  ocioLookStrength: number;
  ocioExecutionMode: 'auto' | 'wrapper-only' | 'fallback-only';
  masterCurve: 'linear' | 'soft-contrast' | 'film-s' | 'lifted-matte';
  redCurve: 'linear' | 'film-warm' | 'teal-shadows' | 'crisp-highlights';
  greenCurve: 'linear' | 'film-balance' | 'lift-shadows' | 'crisp-highlights';
  blueCurve: 'linear' | 'teal-shadows' | 'cool-highlights' | 'lift-shadows';
  masterCurvePoints: PostCurvePoint[];
  redCurvePoints: PostCurvePoint[];
  greenCurvePoints: PostCurvePoint[];
  blueCurvePoints: PostCurvePoint[];
  secondaryHueCenter: number;
  secondaryHueRange: number;
  secondarySaturationBias: number;
  secondaryLumaBias: number;
  filmPrint: 'none' | 'kodak-2383' | 'kodak-5219' | 'fuji-3513';
}

export interface PostUpscaleConfig {
  enabled: boolean;
  scale: 1 | 2 | 4 | 8;
  mode: 'preview' | 'balanced' | 'detail';
  model: 'fsr-fast' | 'realesrgan-balanced' | 'realbasicvsr-video' | 'supir-detail';
  routePolicy: 'auto' | 'fsr-preview' | 'realbasicvsr' | 'supir';
  executionMode: 'auto' | 'wrapper-only' | 'fallback-only';
  gpuTier: 'auto' | '8g-safe' | 'max-quality';
  tileSize: 512 | 768 | 1024;
  seamFix: boolean;
  denoise: number;
  sharpen: number;
  temporalStability: number;
}

export interface PostBloomConfig {
  enabled: boolean;
  preset: 'cinematic-rim' | 'soft-haze' | 'neon-pop';
  threshold: number;
  intensity: number;
  radius: number;
  rgbSplit: number;
  dirtStrength: number;
  blendMode: 'screen' | 'add' | 'softlight';
}

export interface PostDofConfig {
  enabled: boolean;
  mode: 'auto' | 'manual';
  focusX: number;
  focusY: number;
  focusWidth: number;
  focusHeight: number;
  blurStrength: number;
  feather: number;
  shape: 'round' | 'hex' | 'custom';
  tiltShift: boolean;
  depthPreview: boolean;
  maskMode: 'focus-box' | 'paint-mask';
  depthBlend: number;
  engine: 'depth-anything-v3-base' | 'manual-focus-box';
  autoDepthStrength: number;
  transitionPreset: 'hard' | 'soft' | 'cinematic';
  brushSize: number;
  depthMaskUrl: string;
  depthMaskAssetName: string;
  bokehAssetUrl: string;
  bokehAssetName: string;
}

export interface PostGrainConfig {
  enabled: boolean;
  preset: 'kodak-5219' | 'kodak-5222' | 'eterna';
  iso: 100 | 400 | 800 | 1600 | 3200 | 6400;
  amount: number;
  size: number;
  chroma: number;
  shadowBoost: number;
  seed: number;
  distribution: 'gaussian' | 'poisson' | 'lognormal';
}

export interface PostMattingConfig {
  enabled: boolean;
  mode: 'keep-foreground' | 'replace-background' | 'remove-background';
  engine: 'upload-mask' | 'sam2-wrapper' | 'rvm-wrapper';
  tagLayering: boolean;
  subjectPrompt: string;
  edgeFeather: number;
  despill: number;
  fillBackground: boolean;
  backgroundUrl: string;
  maskUrl: string;
}

export interface PostTrackingTrack {
  id: string;
  label: string;
  overlayUrl: string;
  overlayKind: 'image' | 'video';
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  startTime: number;
  endTime: number;
  blendMode: 'normal' | 'screen' | 'add';
  tracker: 'manual' | 'cotracker3-wrapper';
}

export interface PostTrackingConfig {
  enabled: boolean;
  trackerEngine: 'manual' | 'cotracker3-wrapper';
  trackMode: 'point' | 'box' | 'region';
  perspectiveWarp: boolean;
  lockScale: boolean;
  lockRotation: boolean;
  motionBlur: boolean;
  occlusionAware: boolean;
  tracks: PostTrackingTrack[];
}

export interface PostMotionBlurConfig {
  enabled: boolean;
  /** 模糊长度（强度） */
  length: number;
  /** 模糊角度（度） */
  angle: number;
  /** 是否使用 RAFT 光流做逐帧方向性模糊（视频更真实） */
  useOpticalFlow: boolean;
  /** 执行引擎 */
  engine: 'kornia-motion' | 'raft-flow';
}

export interface PostEffectsState {
  color: PostColorConfig;
  upscale: PostUpscaleConfig;
  bloom: PostBloomConfig;
  dof: PostDofConfig;
  grain: PostGrainConfig;
  matting: PostMattingConfig;
  tracking: PostTrackingConfig;
  motionBlur: PostMotionBlurConfig;
}

export interface PostEffectDescriptor {
  id: PostEffectId;
  label: string;
  shortLabel: string;
  description: string;
  latestRoute: string;
}

export interface PostPresetOption<T extends string> {
  value: T;
  label: string;
}

export interface PostPatchPreset<T extends string, P> extends PostPresetOption<T> {
  patch: Partial<P>;
}

export const POST_EFFECT_ORDER: PostEffectId[] = ['color', 'upscale', 'dof', 'bloom', 'grain', 'matting', 'tracking', 'motionBlur'];

export const POST_EFFECT_DESCRIPTORS: Record<PostEffectId, PostEffectDescriptor> = {
  color: {
    id: 'color',
    label: '高级调色',
    shortLabel: '调色',
    description: '覆盖主调、色轮、曲线、二级 HSL、LUT 和 OCIO 色彩管理，适合统一影片或海报的最终风格。',
    latestRoute: 'OpenColorIO / FFmpeg Curves / 色轮矩阵',
  },
  upscale: {
    id: 'upscale',
    label: '高清增强',
    shortLabel: '高清',
    description: '支持预览、均衡、细节优先三类增强路线，可按图片或视频素材选择不同高清策略。',
    latestRoute: 'FSR / RealBasicVSR / SUPIR Wrapper',
  },
  bloom: {
    id: 'bloom',
    label: '氛围辉光',
    shortLabel: '辉光',
    description: '模拟电影级高光扩散、RGB 分离和镜头脏污，适合夜景、广告和氛围强化镜头。',
    latestRoute: 'Kawase Bloom / RGB Shift',
  },
  dof: {
    id: 'dof',
    label: '智能景深',
    shortLabel: '景深',
    description: '支持手动焦区、自动深度和散景控制，用于强化主体聚焦与空间层次。',
    latestRoute: 'Depth Anything V2 / Focus Box / 手绘蒙版',
  },
  grain: {
    id: 'grain',
    label: '电影颗粒',
    shortLabel: '颗粒',
    description: '模拟不同胶片感、ISO、颗粒尺寸与彩色颗粒分布，补足数字画面的胶片质感。',
    latestRoute: 'Perlin / Poisson Film Grain',
  },
  matting: {
    id: 'matting',
    label: 'AI 抠像',
    shortLabel: '抠像',
    description: '支持上传蒙版直通、背景替换和主体保留，并为 SAM2 与 RVM 本地链路预留入口。',
    latestRoute: 'Mask Upload / SAM2 / RVM Adapter',
  },
  tracking: {
    id: 'tracking',
    label: '运动跟踪',
    shortLabel: '跟踪',
    description: '为贴图、视频叠加和运动绑定提供基础参数，并兼容后续 CoTracker3 自动跟踪执行。',
    latestRoute: 'Manual Composite / CoTracker3 Adapter',
  },
  motionBlur: {
    id: 'motionBlur',
    label: '运动模糊',
    shortLabel: '运动模糊',
    description: '基于 RAFT 光流与 Kornia 运动核的方向性电影感模糊，可全局角度模糊或由光流逐帧驱动。',
    latestRoute: 'RAFT Optical Flow / Kornia Motion Kernel',
  },
};

export const POST_EFFECT_DESCRIPTORS_LEGACY: Record<PostEffectId, PostEffectDescriptor> = POST_EFFECT_DESCRIPTORS;

export const POST_COLOR_PRESETS: Array<PostPatchPreset<string, PostColorConfig>> = [
  {
    value: 'neutral',
    label: '中性校正',
    patch: { exposure: 0, contrast: 0.08, saturation: 1, temperature: 0, vibrance: 0.12, hue: 0, filmPrint: 'none' },
  },
  {
    value: 'cinematic',
    label: '电影冷暖',
    patch: { exposure: 0.08, contrast: 0.22, saturation: 1.08, temperature: -0.12, vibrance: 0.24, filmPrint: 'kodak-2383' },
  },
  {
    value: 'product',
    label: '产品通透',
    patch: { exposure: 0.14, contrast: 0.12, saturation: 1.04, temperature: 0.06, vibrance: 0.18, filmPrint: 'none' },
  },
  {
    value: 'night-neon',
    label: '夜景霓虹',
    patch: { exposure: -0.02, contrast: 0.28, saturation: 1.2, temperature: -0.2, hue: 6, vibrance: 0.3, filmPrint: 'fuji-3513' },
  },
] as const;

export const POST_BLOOM_PRESETS: Array<PostPatchPreset<PostBloomConfig['preset'], PostBloomConfig>> = [
  {
    value: 'cinematic-rim',
    label: '电影逆光',
    patch: { threshold: 0.78, intensity: 0.36, radius: 18, rgbSplit: 0.04, blendMode: 'screen' },
  },
  {
    value: 'soft-haze',
    label: '柔雾高光',
    patch: { threshold: 0.62, intensity: 0.28, radius: 28, rgbSplit: 0.02, blendMode: 'softlight' },
  },
  {
    value: 'neon-pop',
    label: '霓虹漫散',
    patch: { threshold: 0.72, intensity: 0.48, radius: 22, rgbSplit: 0.12, blendMode: 'add' },
  },
] as const;

export const POST_GRAIN_PRESETS: Array<PostPatchPreset<PostGrainConfig['preset'], PostGrainConfig>> = [
  {
    value: 'kodak-5219',
    label: 'Kodak 5219',
    patch: { iso: 800, amount: 0.24, size: 1.4, chroma: 0.18, shadowBoost: 0.2, distribution: 'poisson' },
  },
  {
    value: 'kodak-5222',
    label: 'Kodak 5222',
    patch: { iso: 1600, amount: 0.32, size: 1.6, chroma: 0.08, shadowBoost: 0.26, distribution: 'gaussian' },
  },
  {
    value: 'eterna',
    label: 'Fujifilm Eterna',
    patch: { iso: 400, amount: 0.18, size: 1.1, chroma: 0.12, shadowBoost: 0.14, distribution: 'lognormal' },
  },
] as const;

export function createDefaultPostEffects(): PostEffectsState {
  return {
    color: {
      enabled: false,
      preset: 'neutral',
      exposure: 0,
      contrast: 0.08,
      saturation: 1,
      temperature: 0,
      tint: 0,
      lift: 0,
      offset: 0,
      gamma: 1,
      gain: 1,
      vibrance: 0.12,
      hue: 0,
      liftColor: '#0ea5e9',
      gammaColor: '#f59e0b',
      gainColor: '#f8fafc',
      offsetColor: '#f97316',
      liftAmount: 0.18,
      gammaAmount: 0.14,
      gainAmount: 0.16,
      offsetAmount: 0.08,
      colorSpaceIn: 'sRGB',
      colorSpaceOut: 'Rec.709',
      lutAssetUrl: '',
      lutAssetName: '',
      ocioView: 'default',
      ocioConfig: 'builtin',
      ocioConfigAssetUrl: '',
      ocioConfigAssetName: '',
      ocioDisplay: 'rec709-monitor',
      ocioLookStrength: 0.72,
      ocioExecutionMode: 'auto',
      masterCurve: 'linear',
      redCurve: 'linear',
      greenCurve: 'linear',
      blueCurve: 'linear',
      masterCurvePoints: [{ x: 0, y: 0 }, { x: 0.25, y: 0.25 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.75 }, { x: 1, y: 1 }],
      redCurvePoints: [{ x: 0, y: 0 }, { x: 0.25, y: 0.25 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.75 }, { x: 1, y: 1 }],
      greenCurvePoints: [{ x: 0, y: 0 }, { x: 0.25, y: 0.25 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.75 }, { x: 1, y: 1 }],
      blueCurvePoints: [{ x: 0, y: 0 }, { x: 0.25, y: 0.25 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.75 }, { x: 1, y: 1 }],
      secondaryHueCenter: 180,
      secondaryHueRange: 60,
      secondarySaturationBias: 0,
      secondaryLumaBias: 0,
      filmPrint: 'none',
    },
    upscale: {
      enabled: false,
      scale: 2,
      mode: 'balanced',
      model: 'realesrgan-balanced',
      routePolicy: 'auto',
      executionMode: 'auto',
      gpuTier: '8g-safe',
      tileSize: 768,
      seamFix: true,
      denoise: 0.18,
      sharpen: 0.34,
      temporalStability: 0.65,
    },
    bloom: {
      enabled: false,
      preset: 'cinematic-rim',
      threshold: 0.78,
      intensity: 0.36,
      radius: 18,
      rgbSplit: 0.04,
      dirtStrength: 0.12,
      blendMode: 'screen',
    },
    dof: {
      enabled: false,
      mode: 'manual',
      focusX: 50,
      focusY: 50,
      focusWidth: 48,
      focusHeight: 42,
      blurStrength: 0.34,
      feather: 18,
      shape: 'round',
      tiltShift: false,
      depthPreview: false,
      maskMode: 'focus-box',
      depthBlend: 0.72,
      engine: 'manual-focus-box',
      autoDepthStrength: 0.68,
      transitionPreset: 'soft',
      brushSize: 28,
      depthMaskUrl: '',
      depthMaskAssetName: '',
      bokehAssetUrl: '',
      bokehAssetName: '',
    },
    grain: {
      enabled: false,
      preset: 'kodak-5219',
      iso: 800,
      amount: 0.24,
      size: 1.4,
      chroma: 0.18,
      shadowBoost: 0.2,
      seed: 1234,
      distribution: 'poisson',
    },
    matting: {
      enabled: false,
      mode: 'keep-foreground',
      engine: 'upload-mask',
      tagLayering: false,
      subjectPrompt: '',
      edgeFeather: 8,
      despill: 0.2,
      fillBackground: true,
      backgroundUrl: '',
      maskUrl: '',
    },
    tracking: {
      enabled: false,
      trackerEngine: 'manual',
      trackMode: 'point',
      perspectiveWarp: false,
      lockScale: true,
      lockRotation: true,
      motionBlur: false,
      occlusionAware: false,
      tracks: [],
    },
    motionBlur: {
      enabled: false,
      length: 18,
      angle: 0,
      useOpticalFlow: false,
      engine: 'kornia-motion',
    },
  };
}

export function mergePostEffects(partial: Partial<PostEffectsState> | null | undefined): PostEffectsState {
  const defaults = createDefaultPostEffects();
  if (!partial) return defaults;
  const colorPartial = (partial.color || {}) as Partial<PostColorConfig>;
  return {
    color: {
      ...defaults.color,
      ...colorPartial,
      masterCurvePoints: Array.isArray(colorPartial.masterCurvePoints)
        ? colorPartial.masterCurvePoints.map((point: PostCurvePoint) => ({ x: Number(point?.x ?? 0), y: Number(point?.y ?? 0) }))
        : defaults.color.masterCurvePoints,
      redCurvePoints: Array.isArray(colorPartial.redCurvePoints)
        ? colorPartial.redCurvePoints.map((point: PostCurvePoint) => ({ x: Number(point?.x ?? 0), y: Number(point?.y ?? 0) }))
        : defaults.color.redCurvePoints,
      greenCurvePoints: Array.isArray(colorPartial.greenCurvePoints)
        ? colorPartial.greenCurvePoints.map((point: PostCurvePoint) => ({ x: Number(point?.x ?? 0), y: Number(point?.y ?? 0) }))
        : defaults.color.greenCurvePoints,
      blueCurvePoints: Array.isArray(colorPartial.blueCurvePoints)
        ? colorPartial.blueCurvePoints.map((point: PostCurvePoint) => ({ x: Number(point?.x ?? 0), y: Number(point?.y ?? 0) }))
        : defaults.color.blueCurvePoints,
    },
    upscale: { ...defaults.upscale, ...(partial.upscale || {}) },
    bloom: { ...defaults.bloom, ...(partial.bloom || {}) },
    dof: { ...defaults.dof, ...(partial.dof || {}) },
    grain: { ...defaults.grain, ...(partial.grain || {}) },
    matting: { ...defaults.matting, ...(partial.matting || {}) },
    tracking: {
      ...defaults.tracking,
      ...(partial.tracking || {}),
      tracks: Array.isArray(partial.tracking?.tracks)
        ? partial.tracking.tracks.map((track) => ({
            id: track.id,
            label: track.label || '跟踪层',
            overlayUrl: track.overlayUrl || '',
            overlayKind: track.overlayKind === 'video' ? 'video' : 'image',
            x: Number.isFinite(track.x) ? track.x : 50,
            y: Number.isFinite(track.y) ? track.y : 50,
            scale: Number.isFinite(track.scale) ? track.scale : 1,
            rotation: Number.isFinite(track.rotation) ? track.rotation : 0,
            opacity: Number.isFinite(track.opacity) ? track.opacity : 1,
            startTime: Number.isFinite(track.startTime) ? track.startTime : 0,
            endTime: Number.isFinite(track.endTime) ? track.endTime : 5,
            blendMode: track.blendMode === 'screen' || track.blendMode === 'add' ? track.blendMode : 'normal',
            tracker: track.tracker === 'cotracker3-wrapper' ? 'cotracker3-wrapper' : 'manual',
          }))
        : defaults.tracking.tracks,
    },
    motionBlur: { ...defaults.motionBlur, ...(partial.motionBlur || {}) },
  };
}

export function countEnabledPostEffects(effects: PostEffectsState) {
  return POST_EFFECT_ORDER.reduce((count, effectId) => count + (effects[effectId].enabled ? 1 : 0), 0);
}
