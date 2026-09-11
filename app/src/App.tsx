import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthGuard } from '@/components/AuthGuard';
import { initExtensionAiBridge } from '@/services/extensionBridge';
import { useCanvasStore } from '@/store/useCanvasStore';
import { ImportWorkflowModal } from '@/components/ImportWorkflowModal';
import './App.css';

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
    </Suspense>
  );
}

export default App;
