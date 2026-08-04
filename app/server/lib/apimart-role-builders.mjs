// apimart 角色/契约/资源归一化构建簇（零状态纯函数）
// 从 hmdao-api.mjs 抽取，仅依赖同 lib 的 str-utils / object-utils / apimart-payload-utils。
import { extractFirstString, uniqueStrings } from './str-utils.mjs';
import { compactObject } from './object-utils.mjs';
import {
  apimartExpandedImageRoles,
  isStrictImageSubjectSwapOperation,
} from './apimart-payload-utils.mjs';

function normalizeReferenceAssets(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? item : null))
    .filter(Boolean)
    .map((item) => ({
      type: String(item.type || '').trim().toLowerCase(),
      role: String(item.role || '').trim().toLowerCase(),
      uiRole: String(item.ui_role || '').trim().toLowerCase(),
      weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : 0,
      url: extractFirstString(item.url),
      coverageRoles: Array.isArray(item.coverage_roles)
        ? Array.from(new Set(item.coverage_roles.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)))
        : [],
      channel: String(item.channel || '').trim().toLowerCase(),
      preserve: Array.isArray(item.preserve) ? item.preserve.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
      sourceMeta: item.source_meta && typeof item.source_meta === 'object' && !Array.isArray(item.source_meta)
        ? {
            width: Number.isFinite(Number(item.source_meta.width)) ? Number(item.source_meta.width) : 0,
            height: Number.isFinite(Number(item.source_meta.height)) ? Number(item.source_meta.height) : 0,
            duration: Number.isFinite(Number(item.source_meta.duration)) ? Number(item.source_meta.duration) : 0,
            provider: extractFirstString(item.source_meta.provider),
            model: extractFirstString(item.source_meta.model),
            contentType: extractFirstString(item.source_meta.contentType),
            source: extractFirstString(item.source_meta.source),
          }
        : null,
      sourceNodeType: String(item.source_node_type || '').trim().toLowerCase(),
    }))
    .filter((item) => item.type && item.role && item.url);
}

function buildApimartImageRoleEntries(rawPayload = {}, normalizedPayload = {}) {
  const entries = [];
  const seen = new Set();
  const push = (url, role, weight = 0, source = '') => {
    const normalizedUrl = extractFirstString(url);
    const normalizedRole = String(role || '').trim().toLowerCase();
    if (!normalizedUrl || !normalizedRole) return;
    const key = `${normalizedRole}::${normalizedUrl}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(compactObject({
      url: normalizedUrl,
      image_url: normalizedUrl,
      role: normalizedRole,
      weight: Number.isFinite(Number(weight)) && Number(weight) > 0 ? Math.max(0.05, Math.min(1, Number(weight) > 1 ? Number(weight) / 100 : Number(weight))) : undefined,
      source,
    }));
  };

  const sourceMediaType = String(rawPayload.source_media_type || normalizedPayload.source_media_type || '').trim().toLowerCase();
  const imageStrategyOperation = String(
    rawPayload?.conditioning_strategy?.operation
    || normalizedPayload?.conditioning_strategy?.operation
    || '',
  ).trim();
  const primaryAssets = normalizeReferenceAssets(rawPayload.primary_assets);
  const referenceAssets = normalizeReferenceAssets(rawPayload.reference_assets);

  if (sourceMediaType !== 'video') {
    const primarySourceUrl = extractFirstString(normalizedPayload.first_frame_url)
      || extractFirstString(normalizedPayload.source_url);
    if (primarySourceUrl) {
      push(primarySourceUrl, 'composition', 1, 'primary-source');
      push(primarySourceUrl, 'first_frame', 1, 'primary-source');
    }
  }

  const lastFrameUrl = extractFirstString(normalizedPayload.last_frame_url);
  if (lastFrameUrl) push(lastFrameUrl, 'last_frame', 1, 'last-frame');

  for (const asset of primaryAssets) {
    if (asset.type !== 'image') continue;
    for (const role of apimartExpandedImageRoles(asset, { imageStrategyOperation })) {
      push(asset.url, role === 'primary' ? 'composition' : role, asset.weight, 'primary-asset');
    }
  }

  for (const asset of referenceAssets) {
    if (asset.type !== 'image') continue;
    for (const role of apimartExpandedImageRoles(asset, { imageStrategyOperation })) {
      push(asset.url, role, asset.weight, 'reference-asset');
    }
  }

  const fallbackReferenceImageUrl = extractFirstString(normalizedPayload.reference_image_url);
  if (fallbackReferenceImageUrl) {
    push(fallbackReferenceImageUrl, 'subject', Number(rawPayload.reference_weight || 0.7), 'reference-image-url');
  }

  return entries;
}

function buildApimartOrderedImageUrls(imageRoleEntries = []) {
  const priority = new Map([
    ['composition', 0],
    ['first_frame', 1],
    ['subject', 2],
    ['style', 3],
    ['lighting', 4],
    ['reference', 5],
    ['last_frame', 6],
  ]);
  return imageRoleEntries
    .map((item, index) => ({
      url: extractFirstString(item?.url),
      order: priority.get(String(item?.role || '').trim().toLowerCase()) ?? 99,
      index,
    }))
    .filter((item) => item.url)
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .reduce((accumulator, item) => {
      if (!accumulator.includes(item.url)) accumulator.push(item.url);
      return accumulator;
    }, [])
    .slice(0, 16);
}

function buildApimartImagePromptContract(prompt = '', imageRoleEntries = [], strategyOperation = '') {
  const basePrompt = String(prompt || '').trim();
  if (!imageRoleEntries.length) return basePrompt;

  const hasComposition = imageRoleEntries.some((item) => item.role === 'composition' || item.role === 'first_frame');
  const hasSubject = imageRoleEntries.some((item) => item.role === 'subject');
  const hasStyle = imageRoleEntries.some((item) => item.role === 'style' || item.role === 'lighting');
  const lines = [basePrompt];

  lines.push('');
  lines.push('[HMDAO upstream image_urls role contract]');
  if (hasComposition) {
    lines.push('- image_urls[0] is the locked composition anchor. Preserve its camera angle, framing, crop, perspective, subject scale, depth and scene layout.');
  }
  if (hasSubject) {
    lines.push('- The next subject reference image is the only authority for the replacement hero product or object. Replace only the original hero subject with that reference.');
    lines.push('- This is an object or product replacement task, not portrait or character generation. Do not introduce people or human faces unless the prompt explicitly asks for them.');
    lines.push('- Do not modernize, redesign, or substitute the requested subject with a different generation, class, era, or product family than the explicit subject reference.');
  }
  if (hasStyle) {
    lines.push('- Remaining reference images refine only style palette, lighting mood, material finish and atmosphere. They must not override the locked composition or the explicit subject replacement.');
    lines.push('- If any style, lighting, or background reference contains another vehicle, product, animal, or person, ignore that foreground identity completely. Use only its atmosphere, palette, reflections, and environment lighting.');
    lines.push('- If any non-subject reference conflicts with the explicit subject reference, discard the non-subject foreground identity and keep only atmosphere-level cues.');
  }
  if (isStrictImageSubjectSwapOperation(strategyOperation)) {
    lines.push('- Keep the original composition from image_urls[0], replace only the main subject, and preserve the rest of the scene structure.');
  }
  return lines.join('\n');
}

function buildApimartVideoRoleEntries(rawPayload = {}, normalizedPayload = {}) {
  const entries = [];
  const seen = new Set();
  const push = (url, role, source = '') => {
    const normalizedUrl = extractFirstString(url);
    const normalizedRole = String(role || '').trim().toLowerCase();
    if (!normalizedUrl || !normalizedRole) return;
    const key = `${normalizedRole}::${normalizedUrl}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ url: normalizedUrl, role: normalizedRole, source });
  };

  const sourceMediaType = String(rawPayload.source_media_type || normalizedPayload.source_media_type || '').trim().toLowerCase();
  const primaryAssets = normalizeReferenceAssets(rawPayload.primary_assets);
  const referenceAssets = normalizeReferenceAssets(rawPayload.reference_assets);
  if (sourceMediaType === 'video') {
    const sourceUrl = extractFirstString(normalizedPayload.source_url);
    if (sourceUrl) push(sourceUrl, 'composition', 'primary-source-video');
  }

  for (const asset of primaryAssets) {
    if (asset.type !== 'video') continue;
    push(asset.url, asset.role === 'primary' ? 'composition' : asset.role, 'primary-asset-video');
  }

  for (const asset of referenceAssets) {
    if (asset.type !== 'video') continue;
    const roles = String(asset.role || '').trim().toLowerCase() === 'omni'
      ? ['motion', 'rhythm', 'style']
      : [asset.role];
    for (const role of roles) {
      push(asset.url, role, 'reference-asset-video');
    }
  }

  const fallbackReferenceVideoUrl = extractFirstString(normalizedPayload.reference_video_url);
  if (fallbackReferenceVideoUrl) push(fallbackReferenceVideoUrl, 'motion', 'reference-video-url');

  return entries;
}

function buildApimartAudioUrls(rawPayload = {}) {
  const values = [
    extractFirstString(rawPayload.linked_audio_url),
    ...(Array.isArray(rawPayload.reference_assets)
      ? rawPayload.reference_assets
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .filter((item) => String(item.type || '').trim().toLowerCase() === 'audio')
        .map((item) => extractFirstString(item.url))
      : []),
  ].filter(Boolean);
  return uniqueStrings(values);
}

export {
  normalizeReferenceAssets,
  buildApimartImageRoleEntries,
  buildApimartOrderedImageUrls,
  buildApimartImagePromptContract,
  buildApimartVideoRoleEntries,
  buildApimartAudioUrls,
};
