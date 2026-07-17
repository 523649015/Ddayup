import { type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';

interface NodeShellProps extends NodeProps {
  label: string;
  labelIcon: React.ReactNode;
  width?: number;
  children: ReactNode;
  color?: string;
  headerRight?: ReactNode;
  toolbar?: ReactNode;
  aiPanel?: ReactNode;
  modalPanel?: ReactNode;
}

export function NodeShell({
  selected,
  label,
  labelIcon,
  width = 340,
  children,
  headerRight,
  toolbar,
  aiPanel,
  modalPanel,
}: NodeShellProps) {
  return (
    <div
      className={cn(
        'rounded-xl overflow-hidden transition-all duration-200 bg-[#1c1c1e]',
        selected ? 'ring-2 ring-[#e6edf3]' : 'ring-1 ring-[#2a2a2c]'
      )}
      style={{ '--node-w': `${width}px` } as React.CSSProperties}
    >
      {/* Toolbar - above the card, floating */}
      {toolbar && selected && (
        <div className="absolute -top-10 left-0 right-0 flex items-center gap-1 px-2 py-1.5 rounded-lg bg-[#1c1c1e] ring-1 ring-[#2a2a2c] whitespace-nowrap overflow-x-auto -translate-y-1">
          {toolbar}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[#6e7681] text-[11px]">{labelIcon}</span>
          <span className="text-[#6e7681] text-[11px]">{label}</span>
        </div>
        {headerRight}
      </div>

      {/* Main Content */}
      <div className="px-2 pb-2">
        {children}
      </div>

      {/* AI Panel - below the card */}
      {aiPanel && selected && (
        <div className="absolute left-0 right-0 pt-2 top-full">
          {aiPanel}
        </div>
      )}

      {/* Modal Panel - overlay on the card */}
      {modalPanel && (
        <div className="absolute inset-x-0 top-8 bottom-0 z-50 px-2 pb-2">
          {modalPanel}
        </div>
      )}

      {/* Handles — 复用共享 CSS 类 image-node-handle */}
      <Handle type="target" position={Position.Left} className="image-node-handle -left-[10px]" aria-label="输入连接点">
        <span className="text-sm text-[#8b949e] font-bold leading-none">+</span>
      </Handle>
      <Handle type="source" position={Position.Right} className="image-node-handle -right-[10px]" aria-label="输出连接点">
        <span className="text-sm text-[#8b949e] font-bold leading-none">+</span>
      </Handle>
    </div>
  );
}

/* ===== Reusable AI Panel Component ===== */
interface AIPanelProps {
  placeholder?: string;
  modelLabel: string;
  modelIcon?: React.ReactNode;
  modelDropdown?: React.ReactNode;
  extraParams?: ReactNode;
  extraButtons?: ReactNode;
  cost?: number;
  onSend?: () => void;
  onExpand?: () => void;
}

export function AIPanel({
  placeholder = '描述你想要生成的画面内容，按/呼出指令，@引用素材',
  modelLabel,
  extraParams,
  extraButtons,
  cost = 6,
  onSend,
}: AIPanelProps) {
  return (
    <div className="rounded-xl overflow-hidden ring-1 ring-[#2a2a2c] bg-[#1c1c1e]">
      {/* Extra Buttons Row */}
      {extraButtons && (
        <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
          {extraButtons}
        </div>
      )}
      {/* Input */}
      <div className="px-3 py-2">
        <textarea
          placeholder={placeholder}
          className="w-full bg-transparent text-[#e6edf3] text-sm placeholder-[#6e7681] resize-none outline-none min-h-[60px]"
        />
      </div>
      {/* Bottom Params */}
      <div className="flex items-center justify-between px-3 py-2.5 border-t border-[#2a2a2c]">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="flex items-center gap-1.5 text-[#8b949e] text-xs hover:text-[#e6edf3] transition-colors"
            title={modelLabel}
          >
            {modelLabel}
          </button>
          {extraParams}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[#6e7681] text-xs flex items-center gap-1">
            <ZapIcon />
            {cost}
          </span>
          <button
            type="button"
            onClick={onSend}
            title="发送生成请求"
            className="w-7 h-7 rounded-full bg-[#2a2a2c] hover:bg-[#3a3a3c] flex items-center justify-center transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e6edf3" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function ZapIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

/* ===== Placeholder Lines for idle state ===== */
export function PlaceholderLines() {
  return (
    <div className="flex flex-col items-center gap-1.5 py-6">
      <div className="w-16 h-1.5 rounded-full bg-[#2a2a2c]" />
      <div className="w-20 h-1.5 rounded-full bg-[#2a2a2c]" />
      <div className="w-14 h-1.5 rounded-full bg-[#2a2a2c]" />
    </div>
  );
}

/* ===== Try List Component ===== */
interface TryItem {
  icon: React.ReactNode;
  label: string;
}

export function TrySection({ items, onItemClick }: { items: TryItem[]; onItemClick?: (label: string) => void }) {
  return (
    <div className="px-3 pb-3">
      <div className="text-[#6e7681] text-xs mb-2">尝试：</div>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <button
            type="button"
            key={i}
            onClick={() => onItemClick?.(item.label)}
            className="flex items-center gap-2 text-[#c9d1d9] text-sm hover:text-[#e6edf3] transition-colors w-full text-left"
          >
            <span className="text-[#8b949e]">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ===== Expand Arrow Button ===== */
export function ExpandArrow({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="展开"
      className="text-[#6e7681] hover:text-[#e6edf3] transition-colors"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 3 21 3 21 9" />
        <polyline points="9 21 3 21 3 15" />
        <line x1="21" y1="3" x2="14" y2="10" />
        <line x1="3" y1="21" x2="10" y2="14" />
      </svg>
    </button>
  );
}

/* ===== Generating Skeleton — 生成中加载态 ===== */
export function GeneratingSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="px-3 pb-3 space-y-2.5">
      {/* 脉冲指示器 */}
      <div className="flex items-center gap-2 mb-3">
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00d4aa] opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#00d4aa]" />
        </span>
        <span className="text-[#00d4aa] text-xs font-medium">AI 生成中...</span>
      </div>
      {/* 骨架占位线 */}
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-3 rounded-full bg-[#2a2a2c] animate-pulse"
          style={{
            '--skel-w': `${85 - i * 15}%`,
            '--skel-delay': `${i * 150}ms`,
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

/* ===== Status Badge — 节点状态标签 ===== */
export function StatusBadge({ status }: { status: 'idle' | 'generating' | 'completed' | 'error' }) {
  const config: Record<string, { label: string; bg: string; text: string }> = {
    idle:       { label: '待生成', bg: '#2a2a2c', text: '#8b949e' },
    generating: { label: '生成中', bg: '#00d4aa20', text: '#00d4aa' },
    completed:  { label: '已完成', bg: '#22c55e20', text: '#22c55e' },
    error:      { label: '失败',   bg: '#ef444420', text: '#ef4444' },
  };
  const c = config[status] || config.idle;
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
      style={{ '--badge-bg': c.bg, '--badge-color': c.text } as React.CSSProperties}
    >
      {c.label}
    </span>
  );
}
