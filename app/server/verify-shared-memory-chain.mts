import assert from 'node:assert/strict';
import { rememberAgentTraceRun } from '../src/services/agentMemory.ts';
import { buildDebugGenerationBodyFromNode } from '../src/services/generation.ts';
import type { CanvasNode } from '../src/types/index.ts';

type MemoryAwareBody = Record<string, unknown> & {
  shared_memory_ids?: string[];
  shared_memory_layers?: string[];
  shared_memory_context?: string[];
  shared_memory_refs?: Array<Record<string, unknown>>;
  workflow_graph?: {
    sharedMemories?: Array<Record<string, unknown>>;
    artifacts?: Array<{ kind?: string }>;
  };
};

class MemoryStorage {
  #map = new Map<string, string>();

  getItem(key: string) {
    return this.#map.has(key) ? this.#map.get(key) ?? null : null;
  }

  setItem(key: string, value: string) {
    this.#map.set(key, value);
  }

  removeItem(key: string) {
    this.#map.delete(key);
  }

  clear() {
    this.#map.clear();
  }
}

function installWindowStub() {
  const localStorage = new MemoryStorage();
  const listeners = new Map<string, Set<(event?: unknown) => void>>();
  const windowStub = {
    localStorage,
    dispatchEvent(event: { type?: string }) {
      const bucket = listeners.get(String(event?.type || ''));
      if (!bucket) return true;
      for (const handler of bucket) handler(event);
      return true;
    },
    addEventListener(type: string, handler: (event?: unknown) => void) {
      const bucket = listeners.get(type) || new Set<(event?: unknown) => void>();
      bucket.add(handler);
      listeners.set(type, bucket);
    },
    removeEventListener(type: string, handler: (event?: unknown) => void) {
      const bucket = listeners.get(type);
      if (!bucket) return;
      bucket.delete(handler);
    },
  } as unknown as Window & typeof globalThis;

  Object.assign(globalThis, {
    window: windowStub,
    localStorage,
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  });
}

function buildNode(type: CanvasNode['type'], model: string, prompt: string, params: Record<string, unknown>): CanvasNode {
  return {
    id: `${type}-node`,
    type,
    position: { x: 0, y: 0 },
    data: {
      label: `${type}-node`,
      prompt,
      provider: type === 'video' ? 'siliconflow' : type === 'post' ? 'local' : 'fal',
      model,
      params,
    },
  };
}

function verifyMemoryAwareBody(label: string, body: MemoryAwareBody) {
  assert(Array.isArray(body.shared_memory_ids) && body.shared_memory_ids.length > 0, `${label}: missing shared_memory_ids`);
  assert(Array.isArray(body.shared_memory_layers) && body.shared_memory_layers.length > 0, `${label}: missing shared_memory_layers`);
  assert(Array.isArray(body.shared_memory_context) && body.shared_memory_context.length > 0, `${label}: missing shared_memory_context`);
  assert(Array.isArray(body.shared_memory_refs) && body.shared_memory_refs.length > 0, `${label}: missing shared_memory_refs`);
  assert(Array.isArray(body.workflow_graph?.sharedMemories) && body.workflow_graph!.sharedMemories!.length > 0, `${label}: workflow_graph.sharedMemories missing`);
  assert(
    Array.isArray(body.workflow_graph?.artifacts) && body.workflow_graph!.artifacts!.some((artifact) => artifact?.kind === 'memory-pack'),
    `${label}: workflow_graph memory-pack artifact missing`,
  );
}

installWindowStub();

const memorySeed = rememberAgentTraceRun({
  traceId: 'trace-smoke-1',
  templateId: 'poster',
  input: '做一张品牌海报，并统一品牌调性、光影氛围与交付链路。',
  planName: '品牌海报链路',
  skillId: 'brand',
  skillName: '品牌海报',
  routeName: '高保真路线',
  planSnapshot: {
    id: 'plan-smoke-1',
    name: '品牌海报链路',
    description: 'shared memory smoke',
    steps: [
      { type: 'text', label: '文案策划', position: { x: 0, y: 0 }, data: { prompt: '文案策划' } },
      { type: 'image', label: '海报生成', position: { x: 320, y: 0 }, data: { prompt: '海报生成' } },
      { type: 'post', label: '后期统一', position: { x: 640, y: 0 }, data: { prompt: '后期统一' } },
    ],
    connections: [{ from: 0, to: 1 }, { from: 1, to: 2 }],
  },
});

const chosenMemories = memorySeed.nextGraph.slice(0, 3);
assert(chosenMemories.length > 0, 'No shared memories were created for the smoke test.');

const sharedParams = {
  sharedMemoryIds: chosenMemories.map((memory) => memory.id),
  sharedMemoryLayers: chosenMemories.map((memory) => memory.layer),
  sharedMemoryContext: chosenMemories.map((memory) => `[${memory.layer}] ${memory.summary}`),
};

const imageBody = buildDebugGenerationBodyFromNode(buildNode('image', 'flux-pro', '品牌海报主视觉', {
  ...sharedParams,
  nodeId: 'image-node',
})) as MemoryAwareBody;

const videoBody = buildDebugGenerationBodyFromNode(buildNode('video', 'Wan-AI/Wan2.2-I2V-A14B', '品牌短片镜头重塑', {
  ...sharedParams,
  nodeId: 'video-node',
  generationMode: 'referenceVideo',
  sourceMediaType: 'video',
})) as MemoryAwareBody;

const postBody = buildDebugGenerationBodyFromNode(buildNode('post', 'ffmpeg-post-stack', '后期统一品牌氛围', {
  ...sharedParams,
  nodeId: 'post-node',
  sourceMediaType: 'image',
})) as MemoryAwareBody;

verifyMemoryAwareBody('image', imageBody);
verifyMemoryAwareBody('video', videoBody);
verifyMemoryAwareBody('post', postBody);

console.log(JSON.stringify({
  ok: true,
  verified: ['image', 'video', 'post'],
  sharedMemoryIds: sharedParams.sharedMemoryIds,
  image: {
    sharedMemoryIds: imageBody.shared_memory_ids,
    workflowArtifactKinds: imageBody.workflow_graph?.artifacts?.map((artifact) => artifact.kind) || [],
  },
  video: {
    sharedMemoryIds: videoBody.shared_memory_ids,
    workflowArtifactKinds: videoBody.workflow_graph?.artifacts?.map((artifact) => artifact.kind) || [],
  },
  post: {
    sharedMemoryIds: postBody.shared_memory_ids,
    workflowArtifactKinds: postBody.workflow_graph?.artifacts?.map((artifact) => artifact.kind) || [],
  },
}, null, 2));

process.exit(0);
