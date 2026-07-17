import { describe, it, expect } from 'vitest';
import {
  computeMultiAngleTransform,
  computeLightHighlight,
  computeOutpaintBounds,
  renderMaskCanvas,
} from '@/services/imageToolApply';

describe('imageToolApply 纯函数（闭环参数→几何）', () => {
  it('computeMultiAngleTransform：yaw=0 时水平无偏斜且缩放随景别', () => {
    const t = computeMultiAngleTransform(0, 0, 1);
    expect(t.c).toBeCloseTo(0, 5);
    expect(t.a).toBeCloseTo(1, 5);
    const zoomed = computeMultiAngleTransform(0, 0, 1.35);
    expect(zoomed.a).toBeGreaterThan(t.a);
  });

  it('computeMultiAngleTransform：yaw 正负对称影响水平偏斜', () => {
    const left = computeMultiAngleTransform(-90, 0, 1);
    const right = computeMultiAngleTransform(90, 0, 1);
    // c 关于原点对称：yaw 负 → c 负（左转），yaw 正 → c 正（右转）
    expect(Math.abs(left.c + right.c)).toBeLessThan(1e-3);
    expect(left.c).toBeLessThan(0);
    expect(right.c).toBeGreaterThan(0);
  });

  it('computeLightHighlight：方位/俯仰为 0 时高光位于中心', () => {
    const { x, y } = computeLightHighlight(0, 0, 1000, 500);
    expect(x).toBeCloseTo(500, 0);
    expect(y).toBeCloseTo(250, 0);
  });

  it('computeLightHighlight：俯仰升高时高光上移', () => {
    const low = computeLightHighlight(0, -30, 1000, 500);
    const high = computeLightHighlight(0, 60, 1000, 500);
    expect(high.y).toBeLessThan(low.y);
  });

  it('computeOutpaintBounds：向右扩图只增加宽度且不平移源图', () => {
    const b = computeOutpaintBounds('right', 0.5, 800, 600);
    expect(b.width).toBeGreaterThan(800);
    expect(b.height).toBe(600);
    expect(b.offsetX).toBe(0);
  });

  it('computeOutpaintBounds：四周扩图向两侧对称留白', () => {
    const b = computeOutpaintBounds('both', 0.4, 800, 600);
    expect(b.width).toBeGreaterThan(800);
    expect(b.height).toBeGreaterThan(600);
    expect(b.offsetX).toBeGreaterThan(0);
    expect(b.offsetY).toBeGreaterThan(0);
  });

  it('computeOutpaintBounds：ratio 被钳制在 0.1~1', () => {
    const tooBig = computeOutpaintBounds('right', 5, 800, 600);
    expect(tooBig.width).toBeLessThanOrEqual(800 * 2 + 1);
    const tooSmall = computeOutpaintBounds('right', -2, 800, 600);
    expect(tooSmall.width).toBeGreaterThanOrEqual(800);
  });

  it('renderMaskCanvas：返回画布且与输入点数量无关地不抛错', () => {
    const canvas = renderMaskCanvas([
      { x: 0.5, y: 0.5, brushSize: 24, brushMode: 'paint', targetMode: 'inpaint' },
      { x: 0.2, y: 0.8, brushSize: 40, brushMode: 'erase', targetMode: 'erase' },
    ]);
    expect(canvas).toBeDefined();
    expect(canvas.width).toBe(512);
    expect(canvas.height).toBe(512);
  });
});
