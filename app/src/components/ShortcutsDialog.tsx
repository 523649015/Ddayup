import { useCallback, useEffect } from 'react';
import { X } from 'lucide-react';

interface ShortcutItem {
  keys: string[];
  label: string;
}

const SHORTCUTS: ShortcutItem[] = [
  { keys: ['Delete', 'Backspace'], label: '删除选中节点' },
  { keys: ['Ctrl', 'C'], label: '复制选中节点到剪贴板' },
  { keys: ['Ctrl', 'V'], label: '粘贴节点' },
  { keys: ['Ctrl', 'D'], label: '原地复制选中节点' },
  { keys: ['Ctrl', 'A'], label: '全选所有节点' },
  { keys: ['Ctrl', 'Z'], label: '撤销' },
  { keys: ['Ctrl', 'Shift', 'Z'], label: '重做' },
  { keys: ['Ctrl', 'Y'], label: '重做（替代）' },
  { keys: ['Ctrl', 'S'], label: '导出画布为 JSON' },
  { keys: ['Ctrl', '0'], label: '适应视图' },
  { keys: ['Escape'], label: '取消所有选中' },
  { keys: ['?'], label: '显示/隐藏快捷键帮助' },
];

interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  // 按 Escape 关闭
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // 不阻止默认行为 — 让 CanvasBoard 的 Escape 处理器也触发 deselectAll
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (open) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="rounded-xl shadow-2xl border border-[#30363d] w-[420px] max-h-[80vh] overflow-y-auto bg-[#161b22]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#21262d]">
          <h2 className="text-[#e6edf3] text-base font-semibold">键盘快捷键</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[#8b949e] hover:text-[#e6edf3] transition-colors"
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Shortcut List */}
        <div className="px-5 py-4 space-y-1">
          {SHORTCUTS.map((item, i) => (
            <div
              key={i}
              className="flex items-center justify-between py-2 px-2 rounded-md hover:bg-[#1c2128] transition-colors"
            >
              <span className="text-[#c9d1d9] text-sm">{item.label}</span>
              <div className="flex items-center gap-1">
                {item.keys.map((key, j) => (
                  <span key={j}>
                    <kbd className="inline-flex items-center justify-center px-2 py-0.5 text-[11px] font-mono rounded border border-[#30363d] bg-[#21262d] text-[#8b949e] min-w-[22px]">
                      {key}
                    </kbd>
                    {j < item.keys.length - 1 && (
                      <span className="text-[#484f58] mx-0.5 text-[10px]">+</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[#21262d] text-[#6e7681] text-xs">
          按 <kbd className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded border border-[#30363d] bg-[#21262d]">?</kbd> 随时呼出此面板
        </div>
      </div>
    </div>
  );
}
