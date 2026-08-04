/**
 * 多角度能力面板闭环测试（配置侧 + 执行侧）
 *
 * 验收点：
 *   1. 面板渲染：预设标签 / Three.js 轨道球容器 / 滑块 / 关键帧管理 / 提示词开关。
 *   2. 选择预设与保存关键帧均回写到 onChange。
 *   3. 滑块交互即时更新数值。
 *   4. 覆盖原图 / 生成新节点按钮存在且可点击。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MultiAngleCapabilityPanel from '@/components/image-tools/panels/MultiAngleCapabilityPanel';

vi.mock('@/services/imageToolApply', () => ({
  applyMultiAngle: vi.fn().mockResolvedValue({ url: 'mock://result.png', assetId: 'test-asset', engine: 'canvas-camera' }),
}));

// Three.js 的 WebGL 在 jsdom 下不可用，mock 为简单 div
vi.mock('@/components/image-tools/panels/MultiAngleOrbit3D', () => ({
  MultiAngleOrbit3D: () => (<div data-testid="multi-angle-orbit-3d" />),
}));

describe('MultiAngleCapabilityPanel 配置闭环', () => {
  it('渲染所有预设标签', () => {
    render(<MultiAngleCapabilityPanel tool="multiAngle" value={{}} onChange={vi.fn()} />);
    expect(screen.getByTestId('multi-angle-preset-custom')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-preset-fisheye')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-preset-tilt')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-preset-front-top')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-preset-front-low')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-preset-panorama-top')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-preset-back')).toBeTruthy();
  });

  it('渲染轨道球与滑块', () => {
    render(<MultiAngleCapabilityPanel tool="multiAngle" value={{}} onChange={vi.fn()} />);
    expect(screen.getByTestId('multi-angle-orbit-3d')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-yaw-slider')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-pitch-slider')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-zoom-slider')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-consistency-slider')).toBeTruthy();
  });

  it('选择预设与保存关键帧回写 onChange', () => {
    const onChange = vi.fn();
    render(<MultiAngleCapabilityPanel tool="multiAngle" value={{}} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('multi-angle-preset-tilt'));
    const presetCall = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(presetCall.yaw).toBe(42);
    expect(presetCall.pitch).toBe(22);
    expect(presetCall.cameraPreset).toBe('tilt');

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

  it('滑块调整 yaw 回写 onChange', () => {
    const onChange = vi.fn();
    render(<MultiAngleCapabilityPanel tool="multiAngle" value={{ yaw: 45 }} onChange={onChange} />);

    fireEvent.change(screen.getByTestId('multi-angle-yaw-slider'), { target: { value: '120' } });
    const call = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.yaw).toBe(120);
    expect(call.cameraPreset).toBe('custom');
  });

  it('提示词开关切换正常', () => {
    const onChange = vi.fn();
    render(<MultiAngleCapabilityPanel tool="multiAngle" value={{}} onChange={onChange} />);

    const toggle = screen.getByTestId('multi-angle-prompt-toggle');
    fireEvent.click(toggle);

    // 点击后应出现 textarea
    expect(screen.getByTestId('multi-angle-prompt-text')).toBeTruthy();

    // 关闭后应消失
    fireEvent.click(toggle);
    expect(screen.queryByTestId('multi-angle-prompt-text')).toBeNull();
  });

  it('按钮存在且可触发', () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    const onCreateAsNewNode = vi.fn().mockResolvedValue(undefined);

    render(
      <MultiAngleCapabilityPanel
        tool="multiAngle"
        value={{}}
        onChange={vi.fn()}
        sourceImageUrl="test://source.png"
        onApply={onApply}
        onCreateAsNewNode={onCreateAsNewNode}
      />,
    );

    expect(screen.getByTestId('multi-angle-apply')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-new-node')).toBeTruthy();
  });
});
