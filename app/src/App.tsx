import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthGuard } from '@/components/AuthGuard';
import './App.css';

const LaunchCanvasPage = lazy(() => import('@/pages/LaunchCanvasPage'));
const LoginPage = lazy(() => import('@/pages/LoginPage'));
const RegisterPage = lazy(() => import('@/pages/RegisterPage'));
const ForgotPasswordPage = lazy(() => import('@/pages/ForgotPasswordPage'));
const ApiKeysPage = lazy(() => import('@/pages/ApiKeysPage'));
const DispatchSettingsPage = lazy(() => import('@/pages/DispatchSettingsPage'));
const PosterEditorPage = lazy(() => import('@/pages/PosterEditorPage'));

function App() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-[#111] text-sm text-[#d6d6d6]">正在加载 DDUp...</div>}>
      <Routes>
        <Route path="/" element={<LaunchCanvasPage />} />
        <Route path="/canvas" element={<Navigate to="/?skipLaunch=1" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/poster-editor" element={<PosterEditorPage />} />
        <Route element={<AuthGuard />}>
          <Route path="/settings/api-keys" element={<ApiKeysPage />} />
          <Route path="/settings/dispatch" element={<DispatchSettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export default App;
