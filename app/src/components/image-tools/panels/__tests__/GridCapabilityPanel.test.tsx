/**
 * 九宫格 / 分镜能力面板闭环测试（配置侧 + 导出）
 *
 * 验收点：
 *   1️⃣ 面板渲染模板选择 / 镜头数量 / 脚本导入 / 导出按钮。
 *   2️⃣ 选择模板与导出 PDF/ZIP 调用导出服务并回写状态。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const exportPdfMock = vi.fn(async () => undefined);
const exportZipMock = vi.fn(async () => undefined);
vi.mock('@/lib/imageToolExports', () => ({
  exportStoryboardPdf: (...args: unknown[]) => exportPdfMock(...args),
  exportStoryboardZip: (...args: unknown[]) => exportZipMock(...args),
}));

import GridCapabilityPanel from '@/components/image-tools/panels/GridCapabilityPanel';

describe('GridCapabilityPanel 配置与导出闭环', () => {
  beforeEach(() => {
    exportPdfMock.mockClear();
    exportZipMock.mockClear();
  });

  it('渲染关键控件并选择模板回写 onChange', () => {
    const onChange = vi.fn();
    render(
      <GridCapabilityPanel
        tool="grid"
        value={{}}
        onChange={onChange}
        sourceImageUrl="https://example.com/src.png"
      />,
    );
    expect(screen.getByTestId('grid-template-nine_shot')).toBeTruthy();
    expect(screen.getByTestId('grid-cells-slider')).toBeTruthy();
    expect(screen.getByTestId('grid-export-pdf')).toBeTruthy();
    expect(screen.getByTestId('grid-export-zip')).toBeTruthy();

    fireEvent.click(screen.getByTestId('grid-template-four_panel_drama'));
    const call = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.template).toBe('four_panel_drama');
    expect(call.cells).toBe(4);
  });

  it('点击导出 PDF / ZIP 调用导出服务', async () => {
    const onChange = vi.fn();
    render(
      <GridCapabilityPanel
        tool="grid"
        value={{ template: 'nine_shot', cells: 9, exportLayout: '3x3' }}
        onChange={onChange}
        sourceImageUrl="https://example.com/src.png"
      />,
    );

    fireEvent.click(screen.getByTestId('grid-export-pdf'));
    fireEvent.click(screen.getByTestId('grid-export-zip'));

    expect(exportPdfMock).toHaveBeenCalledTimes(1);
    expect(exportZipMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('grid-summary').textContent).toContain('9 格');
  });
});
