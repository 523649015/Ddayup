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
import { createImglyRunner } from './imglyRunner';

export type LocalRunnerKind = 'esrgan' | 'lama' | 'imgly';

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

  // 缓存缺失时（如旧版残留的“已安装”标记、或点过“激活”但从未真下载），
  // 先按模型声明 URL 拉取真实权重再激活，使链路自洽。
  let sessionData: ArrayBuffer | undefined;
  const cached = await getCachedModel(id, version);
  sessionData = cached?.data as ArrayBuffer | undefined;
  if (!sessionData && meta.url) {
    try {
      const { loadModel } = await import('@/services/modelLoader');
      const dl = await loadModel({
        modelId: id,
        version,
        url: meta.url,
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
  const { getPresetInstallState } = await import('@/services/presetModelInstall');
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
