/**
 * Phase 7 UI：HD 精修面板「本地放大（Real-ESRGAN）」闭环测试
 *
 * 验收点：
 *   1️⃣ 面板渲染「本地放大」按钮。
 *   2️⃣ 点击后调用 runLocalHdUpscale 并把结果回显到状态栏。
 *   3️⃣ 无源图时给出提示而不调用。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// HdCapabilityPanel 通过 @/services/imageToolApply 的 applyHdUpscale 执行本地放大（不再是 imageModelRouting.runLocalHdUpscale）
const applyHdUpscaleMock = vi.fn(async () => ({ url: 'hmdao-local://hd-1', engine: 'esrgan' }));
vi.mock('@/services/imageToolApply', () => ({
  applyHdUpscale: (...args: unknown[]) => applyHdUpscaleMock(...args),
  applyHdRestore: vi.fn(),
  applyHdOutpaint: vi.fn(),
  applyHdInpaint: vi.fn(),
  applyHdCutout: vi.fn(),
  applyHdCrop: vi.fn(),
}));

import HdCapabilityPanel from '@/components/image-tools/panels/HdCapabilityPanel';

describe('HdCapabilityPanel 本地放大闭环', () => {
  beforeEach(() => {
    applyHdUpscaleMock.mockClear();
  });

  it('点击本地放大回显结果', async () => {
    render(<HdCapabilityPanel tool="hd" value={{ hdMode: 'upscale' }} onChange={vi.fn()} sourceImageUrl="https://example.com/src.png" />);
    fireEvent.click(screen.getByTestId('hd-apply-upscale'));
    expect(applyHdUpscaleMock).toHaveBeenCalledTimes(1);
    expect(applyHdUpscaleMock.mock.calls[0][0]).toBe('https://example.com/src.png');
    await waitFor(() => expect(screen.getByTestId('hd-apply-status').textContent).toContain('已应用'));
  });

  it('无源图时提示而不调用', async () => {
    render(<HdCapabilityPanel tool="hd" value={{ hdMode: 'upscale' }} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('hd-apply-upscale'));
    expect(applyHdUpscaleMock).not.toHaveBeenCalled();
    // handleApplyByMode 是异步的，失败分支的 setHdStatus 在 microtask 后才落地
    await waitFor(() => expect(screen.getByTestId('hd-apply-status').textContent).toContain('请先'));
  });
});
