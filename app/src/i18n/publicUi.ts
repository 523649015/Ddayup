import { useCallback, useEffect, useState } from 'react';
import type { UILanguage } from '@/i18n/ui';

const PUBLIC_UI_LANGUAGE_KEY = 'hmdao-public-ui-language';

function readPublicLanguage(): UILanguage {
  if (typeof window === 'undefined') return 'zh';
  try {
    const stored = String(window.localStorage.getItem(PUBLIC_UI_LANGUAGE_KEY) || '').trim().toLowerCase();
    if (stored === 'zh' || stored === 'en') return stored;
  } catch {
    // ignore storage failures
  }
  const browserLanguage = String(window.navigator.language || '').trim().toLowerCase();
  return browserLanguage.startsWith('zh') ? 'zh' : 'en';
}

function persistPublicLanguage(language: UILanguage) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PUBLIC_UI_LANGUAGE_KEY, language);
  } catch {
    // ignore storage failures
  }
}

export function usePublicUILanguage() {
  const [language, setLanguageState] = useState<UILanguage>(() => readPublicLanguage());

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const sync = () => setLanguageState(readPublicLanguage());
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  const setLanguage = useCallback((next: UILanguage) => {
    setLanguageState(next);
    persistPublicLanguage(next);
  }, []);

  const t = useCallback((zh: string, en: string) => (language === 'en' ? en : zh), [language]);

  return {
    language,
    setLanguage,
    isZh: language !== 'en',
    t,
  };
}

