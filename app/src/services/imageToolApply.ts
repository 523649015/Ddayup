/**
 * 图片工具「闭环执行」统一服务。
 *
 * 设计目标：把面板里收集到的参数真正落地成一张图并写回素材节点，
 * 形成完整闭环。执行策略按可用资源分级，保证「总能跑通、绝不静默失败」：
 *   1️⃣ 优先复用已安装的本地模型（Real-ESRGAN 放大 / imgly 去背 / LaMa 重绘）
 *   2️⃣ 否则走纯前端 canvas 合成（放大、修复、扩图、重绘兜底、机位透视、打光）
 *
 * 所有 async 函数统一返回 { url, assetId, engine }，url 既可能是
 * hmdao-local:// 资产句柄，也可能是 dataURL —— 节点侧统一写回 imageUrl 即可。
 */
import { commitResultToAsset } from '@/services/assetWriteback';
import { runLocalHdUpscale, removeImageBackground, LocalModelError } from './imageModelRouting';
import { applyBrushEdit, BrushEditError } from './imageBrush';
import { hasLocalModelRunner } from './localModelRunner';
import { resolveLocalMediaUrl, isLocalMediaHandle } from './localMediaRegistry';
import { toRenderableAssetUrl } from './generation';

export interface ToolApplyResult {
  url: string;
  assetId: string;
  engine: string;
}

export interface MaskPoint {
  x: number;
  y: number;
  brushSize: number;
  brushMode: 'paint' | 'erase';
  targetMode: 'inpaint' | 'erase';
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function resolveImageUrl(url: string): string {
  if (!url) throw new Error('缺少可加载的图片地址');
  if (isLocalMediaHandle(url)) {
    const resolved = resolveLocalMediaUrl(url);
    if (resolved) return resolved;
    throw new Error('本地素材句柄已失效（blob 未在注册表中找到），请重新上传或刷新页面后重试');
  }
  // 远端 http(s) / file:// 走与预览一致的 /api/media-proxy 代理，规避 CORS
  return toRenderableAssetUrl(url, 'image') || url;
}

const IMAGE_LOAD_TIMEOUT_MS = 30000;

function loadImage(url: string): Promise<HTMLImageElement> {
  const renderable = resolveImageUrl(url);
  const needsCors = renderable.startsWith('http') || renderable.startsWith('//') || renderable.startsWith('/api/media-proxy');
  return new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`图片加载超时（${IMAGE_LOAD_TIMEOUT_MS / 1000}s），请检查素材图或网络`));
    }, IMAGE_LOAD_TIMEOUT_MS);
    img.onload = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(new Error('图片加载失败，无法处理（可能是 CORS 拦截或后端未启动，请确认 8792 服务在跑）'));
    };
    try {
      if (needsCors) img.crossOrigin = 'anonymous';
      img.src = renderable;
    } catch (err) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

async function commitCanvas(canvas: HTMLCanvasElement, name: string, folderId: string): Promise<{ url: string; assetId: string }> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画布导出失败'))), 'image/png');
  });
  const committed = commitResultToAsset({
    blob,
    name,
    type: 'image',
    folderId,
    width: canvas.width,
    height: canvas.height,
    source: 'generate',
  });
  return { url: committed.url, assetId: committed.assetId };
}

function parseScale(value: string): number {
  const match = String(value).match(/([\d.]+)/);
  const num = match ? parseFloat(match[1]) : 2;
  return clamp(num, 1, 4);
}

function temperatureToRgb(kelvin: number): { r: number; g: number; b: number } {
  const t = kelvin / 100;
  let r = 255;
  let g = 255;
  let b = 255;
  if (t <= 66) {
    g = clamp(99.47 * Math.log(t) - 161.12, 0, 255);
    b = t <= 19 ? 0 : clamp(138.52 * Math.log(t - 10) - 305.04, 0, 255);
  } else {
    r = clamp(329.7 * Math.pow(t - 60, -0.1332) - 0.02, 0, 255);
    g = clamp(288.12 * Math.pow(t - 60, -0.0755) - 0.03, 0, 255);
  }
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}

function withAlpha(rgb: { r: number; g: number; b: number }, alpha: number) {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamp(alpha, 0, 1)})`;
}

/* ------------------------------------------------------------------ */
/* 纯函数（可单测、不依赖真实图像解码）                                  */
/* ------------------------------------------------------------------ */

/** 多角度机位 → 仿射变换矩阵（a,b,c,d），用于前端透视预演合成。 */
export function computeMultiAngleTransform(yaw: number, pitch: number, framingZoom: number) {
  const sx = framingZoom * (1 - Math.min(0.4, (Math.abs(yaw) / 180) * 0.4));
  const sy = framingZoom * (1 - Math.min(0.3, (Math.abs(pitch) / 90) * 0.3));
  const c = (yaw / 180) * 0.3 * framingZoom;
  const b = (-pitch / 90) * 0.22 * framingZoom;
  return { a: Number(sx.toFixed(4)), b: Number(b.toFixed(4)), c: Number(c.toFixed(4)), d: Number(sy.toFixed(4)) };
}

/** 打光面板主光方位/俯仰 → 高光中心像素坐标与半径。 */
export function computeLightHighlight(azimuth: number, elevation: number, width: number, height: number) {
  const x = width * (0.5 + (azimuth / 180) * 0.5);
  const y = height * (0.5 - (elevation / 90) * 0.5);
  const radius = Math.max(width, height) * 0.42;
  return { x: Math.round(x), y: Math.round(y), radius: Math.round(radius) };
}

export interface OutpaintBounds {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

/** 智能扩图方向/比例 → 新画布尺寸与源图贴图偏移。 */
export function computeOutpaintBounds(direction: string, ratio: number, w: number, h: number): OutpaintBounds {
  const r = clamp(ratio, 0.1, 1);
  if (direction === 'left') return { width: Math.round(w * (1 + r)), height: h, offsetX: Math.round(w * r), offsetY: 0 };
  if (direction === 'top') return { width: w, height: Math.round(h * (1 + r)), offsetX: 0, offsetY: Math.round(h * r) };
  if (direction === 'bottom') return { width: w, height: Math.round(h * (1 + r)), offsetX: 0, offsetY: 0 };
  if (direction === 'both') {
    return { width: Math.round(w * (1 + r)), height: Math.round(h * (1 + r)), offsetX: Math.round((w * r) / 2), offsetY: Math.round((h * r) / 2) };
  }
  return { width: Math.round(w * (1 + r)), height: h, offsetX: 0, offsetY: 0 };
}

/** 把蒙版采样点渲染成白色蒙版画布（与笔刷面板 512 基准一致）。 */
export function renderMaskCanvas(points: MaskPoint[], size = 512): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const scale = size / 360;
  for (const point of points) {
    ctx.globalCompositeOperation = point.brushMode === 'erase' ? 'destination-out' : 'source-over';
    ctx.fillStyle = 'rgba(255,255,255,1)';
    const radius = Math.max(6, point.brushSize * scale * 0.55);
    ctx.beginPath();
    ctx.arc(point.x * size, point.y * size, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  return canvas;
}

function normalizeMaskPoint(raw: unknown): MaskPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const targetMode = item.targetMode === 'erase' ? 'erase' : item.targetMode === 'inpaint' ? 'inpaint' : null;
  if (!targetMode) return null;
  return {
    x: clamp(Number(item.x ?? 0), 0, 1),
    y: clamp(Number(item.y ?? 0), 0, 1),
    brushSize: clamp(Number(item.brushSize ?? 24), 1, 140),
    brushMode: item.brushMode === 'erase' ? 'erase' : 'paint',
    targetMode,
  };
}

/* ------------------------------------------------------------------ */
/* 异步执行（闭环核心）                                                 */
/* ------------------------------------------------------------------ */

/** 高清放大：本地 Real-ESRGAN 优先，否则 canvas 双三次放大。 */
export async function applyHdUpscale(imageUrl: string, params: Record<string, unknown> = {}): Promise<ToolApplyResult> {
  const scale = parseScale(String(params.upscale ?? '2x'));
  if (hasLocalModelRunner('real-esrgan-x4')) {
    const { url, assetId } = await runLocalHdUpscale(imageUrl);
    return { url, assetId, engine: 'real-esrgan-x4' };
  }
  const img = await loadImage(imageUrl);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const { url, assetId } = await commitCanvas(canvas, `高清-${Date.now()}.png`, 'img-hd');
  return { url, assetId, engine: 'canvas-bicubic' };
}

/** 画质修复：前端对比度/饱和度/亮度增强合成。 */
export async function applyHdRestore(imageUrl: string, params: Record<string, unknown> = {}): Promise<ToolApplyResult> {
  const img = await loadImage(imageUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  const recovery = Number(params.textureRecovery ?? 0.7);
  ctx.filter = `contrast(${(1.04 + recovery * 0.18).toFixed(3)}) saturate(${(1.02 + recovery * 0.14).toFixed(3)}) brightness(1.02)`;
  ctx.drawImage(img, 0, 0);
  ctx.filter = 'none';
  const { url, assetId } = await commitCanvas(canvas, `修复-${Date.now()}.png`, 'img-hd');
  return { url, assetId, engine: 'canvas-restore' };
}

function drawOutpaintMirror(ctx: CanvasRenderingContext2D, img: HTMLImageElement, bounds: OutpaintBounds, direction: string, feather: number) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const strip = (amount: number) => Math.max(8, Math.round(Math.min(w, h) * amount));
  const drawStrip = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number, flipX: boolean, flipY: boolean) => {
    ctx.save();
    ctx.translate(dx + dw / 2, dy + dh / 2);
    if (flipX) ctx.scale(-1, 1);
    if (flipY) ctx.scale(1, -1);
    ctx.drawImage(img, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  };
  const fa = clamp(0.35 + feather * 0.5, 0.35, 0.9);
  ctx.globalAlpha = fa;
  if (direction === 'right' || direction === 'both') {
    const s = strip(0.18 + (bounds.width - w) / Math.max(1, w) * 0.4);
    drawStrip(w - s, 0, s, h, w, bounds.offsetY, bounds.width - w, h, true, false);
  }
  if (direction === 'left' || direction === 'both') {
    const s = strip(0.18 + (bounds.offsetX) / Math.max(1, w) * 0.4);
    drawStrip(0, 0, s, h, 0, bounds.offsetY, bounds.offsetX, h, true, false);
  }
  if (direction === 'top' || direction === 'both') {
    const s = strip(0.18 + (bounds.offsetY) / Math.max(1, h) * 0.4);
    drawStrip(0, 0, w, s, bounds.offsetX, 0, w, bounds.offsetY, false, true);
  }
  if (direction === 'bottom' || direction === 'both') {
    const s = strip(0.18 + (bounds.height - h) / Math.max(1, h) * 0.4);
    drawStrip(0, h - s, w, s, bounds.offsetX, h, w, bounds.height - h, false, true);
  }
  ctx.globalAlpha = 1;
}

/** 智能扩图：新画布 + 边缘镜像填充（带羽化）。 */
export async function applyHdOutpaint(imageUrl: string, params: Record<string, unknown> = {}): Promise<ToolApplyResult> {
  const img = await loadImage(imageUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const direction = String(params.outpaintDirection ?? 'right');
  const ratio = Number(params.outpaintRatio ?? 0.35);
  const feather = Number(params.outpaintFeather ?? 0.5);
  const bounds = computeOutpaintBounds(direction, ratio, w, h);
  const canvas = document.createElement('canvas');
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.fillStyle = '#0c0c0c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, bounds.offsetX, bounds.offsetY, w, h);
  drawOutpaintMirror(ctx, img, bounds, direction, feather);
  const { url, assetId } = await commitCanvas(canvas, `扩图-${Date.now()}.png`, 'img-hd');
  return { url, assetId, engine: 'canvas-outpaint' };
}

async function canvasHeal(imageUrl: string, maskCanvas: HTMLCanvasElement): Promise<string> {
  const img = await loadImage(imageUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.drawImage(img, 0, 0);
  const src = ctx.getImageData(0, 0, w, h);
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) return canvas.toDataURL('image/png');
  const mask = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  const data = src.data;
  for (let my = 0; my < maskCanvas.height; my += 1) {
    for (let mx = 0; mx < maskCanvas.width; mx += 1) {
      const mi = (my * maskCanvas.width + mx) * 4 + 3;
      if (mask.data[mi] < 40) continue;
      const px = Math.floor((mx / maskCanvas.width) * w);
      const py = Math.floor((my / maskCanvas.height) * h);
      const mirrorX = w - 1 - px;
      const mirrorY = h - 1 - py;
      const di = (py * w + px) * 4;
      const si = (mirrorY * w + mirrorX) * 4;
      data[di] = src.data[si];
      data[di + 1] = src.data[si + 1];
      data[di + 2] = src.data[si + 2];
      data[di + 3] = 255;
    }
  }
  ctx.putImageData(src, 0, 0);
  return canvas.toDataURL('image/png');
}

/** 局部重绘 / 物体移除：本地 LaMa 优先，否则前端镜像修复兜底。 */
export async function applyHdInpaint(imageUrl: string, params: Record<string, unknown> = {}): Promise<ToolApplyResult> {
  const mode = params.mode === 'erase' ? 'erase' : 'inpaint';
  const points = Array.isArray(params.maskPoints)
    ? (params.maskPoints as unknown[]).map(normalizeMaskPoint).filter((p): p is MaskPoint => Boolean(p) && p.targetMode === mode)
    : [];
  const maskCanvas = renderMaskCanvas(points);
  const mask = maskCanvas.toDataURL('image/png');
  try {
    const result = await applyBrushEdit({
      imageUrl,
      mask,
      folderId: 'img-hd',
      prompt: mode === 'erase' ? 'remove object and inpaint background' : 'inpaint the masked region',
    });
    return { url: result.url, assetId: result.assetId, engine: 'lama-inpaint' };
  } catch (err) {
    if (err instanceof BrushEditError && err.code === 'no-backend') {
      const url = await canvasHeal(imageUrl, maskCanvas);
      return { url, assetId: '', engine: 'canvas-heal' };
    }
    throw err;
  }
}

/** 智能抠图：本地 imgly 去背优先；未安装则抛出明确引导。 */
export async function applyHdCutout(imageUrl: string, _params: Record<string, unknown> = {}): Promise<ToolApplyResult> {
  const { url, assetId } = await removeImageBackground(imageUrl);
  return { url, assetId, engine: 'imgly-bgremoval' };
}

/** 智能裁切：前端 canvas 裁切（与面板预演一致）。 */
export async function applyHdCrop(
  imageUrl: string,
  frame: { left: number; top: number; width: number; height: number },
): Promise<ToolApplyResult> {
  const img = await loadImage(imageUrl);
  const sx = (frame.left / 100) * img.naturalWidth;
  const sy = (frame.top / 100) * img.naturalHeight;
  const sw = (frame.width / 100) * img.naturalWidth;
  const sh = (frame.height / 100) * img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw));
  canvas.height = Math.max(1, Math.round(sh));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const { url, assetId } = await commitCanvas(canvas, `裁切-${Date.now()}.png`, 'img-hd');
  return { url, assetId, engine: 'canvas-crop' };
}

/** 多角度机位：基于机位参数做前端透视预演合成并写回。 */
export async function applyMultiAngle(imageUrl: string, params: Record<string, unknown> = {}): Promise<ToolApplyResult> {
  const img = await loadImage(imageUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const yaw = Number(params.yaw ?? 45);
  const pitch = Number(params.pitch ?? 15);
  const framingZoom = Number(params.framingZoom ?? 1);
  const transform = computeMultiAngleTransform(yaw, pitch, framingZoom);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.fillStyle = '#0c0c0c';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.transform(transform.a, transform.b, transform.c, transform.d, 0, 0);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const { url, assetId } = await commitCanvas(canvas, `机位-${Date.now()}.png`, 'img-multiview');
  return { url, assetId, engine: 'canvas-camera' };
}

/** 物理打光：把主光高光/背光阴影烘焙进原图。 */
export async function applyLighting(imageUrl: string, params: Record<string, unknown> = {}): Promise<ToolApplyResult> {
  const img = await loadImage(imageUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const azimuth = Number(params.keyLightAzimuth ?? 45);
  const elevation = Number(params.keyLightElevation ?? 30);
  const intensity = Number(params.keyLightIntensity ?? 0.8);
  const temperature = Number(params.keyLightTemperature ?? 5400);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.drawImage(img, 0, 0);
  const { x, y, radius } = computeLightHighlight(azimuth, elevation, w, h);
  const color = temperatureToRgb(temperature);
  const grad = ctx.createRadialGradient(x, y, 0, x, y, Math.max(8, radius));
  grad.addColorStop(0, withAlpha(color, 0.55 * intensity));
  grad.addColorStop(1, withAlpha(color, 0));
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const sx = w - x;
  const sy = h - y;
  const sgrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(8, radius * 0.8));
  sgrad.addColorStop(0, `rgba(0,0,0,${0.25 * intensity})`);
  sgrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = sgrad;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  const { url, assetId } = await commitCanvas(canvas, `打光-${Date.now()}.png`, 'img-lighting');
  return { url, assetId, engine: 'canvas-lighting' };
}

export { LocalModelError, BrushEditError };
