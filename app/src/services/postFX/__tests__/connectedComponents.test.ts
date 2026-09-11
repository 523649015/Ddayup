import { describe, expect, it } from 'vitest';
import { labelConnectedComponents } from '@/services/postFX/connectedComponents';

describe('labelConnectedComponents', () => {
  it('keeps diagonally connected foreground as one subject', () => {
    const alpha = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 0,
    ]);

    const result = labelConnectedComponents(alpha, 4, 4, 1, 0.5);

    expect(result.components).toHaveLength(1);
    expect(result.components[0].pixelCount).toBe(3);
    expect(result.components[0].bbox).toEqual({ x: 0, y: 0, width: 3, height: 3 });
  });

  it('filters tiny noise subjects below minArea', () => {
    const alpha = new Float32Array([
      1, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 1, 1,
      0, 0, 1, 1,
    ]);

    const result = labelConnectedComponents(alpha, 4, 4, 3, 0.5);

    expect(result.components).toHaveLength(1);
    expect(result.components[0].pixelCount).toBe(4);
    expect(result.labels[0]).toBe(0);
  });
});
