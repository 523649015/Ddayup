// 视觉模型激活闭环：面板跳转到 API 管理激活后，通过 sessionStorage 回传激活结果，
// 返回面板时自动回填并提示。仅在本会话内有效。

const STORAGE_KEY = 'hmdao_vision_activation';

export interface VisionActivationFlag {
  providers: string[];
  ts: number;
}

export function setVisionActivationFlag(providers: string[]): void {
  try {
    const normalized = Array.from(new Set(providers.map((value) => String(value || '').trim().toLowerCase()))).filter(Boolean);
    if (normalized.length === 0) return;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ providers: normalized, ts: Date.now() } as VisionActivationFlag));
  } catch {
    // 存储不可用时静默忽略，闭环仅作体验增强
  }
}

export function consumeVisionActivationFlag(): VisionActivationFlag | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as VisionActivationFlag;
    if (parsed && Array.isArray(parsed.providers)) return parsed;
  } catch {
    // 解析失败忽略
  }
  return null;
}
