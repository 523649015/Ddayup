/**
 * Phase 3：图片节点「对比」工具闭环测试
 *
 * 验收点：
 *   1️⃣ 节点存在成图（imageUrl + outputs.metadata.originalUrl）时，点击工具栏「对比」按钮
 *       activeTool 切到 'compare'，主显示区用 PostComparePreview 替换普通 <img>。
 *   2️⃣ PostComparePreview 渲染出固定 testid：
 *      - 容器 image-compare-preview
 *      - 拖动分割线 image-compare-divider（role=slider, aria-label=post-compare-divider）
 *      - before / after 两张 <img>（原始素材 vs 效果预览）
 *   3️⃣ 再次点击「对比」可关闭对比，回到普通图片视图。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { useCanvasStore } from '@/store/useCanvasStore';
import { ImageNode } from '@/nodes/ImageNode';

const NODE_ID = 'img-compare-test';
const BEFORE_URL = 'https://example.com/before.png';
const AFTER_URL = 'https://example.com/after.png';

// 重网络 store 用最小桩，避免 jsdom 下发起真实请求 / indexedDB 访问。
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
vi.mock('@/store/useAssetStore', () => ({
  useAssetStore: (selector: (s: unknown) => unknown) =>
    selector({ items: [], addItem: vi.fn(), deleteItems: vi.fn(), syncPersistedItems: vi.fn() }),
}));

function buildNodeData(includeOriginal: boolean) {
  return {
    label: '图片节点',
    status: 'completed' as const,
    model: 'flux-pro',
    provider: 'fal',
    imageUrl: AFTER_URL,
    params: {},
    outputs: [
      {
        id: 'o1',
        type: 'image',
        url: AFTER_URL,
        ...(includeOriginal ? { metadata: { originalUrl: BEFORE_URL } } : {}),
      },
    ],
  };
}

function seedCanvas(nodeData: Record<string, unknown>) {
  const base = useCanvasStore.getState().canvas!;
  useCanvasStore.setState({
    canvas: {
      ...base,
      nodes: [
        {
          id: NODE_ID,
          type: 'image',
          position: { x: 0, y: 0 },
          data: nodeData,
        },
      ],
    },
    selectedNodeIds: [NODE_ID],
  });
}

function renderCompareNode(nodeData: Record<string, unknown>) {
  seedCanvas(nodeData);
  return render(
    <ReactFlowProvider>
      <ImageNode selected data={nodeData as never} id={NODE_ID} />
    </ReactFlowProvider>,
  );
}

describe('图片节点对比工具', () => {
  beforeEach(() => {
    useCanvasStore.setState({ selectedNodeIds: [], canvas: useCanvasStore.getState().canvas! });
  });

  afterEach(() => {
    cleanup();
    useCanvasStore.setState({ selectedNodeIds: [], canvas: useCanvasStore.getState().canvas! });
  });

  it('点击「对比」后主显示区渲染前后对比滑块', () => {
    const nodeData = buildNodeData(true);
    renderCompareNode(nodeData);

    // 初始：工具栏存在，但尚未进入对比视图
    const compareBtn = screen.getByTitle('对比');
    expect(compareBtn).toBeTruthy();
    expect(screen.queryByTestId('image-compare-preview')).toBeNull();

    fireEvent.click(compareBtn);

    // 对比容器出现
    const preview = screen.getByTestId('image-compare-preview');
    expect(preview).toBeTruthy();

    // 拖动分割线（role=slider）出现
    const divider = screen.getByTestId('image-compare-divider');
    expect(divider).toBeTruthy();
    expect(divider.getAttribute('aria-label')).toBe('post-compare-divider');

    // before / after 两张图，且分别对应原始素材与效果预览
    const imgs = preview.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    const srcs = Array.from(imgs).map((img) => img.getAttribute('src') || '');
    expect(srcs.some((src) => src.includes(encodeURIComponent(BEFORE_URL)))).toBe(true);
    expect(srcs.some((src) => src.includes(encodeURIComponent(AFTER_URL)))).toBe(true);
  });

  it('再次点击「对比」回到普通图片视图', () => {
    const nodeData = buildNodeData(true);
    renderCompareNode(nodeData);
    const compareBtn = screen.getByTitle('对比');

    fireEvent.click(compareBtn);
    expect(screen.getByTestId('image-compare-preview')).toBeTruthy();

    fireEvent.click(compareBtn);
    expect(screen.queryByTestId('image-compare-preview')).toBeNull();
  });

  it('未生成（无 originalUrl）时，对比仍以前后相同源渲染而不崩溃', () => {
    const nodeData = buildNodeData(false);
    renderCompareNode(nodeData);
    fireEvent.click(screen.getByTitle('对比'));
    expect(screen.getByTestId('image-compare-preview')).toBeTruthy();
  });
});
