/**
 * LaMa 局部修复运行器（入口）
 *
 * 真实推理已迁入 Web Worker（见 inferenceWorkerClient / inferenceWorker），
 * 主线程不再执行 onnxruntime-web 计算，避免「页面未响应」。
 * 此文件仅作为对外接口的稳定再导出。
 */
export { createLamaRunner } from './inferenceWorkerClient';
