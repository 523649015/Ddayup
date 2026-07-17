/**
 * 多角度能力面板闭环测试（配置侧）
 *
 * 验收点：
 *   1️⃣ 面板渲染机位预设 / 环绕拖拽热区 / 关键帧管理。
 *   2️⃣ 选择预设与保存关键帧均回写到 onChange。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MultiAngleCapabilityPanel from '@/components/image-tools/panels/MultiAngleCapabilityPanel';

describe('MultiAngleCapabilityPanel 配置闭环', () => {
  it('渲染关键控件', () => {
    render(<MultiAngleCapabilityPanel tool="multiAngle" value={{}} onChange={vi.fn()} />);
    expect(screen.getByTestId('multi-angle-orbit-pad')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-preset-front')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-yaw-slider')).toBeTruthy();
  });

  it('选择预设与保存关键帧回写 onChange', () => {
    const onChange = vi.fn();
    render(<MultiAngleCapabilityPanel tool="multiAngle" value={{}} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('multi-angle-preset-tilt'));
    const presetCall = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(presetCall.yaw).toBe(42);

    fireEvent.change(screen.getByTestId('multi-angle-keyframe-name'), {
      target: { value: '正面近景' },
    });
    fireEvent.click(screen.getByTestId('multi-angle-keyframe-add'));

    const saved = onChange.mock.calls.some(
      (call) => Array.isArray((call[0] as Record<string, unknown>).keyframes)
        && ((call[0] as Record<string, unknown>).keyframes as unknown[]).length === 1,
    );
    expect(saved).toBe(true);
  });
});
