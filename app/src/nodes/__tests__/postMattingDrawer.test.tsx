import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/store/useBackendHealthStore', () => ({
  useBackendHealthStore: (selector: (s: unknown) => unknown) => selector({ realApiEnabled: false, loading: false, error: undefined, fetchHealth: vi.fn() }),
}));
vi.mock('@/store/useByokRuntimeStore', () => ({
  useByokRuntimeStore: (selector: (s: unknown) => unknown) => selector({ runtime: null, loading: false, error: undefined, fetchRuntime: vi.fn() }),
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
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ isAuthenticated: true }),
}));
vi.mock('@/components/image-tools/panels/MattingCapabilityPanel', () => ({
  __esModule: true,
  default: ({ sourceImageUrl }: { sourceImageUrl: string }) => <div data-testid="mock-matting-panel">mock matting panel: {sourceImageUrl}</div>,
}));

import { useCanvasStore } from '@/store/useCanvasStore';
import { PostNode } from '@/nodes/PostNode';

const NODE_ID = 'post-node-test';
const SOURCE_ID = 'image-source-test';
const SRC = 'https://example.com/source.png';

function seedCanvas() {
  useCanvasStore.getState().createCanvas('post-matting-open');
  const base = useCanvasStore.getState().canvas!;
  useCanvasStore.setState({
    canvas: {
      ...base,
      nodes: [
        {
          id: SOURCE_ID,
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: '源素材',
            status: 'completed',
            imageUrl: SRC,
            outputs: [{ id: 'img-o1', type: 'image', url: SRC }],
            params: {},
          },
        },
        {
          id: NODE_ID,
          type: 'post',
          position: { x: 300, y: 0 },
          data: {
            label: '后期节点',
            status: 'completed',
            params: {},
          },
        },
      ],
      edges: [
        {
          id: 'edge-source-post',
          source: SOURCE_ID,
          target: NODE_ID,
          sourceHandle: 'media-output',
          targetHandle: 'post-input',
          type: 'smoothstep',
        },
      ],
    },
    selectedNodeIds: [NODE_ID],
  });
}

describe('PostNode smart cutout entry', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ capabilities: { localPostBackends: { ocio: null, oiio: null, gmic: null, upscale: {} } } }),
    })));
    seedCanvas();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens the smart cutout drawer from the post node button', async () => {
    const nodeData = useCanvasStore.getState().canvas!.nodes.find((node) => node.id === NODE_ID)!.data;
    render(
      <MemoryRouter>
        <ReactFlowProvider>
          <PostNode id={NODE_ID} selected data={nodeData as never} />
        </ReactFlowProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('一键智能抠图'));

    const panel = await screen.findByTestId('mock-matting-panel');
    expect(panel.textContent).toContain(SRC);
  });
});

