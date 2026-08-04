// 纯对象/代理错误分类工具（从主文件 hmdao-api.mjs 剥离，行为零变更）。
// 仅依赖内置对象与字符串 API，无模块级可变状态依赖。

const INTERNAL_GENERATION_FIELDS = new Set([
  'base_prompt',
  'tool_prompt',
  'tool_operation',
  'tool_capability',
  'tool_config',
  'image_tool',
  'video_tool',
  'generation_mode',
  'motion_preset',
  'style_preset',
  'motion_strength',
  'consistency_strength',
  'reference_weight',
  'source_media_type',
  'primary_assets',
  'reference_assets',
  'reference_summary',
  'conditioning_strategy',
  'workflow_graph',
  'identity_controller',
  'shared_memory_ids',
  'shared_memory_layers',
  'shared_memory_context',
  'shared_memory_refs',
  'linked_audio_url',
  'linked_audio_asset_id',
  'linked_audio_mode',
  'linked_audio_label',
  'linked_audio_backend',
  'audio_mix_mode',
  'audio_gain',
  'video_gain',
  'panorama',
  'multi_angle',
  'lighting',
  'camera_control',
  'grid',
  'split',
]);

export function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== ''),
  );
}

export function classifyProxyError({ code = '', status = 0, message = '' } = {}) {
  const normalized = String(message || '').toLowerCase();
  if (code === 'validation_error') return 'validation';
  if (code === 'timeout' || normalized.includes('timed out') || normalized.includes('timeout')) return 'timeout';
  if (normalized.includes('insufficient balance') || normalized.includes('balance is insufficient') || normalized.includes('balance insufficient') || normalized.includes('quota exceeded') || normalized.includes('insufficient quota') || normalized.includes('token limit exceeded')) {
    return 'quota';
  }
  if (status === 401 || status === 403) return 'auth';
  if (status === 404 || normalized.includes('not found')) return 'routing';
  if (status >= 500) return 'upstream';
  return 'request';
}

export function normalizeAspectRatio(value, fallback = '16:9') {
  const raw = String(value || fallback).trim();
  return /^\d+:\d+$/.test(raw) ? raw : fallback;
}

export function stripInternalGenerationFields(payload = {}) {
  return Object.fromEntries(
    Object.entries(payload || {}).filter(([key]) => !INTERNAL_GENERATION_FIELDS.has(key)),
  );
}
