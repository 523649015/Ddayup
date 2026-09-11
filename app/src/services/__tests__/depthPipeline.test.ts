/**
 * 深度驱动多角度管线测试（纯逻辑 + mock canvas）
 *
 * 验收点：
 *   1. 深度归一化映射：中心近景(>0.9)、边缘远景(<0.3)
 *   2. rotateWithDepth / warpFlat 画布尺寸正确（mock canvas getContext）
 *   3. 深度模块加载不抛异常
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DepthResult } from '@/services/depthEstimation';

// ── mock canvas.getContext ──
const mockCanvasCtx = {
  fillStyle: '',
  fillRect: vi.fn(),
  drawImage: vi.fn(),
  translate: vi.fn(),
  transform: vi.fn(),
  setTransform: vi.fn(),
  getImageData: vi.fn().mockReturnValue({
    data: new Uint8ClampedArray(3200),
    width: 800,
    height: 1,
  }),
  putImageData: vi.fn(),
  createImageData: vi.fn().mockReturnValue({
    data: new Uint8ClampedArray(800 * 600 * 4),
  }),
  save: vi.fn(),
  restore: vi.fn(),
  scale: vi.fn(),
  // mesh warp 所需的路径/裁剪方法
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  closePath: vi.fn(),
  clip: vi.fn(),
  clearRect: vi.fn(),
  arc: vi.fn(),
  ellipse: vi.fn(),
  stroke: vi.fn(),
  fill: vi.fn(),
  strokeStyle: '',
  lineWidth: 1,
  globalAlpha: 1,
  globalCompositeOperation: 'source-over',
};

const origCreateElement = document.createElement.bind(document);
beforeEach(() => {
  const createEl = vi.fn((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === 'canvas') {
      Object.defineProperty(el, 'getContext', {
        value: vi.fn().mockReturnValue(mockCanvasCtx),
        writable: true,
        configurable: true,
      });
    }
    return el;
  });
  vi.stubGlobal('HTMLCanvasElement', class extends window.HTMLCanvasElement {
    getContext = vi.fn().mockReturnValue(mockCanvasCtx);
  });
  vi.spyOn(document, 'createElement').mockImplementation(createEl as unknown as typeof document.createElement);
});

// ── 构建模拟深度数据 ──
function makeDepth(w: number, h: number, pattern: 'center-near' | 'left-near'): DepthResult {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = w / 2, cy = h / 2;
      if (pattern === 'center-near') {
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        const maxDist = Math.sqrt(cx ** 2 + cy ** 2);
        data[y * w + x] = 1 - dist / maxDist;
      } else {
        data[y * w + x] = 1 - x / w;
      }
    }
  }
  return { width: w, height: h, data };
}

// ── 模拟 Image ──
function mockImage(w: number, h: number): HTMLImageElement {
  return { naturalWidth: w, naturalHeight: h, width: w, height: h } as HTMLImageElement;
}

describe('深度数据逻辑', () => {
  it('center-near: 中心 > 角落', () => {
    const d = makeDepth(8, 8, 'center-near');
    expect(d.data[4 * 8 + 4]).toBeGreaterThan(0.9);  // 中心
    expect(d.data[0]).toBeLessThan(0.3);               // 角落
  });

  it('left-near: 左侧 > 右侧', () => {
    const d = makeDepth(8, 8, 'left-near');
    expect(d.data[0]).toBeGreaterThan(0.9);            // 最左侧
    expect(d.data[7]).toBeLessThan(0.2);               // 最右侧
  });

  it('数据大小 = width * height', () => {
    const d = makeDepth(100, 50, 'center-near');
    expect(d.data.length).toBe(5000);
    expect(d.width).toBe(100);
    expect(d.height).toBe(50);
  });
});

describe('rotateWithDepth / warpFlat (mock canvas)', () => {
  it('rotateWithDepth 不抛异常 + 画布尺寸正确', async () => {
    const { rotateWithDepth } = await import('@/services/depthWarp');
    const img = mockImage(800, 600);
    const depth = makeDepth(800, 600, 'center-near');
    const canvas = rotateWithDepth(img, depth, { yaw: 45, pitch: 0, zoom: 1, consistency: 0.85 });
    expect(canvas).toBeDefined();
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
  });

  it('warpFlat 不抛异常 + 尺寸正确', async () => {
    const { warpFlat } = await import('@/services/depthWarp');
    const img = mockImage(1024, 768);
    const canvas = warpFlat(img, { yaw: 90, pitch: 30, zoom: 1.2 });
    expect(canvas.width).toBe(1024);
    expect(canvas.height).toBe(768);
  });

  it('rotateWithDepth yaw=0, pitch=0 仍可执行', async () => {
    const { rotateWithDepth } = await import('@/services/depthWarp');
    const img = mockImage(400, 400);
    const depth = makeDepth(400, 400, 'center-near');
    const canvas = rotateWithDepth(img, depth, { yaw: 0, pitch: 0, zoom: 1, consistency: 0.85 });
    expect(canvas.width).toBe(400);
  });
});

describe('深度估计模块加载', () => {
  it('loadDepthModel 返回 not-cached（无模型）', async () => {
    const { loadDepthModel, isDepthModelReady } = await import('@/services/depthEstimation');
    const result = await loadDepthModel();
    expect(result.ok).toBe(false);
    expect(isDepthModelReady()).toBe(false);
  });
});
