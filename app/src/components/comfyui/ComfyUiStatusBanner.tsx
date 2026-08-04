import { useComfyUiStatus } from '@/services/comfyui/useComfyUiStatus';

// 商业化/多用户场景下，建议 ComfyUI 必装插件白名单（可由平台策展配置）。
const REQUIRED_PLUGINS = ['ComfyUI-Manager', 'ComfyUI-VideoHelperSuite', 'ComfyUI-RIFE'];

const BASE =
  'pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-lg border px-3 py-1.5 text-xs font-medium backdrop-blur-sm';

export function ComfyUiStatusBanner() {
  const { loading, health, plugins, error } = useComfyUiStatus();

  // ComfyUI 集成处于「待完善」状态：画布上不再展示未配置 / 不可达 / 检测失败等提示，
  // 仅当 ComfyUI 已真实连通但缺少必装插件时才给出提示。
  if (loading) return null;
  if (error) return null;
  if (!health?.configured) return null;
  if (!health.reachable) return null;
  const have = new Set((plugins?.plugins || []).map((p: string) => p.toLowerCase()));
  const missing = REQUIRED_PLUGINS.filter((p: string) => !have.has(p.toLowerCase()));
  if (missing.length > 0) {
    return (
      <div className={`${BASE} border-[#3a2f12] bg-[#1a1408]/90 text-[#e3b341]`}>
        缺少插件：{missing.join('、')}（请在 ComfyUI Manager 安装）
      </div>
    );
  }
  return null;
}
