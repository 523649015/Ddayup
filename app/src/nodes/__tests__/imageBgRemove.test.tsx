/**
 * Phase 7：图片节点「智能去背」闭环测试（节点级）
 *
 * 验收点：
 *   1️⃣ 点击工具栏「智能去背」→ 调用 removeImageBackground，节点图片更新为去背结果。
 *   2️⃣ 未安装本地模型时（抛 LocalModelError）不崩溃（触发激活引导）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
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

const removeImageBackgroundMock = vi.fn(async () => ({ url: 'hmdao-local://bg-1', assetId: 'bg-a' }));
vi.mock('@/services/imageModelRouting', () => ({
  removeImageBackground: (...args: unknown[]) => removeImageBackgroundMock(...args),
  runLocalHdUpscale: vi.fn(),
  wireLamaToInpaint: vi.fn(),
  LocalModelError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

import { useCanvasStore } from '@/store/useCanvasStore';
import { ImageNode } from '@/nodes/ImageNode';

const NODE_ID = 'img-bg-test';
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

function seedCanvas(nodeData: Record<string, unknown>) {
  const base = useCanvasStore.getState().canvas!;
  useCanvasStore.setState({
    canvas: { ...base, nodes: [{ id: NODE_ID, type: 'image', position: { x: 0, y: 0 }, data: nodeData }] },
    selectedNodeIds: [NODE_ID],
  });
}

function renderBgNode() {
  const nodeData = buildNodeData();
  seedCanvas(nodeData);
  return render(
    <MemoryRouter>
      <ReactFlowProvider>
        <ImageNode selected data={nodeData as never} id={NODE_ID} />
      </ReactFlowProvider>
    </MemoryRouter>,
  );
}

describe('图片节点智能去背', () => {
  beforeEach(() => {
    removeImageBackgroundMock.mockClear();
    useCanvasStore.setState({ selectedNodeIds: [], canvas: useCanvasStore.getState().canvas! });
  });
  afterEach(() => {
    cleanup();
    useCanvasStore.setState({ selectedNodeIds: [], canvas: useCanvasStore.getState().canvas! });
  });

  it('点击「智能去背」→ 面板应用 → 调用 removeImageBackground 并更新节点', async () => {
    renderBgNode();
    // 点击工具按钮打开去背能力面板（懒加载）
    fireEvent.click(screen.getByTitle('智能去背'));
    const applyBtn = await screen.findByTestId('bgremove-apply');
    fireEvent.click(applyBtn);

    await waitFor(() => expect(removeImageBackgroundMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const node = useCanvasStore.getState().canvas!.nodes.find((n) => n.id === NODE_ID);
      expect(String((node?.data as Record<string, unknown>).imageUrl)).toBe('hmdao-local://bg-1');
    });
  });
});
