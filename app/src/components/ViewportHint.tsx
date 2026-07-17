import { useState, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Compass } from 'lucide-react';
import { useUILanguage } from '@/i18n/ui';

export function ViewportHint({ onFitView }: { onFitView: () => void }) {
  const { getViewport } = useReactFlow();
  const { t } = useUILanguage();
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    const checkViewport = () => {
      const vp = getViewport();
      if (vp.zoom < 0.15 || Math.abs(vp.x) > 3000 || Math.abs(vp.y) > 3000) {
        setShowHint(true);
      } else {
        setShowHint(false);
      }
    };

    const interval = setInterval(checkViewport, 500);
    return () => clearInterval(interval);
  }, [getViewport]);

  if (!showHint) return null;

  return (
    <div className="absolute bottom-20 left-1/2 z-30 -translate-x-1/2">
      <div className="flex items-center gap-3 rounded-full border border-[#2a2a2c] bg-[#1c1c1e] px-4 py-2.5 shadow-2xl">
        <span className="text-xs text-[#8b949e]">
          {t('当前视窗里没有节点，可点击按钮快速回到内容区域。', 'No nodes are visible in the viewport. Use this button to jump back.')}
        </span>
        <button
          onClick={onFitView}
          className="flex items-center gap-1.5 rounded-full bg-[#e6edf3] px-3 py-1.5 text-xs font-medium text-[#0d1117] transition-colors hover:bg-white"
        >
          <Compass className="h-3.5 w-3.5" />
          {t('回到节点', 'Focus nodes')}
        </button>
      </div>
    </div>
  );
}
