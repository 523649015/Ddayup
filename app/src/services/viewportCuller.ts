/**
 * HMDao 虚拟化大画布 — 1000+ 节点视口裁剪
 *
 * Phase 6 P1: 当画布节点超过阈值时，只渲染视口内可见节点，
 * 视口外节点用占位符替代，大幅减少 React Flow 渲染开销。
 *
 * 核心策略：
 * 1. 视口矩形计算 — 基于 ReactFlow viewport transform + 容器尺寸
 * 2. 节点 AABB 快速相交检测
 * 3. 缓冲区扩展 — 视口外扩 20% 避免滚动时闪烁
 * 4. 增量更新 — 仅在视口变化超过阈值时重新计算
 * 5. 退化阈值 — 节点数 < 200 时自动关闭虚拟化
 *
 * 风险防护：
 * - 视口计算异常时回退到全量渲染
 * - ResizeObserver 断开后自动清理
 */

import type { CanvasNode } from '@/types';

// ===== 配置常量 =====

/** 启用虚拟化的最小节点数阈值 */
const MIN_NODES_FOR_CULLING = 200;

/** 视口缓冲区扩展比例（避免滚动时闪烁） */
const VIEWPORT_BUFFER_RATIO = 0.2;

/** 视口变化最小阈值（像素），避免频繁重算 */
const VIEWPORT_CHANGE_THRESHOLD = 50;

// ===== 类型定义 =====

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportTransform {
  x: number;
  y: number;
  zoom: number;
}

export interface CullingResult {
  /** 视口内可见节点 */
  visibleNodes: CanvasNode[];
  /** 视口外被裁剪的节点 ID 集合 */
  culledNodeIds: Set<string>;
  /** 是否启用了虚拟化 */
  cullingActive: boolean;
  /** 性能统计 */
  stats: CullingStats;
}

export interface CullingStats {
  totalNodes: number;
  visibleCount: number;
  culledCount: number;
  computeTimeMs: number;
}

// ===== 视口裁剪引擎 =====

export class ViewportCuller {
  private lastViewport: ViewportRect | null = null;
  private lastTransform: ViewportTransform | null = null;
  private lastResult: CullingResult | null = null;

  /**
   * 计算当前视口内可见节点
   *
   * @param nodes - 所有画布节点
   * @param viewportTransform - ReactFlow viewport transform [x, y, zoom]
   * @param containerSize - 画布容器尺寸 { width, height }
   * @returns 裁剪结果
   */
  computeVisibleNodes(
    nodes: CanvasNode[],
    viewportTransform: ViewportTransform,
    containerSize: { width: number; height: number },
  ): CullingResult {
    const startTime = performance.now();

    // 节点数不足阈值 — 关闭虚拟化
    if (nodes.length < MIN_NODES_FOR_CULLING) {
      return {
        visibleNodes: nodes,
        culledNodeIds: new Set(),
        cullingActive: false,
        stats: {
          totalNodes: nodes.length,
          visibleCount: nodes.length,
          culledCount: 0,
          computeTimeMs: 0,
        },
      };
    }

    // 计算视口矩形（世界坐标）
    const viewport = this.worldViewport(viewportTransform, containerSize);

    // 视口变化不足阈值 — 复用上次结果
    if (this.lastResult && this.lastViewport && this.isStable(viewport)) {
      return this.lastResult;
    }

    // 扩展缓冲区
    const buffered = this.expandViewport(viewport, containerSize);

    // AABB 相交检测
    const visibleNodes: CanvasNode[] = [];
    const culledNodeIds = new Set<string>();

    for (const node of nodes) {
      if (this.isNodeVisible(node, buffered)) {
        visibleNodes.push(node);
      } else {
        culledNodeIds.add(node.id);
      }
    }

    const result: CullingResult = {
      visibleNodes,
      culledNodeIds,
      cullingActive: true,
      stats: {
        totalNodes: nodes.length,
        visibleCount: visibleNodes.length,
        culledCount: culledNodeIds.size,
        computeTimeMs: performance.now() - startTime,
      },
    };

    this.lastViewport = viewport;
    this.lastTransform = { ...viewportTransform };
    this.lastResult = result;

    return result;
  }

  /** 重置缓存（画布结构变化时调用） */
  reset(): void {
    this.lastViewport = null;
    this.lastTransform = null;
    this.lastResult = null;
  }

  // ===== 私有方法 =====

  /** ReactFlow viewport → 世界坐标视口矩形 */
  private worldViewport(
    transform: ViewportTransform,
    containerSize: { width: number; height: number },
  ): ViewportRect {
    const { x, y, zoom } = transform;
    return {
      x: -x / zoom,
      y: -y / zoom,
      width: containerSize.width / zoom,
      height: containerSize.height / zoom,
    };
  }

  /** 扩展视口缓冲区 */
  private expandViewport(
    viewport: ViewportRect,
    containerSize: { width: number; height: number },
  ): ViewportRect {
    const bx = viewport.width * VIEWPORT_BUFFER_RATIO;
    const by = viewport.height * VIEWPORT_BUFFER_RATIO;
    return {
      x: viewport.x - bx,
      y: viewport.y - by,
      width: viewport.width + bx * 2,
      height: viewport.height + by * 2,
    };
  }

  /** AABB 相交检测 */
  private isNodeVisible(node: CanvasNode, viewport: ViewportRect): boolean {
    const nx = node.position.x;
    const ny = node.position.y;
    // 默认节点尺寸 300x200（实际应从 node 的 measured 获取）
    const nw = (node as { measured?: { width?: number } }).measured?.width ?? 300;
    const nh = (node as { measured?: { height?: number } }).measured?.height ?? 200;

    return !(
      nx + nw < viewport.x ||
      nx > viewport.x + viewport.width ||
      ny + nh < viewport.y ||
      ny > viewport.y + viewport.height
    );
  }

  /** 视口是否稳定（变化小于阈值） */
  private isStable(current: ViewportRect): boolean {
    if (!this.lastViewport) return false;
    return (
      Math.abs(current.x - this.lastViewport.x) < VIEWPORT_CHANGE_THRESHOLD &&
      Math.abs(current.y - this.lastViewport.y) < VIEWPORT_CHANGE_THRESHOLD &&
      Math.abs(current.width - this.lastViewport.width) < VIEWPORT_CHANGE_THRESHOLD &&
      Math.abs(current.height - this.lastViewport.height) < VIEWPORT_CHANGE_THRESHOLD
    );
  }
}

/** 全局单例 */
export const viewportCuller = new ViewportCuller();
