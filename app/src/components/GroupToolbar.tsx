import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Clapperboard,
  Download,
  LayoutGrid,
  Play,
  Save,
  SquareStack,
  Trash2,
  Ungroup,
  X,
} from 'lucide-react';

interface GroupToolbarProps {
  selectedCount: number;
  canUngroup: boolean;
  onDelete: () => void;
  onGroup: (name: string, color: string) => void;
  onUngroup: () => void;
  onArrange: (mode: 'grid' | 'horizontal' | 'vertical') => void;
  onSaveWorkflow: (name: string, description?: string) => void;
  onDeselect: () => void;
}

const GROUP_COLORS = [
  '#00d4aa', '#1a8cff', '#ff6b35', '#a855f7',
  '#fbbf24', '#ef4444', '#06b6d4', '#ec4899',
];

const ARRANGE_OPTIONS: Array<{ id: 'grid' | 'horizontal' | 'vertical'; label: string }> = [
  { id: 'grid', label: '宫格排列' },
  { id: 'horizontal', label: '水平排列' },
  { id: 'vertical', label: '垂直排列' },
];

export function GroupToolbar({
  selectedCount,
  canUngroup,
  onDelete,
  onGroup,
  onUngroup,
  onArrange,
  onSaveWorkflow,
  onDeselect,
}: GroupToolbarProps) {
  const canGroup = selectedCount >= 2;
  const showGroupActionCluster = canGroup || canUngroup;
  const [showArrangeMenu, setShowArrangeMenu] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showSaveWorkflow, setShowSaveWorkflow] = useState(false);
  const [selectedColor, setSelectedColor] = useState(GROUP_COLORS[0]);
  const [groupName, setGroupName] = useState('');
  const [workflowName, setWorkflowName] = useState('');
  const [workflowDesc, setWorkflowDesc] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowArrangeMenu(false);
        setShowColorPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!canGroup) {
      setShowArrangeMenu(false);
      setShowColorPicker(false);
    }
  }, [canGroup]);

  const createGroupNow = () => {
    if (!canGroup) return;
    const nextName = groupName.trim() || `分组 ${selectedCount}`;
    onGroup(nextName, selectedColor);
    setShowColorPicker(false);
    setGroupName('');
  };

  const handleSaveWorkflow = () => {
    if (!workflowName.trim()) return;
    onSaveWorkflow(workflowName.trim(), workflowDesc.trim() || undefined);
    setShowSaveWorkflow(false);
    setWorkflowName('');
    setWorkflowDesc('');
  };

  return (
    <div className="absolute left-1/2 top-3 z-40 -translate-x-1/2" ref={menuRef}>
      <div className="flex flex-col items-center gap-1.5">
        {showArrangeMenu && canGroup ? (
          <div className="mb-1 overflow-hidden rounded-xl border border-[#2a2a2c] bg-[#1c1c1e] shadow-2xl">
            {ARRANGE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  onArrange(opt.id);
                  setShowArrangeMenu(false);
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-[#c9d1d9] transition-colors hover:bg-[#2a2a2c]"
              >
                <LayoutGrid className="h-3.5 w-3.5 text-[#8b949e]" />
                {opt.label}
              </button>
            ))}
          </div>
        ) : null}

        {showColorPicker && canGroup ? (
          <div className="mb-1 rounded-xl border border-[#2a2a2c] bg-[#1c1c1e] p-3 shadow-2xl">
            <div className="mb-2 grid grid-cols-4 gap-1.5">
              {GROUP_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setSelectedColor(color)}
                  title={`选择颜色 ${color}`}
                  className={`h-6 w-6 rounded-full transition-all ${selectedColor === color ? 'scale-110 ring-2 ring-white' : ''}`}
                  style={{ background: color }}
                />
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <input
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') createGroupNow();
                }}
                placeholder="输入组名"
                autoFocus
                className="flex-1 rounded-lg border border-[#3a3a3c] bg-[#252528] px-2 py-1 text-xs text-[#e6edf3] outline-none placeholder:text-[#6e7681] focus:border-[#00d4aa]"
              />
              <button
                type="button"
                onClick={createGroupNow}
                title="确认打组"
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#00d4aa] text-[#0d1117] transition-colors hover:bg-[#00e5b3]"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : null}

        {showSaveWorkflow ? (
          <div className="mb-1 w-64 rounded-xl border border-[#2a2a2c] bg-[#1c1c1e] p-3 shadow-2xl">
            <div className="mb-2 text-xs font-medium text-[#e6edf3]">保存为工作流</div>
            <input
              value={workflowName}
              onChange={(event) => setWorkflowName(event.target.value)}
              placeholder="工作流名称"
              className="mb-2 w-full rounded-lg border border-[#3a3a3c] bg-[#252528] px-2.5 py-1.5 text-xs text-[#e6edf3] outline-none placeholder:text-[#6e7681] focus:border-[#00d4aa]"
            />
            <input
              value={workflowDesc}
              onChange={(event) => setWorkflowDesc(event.target.value)}
              placeholder="描述（可选）"
              className="mb-2 w-full rounded-lg border border-[#3a3a3c] bg-[#252528] px-2.5 py-1.5 text-xs text-[#e6edf3] outline-none placeholder:text-[#6e7681] focus:border-[#00d4aa]"
            />
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setShowSaveWorkflow(false)}
                className="rounded-lg bg-[#2a2a2c] px-2.5 py-1 text-xs text-[#8b949e] hover:bg-[#3a3a3c]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSaveWorkflow}
                disabled={!workflowName.trim()}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                  workflowName.trim() ? 'bg-[#00d4aa] text-[#0d1117] hover:bg-[#00e5b3]' : 'bg-[#3a3a3c] text-[#6e7681]'
                }`}
              >
                保存
              </button>
            </div>
          </div>
        ) : null}

        <div data-testid="group-toolbar-selection-label" className="text-[10px] text-[#6e7681]">
          已选中 {selectedCount} 个节点
        </div>

        <div className="flex items-center gap-0.5 rounded-xl border border-[#2a2a2c] bg-[#1c1c1e] px-2 py-1.5 shadow-2xl">
          {canGroup ? (
            <>
              <button
                type="button"
                data-testid="group-toolbar-group-button"
                onClick={createGroupNow}
                className="flex items-center gap-1 rounded-lg bg-[#00d4aa] px-2.5 py-1 text-xs font-medium text-[#0d1117] transition-colors hover:bg-[#00e5b3]"
                title="立即打组（Ctrl+G）"
              >
                <SquareStack className="h-3.5 w-3.5" />
                <span>打组</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowColorPicker(!showColorPicker);
                  setShowSaveWorkflow(false);
                  setShowArrangeMenu(false);
                }}
                className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-[#2a2a2c]"
                title="自定义颜色和组名"
              >
                <div className="h-4 w-4 rounded-full" style={{ background: selectedColor }} />
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowArrangeMenu(!showArrangeMenu);
                  setShowColorPicker(false);
                  setShowSaveWorkflow(false);
                }}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-[#8b949e] transition-colors hover:bg-[#2a2a2c] hover:text-[#c9d1d9]"
                title="排列所选节点"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>

              <div className="mx-0.5 h-4 w-px bg-[#2a2a2c]" />
            </>
          ) : null}

          {showGroupActionCluster ? (
            <>
              <button
                type="button"
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[#c9d1d9] transition-colors hover:bg-[#2a2a2c]"
                title="整组执行"
              >
                <Play className="h-3 w-3" />
                <span className="hidden sm:inline">整组执行</span>
              </button>

              <button
                type="button"
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[#c9d1d9] transition-colors hover:bg-[#2a2a2c]"
                title="转分镜组"
              >
                <Clapperboard className="h-3 w-3" />
                <span className="hidden sm:inline">转分镜组</span>
              </button>

              <button
                type="button"
                onClick={onUngroup}
                disabled={!canUngroup}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[#c9d1d9] transition-colors hover:bg-[#2a2a2c] disabled:cursor-not-allowed disabled:opacity-40"
                title="解组（Ctrl+Shift+G）"
              >
                <Ungroup className="h-3 w-3" />
                <span className="hidden sm:inline">解组</span>
              </button>

              <button
                type="button"
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[#c9d1d9] transition-colors hover:bg-[#2a2a2c]"
                title="批量下载"
              >
                <Download className="h-3 w-3" />
                <span className="hidden sm:inline">批量下载</span>
              </button>

              <div className="mx-0.5 h-4 w-px bg-[#2a2a2c]" />
            </>
          ) : null}

          <button
            type="button"
            onClick={() => {
              setShowSaveWorkflow(!showSaveWorkflow);
              setShowColorPicker(false);
              setShowArrangeMenu(false);
            }}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[#c9d1d9] transition-colors hover:bg-[#2a2a2c]"
            title="保存为工作流"
          >
            <Save className="h-3 w-3" />
            <span className="hidden sm:inline">保存工作流</span>
          </button>

          <div className="mx-0.5 h-4 w-px bg-[#2a2a2c]" />

          <button
            type="button"
            onClick={onDelete}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[#8b949e] transition-colors hover:bg-[#ef4444]/15 hover:text-[#ef4444]"
            title="删除所选节点"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={onDeselect}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[#8b949e] transition-colors hover:bg-[#2a2a2c] hover:text-[#c9d1d9]"
            title="取消选择"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
