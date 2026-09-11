/**
 * 本地模型推理统一入口（Phase 7 真实推理落地）
 *
 * 把「模型下载完成」与「功能真实可用」对齐：
 *  - 下载面板下载真实 onnx 权重（或 @imgly 运行时自取）后调用 activateLocalModel，
 *    从缓存建立 ORT 会话 / 注册 @imgly runner，并注册到运行器注册表。
 *  - 面板「已安装」状态在激活成功后才写入，避免「显示已安装但实际不可用」的
 *    数据不同步。
 *  - 刷新页面后由 reactivateInstalledLocalModels 在后台重建运行器，保持一致性。
 */

import type { LocalModelRunner } from '@/services/localModelRunner';
import { hasLocalModelRunner, registerLocalModelRunner } from '@/services/localModelRunner';
import { getCachedModel } from '@/services/storage';
import { PRESET_MODELS } from '@/config/presetModels';
import { wireLamaToInpaint } from '@/services/imageModelRouting';
import {
  createSessionInWorker,
  disposeSessionInWorker,
  createEsrganRunner,
  createLamaRunner,
} from './inferenceWorkerClient';
// modelLoader / presetModelInstall 已被本地模型面板/下载面板静态广泛引用，
// 必然进入初始主包；此处静态导入以消除 Rollup 的 "dynamic import will not move" 冗余告警。
import { loadModel } from '@/services/modelLoader';
import { markPresetInstalled, getPresetInstallState } from '@/services/presetModelInstall';
import { createImglyRunner } from './imglyRunner';

export type LocalRunnerKind = 'esrgan' | 'lama' | 'imgly' | 'depth-anything-v2' | 'depth-anything-v3' | 'rmbg' | 'raft';

/** 通知 UI 本地模型运行器状态变化（如后台重建完成） */
function emitLocalModelsChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('hmdao-local-models-changed'));
  }
}

/**
 * 激活一个本地模型。
 *  - esrgan / lama：从 IndexedDB 缓存取真实 onnx 权重建立 ORT 会话并注册 runner。
 *  - imgly：由包自身在首次推理时下载模型，这里仅注册 runner。
 */
export async function activateLocalModel(
  id: string,
  version: string,
): Promise<{ ok: boolean; reason?: string }> {
  const meta = PRESET_MODELS.find((m) => m.id === id) || null;
  if (!meta || !meta.localRunner) return { ok: false, reason: 'unknown-model' };
  if (hasLocalModelRunner(id)) return { ok: true };

  if (meta.localRunner === 'imgly') {
    registerLocalModelRunner(id, createImglyRunner());
    emitLocalModelsChanged();
    return { ok: true };
  }

  // Depth Anything V2：运行在主线程（ONNX 模型通过 ortEnv 直接加载，无需 Worker）
  if (meta.localRunner === 'depth-anything-v2') {
    try {
      const { loadDepthModel } = await import('@/services/depthEstimation');
      const result = await loadDepthModel('depth-anything-v2-small');
      if (!result.ok) return result;
      registerLocalModelRunner(id, async (input) => ({
        url: input.imageUrl,
        assetId: '',
        engine: 'depth-anything-v2',
      }));
      emitLocalModelsChanged();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `depth-activation-failed: ${(err as Error)?.message}` };
    }
  }

  // Depth Anything V3：DA3，浏览器端 ONNX（postFX/depthDof）。外部权重加载失败时自动回退 V2。
  if (meta.localRunner === 'depth-anything-v3') {
    const { loadDepthModel } = await import('@/services/depthEstimation');
    let result = await loadDepthModel('depth-anything-v3-base');
    // V3 在浏览器端创建会话失败（拆分式权重 / 算子兼容 / 显存不足）时，
    // 自动补齐并加载轻量可靠的 Depth Anything V2-small（320²，ORT Web 友好）作为兜底，
    // 保证「一键电影感」在 V3 不可用时仍能跑通（仅景深精度略降）。
    if (!result.ok) {
      try {
        const v2 = PRESET_MODELS.find((m) => m.id === 'depth-anything-v2-small');
        if (v2) {
          const dl = await loadModel({
            modelId: v2.id,
            version: v2.version,
            url: v2.url,
            extraFiles: v2.extraFiles,
            timeout: 600000,
            retries: 2,
          });
          if (dl.success) {
            markPresetInstalled(v2.id, v2.version);
            result = await loadDepthModel('depth-anything-v2-small');
          }
        }
      } catch (fallbackErr) {
        console.warn('[localInference] Depth V2 兜底加载失败：', fallbackErr);
      }
    }
    if (!result.ok) return result;
    registerLocalModelRunner(id, async (input) => ({
      url: input.imageUrl,
      assetId: '',
      engine: result.usedId === 'depth-anything-v2-small' ? 'depth-anything-v2' : 'depth-anything-v3',
    }));
    emitLocalModelsChanged();
    return { ok: true };
  }

  // RMBG-2.0 / BiRefNet：浏览器端 ONNX 抠像（postFX/matting）
  if (meta.localRunner === 'rmbg') {
    try {
      const { loadMattingModel } = await import('@/services/postFX/matting');
      const result = await loadMattingModel(id as 'birefnet-matting');
      if (!result.ok) return result;
      registerLocalModelRunner(id, async (input) => ({
        url: input.imageUrl,
        assetId: '',
        engine: 'rmbg-matting',
      }));
      emitLocalModelsChanged();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `rmbg-activation-failed: ${(err as Error)?.message}` };
    }
  }

  // RAFT 光流：浏览器端 ONNX（postFX/motionBlur），用于真实运动模糊
  if (meta.localRunner === 'raft') {
    try {
      const { loadRaftModel } = await import('@/services/postFX/motionBlur');
      const result = await loadRaftModel();
      if (!result.ok) return result;
      registerLocalModelRunner(id, async (input) => ({
        url: input.imageUrl,
        assetId: '',
        engine: 'raft-flow',
      }));
      emitLocalModelsChanged();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `raft-activation-failed: ${(err as Error)?.message}` };
    }
  }

  // 缓存缺失时（如旧版残留的“已安装”标记、或点过“激活”但从未真下载），
  // 先按模型声明 URL 拉取真实权重再激活，使链路自洽。
  let sessionData: ArrayBuffer | undefined;
  const cached = await getCachedModel(id, version);
  sessionData = cached?.data as ArrayBuffer | undefined;
  if (!sessionData && meta.url) {
    try {
      const dl = await loadModel({
        modelId: id,
        version,
        url: meta.url,
        // 与 ensurePresetModel / 面板下载对齐：拆分式权重（如 Depth V3 的 model.onnx_data）
        // 必须在此一并下载+缓存，否则 createOrtSession 解析拆分 onnx 时会因缺外部数据而失败，
        // 导致 isDepthModelReady() 永远 false、一键电影感挂死。
        extraFiles: meta.extraFiles,
        timeout: 600000,
        retries: 2,
      });
      if (dl.success && dl.data) sessionData = dl.data as ArrayBuffer;
    } catch (err) {
      console.warn(`[localInference] 激活前补下载 ${id} 失败：`, err);
    }
  }
  if (!sessionData) return { ok: false, reason: 'model-not-cached' };

  // 会话创建与推理全部在 Web Worker 内完成，主线程不被阻塞
  await createSessionInWorker(id, sessionData);
  const runner: LocalModelRunner =
    meta.localRunner === 'esrgan' ? createEsrganRunner(id) : createLamaRunner(id);
  registerLocalModelRunner(id, runner);
  if (id === 'lama-inpaint') wireLamaToInpaint();
  emitLocalModelsChanged();
  return { ok: true };
}

/** 注销本地模型运行器 */
export function deactivateLocalModel(id: string): void {
  registerLocalModelRunner(id, null);
  // 释放 Worker 内的会话，回收内存
  disposeSessionInWorker(id);
}

/**
 * 应用启动 / 面板挂载后调用：对已标记「已安装」的本地模型在后台重建运行器，
 * 使刷新后仍具备真实推理能力（与面板「已安装」状态一致）。非阻塞、失败不抛。
 */
export async function reactivateInstalledLocalModels(): Promise<void> {
  for (const m of PRESET_MODELS) {
    if (!m.localRunner) continue;
    if (getPresetInstallState(m.id) && !hasLocalModelRunner(m.id)) {
      try {
        await activateLocalModel(m.id, m.version);
      } catch (err) {
        console.warn(`[localInference] 重新激活 ${m.id} 失败：`, err);
      }
    }
  }
  emitLocalModelsChanged();
}
