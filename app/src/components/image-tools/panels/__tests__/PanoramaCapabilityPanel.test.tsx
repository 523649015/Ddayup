/**
 * 全景能力面板闭环测试（配置侧）
 *
 * 验收点：
 *   1️⃣ 面板渲染视场角 / 空间融合 / 尺寸预设 / 局部重绘蒙版等控件。
 *   2️⃣ 切换尺寸预设、复位、局部编辑开关均回写到 onChange。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PanoramaCapabilityPanel from '@/components/image-tools/panels/PanoramaCapabilityPanel';

describe('PanoramaCapabilityPanel 配置闭环', () => {
  it('渲染关键控件', () => {
    render(<PanoramaCapabilityPanel tool="panorama" value={{}} onChange={vi.fn()} />);
    expect(screen.getByTestId('panorama-fov-slider')).toBeTruthy();
    expect(screen.getByTestId('panorama-fusion-slider')).toBeTruthy();
    expect(screen.getByTestId('panorama-size-4k')).toBeTruthy();
    expect(screen.getByTestId('panorama-immersive-viewport')).toBeTruthy();
  });

  it('选择尺寸预设与局部编辑开关回写 onChange', () => {
    const onChange = vi.fn();
    render(<PanoramaCapabilityPanel tool="panorama" value={{}} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('panorama-size-8k'));
    fireEvent.click(screen.getByTestId('panorama-local-edit-toggle'));
    fireEvent.click(screen.getByTestId('panorama-preview-reset'));

    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(last.panoramaResolution).toBe('8K');
    expect(last.panoramaYaw).toBe(0);
    expect(last.panoramaPitch).toBe(0);
  });
});
