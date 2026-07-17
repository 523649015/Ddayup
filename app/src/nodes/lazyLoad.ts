import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { NodeType } from '@/types';

const preloadedChunks = new Set<string>();
const retryCount = new Map<string, number>();
const MAX_RETRIES = 3;
type NodeComponent = ComponentType<NodeProps>;

function lazyWithRetry(
  importer: () => Promise<{ default: NodeComponent }>,
  chunkName: string,
): LazyExoticComponent<NodeComponent> {
  return lazy(async () => {
    try {
      return await importer();
    } catch (error) {
      const count = retryCount.get(chunkName) || 0;
      if (count < MAX_RETRIES) {
        retryCount.set(chunkName, count + 1);
        console.warn(`[LazyLoad] ${chunkName} load failed, retry ${count + 1}/${MAX_RETRIES}.`, error);
        return importer();
      }
      console.error(`[LazyLoad] ${chunkName} failed after ${MAX_RETRIES} retries.`, error);
      throw error;
    }
  }) as LazyExoticComponent<NodeComponent>;
}

export const lazyNodeComponents: Record<NodeType, LazyExoticComponent<NodeComponent>> = {
  text: lazyWithRetry(async () => ({ default: (await import('@/nodes/TextNode')).TextNode }), 'TextNode'),
  image: lazyWithRetry(async () => ({ default: (await import('@/nodes/ImageNode')).ImageNode }), 'ImageNode'),
  video: lazyWithRetry(async () => ({ default: (await import('@/nodes/VideoNode')).VideoNode }), 'VideoNode'),
  audio: lazyWithRetry(async () => ({ default: (await import('@/nodes/AudioNode')).AudioNode }), 'AudioNode'),
  post: lazyWithRetry(async () => ({ default: (await import('@/nodes/PostNode')).PostNode }), 'PostNode'),
  script: lazyWithRetry(async () => ({ default: (await import('@/nodes/ScriptNode')).ScriptNode }), 'ScriptNode'),
  storyboard: lazyWithRetry(async () => ({ default: (await import('@/nodes/StoryboardNode')).StoryboardNode }), 'StoryboardNode'),
  aiapp: lazyWithRetry(async () => ({ default: (await import('@/nodes/AIAppNode')).AIAppNode }), 'AIAppNode'),
  threed: lazyWithRetry(async () => ({ default: (await import('@/nodes/ThreeDNode')).ThreeDNode }), 'ThreeDNode'),
  dcc: lazyWithRetry(async () => ({ default: (await import('@/nodes/DCCCaptureNode')).DCCCaptureNode }), 'DCCCaptureNode'),
  region: lazyWithRetry(async () => ({ default: (await import('@/nodes/RegionContractNode')).RegionContractNode }), 'RegionContractNode'),
};

export function preloadNodeChunk(type: NodeType): void {
  if (preloadedChunks.has(type)) return;
  preloadedChunks.add(type);

  switch (type) {
    case 'text':
      void import('@/nodes/TextNode');
      break;
    case 'image':
      void import('@/nodes/ImageNode');
      break;
    case 'video':
      void import('@/nodes/VideoNode');
      break;
    case 'audio':
      void import('@/nodes/AudioNode');
      break;
    case 'post':
      void import('@/nodes/PostNode');
      break;
    case 'script':
      void import('@/nodes/ScriptNode');
      break;
    case 'storyboard':
      void import('@/nodes/StoryboardNode');
      break;
    case 'aiapp':
      void import('@/nodes/AIAppNode');
      break;
    case 'threed':
      void import('@/nodes/ThreeDNode');
      break;
    case 'dcc':
      void import('@/nodes/DCCCaptureNode');
      break;
    case 'region':
      void import('@/nodes/RegionContractNode');
      break;
  }
}

export function preloadAllNodeChunks(): void {
  const types: NodeType[] = ['text', 'image', 'video', 'audio', 'post', 'script', 'storyboard', 'aiapp', 'threed', 'dcc', 'region'];
  for (const type of types) {
    preloadNodeChunk(type);
  }
}

export function resetPreloadState(): void {
  preloadedChunks.clear();
  retryCount.clear();
}
