import { useCanvasStore } from '@/store/useCanvasStore';

// 将 store 中的 darkMode 状态同步到 <html> 的 `dark` 类。
// index.css 已定义 :root（浅色）与 .dark（深色）两套 CSS 变量主题，
// 但此前没有任何代码把 darkMode 接到 DOM，导致点击切换毫无反应。
// 这里在应用启动最早时机应用一次，并订阅后续变化。

let lastApplied: boolean | null = null;

function applyTheme(dark: boolean): void {
  if (lastApplied === dark) return;
  lastApplied = dark;
  document.documentElement.classList.toggle('dark', dark);
}

// 立即应用（此时 persist 已同步，避免首屏闪烁）
applyTheme(useCanvasStore.getState().darkMode);

// 订阅变化，实时切换
useCanvasStore.subscribe((state) => applyTheme(state.darkMode));

export {};
