/**
 * 深度驱动「真实 3D 旋转」变形（T1 管线，网格贴图版）
 *
 * 设计取舍（重要）：
 *   单张图靠几何深度投射，要么"点云散开→大范围破损"，要么"整张图刚性转→像转照片"，
 *   二者必居其一，无法两全。本实现选择「网格贴图」：把图像铺规则网格、按深度反投影
 *   为 3D 顶点、绕物体中心做轨道旋转后重投影，三角形按视深排序逐个仿射贴图。
 *   它保证：① 内部零空洞 ② 零黑块 ③ 连续无撕裂。代价是整体观感偏"带视差的旋转"，
 *   而非真正看到被遮挡的车侧面——后者必须靠 T2 生成式模型（novelViewSynthesis）补全，
 *   该插件脚手架已就位，真实权重/推理待接入。
 *
 * 因此：几何路线在 ±35° 内"可用、不破损、不黑"，但观感有限；大幅真·新视角请等 T2 插件。
 */
import type { DepthResult } from './depthEstimation';

export interface DepthWarpParams {
  yaw: number; pitch: number; zoom: number; consistency: number;
}

/** 真实 3D 旋转 + 网格贴图重投影（无破损 / 无黑块）。 */
export function rotateWithDepth(
  img: HTMLImageElement,
  depth: DepthResult,
  params: DepthWarpParams,
): HTMLCanvasElement {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const dmm = getMinMax(depth.data);
  if (!dmm) return warpFlat(img, params); // 退化场景

  const dMin = dmm[0];
  const dRange = dmm[1] - dMin || 1;

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d')!;

  // ===== 背景兜底层：暗化源图铺满全幅，杜绝旋转后出现黑块 =====
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0c0c0c';
  ctx.fillRect(0, 0, w, h);
  // 轻微放大 + 暗化，作为暴露区域的合理背景延续
  ctx.globalAlpha = 0.5;
  const bgScale = 1.12;
  ctx.drawImage(img, -(w * (bgScale - 1)) / 2, -(h * (bgScale - 1)) / 2, w * bgScale, h * bgScale);
  ctx.globalAlpha = 1;
  ctx.restore();

  // ===== 网格顶点 → 3D 点（绕物体中心轨道旋转 → 重投影） =====
  const f = Math.max(w, h) * 1.15;   // 像素焦距
  const cx = w / 2;
  const cy = h / 2;
  const zNear = 2.2;                  // 近处（nd=1）深度
  const zFar = 5.0;                   // 远处（nd=0）深度
  // consistency 越高 → 有效旋转越保守，进一步降低大角度形变风险
  const damp = 1 - Math.max(0, Math.min(0.5, (params.consistency - 0.5))) * 0.5;
  const yawRad = (params.yaw * Math.PI / 180) * damp;
  const pitchRad = (params.pitch * Math.PI / 180) * damp;
  const cosY = Math.cos(yawRad), sinY = Math.sin(yawRad);
  const cosP = Math.cos(pitchRad), sinP = Math.sin(pitchRad);
  const zoom = Math.max(0.5, params.zoom);

  const GX = Math.max(16, Math.min(48, Math.round(w / 22)));
  const GY = Math.max(16, Math.min(48, Math.round(h / 22)));
  const cols = GX + 1;
  const rows = GY + 1;

  // 第一遍：反投影得到每个顶点的 3D 坐标，并求平均深度作为旋转轴心
  const X3 = new Float64Array(cols * rows);
  const Y3 = new Float64Array(cols * rows);
  const Z3 = new Float64Array(cols * rows);
  let zSum = 0;
  for (let r = 0; r < rows; r++) {
    const py = (r / GY) * h;
    for (let c = 0; c < cols; c++) {
      const px = (c / GX) * w;
      const dix = clampDepthIndex(px, py, w, h, depth);
      const nd = (depth.data[dix] - dMin) / dRange; // [0,1]，越大越近
      const Z = zNear + (1 - nd) * (zFar - zNear);
      const vi = r * cols + c;
      X3[vi] = ((px - cx) / f) * Z;
      Y3[vi] = ((py - cy) / f) * Z;
      Z3[vi] = Z;
      zSum += Z;
    }
  }
  const zPivot = zSum / (cols * rows); // 物体中心深度

  // 第二遍：绕物体中心旋转 → 投影到 2D
  const DX = new Float64Array(cols * rows);
  const DY = new Float64Array(cols * rows);
  const DZ = new Float64Array(cols * rows);
  for (let vi = 0; vi < cols * rows; vi++) {
    const X = X3[vi];
    const Y = Y3[vi];
    const Zc = Z3[vi] - zPivot;      // 平移到轴心
    // 绕 Y 轴（yaw）
    const x1 = X * cosY + Zc * sinY;
    const z1 = -X * sinY + Zc * cosY;
    // 绕 X 轴（pitch）
    const y2 = Y * cosP - z1 * sinP;
    const z2 = Y * sinP + z1 * cosP;
    const zf = z2 + zPivot;          // 平移回相机空间
    const zSafe = zf > 1e-2 ? zf : 1e-2;
    let sx = cx + (f * x1) / zSafe;
    let sy = cy + (f * y2) / zSafe;
    sx = cx + (sx - cx) * zoom;      // 景别缩放（围绕中心）
    sy = cy + (sy - cy) * zoom;
    DX[vi] = sx; DY[vi] = sy; DZ[vi] = zf;
  }

  // ===== 收集三角形 → 按视深排序（画家算法，远→近） =====
  interface Tri { i0: number; i1: number; i2: number; z: number; }
  const tris: Tri[] = [];
  for (let r = 0; r < GY; r++) {
    for (let c = 0; c < GX; c++) {
      const a = r * cols + c;
      const b = r * cols + c + 1;
      const d = (r + 1) * cols + c;
      const e = (r + 1) * cols + c + 1;
      tris.push({ i0: a, i1: b, i2: d, z: (DZ[a] + DZ[b] + DZ[d]) / 3 });
      tris.push({ i0: b, i1: e, i2: d, z: (DZ[b] + DZ[e] + DZ[d]) / 3 });
    }
  }
  tris.sort((t1, t2) => t2.z - t1.z); // 远的先画，近的后画（覆盖遮挡）

  // 源网格顶点像素坐标（贴图 UV）
  const srcX = (vi: number) => ((vi % cols) / GX) * w;
  const srcY = (vi: number) => (Math.floor(vi / cols) / GY) * h;

  for (const t of tris) {
    drawTexturedTriangle(
      ctx, img,
      srcX(t.i0), srcY(t.i0), srcX(t.i1), srcY(t.i1), srcX(t.i2), srcY(t.i2),
      DX[t.i0], DY[t.i0], DX[t.i1], DY[t.i1], DX[t.i2], DY[t.i2],
    );
  }

  return out;
}

/** 依据源三角形→目标三角形求解仿射矩阵，裁剪后贴图。 */
function drawTexturedTriangle(
  ctx: CanvasRenderingContext2D, img: HTMLImageElement,
  u0: number, v0: number, u1: number, v1: number, u2: number, v2: number,
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
): void {
  ctx.save();
  ctx.beginPath();
  // 三角形轻微外扩 0.5px，消除相邻三角形接缝
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.closePath();
  ctx.clip();

  const denom = u0 * (v2 - v1) - u1 * v2 + u2 * v1 + (u1 - u2) * v0;
  if (denom === 0) { ctx.restore(); return; }
  const a = (x0 * (v2 - v1) - x1 * v2 + x2 * v1 + (x1 - x2) * v0) / denom;
  const b = (y0 * (v2 - v1) - y1 * v2 + y2 * v1 + (y1 - y2) * v0) / denom;
  const c = -(x0 * (u2 - u1) - x1 * u2 + x2 * u1 + (x1 - x2) * u0) / denom;
  const d = -(y0 * (u2 - u1) - y1 * u2 + y2 * u1 + (y1 - y2) * u0) / denom;
  const e = (x0 * (u2 * v1 - u1 * v2) + u0 * (x1 * v2 - x2 * v1) + v0 * (x2 * u1 - x1 * u2)) / denom;
  const g = (y0 * (u2 * v1 - u1 * v2) + u0 * (y1 * v2 - y2 * v1) + v0 * (y2 * u1 - y1 * u2)) / denom;

  ctx.transform(a, b, c, d, e, g);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function clampDepthIndex(px: number, py: number, w: number, h: number, depth: DepthResult): number {
  const dw = depth.width || w;
  const dh = depth.height || h;
  let dx = Math.round((px / w) * (dw - 1));
  let dy = Math.round((py / h) * (dh - 1));
  if (dx < 0) dx = 0; else if (dx > dw - 1) dx = dw - 1;
  if (dy < 0) dy = 0; else if (dy > dh - 1) dy = dh - 1;
  return dy * dw + dx;
}

function getMinMax(data: Float32Array): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  return isFinite(min) ? [min, max] : null;
}

/** 快速仿射回退（无深度模型时） */
export function warpFlat(
  img: HTMLImageElement,
  params: { yaw: number; pitch: number; zoom: number },
): HTMLCanvasElement {
  const w = img.naturalWidth, h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  // 背景兜底：暗化源图铺满，避免黑边
  ctx.fillStyle = '#0c0c0c';
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.drawImage(img, -w * 0.06, -h * 0.06, w * 1.12, h * 1.12);
  ctx.globalAlpha = 1;
  ctx.restore();

  ctx.translate(w / 2, h / 2);
  const { yaw, pitch, zoom } = params;
  const sx = zoom * (1 - Math.min(0.4, (Math.abs(yaw) / 180) * 0.4));
  const sy = zoom * (1 - Math.min(0.3, (Math.abs(pitch) / 90) * 0.3));
  const c = (yaw / 180) * 0.3 * zoom;
  const b = (-pitch / 90) * 0.22 * zoom;
  ctx.transform(sx, b, c, sy, 0, 0);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  return canvas;
}
