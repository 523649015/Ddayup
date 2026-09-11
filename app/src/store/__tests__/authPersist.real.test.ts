/**
 * ★真实代码验证（vitest + jsdom，jsdom 原生提供 localStorage）：
 * 确认 useAuthStore 的 persist 真正把登录态写入 localStorage，
 * 且通过重新 import 模块（模拟刷新 → 新页面生命周期）后 rehydrate 自动恢复。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('useAuthStore 登录态持久化（真实代码）', () => {
  beforeEach(() => {
    // jsdom 提供 localStorage；每个用例前清空，模拟全新浏览器
    localStorage.clear();
    vi.resetModules();
  });

  it('登录后写入 localStorage，且刷新（重新加载模块）后仍保持登录态', async () => {
    // 第一次加载 = 用户打开页面并登录
    const mod1 = await import('@/store/useAuthStore');
    const store1 = mod1.useAuthStore;
    store1.getState().setUser({ id: 'u1', email: 'a@b.com', createdAt: new Date().toISOString() });
    store1.getState().setSession({
      accessToken: 'at_xxx',
      refreshToken: 'rt_xxx',
      expiresAt: Date.now() + 2 * 60 * 60 * 1000, // 后端 createSession 返回毫秒
    });

    // 验证真实写入
    const raw = localStorage.getItem('hmdao-auth-storage');
    expect(raw, '登录态未被 persist 写入 localStorage').toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.user?.email).toBe('a@b.com');
    expect(parsed.state.session?.expiresAt).toBeGreaterThan(Date.now());

    // 模拟刷新：重新加载模块（vitest 用 resetModules + 重新 import 模拟新页面）
    const mod2 = await import('@/store/useAuthStore');
    const store2 = mod2.useAuthStore;

    // zustand persist 在模块加载时已自动 rehydrate（异步）。等待 hydration。
    // 通过 onRehydrateStorage 设的 hasHydrated 判断完成。
    const start = Date.now();
    while (!store2.getState().hasHydrated && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(store2.getState().hasHydrated, '刷新后 persist 未触发 rehydrate (hasHydrated=false)').toBe(true);
    expect(store2.getState().isAuthenticated(), '刷新后 isAuthenticated 应为 true').toBe(true);
    expect(store2.getState().user?.email, '刷新后 user 应为 a@b.com').toBe('a@b.com');
  });
});
