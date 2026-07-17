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

const runLocalHdUpscaleMock = vi.fn(async () => ({ url: 'hmdao-local://hd-1', assetId: 'a1' }));
vi.mock('@/services/imageModelRouting', () => ({
  runLocalHdUpscale: (...args: unknown[]) => runLocalHdUpscaleMock(...args),
  LocalModelError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

import HdCapabilityPanel from '@/components/image-tools/panels/HdCapabilityPanel';

describe('HdCapabilityPanel 本地放大闭环', () => {
  beforeEach(() => {
    runLocalHdUpscaleMock.mockClear();
  });

  it('点击本地放大回显结果', async () => {
    render(<HdCapabilityPanel tool="hd" value={{ hdMode: 'upscale' }} onChange={vi.fn()} sourceImageUrl="https://example.com/src.png" />);
    fireEvent.click(screen.getByTestId('hd-local-upscale'));
    expect(runLocalHdUpscaleMock).toHaveBeenCalledTimes(1);
    expect(runLocalHdUpscaleMock.mock.calls[0][0]).toBe('https://example.com/src.png');
    await waitFor(() => expect(screen.getByTestId('hd-local-status').textContent).toContain('本地放大完成'));
  });

  it('无源图时提示而不调用', () => {
    render(<HdCapabilityPanel tool="hd" value={{ hdMode: 'upscale' }} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('hd-local-upscale'));
    expect(runLocalHdUpscaleMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('hd-local-status').textContent).toContain('请先');
  });
});
