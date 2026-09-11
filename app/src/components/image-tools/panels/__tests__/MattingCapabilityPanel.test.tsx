import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MattingCapabilityPanel from '@/components/image-tools/panels/MattingCapabilityPanel';

function makeImageData(w: number, h: number) {
  return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } as ImageData;
}

function installCanvasStub() {
  if (typeof HTMLCanvasElement === 'undefined') return;
  HTMLCanvasElement.prototype.getContext = function getContextStub() {
    const ctx: Record<string, unknown> = {
      createImageData: (w: number, h: number) => makeImageData(w, h),
      getImageData: (_x: number, _y: number, w: number, h: number) => makeImageData(w, h),
      putImageData: () => {},
      drawImage: () => {},
      clearRect: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      beginPath: () => {},
      fill: () => {},
      stroke: () => {},
      roundRect: () => {},
      fillText: () => {},
      setLineDash: () => {},
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

  HTMLCanvasElement.prototype.getBoundingClientRect = function rectStub() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: this.width || 100,
      bottom: this.height || 100,
      width: this.width || 100,
      height: this.height || 100,
      toJSON: () => ({}),
    } as DOMRect;
  };

  HTMLCanvasElement.prototype.toBlob = function toBlobStub(cb: (blob: Blob | null) => void, type?: string) {
    cb(new Blob([new Uint8Array([1, 2, 3])], { type: type || 'image/png' }));
  } as unknown as HTMLCanvasElement['toBlob'];
}

const removeBackgroundMock = vi.fn();
const loadImageFromUrlMock = vi.fn();
const imageToCanvasMock = vi.fn();
const canvasToBlobMock = vi.fn();
const labelConnectedComponentsMock = vi.fn();

vi.mock('@/services/postFX/matting', () => ({
  removeBackground: (...args: unknown[]) => removeBackgroundMock(...args),
}));

vi.mock('@/services/postFX/util', () => ({
  loadImageFromUrl: (...args: unknown[]) => loadImageFromUrlMock(...args),
  imageToCanvas: (...args: unknown[]) => imageToCanvasMock(...args),
  canvasToBlob: (...args: unknown[]) => canvasToBlobMock(...args),
}));

vi.mock('@/services/postFX/connectedComponents', async (importActual) => {
  const actual = await importActual<typeof import('@/services/postFX/connectedComponents')>();
  return {
    ...actual,
    labelConnectedComponents: (...args: unknown[]) => labelConnectedComponentsMock(...args),
  };
});

const sourceCanvas = document.createElement('canvas');
sourceCanvas.width = 100;
sourceCanvas.height = 60;

beforeAll(() => {
  installCanvasStub();
});

afterEach(() => {
  cleanup();
  removeBackgroundMock.mockReset();
  loadImageFromUrlMock.mockReset();
  imageToCanvasMock.mockReset();
  canvasToBlobMock.mockReset();
  labelConnectedComponentsMock.mockReset();
});

describe('MattingCapabilityPanel', () => {
  it('supports tap select, box reselect, and batch png export', async () => {
    const labels = new Int32Array(sourceCanvas.width * sourceCanvas.height);
    for (let y = 10; y < 42; y += 1) {
      for (let x = 8; x < 34; x += 1) labels[y * sourceCanvas.width + x] = 1;
      for (let x = 56; x < 88; x += 1) labels[y * sourceCanvas.width + x] = 2;
    }

    loadImageFromUrlMock.mockResolvedValue({});
    imageToCanvasMock.mockReturnValue(sourceCanvas);
    removeBackgroundMock.mockResolvedValue({
      alpha: new Float32Array(sourceCanvas.width * sourceCanvas.height).fill(1),
    });
    labelConnectedComponentsMock.mockReturnValue({
      labels,
      components: [
        { id: 0, pixelCount: 832, bbox: { x: 8, y: 10, width: 26, height: 32 } },
        { id: 1, pixelCount: 1024, bbox: { x: 56, y: 10, width: 32, height: 32 } },
      ],
    });
    canvasToBlobMock.mockImplementation(async (canvas: HTMLCanvasElement) => new Blob([String(canvas.width)], { type: 'image/png' }));

    const onExtract = vi.fn(async () => {});
    const onClose = vi.fn();

    render(
      <MattingCapabilityPanel
        sourceImageUrl="test://source.png"
        onClose={onClose}
        onExtract={onExtract}
      />,
    );

    await screen.findByText('检测到 2 个候选主体，已选中 2 个');

    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    fireEvent.pointerUp(canvas, { clientX: 70, clientY: 20 });
    await screen.findByText('检测到 2 个候选主体，已选中 1 个');

    fireEvent.click(screen.getByText('框选补漏'));
    fireEvent.pointerDown(canvas, { clientX: 52, clientY: 8 });
    fireEvent.pointerMove(canvas, { clientX: 92, clientY: 46 });
    fireEvent.pointerUp(canvas, { clientX: 92, clientY: 46 });
    await screen.findByText('检测到 2 个候选主体，已选中 2 个');

    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: '主角' } });
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: '配角' } });
    fireEvent.click(screen.getByText('批量输出 2 个 PNG'));

    await waitFor(() => expect(onExtract).toHaveBeenCalledTimes(1));
    const results = onExtract.mock.calls[0][0] as Array<{ name: string; blob: Blob }>;
    expect(results).toHaveLength(2);
    expect(results.map((item) => item.name)).toEqual(['主角', '配角']);
    expect(results.every((item) => item.blob instanceof Blob)).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
