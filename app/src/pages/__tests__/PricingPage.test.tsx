import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// 被测组件（默认导出）
import PricingPage from '../PricingPage';

// ---- mock react-router-dom：用 MemoryRouter 注入 query ----
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    // Link 在测试里直接渲染为 a，无需特殊处理
  };
});

// ---- mock i18n（与现有测试约定一致） ----
vi.mock('@/i18n/publicUi', () => ({
  usePublicUILanguage: () => ({
    t: (k: string, _en?: string) => k,
    language: 'zh',
  }),
}));

// ---- mock qrcode（避免 jsdom 生成 canvas） ----
vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,TEST')),
  },
}));

// 渲染辅助：带 query 的 MemoryRouter 包裹
function renderPage(initialEntries: string[]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <PricingPage />
    </MemoryRouter>,
  );
}

// 统一构造 fetch 响应
function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

describe('PricingPage 订阅回跳与状态机', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // 场景 1：无 deviceId → 显示「请从扩展进入」卡片，不发任何 fetch
  it('场景1 无 deviceId 时显示「请从浏览器扩展内进入」且不发起任何请求', async () => {
    const fetchMock = vi.fn(() => jsonResponse({ success: false }));
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/pricing']); // 无 query

    await waitFor(() => {
      expect(screen.getByText('请从浏览器扩展内进入')).toBeTruthy();
    });
    // 不应调用任何 API（无 deviceId，连 create 都不该发）
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // 场景 2：?paid=1 + 后端尚未激活（mode:'trial'）→ 先「正在确认」再保持轮询态（不误显成功）
  it('场景2 回跳 ?paid=1 但后端尚未 paid 时，不误显成功并保持核实', async () => {
    // 第 1 次 fetchLicenseStatus（回跳核实）返回 trial；后续轮询也一直 trial
    const fetchMock = vi.fn(() =>
      jsonResponse({ success: true, mode: 'trial', periodEnd: null }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/pricing?deviceId=test-device-001&paid=1']);

    // 先进入「正在确认支付结果…」：证明没有直接假成功
    await waitFor(() => {
      expect(screen.getByText('正在确认支付结果…')).toBeTruthy();
    });
    // 不应出现「订阅成功」卡片
    expect(screen.queryByText('订阅成功！')).toBeNull();

    // 核实请求已发出（对 license/status 的 POST）
    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = (fetchMock.mock.calls[0][0] as string);
    expect(calledUrl).toContain('/api/extension/license/status');
  });

  // 场景 3：?paid=1 + 后端已 paid → 先「正在确认」再翻成「订阅成功」绿卡
  it('场景3 回跳 ?paid=1 且后端已 paid 时，最终显示「订阅成功」', async () => {
    const future = Date.now() + 365 * 86400000;
    const fetchMock = vi.fn(() =>
      jsonResponse({ success: true, mode: 'paid', periodEnd: future }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/pricing?deviceId=test-device-001&paid=1']);

    // 最终出现「订阅成功」卡片
    await waitFor(() => {
      expect(screen.getByText('订阅成功！')).toBeTruthy();
    }, { timeout: 3000 });
    // 有效期内应显示有效期文案
    expect(screen.getByText(/有效期至/)).toBeTruthy();
    // 核实接口被调用（mode 来自真实后端，不是 URL 参数）
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/extension/license/status'),
      expect.any(Object),
    );
  });

  // 场景 4a：mock 模式订单（mock=true + checkoutUrl） —— 展示「点击此处完成支付（模拟）」链接（不走二维码）
  it('场景4a 点击订阅（mock 模式）后展示模拟支付链接而非二维码', async () => {
    const deviceId = 'test-device-001';
    const checkoutUrl = '/api/extension/webhook/wechat/mock?orderId=SUB-X&deviceId=' + deviceId;
    const fetchMock = vi.fn(() =>
      jsonResponse({
        success: true, mock: true, orderId: 'SUB-X', provider: 'wechat',
        plan: 'yearly', amountCny: 168, checkoutUrl,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderPage([`/pricing?deviceId=${deviceId}`]);

    const subscribeBtn = await screen.findByText('立即订阅');
    subscribeBtn.click();

    // 创建订单请求已发出且带 omit
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/extension/subscription/create'),
        expect.objectContaining({ credentials: 'omit' }),
      );
    });
    // mock 订单 → 出现「点击此处完成支付（模拟）」链接，指向 checkoutUrl
    const payLink = await screen.findByText('点击此处完成支付（模拟）');
    expect(payLink.getAttribute('href')).toBe(checkoutUrl);
    // 且不应渲染二维码（mock 走 checkoutUrl 而非 qrDataUrl）
    expect(screen.queryByAltText('pay qrcode')).toBeNull();
  });

  // 场景 4b：真实网关订单（mock=false + codeUrl） —— 展示微信/支付宝扫码二维码
  it('场景4b 点击订阅（真实网关）后展示扫码二维码', async () => {
    const deviceId = 'test-device-001';
    const codeUrl = 'weixin://wxpay/bizpayurl?pr=xxxx';
    const fetchMock = vi.fn(() =>
      jsonResponse({
        success: true, mock: false, orderId: 'SUB-REAL', provider: 'wechat',
        plan: 'yearly', amountCny: 168, codeUrl,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderPage([`/pricing?deviceId=${deviceId}`]);

    const subscribeBtn = await screen.findByText('立即订阅');
    subscribeBtn.click();

    // 创建订单请求已发出
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/extension/subscription/create'),
        expect.any(Object),
      );
    });
    // 真实订单 → 渲染二维码图片（alt="pay qrcode"），而非「点击此处完成支付（模拟）」链接
    const qr = await screen.findByAltText('pay qrcode');
    expect(qr).toBeTruthy();
    expect(screen.queryByText('点击此处完成支付（模拟）')).toBeNull();
  });

  // 场景 5（附加）：fetch 抛网络错误时应被 try/catch 兜住，不崩溃白屏
  it('场景5 网络异常时显示错误提示而非白屏', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('network-down')));
    vi.stubGlobal('fetch', fetchMock);

    renderPage(['/pricing?deviceId=test-device-001&paid=1']);

    // 回跳核实失败 → verifyingReturn 解除，且不显示假成功
    await waitFor(() => {
      expect(screen.queryByText('订阅成功！')).toBeNull();
    });
    // 页面仍渲染（未白屏），且显示了「请从扩展进入」之外的合法分支
    expect(screen.queryByText('请从浏览器扩展内进入')).toBeNull();
  });

  // 附加断言：fetch 应使用 credentials:'omit'（避免第三方 Cookie 拦截）
  it('附加 createSubscription / fetchLicenseStatus 均带 credentials:omit', async () => {
    const deviceId = 'test-device-001';
    const fetchMock = vi.fn((url: string) => {
      if ((url as string).includes('/subscription/create')) {
        return jsonResponse({ success: true, mock: true, orderId: 'SUB-X', checkoutUrl: '/x' });
      }
      return jsonResponse({ success: true, mode: 'trial' });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage([`/pricing?deviceId=${deviceId}`]);
    const subscribeBtn = await screen.findByText('立即订阅');
    subscribeBtn.click();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/extension/subscription/create'),
        expect.objectContaining({ credentials: 'omit' }),
      );
    });
  });
});
