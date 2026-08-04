import { useEffect, useState } from 'react';
import { comfyHealth, comfyPlugins, type ComfyUiHealth, type ComfyUiPlugins } from './comfyuiClient';

export interface ComfyUiStatusState {
  loading: boolean;
  health?: ComfyUiHealth;
  plugins?: ComfyUiPlugins;
  error?: string;
}

// 轮询 ComfyUI 中转网关健康与插件清单，供画布自动识别"装没装 ComfyUI / 插件"。
export function useComfyUiStatus(pollMs = 15000): ComfyUiStatusState {
  const [state, setState] = useState<ComfyUiStatusState>({ loading: true });
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const health = await comfyHealth();
        let plugins: ComfyUiPlugins | undefined;
        if (health.configured && health.reachable) {
          plugins = await comfyPlugins();
        }
        if (alive) setState({ loading: false, health, plugins });
      } catch (e) {
        if (alive) setState({ loading: false, error: String((e as Error)?.message || e) });
      }
    };
    void load();
    const t = setInterval(() => void load(), pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pollMs]);
  return state;
}
