/**
 * 摄像机能力面板闭环测试（配置侧）
 *
 * 验收点：
 *   1️⃣ 面板渲染机身库 / 镜头库 / 预设 / 光学参数。
 *   2️⃣ 选择预设、机身、镜头与调节参数均回写到 onChange。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CameraCapabilityPanel from '@/components/image-tools/panels/CameraCapabilityPanel';

describe('CameraCapabilityPanel 配置闭环', () => {
  it('渲染关键控件', () => {
    render(<CameraCapabilityPanel tool="camera" value={{}} onChange={vi.fn()} />);
    expect(screen.getByTestId('camera-preset-product-shot')).toBeTruthy();
    expect(screen.getByTestId('camera-body-arri-alexa-35')).toBeTruthy();
    expect(screen.getByTestId('camera-focal-slider')).toBeTruthy();
    expect(screen.getByTestId('camera-shutter-select')).toBeTruthy();
  });

  it('选择预设 / 机身 / 镜头与调节焦距回写 onChange', () => {
    const onChange = vi.fn();
    render(<CameraCapabilityPanel tool="camera" value={{}} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('camera-preset-portrait'));
    const presetCall = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(presetCall.lens).toBe('Zeiss Supreme 85mm');

    fireEvent.click(screen.getByTestId('camera-body-sony-venice-2'));
    fireEvent.click(screen.getByTestId('camera-lens-cooke-s4-i-50mm'));

    fireEvent.change(screen.getByTestId('camera-focal-slider'), { target: { value: '85' } });

    const hasFocal = onChange.mock.calls.some(
      (call) => (call[0] as Record<string, unknown>).focalLength === 85,
    );
    expect(hasFocal).toBe(true);
  });
});
