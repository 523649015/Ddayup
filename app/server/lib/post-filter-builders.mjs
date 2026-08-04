// P1-11 抽取：自 hmdao-api.mjs 原样搬移（零转写），仅追加 export 前缀。
// 依赖常量/工具经既有模块单点导入，ESM 单例语义与原文件一致。
import path from 'node:path';
import { bloomBlendMode, buildIntermediateImageArgs, buildIntermediateVideoArgs, buildWebmEncodeArgs, evenSize, fileExists } from './media-pipeline-utils.mjs';
import { buildColorWheelFilter, buildCurveFilter, buildOcioLikeFilter, clampNumber, escapeFfmpegFilterPath, hexToRgbUnit, isSupportedLutFile, resolvePostUpscaleRoute, runCommand } from './local-post-processing.mjs';
import { downloadRemoteMediaBuffer, extensionFromMimeType } from './http-fetch-utils.mjs';
import { promises as fs } from 'node:fs';

export function buildPostColorFilter(config = {}, lutPath = '') {
  const exposure = clampNumber(config.exposure, -1, 1, 0);
  const contrast = 1 + clampNumber(config.contrast, -0.8, 1.2, 0.08) * 0.6;
  const saturation = clampNumber(config.saturation, 0, 2.5, 1);
  const hue = clampNumber(config.hue, -180, 180, 0);
  const vibrance = clampNumber(config.vibrance, -1, 1, 0.12);
  const temperature = clampNumber(config.temperature, -1, 1, 0);
  const tint = clampNumber(config.tint, -1, 1, 0);
  const lift = clampNumber(config.lift, -1, 1, 0);
  const gain = clampNumber(config.gain, 0.2, 2.6, 1);
  const gamma = clampNumber(config.gamma, 0.2, 3, 1);
  const secondaryHueCenter = clampNumber(config.secondaryHueCenter, 0, 360, 180);
  const secondaryHueRange = clampNumber(config.secondaryHueRange, 5, 180, 60);
  const secondarySaturationBias = clampNumber(config.secondarySaturationBias, -1, 1, 0);
  const secondaryLumaBias = clampNumber(config.secondaryLumaBias, -1, 1, 0);
  const offset = clampNumber(config.offset, -1, 1, 0);
  const offsetColor = hexToRgbUnit(config.offsetColor, { r: 0.5, g: 0.5, b: 0.5 });
  const offsetAmount = clampNumber(config.offsetAmount, 0, 1, 0.08);
  const outMin = clampNumber(0.5 - contrast * 0.5 + exposure * 0.18 + lift * 0.08, 0, 0.45, 0);
  const outMax = clampNumber(0.5 + contrast * 0.5 + exposure * 0.18, 0.55, 1, 1);
  const midInput = 0.5;
  const midOutput = clampNumber(Math.pow(midInput, 1 / gamma), 0.18, 0.82, 0.5);
  const filters = [
    `colorlevels=romin=${outMin.toFixed(3)}:gomin=${outMin.toFixed(3)}:bomin=${outMin.toFixed(3)}:romax=${outMax.toFixed(3)}:gomax=${outMax.toFixed(3)}:bomax=${outMax.toFixed(3)}`,
    buildColorWheelFilter(config),
    `colorbalance=rs=${(temperature * 0.12).toFixed(3)}:bs=${(-temperature * 0.12).toFixed(3)}:gm=${(-tint * 0.08).toFixed(3)}:bm=${(tint * 0.08).toFixed(3)}:rh=${((offsetColor.r - 0.5) * Math.abs(offset) * offsetAmount).toFixed(3)}:gh=${((offsetColor.g - 0.5) * Math.abs(offset) * offsetAmount).toFixed(3)}:bh=${((offsetColor.b - 0.5) * Math.abs(offset) * offsetAmount).toFixed(3)}`,
    `hue=h=${hue.toFixed(2)}:s=${gain.toFixed(3)}`,
    `vibrance=intensity=${vibrance.toFixed(3)}`,
    `curves=all='0/0 ${midInput.toFixed(2)}/${midOutput.toFixed(2)} 1/1'`,
    buildCurveFilter(config),
  ];
  const filmPrint = String(config.filmPrint || 'none').trim();
  if (filmPrint === 'kodak-2383') {
    filters.push('curves=all=\'0/0 0.45/0.42 1/1\'');
  } else if (filmPrint === 'kodak-5219') {
    filters.push('curves=all=\'0/0 0.48/0.44 1/1\'');
  } else if (filmPrint === 'fuji-3513') {
    filters.push('curves=all=\'0/0 0.52/0.56 1/1\'');
  }
  if (Math.abs(saturation - 1) > 0.01) {
    filters.push(`hue=s=${saturation.toFixed(3)}`);
  }
  if (Math.abs(secondarySaturationBias) > 0.01 || Math.abs(secondaryLumaBias) > 0.01) {
    const qualifierWeight = clampNumber(secondaryHueRange / 180, 0.1, 1, 0.33);
    const secondaryMid = clampNumber(0.5 + secondaryLumaBias * qualifierWeight * 0.05, 0.42, 0.58, 0.5);
    filters.push(`hue=s=${clampNumber(1 + secondarySaturationBias * qualifierWeight * 0.22, 0.6, 1.6, 1).toFixed(3)}`);
    filters.push(`curves=all='0/0 0.50/${secondaryMid.toFixed(3)} 1/1'`);
  }
  const ocioView = String(config.ocioView || 'default').trim();
  if (ocioView === 'filmic') {
    filters.push(`curves=all='0/0 0.18/0.12 0.75/0.84 1/1'`);
  } else if (ocioView === 'aces') {
    filters.push('colorlevels=romin=0.000:gomin=0.000:bomin=0.000:romax=1.000:gomax=1.000:bomax=1.000');
    filters.push('hue=s=1.030');
    filters.push("curves=all='0/0 0.50/0.520 1/1'");
  }
  filters.push(...buildOcioLikeFilter(config));
  if (lutPath && isSupportedLutFile(lutPath)) {
    filters.push(`lut3d=file='${escapeFfmpegFilterPath(lutPath)}'`);
  }
  return filters.join(',');
}

export function buildPostUpscaleFilter(config = {}, meta = { width: 0, height: 0 }, mediaKind = 'image') {
  const scale = clampNumber(config.scale, 1, 8, 2);
  const denoise = clampNumber(config.denoise, 0, 1, 0.18);
  const sharpen = clampNumber(config.sharpen, 0, 1, 0.34);
  const resolvedRoute = resolvePostUpscaleRoute(config);
  const tileSize = clampNumber(config.tileSize, 256, 2048, 768);
  const seamFix = Boolean(config.seamFix);
  const temporalStability = clampNumber(config.temporalStability, 0, 1, 0.65);
  const outWidth = evenSize((meta.width || 2) * scale, meta.width || 2);
  const outHeight = evenSize((meta.height || 2) * scale, meta.height || 2);
  const scaleFlags = resolvedRoute === 'fsr-preview' ? 'bicubic' : resolvedRoute === 'supir' ? 'spline' : 'lanczos';
  const filters = [`scale=${outWidth}:${outHeight}:flags=${scaleFlags}`];
  if (denoise > 0.01) {
    // 当前本机 ffmpeg 构建不包含 hqdn3d，回退到稳定可用的 gblur 轻降噪
    const sigmaBase = resolvedRoute === 'supir' ? 1.2 : resolvedRoute === 'fsr-preview' ? 0.8 : 1;
    filters.push(`gblur=sigma=${clampNumber(denoise * 1.6 * sigmaBase, 0.05, 2.4, 0.24).toFixed(2)}`);
  }
  if (sharpen > 0.01) {
    const sharpenBoost = resolvedRoute === 'supir' ? 2.8 : resolvedRoute === 'fsr-preview' ? 1.9 : 2.4;
    filters.push(`unsharp=7:7:${(0.25 + sharpen * sharpenBoost).toFixed(2)}:7:7:0`);
  }
  if (seamFix && tileSize < 900) {
    // Keep seam smoothing on a filter that exists in the stock ffmpeg builds we ship against.
    filters.push('gblur=sigma=0.28:steps=1');
  }
  if (mediaKind === 'video' && temporalStability > 0.55) {
    filters.push(`tmix=frames=2:weights='${(1 - temporalStability * 0.18).toFixed(2)} ${(temporalStability * 0.18).toFixed(2)}'`);
  }
  if (resolvedRoute === 'supir') {
    filters.push('colorlevels=romin=0.000:gomin=0.000:bomin=0.000:romax=1.000:gomax=1.000:bomax=1.000');
    filters.push('hue=s=1.030');
    filters.push("curves=all='0/0 0.50/0.515 1/1'");
  }
  return filters.join(',');
}

export function buildPostBloomFilterComplex(config = {}) {
  const threshold = Math.round(clampNumber(config.threshold, 0.1, 1, 0.76) * 255);
  const radius = clampNumber(config.radius, 1, 64, 16);
  const intensity = clampNumber(config.intensity, 0, 1.4, 0.34);
  const rgbShift = clampNumber(config.rgbSplit, 0, 0.2, 0.04);
  const shift = Math.max(0, Math.round(rgbShift * 12));
  return [
    `[0:v]split=2[base][glow]`,
    `[glow]lutyuv=y='if(gte(val,${threshold}),val,0)',gblur=sigma=${radius.toFixed(2)},rgbashift=rh=${shift}:rv=0:gh=0:gv=0:bh=${-shift}:bv=0,colorchannelmixer=aa=${clampNumber(intensity * 0.9, 0, 1, 0.3).toFixed(3)}[bloom]`,
    `[base][bloom]blend=all_mode=${bloomBlendMode(String(config.blendMode || 'screen'))}:all_opacity=${clampNumber(intensity, 0, 1, 0.34).toFixed(3)}[vout]`,
  ].join(';');
}

export function buildPostDofFilterComplex(config = {}, meta = { width: 0, height: 0 }, depthMaskPath = '') {
  const focusWidth = Math.max(8, Math.round((clampNumber(config.focusWidth, 4, 100, 48) / 100) * meta.width));
  const focusHeight = Math.max(8, Math.round((clampNumber(config.focusHeight, 4, 100, 42) / 100) * meta.height));
  const focusX = Math.max(0, Math.min(meta.width - focusWidth, Math.round((clampNumber(config.focusX, 0, 100, 50) / 100) * meta.width) - Math.round(focusWidth / 2)));
  const focusY = Math.max(0, Math.min(meta.height - focusHeight, Math.round((clampNumber(config.focusY, 0, 100, 50) / 100) * meta.height) - Math.round(focusHeight / 2)));
  const blurStrength = clampNumber(config.blurStrength, 0, 1.4, 0.4);
  const depthBlend = clampNumber(config.depthBlend, 0, 1, 0.72);
  const tiltShift = Boolean(config.tiltShift);
  const transitionPreset = String(config.transitionPreset || 'soft').trim();
  const transitionBoost = transitionPreset === 'hard' ? 0.82 : transitionPreset === 'cinematic' ? 1.28 : 1;
  const effectiveFocusHeight = tiltShift ? Math.max(6, Math.round(focusHeight * 0.6)) : focusHeight;
  const effectiveFocusY = tiltShift ? Math.max(0, Math.min(meta.height - effectiveFocusHeight, focusY + Math.round((focusHeight - effectiveFocusHeight) / 2))) : focusY;
  const blurSigma = Math.max(0.8, blurStrength * (8 + depthBlend * 12) * transitionBoost);
  if (depthMaskPath) {
    return [
      `[0:v]gblur=sigma=${blurSigma.toFixed(2)}[blurred]`,
      `[1:v]format=gray,scale=${meta.width}:${meta.height}[mask]`,
      `[blurred][0:v][mask]maskedmerge[vout]`,
    ].join(';');
  }
  return [
    `[0:v]gblur=sigma=${blurSigma.toFixed(2)}[blurred]`,
    `[0:v]crop=${focusWidth}:${effectiveFocusHeight}:${focusX}:${effectiveFocusY}[sharp]`,
    `[blurred][sharp]overlay=${focusX}:${effectiveFocusY}[vout]`,
  ].join(';');
}

export function buildPostGrainFilter(config = {}, mediaKind = 'image') {
  const iso = clampNumber(config.iso, 100, 6400, 800);
  const amount = clampNumber(config.amount, 0, 1, 0.24);
  const size = clampNumber(config.size, 0.5, 4, 1.4);
  const chroma = clampNumber(config.chroma, 0, 1, 0.18);
  const shadowBoost = clampNumber(config.shadowBoost, 0, 1, 0.2);
  const distribution = String(config.distribution || 'poisson').trim();
  const flags = mediaKind === 'video' ? 't+u' : 'u';
  const distributionBoost = distribution === 'lognormal' ? 0.92 : distribution === 'gaussian' ? 0.86 : 1;
  const strength = Math.max(1, Math.round((iso / 200) * (amount * 14 + size * 3.5 + chroma * 4.2 + shadowBoost * 3.8) * distributionBoost));
  return `noise=alls=${strength}:allf=${flags}`;
}

export async function writePostAssetInput(baseDir, requestId, asset) {
  const key = String(asset?.key || '').trim();
  if (!key) return null;
  const uploadedPath = String(asset?.uploadedPath || '').trim();
  if (uploadedPath) return uploadedPath;
  const sourceUrl = String(asset?.sourceUrl || '').trim();
  const inputBase64 = String(asset?.inputBase64 || '').trim();
  if (!sourceUrl && !inputBase64) return null;
  const ext = extensionFromMimeType(
    asset?.inputMimeType
      || asset?.originalName
      || (asset?.kind === 'video' ? 'video/mp4' : 'image/png'),
  );
  const filePath = path.join(baseDir, `${requestId}-${key}.${ext}`);
  if (inputBase64) {
    await fs.writeFile(filePath, Buffer.from(inputBase64, 'base64'));
  } else {
    const remote = await downloadRemoteMediaBuffer(sourceUrl);
    await fs.writeFile(filePath, remote.bytes);
  }
  return filePath;
}

export async function runPostStep({
  mediaKind,
  inputPath,
  outputPath,
  filter,
  filterComplex,
  extraInputs = [],
  map = '[vout]',
  stage = 'post-step',
}) {
  const args = ['-y', '-i', inputPath];
  for (const extraInput of extraInputs) {
    args.push('-i', extraInput);
  }
  if (filterComplex) {
    args.push('-filter_complex', filterComplex, '-map', map);
  } else if (filter) {
    args.push('-vf', filter);
  }
  args.push(...(mediaKind === 'video' ? buildIntermediateVideoArgs(outputPath) : buildIntermediateImageArgs(outputPath)));
  try {
    await runCommand('ffmpeg', args);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error || 'unknown-error');
    throw new Error(`${stage} failed: ${detail}`);
  }
  if (!(await fileExists(outputPath))) {
    throw new Error(`${stage} produced no output: ${outputPath}; ffmpegArgs=${args.join(' ')}`);
  }
}

export async function finalizePostVideo(processedPath, originalInputPath, outputPath) {
  await runCommand('ffmpeg', [
    '-y',
    '-i',
    processedPath,
    '-i',
    originalInputPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a?',
    ...buildWebmEncodeArgs(outputPath, { includeAudio: true }),
  ]);
}
