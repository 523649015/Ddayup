import type { DccConnectionSnapshot, DccEngine, DccRuntimeStage, DccRuntimeStageState } from './types';

const BROKEN_DCC_TEXT_RE = /\uFFFD|\u951f|\?{2,}|ï¿½|[闂闁婵濠缂鐘鍙]|鎻掍欢|閫傞厤鍣|妫(?:€)?娴|杩炴帴|瀹夎|閲嶅畨瑁|閲嶅缓|娓呯悊|鍥為(?:€|退)|璇峰厛|姝ｅ父鎵撳紑|鍐嶇偣鍑|浼氳瘽|鏈嶅姟|鍚姩|璇婃柇|绛夊緟/;
const BROKEN_DCC_TEXT_HINTS = new Set(['闂', '闁', '婵', '濠', '缂', '鎻', '掍', '歡', '閫', '傞', '厤', '鍣', '妫', '娴', '杩', '炴', '帴', '瀹', '夎', '閲', '嶅', '娓', '呯', '悊', '鍥', '璇', '姝', '鎵', '撳', '鍐', '偣', '鍑', '浼', '鏈', '嶅', '鍚', '', '璇', '婃', '柇', '绛', '夊', '緟']);
const ESCAPED_UNICODE_RE = /\\u([0-9a-fA-F]{4})/g;
const ESCAPED_HEX_RE = /\\x([0-9a-fA-F]{2})/g;

export interface DccRuntimePresentation {
  stage: DccRuntimeStage;
  state: DccRuntimeStageState;
  label: string;
  message: string;
  dedupeKey: string;
}

export interface DccRuntimeStateLike {
  stage?: string;
  state?: string;
  label?: string;
  message?: string;
  reason?: string;
  dedupeKey?: string;
}

export function isBrokenDccText(value: string | undefined | null) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (BROKEN_DCC_TEXT_RE.test(raw)) return true;
  const suspiciousCount = [...raw].reduce((count, char) => count + (BROKEN_DCC_TEXT_HINTS.has(char) ? 1 : 0), 0);
  const replacementCount = (raw.match(/\?/g) || []).length;
  return suspiciousCount >= 4 || (raw.length <= 120 ? replacementCount >= 3 : replacementCount >= 5);
}

function decodeEscapedUnicode(value: string) {
  if (!value || (!value.includes('\\u') && !value.includes('\\x'))) return value;
  return value
    .replace(ESCAPED_UNICODE_RE, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(ESCAPED_HEX_RE, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

export function sanitizeDccVisibleText(value: string | undefined | null, fallback: string) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const decoded = decodeEscapedUnicode(raw).trim();
  if (decoded && decoded !== raw && !isBrokenDccText(decoded)) return decoded;
  return isBrokenDccText(raw) ? fallback : raw;
}

function normalizeStage(value: string | undefined | null): DccRuntimeStage {
  return value === 'plugin' || value === 'bridge' || value === 'frame' ? value : 'host';
}

function normalizeStageState(value: string | undefined | null): DccRuntimeStageState {
  return value === 'waiting' || value === 'ready' || value === 'error' ? value : 'idle';
}

function fallbackRuntimeLabel(engine: DccEngine, stage: DccRuntimeStage, state: DccRuntimeStageState) {
  if (stage === 'plugin') return state === 'error' ? '插件阶段异常' : state === 'ready' ? '插件已就绪' : '等待插件就绪';
  if (stage === 'bridge') return state === 'error' ? '桥接不可用' : state === 'ready' ? '桥接已上线' : '等待桥接上线';
  if (stage === 'frame') return state === 'error' ? '预览/录制异常' : state === 'ready' ? '首帧预览已就绪' : '等待首帧预览';
  return engine === 'unreal'
    ? (state === 'ready' ? 'Unreal 已就绪' : state === 'error' ? 'Unreal 未就绪' : '等待 Unreal 启动')
    : (state === 'ready' ? 'Blender 已就绪' : state === 'error' ? 'Blender 未就绪' : '等待 Blender 启动');
}

function fallbackRuntimeMessage(engine: DccEngine, stage: DccRuntimeStage) {
  if (stage === 'plugin') return engine === 'unreal' ? '请确认 Unreal 插件已经安装并启用。' : '请确认 Blender 插件已经安装并启用。';
  if (stage === 'bridge') return engine === 'unreal' ? '请等待 HMDao 直连桥上线。' : '请等待 8766 捕获服务上线。';
  if (stage === 'frame') return '连接已建立，正在等待真实首帧预览。';
  return engine === 'unreal' ? '请先正常打开 Unreal 主窗口，再点击 Connect。' : '请先正常打开 Blender 主窗口，再点击 Connect。';
}

export function normalizeDccRuntimePresentation(engine: DccEngine, value: DccRuntimeStateLike | null | undefined): DccRuntimePresentation {
  const stage = normalizeStage(value?.stage);
  const state = normalizeStageState(value?.state);
  const fallbackLabel = fallbackRuntimeLabel(engine, stage, state);
  const label = sanitizeDccVisibleText(value?.label, fallbackLabel);
  const message = sanitizeDccVisibleText(value?.message, fallbackRuntimeMessage(engine, stage));
  const dedupeKey = sanitizeDccVisibleText(value?.dedupeKey || value?.reason, `${stage}:${state}`);
  return { stage, state, label, message, dedupeKey };
}

export function summarizeDccSnapshot(engine: DccEngine, snapshot: DccConnectionSnapshot): DccRuntimePresentation {
  const stage = normalizeStage(snapshot.runtimeStage);
  const state = normalizeStageState(snapshot.runtimeStageState);
  const fallbackLabel = fallbackRuntimeLabel(engine, stage, state);
  const label = sanitizeDccVisibleText(snapshot.runtimeStageLabel, fallbackLabel);
  const message = sanitizeDccVisibleText(snapshot.message, fallbackRuntimeMessage(engine, stage));
  return {
    stage,
    state,
    label,
    message,
    dedupeKey: `${stage}:${state}:${label}`,
  };
}

