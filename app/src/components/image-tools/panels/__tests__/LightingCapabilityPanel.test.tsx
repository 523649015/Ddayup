/**
 * 打光能力面板闭环测试（配置侧）
 *
 * 验收点：
 *   1️⃣ 面板渲染光位预设 / 多灯位 / HDRI 资源区。
 *   2️⃣ 选择预设与切换灯位 / 轮廓光 / HDRI 开关均回写到 onChange。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/store/useAssetStore', () => {
  const store = {
    items: [] as unknown[],
    addItem: vi.fn(() => 'asset-id'),
    deleteItems: vi.fn(),
    syncPersistedItems: vi.fn(),
  };
  const hook = (selector: (s: unknown) => unknown) => selector(store);
  return { useAssetStore: Object.assign(hook, { getState: () => store, setState: vi.fn() }) };
});

import LightingCapabilityPanel from '@/components/image-tools/panels/LightingCapabilityPanel';

describe('LightingCapabilityPanel 配置闭环', () => {
  it('渲染关键控件', () => {
    render(<LightingCapabilityPanel tool="lighting" value={{}} onChange={vi.fn()} />);
    expect(screen.getByTestId('lighting-preset-rembrandt')).toBeTruthy();
    expect(screen.getByTestId('lighting-direction-pad')).toBeTruthy();
    expect(screen.getByTestId('lighting-azimuth-slider')).toBeTruthy();
    expect(screen.getByTestId('lighting-hdri-toggle')).toBeTruthy();
  });

  it('选择预设与切换灯位 / 轮廓光开关回写 onChange', () => {
    const onChange = vi.fn();
    render(<LightingCapabilityPanel tool="lighting" value={{}} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('lighting-preset-golden_hour'));
    const presetCall = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(presetCall.preset).toBe('golden_hour');

    fireEvent.click(screen.getByTestId('lighting-active-rim'));
    fireEvent.click(screen.getByTestId('lighting-rim-toggle'));

    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(last.rimLightEnabled).toBe(false);
  });
});
