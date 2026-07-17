/**
 * Phase 8：图片节点「查看大图」灯箱闭环测试
 *
 * 验收点：
 *   1️⃣ 点击工具栏「查看大图」→ 渲染全屏灯箱（image-lightbox）。
 *   2️⃣ 点击关闭按钮（或遮罩）→ 灯箱消失。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/store/useBackendHealthStore', () => ({
  useBackendHealthStore: (selector: (s: unknown) => unknown) =>
    selector({ realApiEnabled: false, loading: false, error: undefined, fetchHealth: vi.fn() }),
}));
vi.mock('@/store/useByokRuntimeStore', () => ({
  useByokRuntimeStore: (selector: (s: unknown) => unknown) =>
    selector({ runtime: null, loading: false, error: undefined, fetchRuntime: vi.fn() }),
}));
vi.mock('@/store/useModelCatalogStore', () => ({
  useModelCatalogStore: (selector: (s: unknown) => unknown) => selector({ models: [] }),
}));
vi.mock('@/store/useApiKeyStore', () => ({
  useApiKeyStore: (selector: (s: unknown) => unknown) => selector({ keys: {} }),
  findProviderKeyState: () => null,
  providerKeyMatchesModel: () => false,
}));
vi.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ isAuthenticated: false }),
}));
vi.mock('@/store/useAssetStore', () => {
  const store = { items: [] as unknown[], addItem: vi.fn(() => 'asset-id'), deleteItems: vi.fn(), syncPersistedItems: vi.fn() };
  const hook = (selector: (s: unknown) => unknown) => selector(store);
  return { useAssetStore: Object.assign(hook, { getState: () => store, setState: vi.fn() }) };
});
vi.mock('@/services/localMediaRegistry', async () => {
  const actual = (await vi.importActual('@/services/localMediaRegistry')) as Record<string, unknown>;
  return { ...actual, registerLocalMedia: (b: Blob) => `hmdao-local://x-${Date.now()}`, resolveLocalMediaUrl: (h: string) => h, hydrateLocalMediaRegistry: vi.fn() };
});

import { useCanvasStore } from '@/store/useCanvasStore';
import { ImageNode } from '@/nodes/ImageNode';

const NODE_ID = 'img-lightbox-test';
const SRC = 'https://example.com/src.png';

function buildNodeData() {
  return {
    label: '图片节点',
    status: 'completed' as const,
    model: 'flux-pro',
    provider: 'fal',
    imageUrl: SRC,
    params: {},
    outputs: [{ id: 'o1', type: 'image', url: SRC }],
  };
}

function renderLightboxNode() {
  const nodeData = buildNodeData();
  const base = useCanvasStore.getState().canvas!;
  useCanvasStore.setState({
    canvas: { ...base, nodes: [{ id: NODE_ID, type: 'image', position: { x: 0, y: 0 }, data: nodeData }] },
    selectedNodeIds: [NODE_ID],
  });
  return render(
    <MemoryRouter>
      <ReactFlowProvider>
        <ImageNode selected data={nodeData as never} id={NODE_ID} />
      </ReactFlowProvider>
    </MemoryRouter>,
  );
}

describe('图片节点查看大图灯箱', () => {
  beforeEach(() => {
    useCanvasStore.setState({ selectedNodeIds: [], canvas: useCanvasStore.getState().canvas! });
  });
  afterEach(() => {
    cleanup();
    useCanvasStore.setState({ selectedNodeIds: [], canvas: useCanvasStore.getState().canvas! });
  });

  it('点击查看大图渲染灯箱，关闭后消失', () => {
    renderLightboxNode();
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
    fireEvent.click(screen.getByTitle('查看大图'));
    const lightbox = screen.getByTestId('image-lightbox');
    expect(lightbox).toBeTruthy();
    fireEvent.click(screen.getByTestId('image-lightbox-close'));
    expect(screen.queryByTestId('image-lightbox')).toBeNull();
  });
});
