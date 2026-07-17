import { useEffect } from 'react';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { getCatalogSyncClient } from '@/services/catalog';

export function useModelCatalogSync(nodeType?: string) {
  const fetchCatalog = useModelCatalogStore((state) => state.fetchCatalog);

  useEffect(() => {
    const syncCatalog = () => {
      void fetchCatalog({ nodeType, force: true });
    };

    syncCatalog();
    const timer = window.setInterval(() => {
      syncCatalog();
    }, 30_000);
    const unsubscribeCatalogSocket = getCatalogSyncClient().subscribe(() => {
      syncCatalog();
    });
    const handleFocus = () => syncCatalog();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') syncCatalog();
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(timer);
      unsubscribeCatalogSocket();
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchCatalog, nodeType]);
}
