/**
 * 多角度轨道球：拖拽坐标 → 角度映射纯函数测试（无 WebGL / 无 Canvas 依赖）
 */
import { describe, it, expect } from 'vitest';
import { normToAngle } from '@/components/image-tools/panels/multiAngleOrbitMath';

describe('normToAngle 拖拽映射', () => {
  it('顶部 → pitch +90', () => {
    const { pitch } = normToAngle(0, -1);
    expect(pitch).toBeCloseTo(90, 0);
  });

  it('底部 → pitch -90', () => {
    const { pitch } = normToAngle(0, 1);
    expect(pitch).toBeCloseTo(-90, 0);
  });

  it('正右 → yaw 90（前半球右缘）', () => {
    const { yaw } = normToAngle(1, 0);
    expect(yaw).toBeCloseTo(90, 0);
  });

  it('正左 → yaw 270（前半球左缘，环绕回绕）', () => {
    const { yaw } = normToAngle(-1, 0);
    expect(yaw).toBeCloseTo(270, 0);
  });

  it('中心 → yaw 0 / pitch 0', () => {
    const { yaw, pitch } = normToAngle(0, 0);
    expect(yaw).toBeCloseTo(0, 0);
    expect(pitch).toBeCloseTo(0, 0);
  });

  it('超出单位圆被投影回边缘（不 NaN）', () => {
    const { yaw, pitch } = normToAngle(2, 2);
    expect(Number.isFinite(yaw)).toBe(true);
    expect(Number.isFinite(pitch)).toBe(true);
  });

  it('yaw 始终落在 0~360', () => {
    for (const nx of [-0.9, -0.3, 0, 0.3, 0.9]) {
      const { yaw } = normToAngle(nx, 0.1);
      expect(yaw).toBeGreaterThanOrEqual(0);
      expect(yaw).toBeLessThan(360);
    }
  });
});
