import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthGuard } from '@/components/AuthGuard';
import { initExtensionAiBridge, requestExtensionCreds, onExtensionAutoLogin, onSiteRefreshLoginRequest, syncLoginToExtension } from '@/services/extensionBridge';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useAuthStore } from '@/store/useAuthStore';
import { signInWithEmail } from '@/services/authService';
import { ImportWorkflowModal } from '@/components/ImportWorkflowModal';
import './App.css';
import SiteFooter from '@/components/SiteFooter';

const LaunchCanvasPage = lazy(() => import('@/pages/LaunchCanvasPage'));
const LoginPage = lazy(() => import('@/pages/LoginPage'));
const RegisterPage = lazy(() => import('@/pages/RegisterPage'));
const ForgotPasswordPage = lazy(() => import('@/pages/ForgotPasswordPage'));
const ApiKeysPage = lazy(() => import('@/pages/ApiKeysPage'));
const DispatchSettingsPage = lazy(() => import('@/pages/DispatchSettingsPage'));
const PosterEditorPage = lazy(() => import('@/pages/PosterEditorPage'));
const LandingHome = lazy(() => import('@/pages/LandingHome'));
const ServicesPage = lazy(() => import('@/pages/ServicesPage'));
const SubscribePage = lazy(() => import('@/pages/SubscribePage'));
// 懒加载：避免 PricingDemo/ScanCaptureDemo 等演示组件被打进主包，拖慢 /subscribe 首屏
const PricingPage = lazy(() => import('@/pages/PricingPage'));

function App() {
  // 始终注册扩展 AI 助手桥接监听（hmdao:ai-chat -> /api/extension-ai -> hmdao:ai-chat-reply），
  // 确保任何路由下扩展侧栏都能调用 Ddayup 智能机器人。
  useEffect(() => {
    initExtensionAiBridge();
    // 扩展侧栏深链：访问 http://127.0.0.1:3000/#models 时自动切到「模型下载」面板
    const applyHashRoute = () => {
      if (window.location.hash === '#models') {
        useCanvasStore.getState().setSidebarTab('models');
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    };
    applyHashRoute();
    window.addEventListener('hashchange', applyHashRoute);
    return () => window.removeEventListener('hashchange', applyHashRoute);
  }, []);

  // 扩展 ↔ 官网 登录态打通（2026-09-14）：
  //  ① 官网未登录时主动向扩展索取本机记住的凭据（扩展侧登录过 → 官网免重复输入）；
  //  ② 监听扩展「登录成功」主动推送的凭据，同样自动登录。
  //  ★以「已水化 且 未登录」为唯一触发条件，单会话单次尝试，避免重复请求与相互触发循环。
  useEffect(() => {
    let cancelled = false;
    let tried = false;

    const attempt = async (email?: string | null, password?: string | null) => {
      if (cancelled || tried) return;
      const auth = useAuthStore.getState() as unknown as { hasHydrated?: boolean; isAuthenticated?: () => boolean };
      if (!auth.hasHydrated) return;            // 未水化不判定，交给后续触发点
      if (auth.isAuthenticated && auth.isAuthenticated()) return; // 已登录无需自动登录
      tried = true;
      let em = email || '';
      let pw = password || '';
      if (!em || !pw) {
        const r = await requestExtensionCreds();
        if (cancelled || !r.ok || !r.email || !r.password) return;
        em = r.email; pw = r.password;
      }
      try {
        const res = await signInWithEmail({ email: em, password: pw });
        if (!res.success) console.debug('[hmdao] 扩展凭据自动登录官网未成功:', (res as any).code || (res as any).error);
      } catch (_) { /* ignore */ }
    };

    const off = onExtensionAutoLogin((c) => { attempt(c.email, c.password); });
    // 扩展侧令牌失效时会请求官网「重新同步」（自愈）：官网仍处于登录态则重新签发绑定码，
    // 扩展用新码换取有效令牌，用户无需手动点任何按钮。
    const offRefresh = onSiteRefreshLoginRequest(() => {
      const st = useAuthStore.getState() as unknown as { hasHydrated?: boolean; isAuthenticated?: () => boolean };
      if (!st.hasHydrated) return;
      if (st.isAuthenticated && !st.isAuthenticated()) return; // 官网未登录 → 无法自愈
      syncLoginToExtension(6000).catch(() => { /* 扩展未安装/未响应：静默忽略 */ });
    });
    const timers = [800, 2000].map((ms) => window.setTimeout(() => { attempt(); }, ms));
    let unsub: (() => void) | undefined;
    try {
      unsub = useAuthStore.subscribe((s: unknown) => {
        const st = s as { hasHydrated?: boolean };
        if (st && st.hasHydrated) attempt();
      }) as unknown as () => void;
    } catch (_) { /* ignore */ }

    return () => {
      cancelled = true;
      off();
      offRefresh();
      timers.forEach((t) => window.clearTimeout(t));
      if (unsub) unsub();
    };
  }, []);

  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-[#111] text-sm text-[#d6d6d6]">正在加载 DDUp...</div>}>
      <Routes>
        <Route path="/" element={<LaunchCanvasPage />} />
        <Route path="/canvas" element={<Navigate to="/?skipLaunch=1" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/poster-editor" element={<PosterEditorPage />} />
      <Route path="/landing" element={<LandingHome />} />
      <Route path="/services" element={<ServicesPage />} />
      <Route path="/subscribe" element={<SubscribePage />} />
        <Route element={<AuthGuard />}>
          <Route path="/settings/api-keys" element={<ApiKeysPage />} />
          <Route path="/settings/dispatch" element={<DispatchSettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* 全局工作流模板面板（含导入/导出 JSON）：顶栏不放按钮，按 Ctrl/Cmd+Shift+W 打开 */}
      <ImportWorkflowModal />
      <SiteFooter />
    </Suspense>
  );
}

export default App;
