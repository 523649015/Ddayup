import { useCallback } from 'react';
import { useCanvasStore } from '@/store/useCanvasStore';

export type UILanguage = 'zh' | 'en';

export function useUILanguage() {
  const language = useCanvasStore((state) => state.language);
  const setLanguage = useCanvasStore((state) => state.setLanguage);
  const t = useCallback((zh: string, en: string) => (language === 'en' ? en : zh), [language]);

  return {
    language,
    setLanguage,
    isZh: language !== 'en',
    t,
  };
}
