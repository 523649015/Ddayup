/**
 * Phase 6（一）UI：宫格切分面板「切分并入库」闭环测试
 *
 * 验收点：
 *   1️⃣ 面板渲染「切分并入库」按钮。
 *   2️⃣ 点击后调用 splitImageToLibrary 并把返回数量回显到状态栏。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const splitImageToLibraryMock = vi.fn(async () => ({ assetIds: ['a', 'b', 'c'], count: 3 }));
vi.mock('@/services/imageTiling', () => ({
  splitImageToLibrary: (...args: unknown[]) => splitImageToLibraryMock(...args),
}));

import SplitCapabilityPanel from '@/components/image-tools/panels/SplitCapabilityPanel';

describe('SplitCapabilityPanel 切分并入库', () => {
  beforeEach(() => {
    splitImageToLibraryMock.mockClear();
  });

  it('点击「切分并入库」回显入库数量', async () => {
    render(
      <SplitCapabilityPanel
        tool="split"
        value={{ rows: 2, cols: 2 }}
        onChange={vi.fn()}
        sourceImageUrl="https://example.com/src.png"
      />,
    );

    fireEvent.click(screen.getByTestId('split-to-library'));

    expect(splitImageToLibraryMock).toHaveBeenCalledTimes(1);
    expect(splitImageToLibraryMock.mock.calls[0][0]).toMatchObject({
      sourceImageUrl: 'https://example.com/src.png',
      rows: 2,
      cols: 2,
      folderId: 'img-grid',
    });

    await waitFor(() =>
      expect(screen.getByTestId('split-library-status').textContent).toContain('已入库 3 张'),
    );
  });

  it('无源图时给出提示而不调用入库', () => {
    render(<SplitCapabilityPanel tool="split" value={{ rows: 2, cols: 2 }} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('split-to-library'));
    expect(splitImageToLibraryMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('split-library-status').textContent).toContain('请先');
  });
});
