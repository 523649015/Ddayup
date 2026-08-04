/**
 * 多角度轨道球预览组件（纯 2D Canvas，无 Three.js / WebGL / OrbitControls）
 *
 * 为什么不用 Three.js + OrbitControls：
 *   面板根节点带有 onPointerDownCapture: stopPropagation（ReactFlow 选择守卫），
 *   它会在捕获阶段把事件掐断，导致 OrbitControls 的 canvas 永远收不到 pointerdown，
 *   拖拽失效；同时 React 的 onPointerDown（冒泡）不触发 → 选择守卫不续命 → 面板自动关闭；
 *   且 WebGL 持续 rAF 渲染循环造成卡顿。
 *
 * 本实现改为：
 *   1. 纯 2D Canvas 绘制经纬线球面辅助网格 + 相机标记（对齐参考图视觉）。
 *   2. 在 document 捕获阶段拦截指针事件（早于面板守卫），自行处理拖拽，
 *      并主动调用 useCanvasStore.setSelectionGuard 续命，彻底规避上述问题。
 *   3. 仅在 yaw/pitch/zoom/image 变化时重绘，无持续渲染循环 → 无卡顿。
 */
import { useEffect, useRef } from 'react';
import { useCanvasStore } from '@/store/useCanvasStore';
import { normToAngle } from './multiAngleOrbitMath';

export interface MultiAngleOrbit3DProps {
  yaw: number;
  pitch: number;
  zoom: number;
  imageUrl?: string;
  onYawChange: (yaw: number) => void;
  onPitchChange: (pitch: number) => void;
  onZoomChange: (zoom: number) => void;
}

const YAW_THRESHOLD = 0.5;
const PITCH_THRESHOLD = 0.5;
const ZOOM_STEP = 0.04;
const GUARD_MS = 320;

export function MultiAngleOrbit3D({
  yaw, pitch, zoom, imageUrl, onYawChange, onPitchChange, onZoomChange,
}: MultiAngleOrbit3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef({ yaw, pitch, zoom, imageUrl, onYawChange, onPitchChange, onZoomChange });
  propsRef.current = { yaw, pitch, zoom, imageUrl, onYawChange, onPitchChange, onZoomChange };
  const draggingRef = useRef(false);
  const lastAngleRef = useRef({ yaw, pitch });
  // rAF 合并：拖拽时把状态推送与重绘合并到每帧一次，消除卡顿
  const pendingRef = useRef<{ yaw: number; pitch: number } | null>(null);
  const rafRef = useRef(0);

  const draw = (overrideYaw?: number, overridePitch?: number) => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom 等无 2D 上下文环境安全退出
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGlobe(
      ctx, w, h,
      overrideYaw ?? propsRef.current.yaw,
      overridePitch ?? propsRef.current.pitch,
    );
  };

  useEffect(() => { draw(); }, [yaw, pitch, zoom, imageUrl]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // ===== 指针交互：document 捕获阶段拦截，早于面板守卫 =====
  // 摄像机仅在指针位于轨道球内且按住时跟随；指针离开轨道球即停止跟随。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const toNorm = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      let nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      let ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
      const r2 = nx * nx + ny * ny;
      if (r2 > 1) { const s = 1 / Math.sqrt(r2); nx *= s; ny *= s; } // 投影回单位圆
      return { nx, ny };
    };

    const sustainGuard = () => useCanvasStore.getState().setSelectionGuard?.(GUARD_MS);

    const onDownCapture = (e: PointerEvent) => {
      if (e.target !== canvas) return; // 仅处理轨道球自身的指针
      draggingRef.current = true;
      canvas.style.cursor = 'grabbing';
      const { nx, ny } = toNorm(e);
      lastAngleRef.current = normToAngle(nx, ny);
      sustainGuard();           // 续命：防止拖拽时面板自动关闭
      e.stopPropagation();      // 阻止面板守卫 / ReactFlow 节点拖拽接收该事件
      e.preventDefault();
    };

    // 每帧最多刷新一次父状态，避免 pointermove 高频触发整面板重渲染 → 消除卡顿
    const flush = () => {
      rafRef.current = 0;
      const p = pendingRef.current;
      if (!p) return;
      pendingRef.current = null;
      propsRef.current.onYawChange(p.yaw);
      propsRef.current.onPitchChange(p.pitch);
      sustainGuard();
    };

    // pointermove 挂在 canvas 上：指针离开轨道球后不再触发 → 摄像机停止跟随
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const { nx, ny } = toNorm(e);
      const next = normToAngle(nx, ny);
      const dy = Math.abs(next.yaw - lastAngleRef.current.yaw);
      const dp = Math.abs(next.pitch - lastAngleRef.current.pitch);
      if (dy >= YAW_THRESHOLD || dp >= PITCH_THRESHOLD) {
        lastAngleRef.current = next;
        pendingRef.current = next;
        draw(next.yaw, next.pitch);   // 本地即时重绘，视觉零延迟
        if (!rafRef.current) rafRef.current = requestAnimationFrame(flush); // 状态每帧推送一次
      }
    };

    // 指针离开轨道球 → 立即停止跟随
    const onLeave = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      canvas.style.cursor = 'grab';
    };

    const onUp = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      canvas.style.cursor = 'grab';
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      flush(); // 结束时确保最终角度落地
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };

    const onWheel = (e: WheelEvent) => {
      if (e.target !== canvas) return;
      e.stopPropagation();
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      const nz = Math.min(1.5, Math.max(0.78, propsRef.current.zoom + delta));
      propsRef.current.onZoomChange(+nz.toFixed(3));
    };

    document.addEventListener('pointerdown', onDownCapture, true);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('wheel', onWheel, { passive: false } as EventListenerOptions);
    return () => {
      document.removeEventListener('pointerdown', onDownCapture, true);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('wheel', onWheel);
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="nodrag nopan nowheel relative h-full w-full overflow-hidden rounded-xl border border-[#454545]"
    >
      <canvas
        ref={canvasRef}
        data-testid="multi-angle-orbit-3d"
        className="nodrag nopan nowheel block h-full w-full"
        style={{ touchAction: 'none', cursor: 'grab' }}
      />
    </div>
  );
}

/** 绘制经纬线球面辅助网格 + 相机标记（对齐参考图视觉） */
function drawGlobe(ctx: CanvasRenderingContext2D, w: number, h: number, yaw: number, pitch: number) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#141414';
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 8;

  // 球体外轮廓
  ctx.strokeStyle = 'rgba(156,163,175,0.8)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();

  // 纬线（水平椭圆）
  ctx.strokeStyle = 'rgba(120,130,150,0.32)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    const yy = -R + (2 * R) * (i / 6);
    const rx = Math.sqrt(Math.max(0, R * R - yy * yy));
    ctx.beginPath();
    ctx.ellipse(cx, cy + yy, rx, Math.max(0.5, rx * 0.26), 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 经线（竖直椭圆）
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI;
    const rx = Math.abs(Math.cos(ang)) * R;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(0.5, rx), R, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 赤道（加亮）
  ctx.strokeStyle = 'rgba(156,163,175,0.65)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, R, Math.max(0.5, R * 0.26), 0, 0, Math.PI * 2);
  ctx.stroke();

  // 相机标记（正交投影位置）
  const nx = Math.sin(yaw * (Math.PI / 180)) * Math.cos(pitch * (Math.PI / 180));
  const ny = -Math.sin(pitch * (Math.PI / 180));
  const mx = cx + nx * R;
  const my = cy + ny * R;

  // 指向球心的连线
  ctx.strokeStyle = 'rgba(0,180,216,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mx, my);
  ctx.lineTo(cx, cy);
  ctx.stroke();

  // 标记圆点
  ctx.fillStyle = '#00b4d8';
  ctx.beginPath();
  ctx.arc(mx, my, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(mx, my, 6, 0, Math.PI * 2);
  ctx.stroke();
}
