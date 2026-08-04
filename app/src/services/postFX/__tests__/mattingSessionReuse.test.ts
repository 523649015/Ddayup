/**
 * BiRefNet 抠像回归测试
 *
 * 1. 1024² 首次推理失败后，应复用同一个 ONNX 会话继续回退分辨率；
 * 2. fresh profile / fresh cache 时，应先自动补齐 BiRefNet 缓存，再继续抠图。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createOrtSessionMock = vi.fn();
const createTensorMock = vi.fn();
const getCachedModelMock = vi.fn();
const loadModelMock = vi.fn();

function makeImageData(width: number, height: number) {
  return { data: new Uint8ClampedArray(Math.max(1, width * height * 4)), width, height };
}

function installCanvasStub(): void {
  if (typeof HTMLCanvasElement === 'undefined') return;
  HTMLCanvasElement.prototype.getContext = function getContextStub() {
    const canvas = this as HTMLCanvasElement;
    const ctx: Record<string, unknown> = {
      createImageData: (w: number, h: number) => makeImageData(w, h),
      getImageData: (_x: number, _y: number, w: number, h: number) => makeImageData(w, h),
      putImageData: () => {},
      drawImage: () => {},
      fillRect: () => {},
      clearRect: () => {},
      getContextAttributes: () => ({}),
      canvas,
    };
    return new Proxy(ctx, {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        return () => {};
      },
      set() {
        return true;
      },
    });
  } as unknown as HTMLCanvasElement['getContext'];
}

vi.mock('@/services/localInference/ortEnv', () => ({
  createOrtSession: createOrtSessionMock,
  createTensor: createTensorMock,
}));

vi.mock('@/services/storage', () => ({
  getCachedModel: getCachedModelMock,
}));

vi.mock('@/services/modelLoader', () => ({
  loadModel: loadModelMock,
}));

vi.mock('@/services/postFX/util', () => ({
  clamp: (value: number, min: number, max: number) => Math.min(max, Math.max(min, value)),
  imageToCanvas: (img: HTMLImageElement | HTMLCanvasElement) => img,
  loadImageFromUrl: vi.fn(),
}));

describe('BiRefNet 抠像回归', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installCanvasStub();

    getCachedModelMock.mockResolvedValue({ data: new ArrayBuffer(16) });
    loadModelMock.mockResolvedValue({ success: true, data: new ArrayBuffer(16) });
    createTensorMock.mockImplementation(async (_type: string, data: Float32Array, dims: number[]) => ({ data, dims }));
    createOrtSessionMock.mockResolvedValue({
      inputNames: ['pixel_values'],
      outputNames: ['alpha'],
      run: vi.fn(async (feeds: Record<string, { dims: number[] }>) => {
        const input = feeds.pixel_values;
        const size = input.dims[3];
        if (size === 1024) throw new Error('oom-at-1024');
        return { alpha: { data: new Float32Array(size * size).fill(1) } };
      }),
    });
  });

  it('1024² 失败后应复用同一个会话回退到 896²，而不是重建 session', async () => {
    const mod = await import('@/services/postFX/matting');

    const ready = await mod.loadMattingModel();
    expect(ready.ok).toBe(true);
    expect(createOrtSessionMock).toHaveBeenCalledTimes(1);

    const source = document.createElement('canvas');
    source.width = 1055;
    source.height = 612;

    const result = await mod.removeBackground(source);

    expect(result.width).toBe(1055);
    expect(result.height).toBe(612);
    expect(createOrtSessionMock).toHaveBeenCalledTimes(1);
    expect(createTensorMock.mock.calls.map((call) => call[2][3])).toEqual([1024, 896]);
  });

  it('缓存缺失时应先自动下载 BiRefNet，再继续抠图', async () => {
    getCachedModelMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ data: new ArrayBuffer(16) });

    const mod = await import('@/services/postFX/matting');
    const source = document.createElement('canvas');
    source.width = 1055;
    source.height = 612;

    const result = await mod.removeBackground(source);

    expect(result.width).toBe(1055);
    expect(result.height).toBe(612);
    expect(loadModelMock).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'birefnet-matting' }));
    expect(createOrtSessionMock).toHaveBeenCalledTimes(1);
  });
});
