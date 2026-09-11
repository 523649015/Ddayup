import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { ModelDownloadPanel } from '../ModelDownloadPanel';

// ---- P0-1: 全量 mock 服务层，聚焦「三分区」结构重组验证 ----
// vi.hoisted: 让 mock 数据在 vi.mock 工厂提升时可用（避免 TDZ）

const { presetModels, searchExtensions } = vi.hoisted(() => ({
  presetModels: [
    {
      id: 'sdxl',
      name: 'SDXL Base',
      desc: '文本生成图像',
      size: '6.9GB',
      recommended: true,
      extraFiles: [],
      browserRuntime: false,
      quant: 'fp16',
      defaultPath: 'models/sdxl',
      version: '1.0',
      purpose: '文生图',
      node: '文生图',
    },
    {
      id: 'realistic',
      name: 'Realistic Vision',
      desc: '写实风格',
      size: '4.2GB',
      recommended: false,
      extraFiles: [{ name: 'extra.safetensors', size: '2GB' }],
      browserRuntime: false,
      quant: 'fp16',
      defaultPath: 'models/realistic',
      version: '1.0',
      purpose: '写实',
      node: '文生图',
    },
    {
      id: 'nllb',
      name: 'NLLB-200',
      desc: '翻译模型',
      size: '400MB',
      recommended: false,
      extraFiles: [],
      browserRuntime: 'nllb',
      baseModel: 'nllb-200',
      defaultPath: 'models/nllb',
      localUrl: 'http://localhost:8787',
      quant: 'int8',
      version: '1.0',
      purpose: '翻译',
      node: '翻译',
    },
  ],
  searchExtensions: [
    { id: 'search1', name: '搜索助手', desc: '网页搜索', installUrl: 'https://example.com/search' },
    { id: 'cap1', name: '截图工具', desc: '截图', installUrl: 'https://example.com/cap' },
  ],
}));

vi.mock('@/config/presetModels', () => ({
  PRESET_MODELS: presetModels,
  SEARCH_EXTENSIONS: searchExtensions,
}));

vi.mock('@/services/modelLoader', () => ({
  getAllDownloadProgress: vi.fn(() => []),
  loadModel: vi.fn(() => Promise.resolve()),
  clearProgress: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/services/presetModelInstall', () => ({
  getPresetInstallHealth: vi.fn(() => ({
    status: 'not_installed',
    installed: false,
    running: false,
    version: null,
    updateInfo: null,
    error: null,
    message: '',
  })),
  getPresetUpdateInfo: vi.fn(() => null),
  initPresetInstalledState: vi.fn(() => Promise.resolve()),
  checkPresetUpdates: vi.fn(() => Promise.resolve()),
  subscribePresetInstall: vi.fn(() => () => {}),
  markPresetInstalled: vi.fn(() => Promise.resolve()),
  clearPresetInstalled: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/services/localModelRunner', () => ({
  hasLocalModelRunner: vi.fn(() => false),
}));

vi.mock('@/services/storage', () => ({
  deleteCachedModel: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/services/localInference', () => ({
  reactivateInstalledLocalModels: vi.fn(() => Promise.resolve()),
  activateLocalModel: vi.fn(() => Promise.resolve()),
  deactivateLocalModel: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/services/localTranslate', () => ({
  ensureTranslatorLoaded: vi.fn(() => Promise.resolve()),
  getLocalTranslateState: vi.fn(() => ({
    ready: false,
    progress: 0,
    needWasm: false,
    canTranslate: false,
    active: false,
    error: null,
  })),
  onLocalTranslateStateChange: vi.fn(() => () => {}),
}));

vi.mock('@/services/comfyui/comfyuiClient', () => ({
  comfyHealth: vi.fn(() => Promise.resolve({ status: 'down', engine: null, url: null, managerInstalled: false, models: [] })),
  comfyConfig: vi.fn(() => Promise.resolve({ url: '', autoStart: false, lastError: null })),
  startComfyUi: vi.fn(() => Promise.resolve()),
  openComfyUiWeb: vi.fn(() => Promise.resolve()),
  installComfyUiManager: vi.fn(() => Promise.resolve()),
  runComfyChain: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/services/extensionBridge', () => ({
  detectHmdaoExtension: vi.fn(() => Promise.resolve({ detected: false, version: null })),
  fetchHmdaoExtBuilds: vi.fn(() => Promise.resolve({ ok: true, builds: [] })),
}));

vi.mock('@/api/assetLibrary', () => ({
  pickAssetLibraryDirectory: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'zh' } }),
}));

// 阻断真实网络请求（被 try/catch 兜住，避免测试噪音）
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no-network-in-test'))));
});

// 在模块被 mock 之后导入被测组件（vi.mock 已提升，静态 import 顺序安全）
describe('P0-1 插件管理三分区重构', () => {
  it('渲染三个分区且顺序为「本地模型 / 浏览器内模型 / 运行时插件」', async () => {
    const { container } = render(<ModelDownloadPanel />);
    await waitFor(() => {
      expect(screen.getByText('本地模型')).toBeTruthy();
      expect(screen.getByText('浏览器内模型')).toBeTruthy();
      expect(screen.getByText('运行时插件')).toBeTruthy();
    });

    const zones = Array.from(
      container.querySelectorAll('[data-testid^="plugin-zone-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(zones).toEqual([
      'plugin-zone-本地模型',
      'plugin-zone-浏览器内模型',
      'plugin-zone-运行时插件',
    ]);
  });

  it('既有安装/卸载入口与关键 testid 仍然保留（不丢功能）', async () => {
    render(<ModelDownloadPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('model-download-panel')).toBeTruthy();
      expect(screen.getByTestId('model-download-runtime-section')).toBeTruthy();
      expect(screen.getByTestId('preset-model-sdxl')).toBeTruthy();
    });
    // 运行时卡片（oiio/gmic/ocio/ytdlp）仍渲染
    expect(screen.getByTestId('runtime-card-oiio')).toBeTruthy();
    expect(screen.getByTestId('runtime-card-ytdlp')).toBeTruthy();
  });

  it('「本地模型」分区含已缓存（仅一份，无重复渲染）', async () => {
    render(<ModelDownloadPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('plugin-zone-本地模型')).toBeTruthy();
    });
    // 已缓存区块标题在整棵 DOM 中只应出现一次（证明未被重复复制）
    const cachedHeaders = screen.queryAllByText('已缓存');
    expect(cachedHeaders.length).toBe(1);
  });

  it('分区状态摘要徽标正确生成', async () => {
    render(<ModelDownloadPanel />);
    await waitFor(() => {
      expect(screen.getByText('0/2 已安装')).toBeTruthy();
      expect(screen.getByText('0/4 已接入')).toBeTruthy();
    });
  });
});

// 确保 vitest 在全量 globals 下清理
afterEach(() => {
  cleanup();
});
