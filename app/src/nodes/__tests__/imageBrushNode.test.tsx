/**
 * Phase 4：图片节点「局部编辑（笔刷）」闭环测试（节点级）
 *
 * 验收点：
 *   1️⃣ 点击工具栏「局部编辑」按钮 → 主显示区渲染 BrushEditCanvas（brush-edit-canvas）。
 *   2️⃣ 点击「应用」→ 走本地修复路由（已注册 handler），结果写入「局部编辑」(img-brush)
 *      素材文件夹，且节点图片更新为修复结果、笔刷画布退出。
 *   3️⃣ 未注册本地处理器时，点击「应用」不崩溃，而是弹出友好的激活引导（ModelActivationPrompt）。
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

const h = vi.hoisted(() => ({ addItemSpy: vi.fn(() => 'asset-id') }));
vi.mock('@/store/useAssetStore', () => {
  const store = {
    items: [] as unknown[],
    addItem: h.addItemSpy,
    deleteItems: vi.fn(),
    syncPersistedItems: vi.fn(),
  };
  const hook = (selector: (s: unknown) => unknown) => selector(store);
  return {
    useAssetStore: Object.assign(hook, { getState: () => store, setState: vi.fn() }),
  };
});
vi.mock('@/services/localMediaRegistry', async () => {
  const actual = (await vi.importActual('@/services/localMediaRegistry')) as Record<string, unknown>;
  return {
    ...actual,
    registerLocalMedia: (blob: Blob) => `hmdao-local://brush-${Date.now()}`,
    resolveLocalMediaUrl: (handle: string) => handle,
    hydrateLocalMediaRegistry: vi.fn(),
  };
});

import { useCanvasStore } from '@/store/useCanvasStore';
import { ImageNode } from '@/nodes/ImageNode';
import { registerLocalInpaintHandler } from '@/services/imageBrush';

const NODE_ID = 'img-brush-test';
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

function renderBrushNode() {
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

describe('图片节点局部编辑（笔刷）', () => {
  beforeEach(() => {
    registerLocalInpaintHandler(null);
    useCanvasStore.setState({ selectedNodeIds: [], canvas: useCanvasStore.getState().canvas! });
    h.addItemSpy.mockClear();
    // jsdom 的 canvas.toDataURL 默认抛 "Not implemented"，强制桩一个固定蒙版串
    HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,brushmask';
  });

  afterEach(() => {
    cleanup();
    registerLocalInpaintHandler(null);
    useCanvasStore.setState({ selectedNodeIds: [], canvas: useCanvasStore.getState().canvas! });
  });

  // TODO: 工具栏已移除直接「局部编辑」入口，待新入口稳定后恢复测试
  it.skip('点击「局部编辑」渲染笔刷画布，应用后写入 img-brush 并退出', async () => {
    const handler = vi.fn(async () => ({
      blob: new Blob(['ok'], { type: 'image/png' }),
      width: 512,
      height: 512,
      engine: 'lama',
    }));
    registerLocalInpaintHandler(handler);

    renderBrushNode();

    // 点击工具按钮打开局部编辑能力面板（懒加载），画布 testid 为 brush-mask-canvas
    fireEvent.click(screen.getByTitle('局部编辑'));
    expect(await screen.findByTestId('brush-mask-canvas')).toBeTruthy();

    fireEvent.click(screen.getByTestId('brush-apply'));

    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.addItemSpy).toHaveBeenCalledTimes(1));

    // 应用成功后面板退出，画布不再挂载
    await waitFor(() => {
      expect(screen.queryByTestId('brush-mask-canvas')).toBeNull();
    });

    const addedItem = h.addItemSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(addedItem.folderId).toBe('img-brush');
    expect(addedItem.type).toBe('image');

    const node = useCanvasStore.getState().canvas!.nodes.find((n) => n.id === NODE_ID);
    expect(String((node?.data as Record<string, unknown>).imageUrl || '').startsWith('hmdao-local://')).toBe(true);
  });

  it.skip('未注册本地处理器时，应用不崩溃并弹出激活引导', async () => {
    renderBrushNode();

    fireEvent.click(screen.getByTitle('局部编辑'));
    const applyBtn = await screen.findByTestId('brush-apply');
    fireEvent.click(applyBtn);

    await waitFor(() => {
      expect(screen.getByTestId('generation-auth-modal')).toBeTruthy();
    });
    // 面板仍停留，画布仍在
    expect(screen.getByTestId('brush-mask-canvas')).toBeTruthy();
  });
});
