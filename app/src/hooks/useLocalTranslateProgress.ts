import { useEffect, useState } from 'react';
import { onLocalTranslateStateChange, getLocalTranslateState, type TranslateState as _TranslateState } from '@/services/localTranslate';

type LocalTranslateState = {
  status: 'idle' | 'downloading' | 'ready' | 'error';
  progress: number;
  error: string | null;
};

/** 订阅本地翻译模型加载进度（React hook） */
export function useLocalTranslateProgress(): LocalTranslateState {
  const [state, setState] = useState<LocalTranslateState>(() => {
    const s = getLocalTranslateState();
    return { status: s.status, progress: s.progress, error: s.error };
  });

  useEffect(() => {
    return onLocalTranslateStateChange((next) => {
      setState({ status: next.status, progress: next.progress, error: next.error });
    });
  }, []);

  return state;
}
