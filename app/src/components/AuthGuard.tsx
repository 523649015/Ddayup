import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { usePublicUILanguage } from '@/i18n/publicUi';
import { useAuthStore } from '@/store/useAuthStore';
import { allowsLocalCanvasDemoAccess } from '@/utils/demoMode';

export function AuthGuard() {
  const location = useLocation();
  const { t } = usePublicUILanguage();
  const hasHydrated = useAuthStore((state) => state.hasHydrated);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const allowDevCanvasDemo = allowsLocalCanvasDemoAccess();

  if (!hasHydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0d1117] text-[#8b949e]">
        {t('正在加载会话...', 'Loading session...')}
      </div>
    );
  }

  if (!allowDevCanvasDemo && !isAuthenticated()) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }

  return <Outlet />;
}
