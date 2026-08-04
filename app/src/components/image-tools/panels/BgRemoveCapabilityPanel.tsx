import { useState } from 'react';
import { Shapes } from 'lucide-react';
import type { ToolCapabilityPanelProps } from './capabilityPanelTypes';
import { toRenderableAssetUrl } from '@/services/generation';

/**
 * 智能去背 CapabilityPanel：极简确认面板，一键执行去背景。
 */
export default function BgRemoveCapabilityPanel({ sourceImageUrl, onApply, onClose }: ToolCapabilityPanelProps) {
  const [status, setStatus] = useState<string | null>(null);

  const handleApply = async () => {
    if (!sourceImageUrl) {
      setStatus('源图缺失');
      return;
    }
    setStatus('处理中…');
    try {
      await onApply?.({ imageUrl: sourceImageUrl });
      setStatus(null);
    } catch {
      setStatus('去背失败');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="relative overflow-hidden rounded-lg bg-[#0b0b0b]" style={{ aspectRatio: '1 / 1' }}>
        <img src={sourceImageUrl || ''} alt="" draggable={false} className="h-full w-full object-contain" />
      </div>

      <div className="flex items-center justify-between rounded-lg border border-[#404040] bg-[#1c1c1c] px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-[#b4b4b4]">
          <Shapes className="h-4 w-4" />
          智能去除背景
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="bgremove-cancel"
          onClick={onClose}
          className="flex-1 rounded-md bg-[#2a2a2a] px-3 py-2 text-xs text-[#cfcfcf] hover:bg-[#343434]"
        >
          取消
        </button>
        <button
          type="button"
          data-testid="bgremove-apply"
          onClick={() => void handleApply()}
          className="flex-1 rounded-md bg-[#2f6df6] px-3 py-2 text-xs font-semibold text-white hover:bg-[#3f7df8]"
        >
          去背
        </button>
      </div>

      {status ? <div data-testid="bgremove-status" className="rounded-lg bg-[#1a1a1a] px-3 py-2 text-xs text-[#b4b4b4]">{status}</div> : null}
    </div>
  );
}
