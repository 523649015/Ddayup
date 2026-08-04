// Shared constants, types and pure helpers extracted from CanvasBoard.tsx.
// Moved verbatim — no behavior change.
import type { CSSProperties } from 'react';
import { z } from 'zod';
import type { NodeData, NodeType } from '@/types';

export const clipboardNodeSchema = z.object({
  type: z.enum(['text', 'image', 'video', 'audio', 'storyboard', 'aiapp', 'threed', 'script', 'dcc', 'post', 'region']).catch('text'),
  position: z.object({
    x: z.number().catch(400),
    y: z.number().catch(300),
  }).catch({ x: 400, y: 300 }),
  data: z.record(z.string(), z.unknown()).optional(),
});

export type ClipboardNode = z.infer<typeof clipboardNodeSchema>;

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']);
export const FLOW_PAN_ON_DRAG = [1];
export const FLOW_VIEWPORT_STYLE: CSSProperties = { width: '100%', height: '100%', minWidth: '1px', minHeight: '1px' };
export const DEBUG_VIDEO_DEMO_URL = 'https://placeholdervideo.dev/1280x720';
export const DEBUG_REMOTE_IMAGE_URL = 'https://images.unsplash.com/photo-1519389950473-47ba0277781c?auto=format&fit=crop&w=1280&q=80';
export const DEBUG_REMOTE_VIDEO_URL = DEBUG_VIDEO_DEMO_URL;
// 调试图（手动放到项目根的 tmp-*.jpg，构建时不存在）。
// 关键：第一个参数必须是「变量表达式」而非字符串字面量，否则 Vite 会在构建期
// 尝试解析该相对路径并告警 "will be resolved at runtime"。用变量拼接可消除告警，
// 运行时 new URL(base + name, import.meta.url) 的解析结果与原字面量完全一致。
export const DEBUG_TAGGING_ASSET_BASE = '../../';
export function debugTaggingImageUrl(name: string): string {
  return new URL(DEBUG_TAGGING_ASSET_BASE + name, import.meta.url).toString();
}
export const DEBUG_TAGGING_BASE_IMAGE_URL = debugTaggingImageUrl('tmp-main-compressed.jpg');
export const DEBUG_TAGGING_SUBJECT_IMAGE_URL = debugTaggingImageUrl('tmp-subject-compressed.jpg');
export const DEBUG_TAGGING_LIGHTING_IMAGE_URL = debugTaggingImageUrl('tmp-omni-compressed.jpg');

export function buildDebugFixtureImageUrl(text: string, fill = '#0f766e') {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640"><rect width="960" height="640" fill="${fill}"/><text x="80" y="360" fill="#ffffff" font-size="72" font-family="Arial, sans-serif">${text}</text></svg>`,
  )}`;
}

/* ===== 拖动状态通知 store =====
 * 拖拽节点的实时位置改由 <FlowCanvas> 内部的本地 React state（useState + 官方
 * applyNodeChanges）驱动 —— 这是 ReactFlow 受控模式下保证「实时跟手」的标准写法。
 * 本模块级 store 仅用于把「是否正在拖动」这一布尔状态广播给 CanvasGroupLayer 等，
 * 让它们在拖动期间跳过包围盒等非必要重算。FlowCanvas 已 memo，拖拽期间的本地 state
 * 重渲染被隔离在画布内，不会级联到 CanvasFlow 的 Toolbar/Sidebar/Panel 等重型子树。
 */
export const dragTickListeners = new Set<() => void>();
export let dragVersion = 0;

export function subscribeDragTick(callback: () => void): () => void {
  dragTickListeners.add(callback);
  return () => {
    dragTickListeners.delete(callback);
  };
}

export function getDragVersion(): number {
  return dragVersion;
}

// 是否正在拖动节点：仅当 ReactFlow 的 onNodeDragStart 触发（即指针已移动超过阈值，
// 不是单纯点击）才置 true；onNodeDragStop 时清零。用于让节点/分组层在拖动期间跳过
// 非必要重计算，并区分「按住左键拖动」与「点击」。
export let isDraggingNode = false;

export function getIsDragging(): boolean {
  return isDraggingNode;
}

export function setDragging(next: boolean): void {
  if (isDraggingNode === next) return;
  isDraggingNode = next;
  dragVersion += 1;
  dragTickListeners.forEach((listener) => listener());
}

export interface CachedRfNode {
  node: {
    id: string;
    type: string;
    className: string;
    position: { x: number; y: number };
    selectable: boolean;
    draggable: boolean;
    data: Record<string, unknown>;
  };
  dataSrc: unknown;
  posX: number;
  posY: number;
}

export function getMediaNodeType(file: File): NodeType | null {
  const mimeType = file.type.toLowerCase();
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';

  const dotIndex = file.name.lastIndexOf('.');
  const extension = dotIndex >= 0 ? file.name.slice(dotIndex).toLowerCase() : '';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return null;
}

export function getMediaNodeTypeFromPath(filePath: string): 'image' | 'video' | null {
  const normalized = String(filePath || '').trim().replace(/^file:\/\/\/?/i, '');
  if (!normalized) return null;
  const withoutQuery = normalized.split('#')[0]?.split('?')[0] || normalized;
  const dotIndex = withoutQuery.lastIndexOf('.');
  const extension = dotIndex >= 0 ? withoutQuery.slice(dotIndex).toLowerCase() : '';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return null;
}

// 拖放素材上传到 ComfyUI 临时托管，返回可被网关/ComfyUI 远程拉取的临时 URL（不传本地路径）
export async function uploadComfyTempUrl(file: File): Promise<string | null> {
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/comfyui/upload', { method: 'POST', body: form });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.success ? data.url : null;
  } catch {
    return null;
  }
}

export function normalizeClipboardLocalPath(value: string) {
  const trimmed = String(value || '').trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return '';
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return decodeURIComponent(trimmed.replace(/^file:\/\/\/?/i, '').replace(/\//g, '\\'));
    } catch {
      return trimmed.replace(/^file:\/\/\/?/i, '').replace(/\//g, '\\');
    }
  }
  return trimmed;
}

export function isLikelyLocalMediaPath(value: string) {
  const normalized = normalizeClipboardLocalPath(value);
  return Boolean(normalized) && (/^[a-zA-Z]:[\\/]/.test(normalized) || normalized.startsWith('\\\\')) && Boolean(getMediaNodeTypeFromPath(normalized));
}

export function cloneNodeData(value: unknown): Partial<NodeData> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value) as Partial<NodeData>;
    } catch {
      // fall through
    }
  }
  try {
    return JSON.parse(JSON.stringify(value)) as Partial<NodeData>;
  } catch {
    return {};
  }
}

export function readImageMetadata(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const image = new window.Image();
    image.onload = () => {
      resolve({
        width: image.naturalWidth || image.width || 1024,
        height: image.naturalHeight || image.height || 1024,
      });
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

export function readVideoMetadata(url: string): Promise<{ width: number; height: number; duration: number } | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
    };

    video.onloadedmetadata = () => {
      resolve({
        width: video.videoWidth || 1280,
        height: video.videoHeight || 720,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
      });
      cleanup();
    };
    video.onerror = () => {
      resolve(null);
      cleanup();
    };
    video.src = url;
  });
}

