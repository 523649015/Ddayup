/**
 * T2 生成式新视角插件（脚手架 + 扩展点）
 *
 * 用途：当用户把机位调到大幅角度（>~35°，如侧面/背视角）时，
 *       单图 3D 旋转（depthWarp.rotateWithDepth）无法补全被遮挡的车身，
 *       需要用「生成式新视角」模型补全 —— 输出完整图、无破损。
 *
 * 部署方式（贴合产品约束：用户本地下载、体积小、不依赖云端 Key）：
 *   - 模型以可下载插件形式列在 presetModels.ts（id = NOVEL_VIEW_MODEL_ID）。
 *   - 用户在「模型下载」面板安装后，由本地 ONNX/WebGPU 推理（与 Depth Anything V2 同机制）。
 *   - 推荐开源方案：Stable Zero123 / Zero123++ / 轻量 LCM 蒸馏 inpaint 的 ONNX 导出。
 *
 * 当前状态：脚手架已接入 applyMultiAngle 的路由，但真实权重与推理运行器
 *   尚未实现（isNovelViewPluginReady 暂返回 false），因此大角度会安全回退到 T1。
 *   后续在此处接入具体模型的 ONNX 会话即可自动启用。
 */
import { hasLocalModelRunner } from '@/services/localModelRunner';
import { getPresetInstallState } from '@/services/presetModelInstall';

export const NOVEL_VIEW_MODEL_ID = 'novel-view-gen';

export interface NovelViewParams {
  yaw: number;
  pitch: number;
  zoom: number;
  consistency: number;
}

export interface NovelViewResult {
  url: string;
  assetId: string;
  engine: string;
}

/** 插件是否已安装并激活（当前未实现运行器，恒为 false，安全回退 T1）。 */
export function isNovelViewPluginReady(): boolean {
  try {
    return Boolean(getPresetInstallState(NOVEL_VIEW_MODEL_ID)) && hasLocalModelRunner(NOVEL_VIEW_MODEL_ID);
  } catch {
    return false;
  }
}

/**
 * 生成式新视角（占位，待接入真实模型）。
 * 一旦接入 ONNX 会话，把 image + (azimuth=yaw, elevation=pitch) 喂给模型，
 * 返回完整新视角图 URL。
 */
export async function generateNovelView(
  _img: HTMLImageElement,
  _params: NovelViewParams,
): Promise<NovelViewResult> {
  throw new Error('novel-view-plugin-not-ready: 请先在「模型下载」面板安装「高保真新视角」插件');
}
