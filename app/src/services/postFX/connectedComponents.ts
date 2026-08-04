/**
 * Split a foreground alpha matte into separate subject candidates.
 * We keep the alpha thresholding path simple and rely on 8-neighbour
 * connectivity plus minArea filtering to avoid over-cleaning thin subjects.
 */

export interface ComponentLabel {
  id: number;
  pixelCount: number;
  bbox: { x: number; y: number; width: number; height: number };
}

function buildDetectionMask(alpha: Float32Array, threshold: number): Uint8Array {
  const mask = new Uint8Array(alpha.length);
  for (let index = 0; index < alpha.length; index += 1) {
    mask[index] = alpha[index] >= threshold ? 1 : 0;
  }
  return mask;
}

export function labelConnectedComponents(
  alpha: Float32Array,
  width: number,
  height: number,
  minArea: number = 256,
  threshold: number = 0.3,
): { labels: Int32Array; components: ComponentLabel[] } {
  const N = width * height;
  const detectionMask = buildDetectionMask(alpha, threshold);
  const labels = new Int32Array(N);

  let nextLabel = 1;
  const eqTable: Map<number, number> = new Map();

  function findRoot(label: number): number {
    let root = label;
    while (eqTable.has(root) && eqTable.get(root)! !== root) {
      root = eqTable.get(root)!;
    }
    while (label !== root) {
      const next = eqTable.get(label) || label;
      eqTable.set(label, root);
      label = next;
    }
    return root;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (detectionMask[idx] === 0) continue;

      const neighbors: number[] = [];
      if (y > 0 && labels[idx - width] > 0) neighbors.push(labels[idx - width]);
      if (x > 0 && labels[idx - 1] > 0) neighbors.push(labels[idx - 1]);
      if (x > 0 && y > 0 && labels[idx - width - 1] > 0) neighbors.push(labels[idx - width - 1]);
      if (x + 1 < width && y > 0 && labels[idx - width + 1] > 0) neighbors.push(labels[idx - width + 1]);

      if (neighbors.length === 0) {
        labels[idx] = nextLabel;
        eqTable.set(nextLabel, nextLabel);
        nextLabel += 1;
        continue;
      }

      const minLabel = Math.min(...neighbors);
      labels[idx] = minLabel;
      for (const neighbor of neighbors) {
        if (neighbor === minLabel) continue;
        const left = findRoot(minLabel);
        const right = findRoot(neighbor);
        if (left !== right) eqTable.set(Math.max(left, right), Math.min(left, right));
      }
    }
  }

  const rootLabels = new Map<number, number>();
  let compactLabel = 0;
  for (let index = 0; index < N; index += 1) {
    if (labels[index] === 0) continue;
    const root = findRoot(labels[index]);
    let compact = rootLabels.get(root);
    if (compact === undefined) {
      compact = ++compactLabel;
      rootLabels.set(root, compact);
    }
    labels[index] = compact;
  }

  const compStats: Array<{ pixels: number; minX: number; minY: number; maxX: number; maxY: number }> = [];
  for (let id = 1; id <= compactLabel; id += 1) {
    compStats.push({ pixels: 0, minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 });
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const label = labels[idx];
      if (label === 0) continue;
      const stat = compStats[label - 1];
      stat.pixels += 1;
      if (x < stat.minX) stat.minX = x;
      if (y < stat.minY) stat.minY = y;
      if (x > stat.maxX) stat.maxX = x;
      if (y > stat.maxY) stat.maxY = y;
    }
  }

  const components: ComponentLabel[] = [];
  const validMap = new Map<number, number>();
  for (let index = 0; index < compStats.length; index += 1) {
    const stat = compStats[index];
    if (stat.pixels < minArea) continue;
    const id = components.length;
    validMap.set(index + 1, id);
    components.push({
      id,
      pixelCount: stat.pixels,
      bbox: {
        x: stat.minX,
        y: stat.minY,
        width: Math.max(1, stat.maxX - stat.minX + 1),
        height: Math.max(1, stat.maxY - stat.minY + 1),
      },
    });
  }

  const cleaned = new Int32Array(N);
  for (let index = 0; index < N; index += 1) {
    if (labels[index] === 0) continue;
    const newId = validMap.get(labels[index]);
    cleaned[index] = newId !== undefined ? newId + 1 : 0;
  }

  return { labels: cleaned, components };
}

export function extractComponentAlpha(
  labels: Int32Array,
  origAlpha: Float32Array,
  componentId: number,
  width: number,
  height: number,
): Float32Array {
  const N = width * height;
  const out = new Float32Array(N);
  for (let index = 0; index < N; index += 1) {
    if (labels[index] === componentId + 1) {
      out[index] = origAlpha[index];
    }
  }
  return out;
}

export function cropComponentCanvas(
  source: HTMLCanvasElement,
  alpha: Float32Array,
  srcW: number,
  bbox: { x: number; y: number; width: number; height: number },
  padPx: number = 16,
): HTMLCanvasElement {
  const pad = Math.max(0, padPx);
  const cx = Math.max(0, bbox.x - pad);
  const cy = Math.max(0, bbox.y - pad);
  const cw = Math.min(srcW - cx, bbox.width + pad * 2);
  const ch = Math.min(source.height - cy, bbox.height + pad * 2);

  const srcCtx = source.getContext('2d')!;
  const srcData = srcCtx.getImageData(0, 0, srcW, source.height);

  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  const octx = out.getContext('2d')!;
  const oimg = octx.createImageData(cw, ch);

  for (let y = 0; y < ch; y += 1) {
    for (let x = 0; x < cw; x += 1) {
      const sx = cx + x;
      const sy = cy + y;
      const si = (sy * srcW + sx) * 4;
      const ai = sy * srcW + sx;
      const di = (y * cw + x) * 4;
      const a = alpha[ai];
      oimg.data[di] = srcData.data[si];
      oimg.data[di + 1] = srcData.data[si + 1];
      oimg.data[di + 2] = srcData.data[si + 2];
      oimg.data[di + 3] = Math.round(a * 255);
    }
  }
  octx.putImageData(oimg, 0, 0);
  return out;
}
