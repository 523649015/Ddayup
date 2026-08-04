/**
 * relayPresets.ts — 自定义中转预设的持久化与构造（业务逻辑层，单一职责）
 *
 * 从 ApiKeysPage 抽离：原本内联在页面文件里的 localStorage 直写、ID 规范化、
 * 预设构造等纯逻辑，统一收敛到 services 层。页面只负责组合 UI，不再持有副作用。
 *
 * 仅依赖配置类型 RelayPreset（@/config/providerGuides），不引用任何 React/store。
 */
import type { RelayPreset } from '@/config/providerGuides';

const CUSTOM_RELAY_PRESETS_STORAGE_KEY = 'hmdao-custom-relay-presets-v1';

/** 将任意用户输入规范为安全的预设 ID（小写、去协议、限长） */
export function sanitizeRelayPresetId(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `relay-${Date.now()}`;
}

/** 规范化中转 Base URL（处理 apimart 特例、去尾斜杠、保留协议与路径） */
export function canonicalizeRelayBaseUrl(baseUrl: string): string {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  const normalizedInput = raw.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(normalizedInput)) return normalizedInput;
  try {
    const parsed = new URL(normalizedInput);
    const hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (hostname === 'apimart.ai' || hostname === 'api.apimart.ai') {
      return 'https://api.apimart.ai/v1';
    }
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return normalizedInput;
  }
}

/** 由 Base URL 构造一个 RelayPreset 描述对象 */
export function buildCustomRelayPreset(baseUrl: string): RelayPreset {
  const normalizedBaseUrl = canonicalizeRelayBaseUrl(baseUrl);
  let hostLabel = normalizedBaseUrl;
  try {
    hostLabel = new URL(normalizedBaseUrl).hostname.replace(/^www\./i, '') || normalizedBaseUrl;
  } catch {
    hostLabel = normalizedBaseUrl.replace(/^https?:\/\//i, '');
  }
  const safeId = sanitizeRelayPresetId(hostLabel);
  return {
    id: `custom-${safeId}`,
    nameZh: `${hostLabel} 自定义中转`,
    nameEn: `${hostLabel} Custom Relay`,
    docsUrl: normalizedBaseUrl,
    consoleUrl: normalizedBaseUrl,
    baseUrlExample: normalizedBaseUrl,
    descriptionZh: '本地保存的自定义中转平台，便于下次继续使用，无需重复输入 Base URL。',
    descriptionEn: 'A locally saved custom relay so you can reuse the Base URL without entering it again.',
    endpointHintZh: '填写该平台控制台给出的 OpenAI 兼容 Base URL，通常以 /v1 结尾。',
    endpointHintEn: 'Use the OpenAI-compatible Base URL shown in the platform console, usually ending with /v1.',
    recommendedProviders: [],
    recommendedModels: {},
  };
}

/** 从 localStorage 读取用户保存的自定义中转预设（SSR/无 window 环境返回空） */
export function readCustomRelayPresets(): RelayPreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_RELAY_PRESETS_STORAGE_KEY);
    const parsed = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object' && String(item.baseUrlExample || '').trim())
      .map((item) => buildCustomRelayPreset(canonicalizeRelayBaseUrl(String(item.baseUrlExample || '').trim())));
  } catch {
    return [];
  }
}

/** 将自定义中转预设写回 localStorage（写入失败静默忽略，不影响运行时状态） */
export function writeCustomRelayPresets(presets: RelayPreset[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      CUSTOM_RELAY_PRESETS_STORAGE_KEY,
      JSON.stringify(presets.map((item) => ({ id: item.id, baseUrlExample: item.baseUrlExample }))),
    );
  } catch {
    // Ignore localStorage write failures and continue with runtime state.
  }
}
