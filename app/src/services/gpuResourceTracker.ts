/**
 * HMDao Three.js GPU 资源追踪器 — dispose() 自动调用 + 纹理池
 *
 * Phase 6 P4: 追踪所有 Three.js GPU 资源（纹理、几何体、材质、
 * RenderTarget、BufferGeometry），确保组件卸载时自动释放，
 * 防止 GPU 内存泄漏。
 *
 * 核心能力：
 * 1. 资源注册表 — 追踪每个资源的创建者（组件/节点 ID）
 * 2. 自动清理 — 组件卸载时自动 dispose 所有关联资源
 * 3. GPU 内存估算 — 基于纹理分辨率、几何体顶点数估算显存占用
 * 4. 纹理池 — 相同 URL/配置的纹理复用，避免重复上传
 * 5. 泄漏检测 — 开发模式下定期扫描未释放资源
 *
 * 风险防护：
 * - 纹理池上限 — 超过限制时 LRU 淘汰
 * - dispose 异常隔离 — 单个资源释放失败不影响其他
 * - 内存告警 — 超过阈值时 console.warn + 触发清理
 */

import * as THREE from 'three';

// ===== 配置 =====

/** 纹理池最大缓存数 */
const TEXTURE_POOL_MAX_SIZE = 64;

/** GPU 内存告警阈值 (MB) */
const GPU_MEMORY_WARN_MB = 512;

/** GPU 内存临界阈值 (MB) */
const GPU_MEMORY_CRITICAL_MB = 1024;

/** 泄漏检测间隔 (ms)，仅开发模式 */
const LEAK_CHECK_INTERVAL_MS = 30_000;

// ===== 类型定义 =====

export interface TrackedResource {
  resource: THREE.Object3D | THREE.Material | THREE.Texture | THREE.BufferGeometry | THREE.WebGLRenderTarget;
  type: 'geometry' | 'material' | 'texture' | 'renderTarget' | 'object3d';
  ownerId: string;
  createdAt: number;
  estimatedBytes: number;
}

export interface TexturePoolEntry {
  texture: THREE.Texture;
  key: string;
  lastUsed: number;
  refCount: number;
}

export interface GPUMemoryStats {
  totalTextures: number;
  totalGeometries: number;
  totalMaterials: number;
  totalRenderTargets: number;
  estimatedTotalBytes: number;
  estimatedTotalMB: number;
  texturePoolSize: number;
}

// ===== GPU 资源追踪器 =====

export class GPUResourceTracker {
  private resources = new Map<string, TrackedResource[]>();
  private texturePool = new Map<string, TexturePoolEntry>();
  private leakCheckTimer: ReturnType<typeof setInterval> | null = null;

  /** 注册资源 */
  register(
    resource: TrackedResource['resource'],
    type: TrackedResource['type'],
    ownerId: string,
  ): void {
    const estimatedBytes = this.estimateBytes(resource, type);
    const tracked: TrackedResource = {
      resource,
      type,
      ownerId,
      createdAt: Date.now(),
      estimatedBytes,
    };

    const ownerResources = this.resources.get(ownerId) || [];
    ownerResources.push(tracked);
    this.resources.set(ownerId, ownerResources);

    this.checkMemoryThreshold();
  }

  /** 释放指定 owner 的所有资源 */
  disposeOwner(ownerId: string): void {
    const ownerResources = this.resources.get(ownerId);
    if (!ownerResources) return;

    for (const tracked of ownerResources) {
      try {
        this.safeDispose(tracked.resource, tracked.type);
      } catch (err) {
        console.warn(`[GPUResourceTracker] dispose 失败 (owner: ${ownerId}):`, err);
      }
    }

    this.resources.delete(ownerId);
  }

  /** 从纹理池获取或创建纹理 */
  acquireTexture(key: string, factory: () => THREE.Texture): THREE.Texture {
    const entry = this.texturePool.get(key);
    if (entry) {
      entry.lastUsed = Date.now();
      entry.refCount++;
      return entry.texture;
    }

    // LRU 淘汰
    if (this.texturePool.size >= TEXTURE_POOL_MAX_SIZE) {
      this.evictLRU();
    }

    const texture = factory();
    this.texturePool.set(key, {
      texture,
      key,
      lastUsed: Date.now(),
      refCount: 1,
    });

    return texture;
  }

  /** 释放纹理池引用 */
  releaseTexture(key: string): void {
    const entry = this.texturePool.get(key);
    if (!entry) return;

    entry.refCount--;
    if (entry.refCount <= 0) {
      try {
        entry.texture.dispose();
      } catch { /* 静默处理 */ }
      this.texturePool.delete(key);
    }
  }

  /** 获取 GPU 内存统计 */
  getStats(): GPUMemoryStats {
    let totalTextures = 0;
    let totalGeometries = 0;
    let totalMaterials = 0;
    let totalRenderTargets = 0;
    let estimatedTotalBytes = 0;

    for (const [, resources] of this.resources) {
      for (const r of resources) {
        switch (r.type) {
          case 'texture':
            totalTextures++;
            break;
          case 'geometry':
            totalGeometries++;
            break;
          case 'material':
            totalMaterials++;
            break;
          case 'renderTarget':
            totalRenderTargets++;
            break;
        }
        estimatedTotalBytes += r.estimatedBytes;
      }
    }

    return {
      totalTextures,
      totalGeometries,
      totalMaterials,
      totalRenderTargets,
      estimatedTotalBytes,
      estimatedTotalMB: Math.round(estimatedTotalBytes / (1024 * 1024)),
      texturePoolSize: this.texturePool.size,
    };
  }

  /** 启动泄漏检测（仅开发模式） */
  startLeakDetection(): void {
    if (this.leakCheckTimer) return;
    this.leakCheckTimer = setInterval(() => {
      const stats = this.getStats();
      const now = Date.now();
      let staleCount = 0;

      for (const [ownerId, resources] of this.resources) {
        // 超过 5 分钟未释放的资源标记为疑似泄漏
        const stale = resources.filter((r) => now - r.createdAt > 300_000);
        if (stale.length > 0) {
          staleCount += stale.length;
          console.warn(
            `[GPUResourceTracker] 疑似泄漏: owner=${ownerId}, ` +
            `stale=${stale.length}, types=${stale.map((r) => r.type).join(',')}`,
          );
        }
      }

      if (staleCount === 0) {
        console.debug(`[GPUResourceTracker] 无泄漏, stats:`, stats);
      }
    }, LEAK_CHECK_INTERVAL_MS);
  }

  /** 停止泄漏检测 */
  stopLeakDetection(): void {
    if (this.leakCheckTimer) {
      clearInterval(this.leakCheckTimer);
      this.leakCheckTimer = null;
    }
  }

  /** 清空所有资源 */
  clearAll(): void {
    for (const [ownerId] of this.resources) {
      this.disposeOwner(ownerId);
    }
    this.resources.clear();

    for (const [key, entry] of this.texturePool) {
      try {
        entry.texture.dispose();
      } catch { /* 静默处理 */ }
    }
    this.texturePool.clear();
  }

  // ===== 私有方法 =====

  /** 安全释放资源 */
  private safeDispose(
    resource: TrackedResource['resource'],
    type: TrackedResource['type'],
  ): void {
    if (type === 'geometry' || type === 'bufferGeometry') {
      (resource as THREE.BufferGeometry).dispose();
    } else if (type === 'material') {
      (resource as THREE.Material).dispose();
    } else if (type === 'texture') {
      (resource as THREE.Texture).dispose();
    } else if (type === 'renderTarget') {
      (resource as THREE.WebGLRenderTarget).dispose();
    } else if (type === 'object3d') {
      this.disposeObject3D(resource as THREE.Object3D);
    }
  }

  /** 递归释放 Object3D 及其子对象的所有资源 */
  private disposeObject3D(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material?.dispose();
        }
      }
    });
    if (obj.parent) {
      obj.parent.remove(obj);
    }
  }

  /** 估算资源 GPU 内存占用 */
  private estimateBytes(
    resource: TrackedResource['resource'],
    type: TrackedResource['type'],
  ): number {
    switch (type) {
      case 'texture': {
        const tex = resource as THREE.Texture;
        if (tex.image) {
          const w = (tex.image as { width?: number }).width || 512;
          const h = (tex.image as { height?: number }).height || 512;
          return w * h * 4; // RGBA 4 bytes per pixel
        }
        return 512 * 512 * 4;
      }
      case 'geometry': {
        const geo = resource as THREE.BufferGeometry;
        const posAttr = geo.getAttribute('position');
        return posAttr ? posAttr.count * 3 * 4 : 0; // 3 floats × 4 bytes
      }
      case 'renderTarget': {
        const rt = resource as THREE.WebGLRenderTarget;
        return rt.width * rt.height * 4;
      }
      default:
        return 0;
    }
  }

  /** 检查内存阈值 */
  private checkMemoryThreshold(): void {
    const stats = this.getStats();
    if (stats.estimatedTotalMB > GPU_MEMORY_CRITICAL_MB) {
      console.error(
        `[GPUResourceTracker] ⚠️ GPU 内存临界: ${stats.estimatedTotalMB}MB, ` +
        `纹理=${stats.totalTextures}, 几何体=${stats.totalGeometries}`,
      );
      // 触发纹理池清理
      this.evictLRU();
    } else if (stats.estimatedTotalMB > GPU_MEMORY_WARN_MB) {
      console.warn(
        `[GPUResourceTracker] GPU 内存告警: ${stats.estimatedTotalMB}MB`,
      );
    }
  }

  /** LRU 淘汰 — 移除最久未使用的纹理 */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.texturePool) {
      if (entry.refCount <= 0 && entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.texturePool.get(oldestKey);
      if (entry) {
        try {
          entry.texture.dispose();
        } catch { /* 静默处理 */ }
        this.texturePool.delete(oldestKey);
      }
    }
  }
}

/** 全局单例 */
export const gpuTracker = new GPUResourceTracker();
