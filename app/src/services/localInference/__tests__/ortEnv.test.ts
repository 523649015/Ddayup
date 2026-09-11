/**
 * ortEnv 执行后端选择回归测试
 *
 * 真机问题（2026-07-18）：onnxruntime-web 的 WebGPU EP 对 BiRefNet / Depth V3
 * 这类含大 Concat/Split、深嵌套的模型，会生成超出 WebGPU 单阶段 storage buffer
 * 上限（默认 8，模型需要 17/33/65 个）、且 WGSL 链长超过 127 的着色器，
 * 会话创建即抛大量 WebGPU validation error，一键抠图 / 一键电影感全部失败。
 *
 * 修复：buildEpCandidates 一律返回 [['webgl','wasm'],['wasm']]，禁用 webgpu。
 * 本测试锁定该约束，避免后续改动再次引入 webgpu 候选。
 */
import { describe, it, expect } from 'vitest';
import { buildEpCandidates } from '../ortEnv';

describe('ortEnv 执行后端选择', () => {
  it('绝不返回 webgpu（否则触发 WebGPU 着色器资源上限崩溃）', () => {
    const candidates = buildEpCandidates();
    const flat = candidates.flat();
    expect(flat).not.toContain('webgpu');
  });

  it('首选 WebGL EP（用显存放权重，绕开 wasm 4GB 堆 OOM）', () => {
    const candidates = buildEpCandidates();
    expect(candidates[0]).toEqual(['webgl', 'wasm']);
  });

  it('保留纯 wasm 兜底档（WebGL 不支持的算子节点级回退）', () => {
    const candidates = buildEpCandidates();
    const last = candidates[candidates.length - 1];
    expect(last).toEqual(['wasm']);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('结果与运行环境（是否跨域隔离 / 有无 navigator.gpu）无关', () => {
    // webgl 不需要 SharedArrayBuffer / COOP-COEP，任何环境都走同一候选，行为可预期。
    const a = buildEpCandidates();
    const b = buildEpCandidates();
    expect(a).toEqual(b);
    expect(a).toEqual([['webgl', 'wasm'], ['wasm']]);
  });
});
