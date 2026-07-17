import type { CSSProperties } from 'react';
import {
  type PostEffectsState,
  type PostMattingConfig,
  type PostMediaKind,
  type PostTrackingTrack,
} from '@/config/postEffectPresets';
import { isLocalMediaHandle, readLocalMediaBlob } from '@/services/localMediaRegistry';

export interface LocalPostProcessingResult {
  blob?: Blob;
  handle: string;
  url: string;
  assetId: string;
  mimeType: string;
  format: string;
  width: number;
  height: number;
  duration: number;
  size: number;
  processingEngine: string;
  warnings: string[];
  processingMeta: Record<string, unknown>;
}

export interface LocalPostProcessingRequest {
  sourceUrl: string;
  mediaKind: PostMediaKind;
  effects: PostEffectsState;
}

interface PostTransferredAsset {
  key: string;
  sourceUrl?: string;
  inputMimeType?: string;
  originalName?: string;
  kind?: 'image' | 'video';
  fieldName?: string;
  fileBlob?: Blob;
}

interface PostPreviewFocusBox {
  left: string;
  top: string;
  width: string;
  height: string;
  feather: number;
}

export interface PostPreviewDescriptor {
  mediaStyle: CSSProperties;
  grainOpacity: number;
  grainTexture: string;
  grainScale: string;
  grainBlendMode: CSSProperties['mixBlendMode'];
  focusBox: PostPreviewFocusBox | null;
  matteBackgroundUrl: string;
  matteMaskUrl: string;
  tracks: PostTrackingTrack[];
  bloomOpacity: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function buildFilmGrainTexture(
  amount: number,
  size: number,
  chroma: number,
  shadowBoost: number,
  distribution: string,
) {
  const baseFrequency = distribution === 'poisson'
    ? Math.max(0.5, 1.6 / Math.max(size, 0.6))
    : distribution === 'lognormal'
      ? Math.max(0.42, 1.2 / Math.max(size, 0.6))
      : Math.max(0.36, 0.92 / Math.max(size, 0.6));
  const octaves = distribution === 'poisson' ? 2 : distribution === 'lognormal' ? 4 : 3;
  const grainStrength = clamp(0.32 + amount * 0.48 + shadowBoost * 0.18, 0.18, 0.92);
  const chromaTint = clamp(chroma * 0.42, 0, 0.42);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" preserveAspectRatio="none">
      <filter id="noise">
        <feTurbulence type="fractalNoise" baseFrequency="${baseFrequency.toFixed(3)}" numOctaves="${octaves}" seed="17" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="${(0.08 + chromaTint).toFixed(3)}" />
        <feComponentTransfer>
          <feFuncR type="gamma" amplitude="1" exponent="${(1.06 + grainStrength * 0.12).toFixed(3)}" offset="0" />
          <feFuncG type="gamma" amplitude="1" exponent="${(1.02 + grainStrength * 0.08).toFixed(3)}" offset="0" />
          <feFuncB type="gamma" amplitude="1" exponent="${(0.98 + grainStrength * 0.16).toFixed(3)}" offset="0" />
        </feComponentTransfer>
      </filter>
      <rect width="96" height="96" filter="url(#noise)" opacity="${grainStrength.toFixed(3)}" />
    </svg>
  `.trim();
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

async function fetchAssetSource(url: string) {
  if (isLocalMediaHandle(url)) {
    const blob = readLocalMediaBlob(url);
    if (!blob) {
      throw new Error(`local-post-asset-missing:${url}`);
    }
    return {
      blob,
      mimeType: blob.type || 'application/octet-stream',
    };
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`local-post-fetch-failed:${response.status}`);
  }

  const blob = await response.blob();
  return {
    blob,
    mimeType: blob.type || response.headers.get('content-type') || 'application/octet-stream',
  };
}

function sanitizeUploadFieldName(value: string) {
  return String(value || 'asset')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'asset';
}

function extensionFromMimeType(mimeType: string, mediaKind: PostMediaKind = 'image') {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('quicktime')) return 'mov';
  if (normalized.includes('x-matroska') || normalized.includes('mkv')) return 'mkv';
  if (normalized.includes('cube')) return 'cube';
  if (normalized.includes('plain')) return 'cube';
  return mediaKind === 'video' ? 'mp4' : 'png';
}

function toServerReadableUrl(url: string) {
  const trimmed = String(url || '').trim();
  if (!trimmed || isLocalMediaHandle(trimmed) || trimmed.startsWith('blob:') || trimmed.startsWith('data:')) {
    return '';
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (typeof window !== 'undefined') {
    try {
      return new URL(trimmed, window.location.origin).toString();
    } catch {
      return '';
    }
  }
  return '';
}

async function createTransferredAsset(
  key: string,
  url: string,
  kind?: 'image' | 'video',
  originalName?: string,
): Promise<PostTransferredAsset | null> {
  const trimmed = String(url || '').trim();
  if (!trimmed) return null;
  const serverUrl = toServerReadableUrl(trimmed);
  if (serverUrl) {
    return {
      key,
      kind,
      sourceUrl: serverUrl,
      originalName,
    };
  }

  const file = await fetchAssetSource(trimmed);
  return {
    key,
    kind,
    inputMimeType: file.mimeType,
    originalName,
    fieldName: `asset-${sanitizeUploadFieldName(key)}`,
    fileBlob: file.blob,
  };
}

async function collectTransferredAssets(effects: PostEffectsState) {
  const assets: PostTransferredAsset[] = [];
  const colorLut = await createTransferredAsset('color-lut', effects.color.lutAssetUrl, undefined, effects.color.lutAssetName);
  const ocioConfig = await createTransferredAsset('color-ocio-config', effects.color.ocioConfigAssetUrl, undefined, effects.color.ocioConfigAssetName);
  const depthMask = await createTransferredAsset('dof-depth-mask', effects.dof.depthMaskUrl, 'image', effects.dof.depthMaskAssetName);
  const bokehMask = await createTransferredAsset('dof-bokeh', effects.dof.bokehAssetUrl, 'image', effects.dof.bokehAssetName);
  const mattingMask = await createTransferredAsset('matting-mask', effects.matting.maskUrl, 'image');
  const mattingBackground = await createTransferredAsset('matting-background', effects.matting.backgroundUrl, 'image');
  if (colorLut) assets.push(colorLut);
  if (ocioConfig) assets.push(ocioConfig);
  if (depthMask) assets.push(depthMask);
  if (bokehMask) assets.push(bokehMask);
  if (mattingMask) assets.push(mattingMask);
  if (mattingBackground) assets.push(mattingBackground);

  for (const track of effects.tracking.tracks) {
    const asset = await createTransferredAsset(`tracking-${track.id}`, track.overlayUrl, track.overlayKind);
    if (asset) assets.push(asset);
  }

  return assets;
}

function buildPreviewFilter(effects: PostEffectsState) {
  const filters: string[] = [];
  const brightness = clamp(1 + effects.color.exposure * 0.55, 0.15, 2.4);
  const contrast = clamp(1 + effects.color.contrast, 0.2, 2.2);
  const saturation = clamp(effects.color.saturation + effects.color.vibrance * 0.32, 0, 2.5);
  const hue = effects.color.hue;
  const tint = effects.color.tint;
  const blur = effects.dof.enabled ? clamp(effects.dof.blurStrength * 18, 0, 18) : 0;
  const gamma = Number.isFinite(effects.color.gamma) ? clamp(effects.color.gamma, 0.2, 2) : 1;
  const gain = Number.isFinite(effects.color.gain) ? clamp(effects.color.gain, 0.2, 2) : 1;

  filters.push(`brightness(${brightness})`);
  filters.push(`contrast(${contrast})`);
  filters.push(`saturate(${saturation})`);
  if (Math.abs(gamma - 1) > 0.01) filters.push(`brightness(${clamp(0.82 + gamma * 0.18, 0.5, 1.3)})`);
  if (Math.abs(gain - 1) > 0.01) filters.push(`contrast(${clamp(0.9 + gain * 0.1, 0.5, 1.4)})`);

  if (Math.abs(hue) > 0.01) filters.push(`hue-rotate(${hue}deg)`);
  if (effects.color.temperature) {
    const temperature = effects.color.temperature;
    filters.push(`sepia(${clamp(Math.abs(temperature) * 0.22, 0, 0.35)})`);
  }
  if (Math.abs(tint) > 0.01) {
    filters.push(`drop-shadow(0 0 0 rgba(${tint > 0 ? '255,64,180' : '64,220,180'},${clamp(Math.abs(tint) * 0.18, 0, 0.18)}))`);
  }
  if (effects.upscale.enabled && effects.upscale.scale > 1) {
    filters.push(`saturate(${clamp(1 + effects.upscale.sharpen * 0.45, 1, 1.45)})`);
    filters.push(`contrast(${clamp(1 + effects.upscale.sharpen * 0.18 + effects.upscale.scale * 0.03, 1, 1.5)})`);
    filters.push(`brightness(${clamp(1 + effects.upscale.denoise * 0.03, 1, 1.08)})`);
  }
  if (effects.bloom.enabled) {
    filters.push(`drop-shadow(0 0 ${Math.round(effects.bloom.radius)}px rgba(255,255,255,${clamp(effects.bloom.intensity * 0.55, 0.08, 0.42)}))`);
  }
  if (blur > 0) {
    filters.push(`blur(${blur}px)`);
  }

  return filters.join(' ');
}

export function buildPostPreviewDescriptor(effects: PostEffectsState): PostPreviewDescriptor {
  const grainTexture = effects.grain.enabled
    ? buildFilmGrainTexture(
      effects.grain.amount,
      effects.grain.size,
      effects.grain.chroma,
      effects.grain.shadowBoost,
      effects.grain.distribution,
    )
    : '';
  const focusBox = effects.dof.enabled
    ? {
        left: `${clamp(effects.dof.focusX - effects.dof.focusWidth / 2, 0, 100)}%`,
        top: `${clamp(effects.dof.focusY - effects.dof.focusHeight / 2, 0, 100)}%`,
        width: `${clamp(effects.dof.focusWidth, 4, 100)}%`,
        height: `${clamp(effects.dof.focusHeight, 4, 100)}%`,
        feather: Math.round(effects.dof.feather),
      }
    : null;

  return {
    mediaStyle: {
      filter: buildPreviewFilter(effects),
      transform: effects.upscale.enabled && effects.upscale.scale > 1 ? `scale(${1 + (effects.upscale.scale - 1) * 0.015})` : undefined,
      transformOrigin: 'center center',
    },
    grainOpacity: effects.grain.enabled ? clamp(effects.grain.amount * 0.9, 0.04, 0.48) : 0,
    grainTexture,
    grainScale: `${Math.round(clamp(effects.grain.size * 18, 16, 54))}px ${Math.round(clamp(effects.grain.size * 18, 16, 54))}px`,
    grainBlendMode: effects.grain.chroma > 0.16 ? 'overlay' : 'soft-light',
    focusBox,
    matteBackgroundUrl: effects.matting.enabled ? String(effects.matting.backgroundUrl || '') : '',
    matteMaskUrl: effects.matting.enabled ? String(effects.matting.maskUrl || '') : '',
    tracks: effects.tracking.enabled ? effects.tracking.tracks.filter((track) => Boolean(track.overlayUrl)) : [],
    bloomOpacity: effects.bloom.enabled ? clamp(effects.bloom.intensity * 0.7, 0.1, 0.55) : 0,
  };
}

export function validateMattingSetup(config: PostMattingConfig) {
  if (!config.enabled) return null;
  if (config.engine === 'upload-mask' && !config.maskUrl.trim()) {
    return '抠像已启用，但还没有上传蒙版。';
  }
  if (config.mode === 'replace-background' && !config.backgroundUrl.trim()) {
    return '背景替换已启用，但还没有选择背景素材。';
  }
  return null;
}

export async function applyPostProcessingLocally(
  request: LocalPostProcessingRequest,
): Promise<LocalPostProcessingResult> {
  const serverReadableSourceUrl = toServerReadableUrl(request.sourceUrl);
  const assets = await collectTransferredAssets(request.effects);
  const formData = new FormData();
  const sourceField = 'source';
  let inputMimeType = request.mediaKind === 'video' ? 'video/mp4' : 'image/png';

  if (serverReadableSourceUrl) {
    formData.append('manifest', JSON.stringify({
      mediaKind: request.mediaKind,
      sourceUrl: serverReadableSourceUrl,
      inputMimeType,
      effects: request.effects,
      assets: assets.map(({ fileBlob: _fileBlob, ...asset }) => asset),
    }));
  } else {
    const source = await fetchAssetSource(request.sourceUrl);
    inputMimeType = source.mimeType || inputMimeType;
    formData.append(sourceField, source.blob, `source.${extensionFromMimeType(inputMimeType, request.mediaKind)}`);
    formData.append('manifest', JSON.stringify({
      mediaKind: request.mediaKind,
      sourceField,
      inputMimeType,
      effects: request.effects,
      assets: assets.map(({ fileBlob: _fileBlob, ...asset }) => asset),
    }));
  }

  for (const asset of assets) {
    if (asset.fieldName && asset.fileBlob) {
      const assetKind = asset.kind === 'video' ? 'video' : 'image';
      const assetMimeType = asset.inputMimeType || (assetKind === 'video' ? 'video/mp4' : 'image/png');
      const fileName = `${asset.fieldName}.${extensionFromMimeType(asset.inputMimeType || asset.originalName || assetMimeType, assetKind)}`;
      formData.append(
        asset.fieldName,
        asset.fileBlob,
        fileName,
      );
    }
  }

  const response = await fetch('/api/local-post/process', {
    method: 'POST',
    body: formData,
  });

  const result = await response.json().catch(() => null) as {
    success?: boolean;
    error?: { message?: string };
    outputUrl?: string;
    outputAssetId?: string;
    mimeType?: string;
    format?: string;
    width?: number;
    height?: number;
    duration?: number;
    size?: number;
    processingEngine?: string;
    warnings?: string[];
    processingMeta?: Record<string, unknown>;
  } | null;

  const outputUrl = String(result?.outputUrl || '').trim();
  const outputAssetId = String(result?.outputAssetId || '').trim();
  if (!response.ok || !result?.success || !outputUrl) {
    throw new Error(result?.error?.message || `local-post-process-failed:${response.status}`);
  }

  return {
    handle: outputUrl,
    url: outputUrl,
    assetId: outputAssetId,
    mimeType: String(result.mimeType || (request.mediaKind === 'video' ? 'video/webm' : 'image/png')),
    format: String(result.format || (request.mediaKind === 'video' ? 'webm' : 'png')),
    width: Math.max(1, Number(result.width || 0)),
    height: Math.max(1, Number(result.height || 0)),
    duration: Math.max(0, Number(result.duration || 0)),
    size: Math.max(0, Number(result.size || 0)),
    processingEngine: String(result.processingEngine || 'ffmpeg-post-stack'),
    warnings: Array.isArray(result.warnings) ? result.warnings.map((item) => String(item)) : [],
    processingMeta: result?.processingMeta && typeof result.processingMeta === 'object' ? result.processingMeta : {},
  };
}

