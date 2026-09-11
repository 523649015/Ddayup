/**
 * MultiAngleOrbit3D 容器测试 + 面板集成验证
 *
 * jsdom 不支持 WebGL，Three.js mock 过于复杂。
 * 改为在面板测试中通过 mock 组件验证 Orbit3D 接入点。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MultiAngleCapabilityPanel from '@/components/image-tools/panels/MultiAngleCapabilityPanel';

// Mock MultiAngleOrbit3D：记录 props 变化 + 提供 testid 容器
vi.mock('@/components/image-tools/panels/MultiAngleOrbit3D', () => ({
  MultiAngleOrbit3D: (props: Record<string, unknown>) => {
    // 测试中不渲染真正的 Three.js，但提供容器和回调调用
    const onYaw = props.onYawChange as ((v: number) => void) | undefined;
    const onPitch = props.onPitchChange as ((v: number) => void) | undefined;
    const onZoom = props.onZoomChange as ((v: number) => void) | undefined;
    return (
      <div data-testid="multi-angle-orbit-3d">
        <button data-testid="orbit-sim-drag-right" onClick={() => onYaw?.(120)}>向右拖</button>
        <button data-testid="orbit-sim-drag-up" onClick={() => onPitch?.(60)}>向上拖</button>
        <button data-testid="orbit-sim-zoom-in" onClick={() => onZoom?.(1.3)}>放大</button>
      </div>
    );
  },
}));

vi.mock('@/services/imageToolApply', () => ({
  applyMultiAngle: vi.fn().mockResolvedValue({ url: 'mock://result.png', assetId: 'test-asset', engine: 'canvas-camera' }),
}));

describe('MultiAngleOrbit3D 通过面板模拟拖拽', () => {
  it('模拟拖拽 → yaw 回写 onChange', () => {
    const onChange = vi.fn();
    render(<MultiAngleCapabilityPanel tool="multiAngle" value={{ yaw: 45 }} onChange={onChange} />);

    // 点击模拟的「向右拖」按钮
    fireEvent.click(screen.getByTestId('orbit-sim-drag-right'));

    const lastCall = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastCall.yaw).toBe(120);
    expect(lastCall.cameraPreset).toBe('custom');
  });

  it('模拟俯仰拖拽 → pitch 回写 onChange', () => {
    const onChange = vi.fn();
    render(<MultiAngleCapabilityPanel tool="multiAngle" value={{ pitch: 15 }} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('orbit-sim-drag-up'));

    const lastCall = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastCall.pitch).toBe(60);
    expect(lastCall.cameraPreset).toBe('custom');
  });

  it('模拟缩放 → zoom 回写 onChange', () => {
    const onChange = vi.fn();
    render(<MultiAngleCapabilityPanel tool="multiAngle" value={{ framingZoom: 1 }} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('orbit-sim-zoom-in'));

    const lastCall = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastCall.framingZoom).toBe(1.3);
  });

  it('Orbit3D 容器在面板内存在', () => {
    render(<MultiAngleCapabilityPanel tool="multiAngle" value={{}} onChange={vi.fn()} />);
    expect(screen.getByTestId('multi-angle-orbit-3d')).toBeTruthy();
  });

  it('面板渲染仍保持所有预设标签', () => {
    render(<MultiAngleCapabilityPanel tool="multiAngle" value={{}} onChange={vi.fn()} />);
    expect(screen.getByTestId('multi-angle-preset-custom')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-preset-fisheye')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-preset-tilt')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-preset-front-top')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-preset-front-low')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-preset-panorama-top')).toBeTruthy();
    expect(screen.getByTestId('multi-angle-preset-back')).toBeTruthy();
  });
});
