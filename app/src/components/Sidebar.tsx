import { Suspense, lazy, memo, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useCanvasStore } from '@/store/useCanvasStore';
import { ResizableAssetPanel } from './ResizableAssetPanel';

// ★性能（2026-09-14）：三个重量级面板改为按需加载，移出入口 chunk（此前入口 840KB）。
//   lazy 需要 default 导出，这里用 .then 做命名导出映射。
const AssetLibrary = lazy(() => import('./AssetLibrary').then((m) => ({ default: m.AssetLibrary })));
const ModelDownloadPanel = lazy(() => import('./ModelDownloadPanel').then((m) => ({ default: m.ModelDownloadPanel })));
const DccEnvironmentPanel = lazy(() => import('./DccEnvironmentPanel').then((m) => ({ default: m.DccEnvironmentPanel })));

/** 重面板懒加载骨架（仅首次进入该面板的极短时间内可见） */
function PanelSkeleton() {
  return (
    <div className="flex h-full items-center justify-center p-4 text-xs text-[#6e7681]">
      正在加载面板…
    </div>
  );
}

// ★性能（2026-09-14）：常驻面板必须 memo 化。
//   Sidebar 订阅了 canvas / workflows（画布拖拽时高频更新），若不 memo，
//   每次 Sidebar 重渲染都会连带重渲染这些常驻大面板 —— 比原先卸载重建更糟。
//   这里用轻量包装组件做 memo，props 只有 active（切 tab 才变），可稳定跳过重渲染。
const MemoModelPanel = memo(function MemoModelPanel({ active }: { active: boolean }) {
  return <ModelDownloadPanel active={active} />;
});
const MemoDccPanel = memo(function MemoDccPanel({ active }: { active: boolean }) {
  return <DccEnvironmentPanel active={active} />;
});
const MemoAssetLibrary = memo(function MemoAssetLibrary() {
  return <AssetLibrary />;
});
import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Clock,
  Edit3,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  HardDrive,
  History,
  Image,
  LayoutGrid,
  Layers,
  MonitorUp,
  Plus,
  RotateCcw,
  Tags,
  Trash2,
  Video,
  type LucideIcon,
} from 'lucide-react';
import type { NodeType, SidebarTab } from '@/types';

const MEDIA_NODE_TYPES = new Set<NodeType>(['script', 'storyboard', 'video', 'image']);

const NODE_TYPE_CONFIG: Record<string, { color: string; icon: LucideIcon }> = {
  script: { color: '#fbbf24', icon: FileText },
  video: { color: '#ff6b35', icon: Video },
  image: { color: '#1a8cff', icon: Image },
  storyboard: { color: '#ec4899', icon: LayoutGrid },
};



const nodeItems: { type: NodeType; icon: LucideIcon; label: string; desc: string; color: string }[] = [
  { type: 'text', icon: FileText, label: '文本', desc: '脚本、广告词、品牌文案', color: '#00d4aa' },
  { type: 'image', icon: Image, label: '图片', desc: '图像生成与编辑', color: '#1a8cff' },
  { type: 'video', icon: Video, label: '视频', desc: '视频生成与编辑', color: '#ff6b35' },
  { type: 'audio', icon: AudioLines, label: '音频', desc: '音频生成与处理', color: '#a855f7' },
  { type: 'post', icon: Layers, label: '后期', desc: '图片 / 视频后期合成', color: '#f97316' },
  { type: 'script', icon: FileText, label: '脚本生成器', desc: '剧本/角色生成分镜脚本', color: '#fbbf24' },
  { type: 'storyboard', icon: LayoutGrid, label: '分镜格子', desc: '分镜故事板', color: '#ec4899' },
  { type: 'aiapp', icon: Layers, label: 'AI 应用', desc: 'AI工作流应用', color: '#22c55e' },
  { type: 'threed', icon: Globe, label: '3D 世界', desc: '3D场景与模型', color: '#06b6d4' },
  { type: 'dcc', icon: MonitorUp, label: 'DCC捕捉', desc: 'Blender/UE视窗捕获', color: '#14b8a6' },
  { type: 'region', icon: Tags, label: '打标签节点', desc: 'DCC 构图 / 区域标记 / 标签协议', color: '#8b5cf6' },
];

const navItems: { tab: SidebarTab; icon: LucideIcon; label: string }[] = [
  { tab: 'assets', icon: FolderOpen, label: '资产库' },
  { tab: 'workflow', icon: GitBranch, label: '工作流' },
  { tab: 'history', icon: Clock, label: '历史' },
  { tab: 'director', icon: Clapperboard, label: '导演台' },
  { tab: 'models', icon: HardDrive, label: '模型' },
  { tab: 'dcc', icon: MonitorUp, label: 'DCC环境' },
];

function iconTileStyle(color: string): CSSProperties {
  return { backgroundColor: `${color}15`, color };
}

export function Sidebar() {
  const canvas = useCanvasStore((s) => s.canvas);
  const addNode = useCanvasStore((s) => s.addNode);
  const toggleSidebar = useCanvasStore((s) => s.toggleSidebar);
  const undo = useCanvasStore((s) => s.undo);
  const undoSteps = useCanvasStore((s) => s.undoSteps);
  const redo = useCanvasStore((s) => s.redo);
  const clearHistory = useCanvasStore((s) => s.clearHistory);
  const historyIndex = useCanvasStore((s) => s.historyIndex);
  const history = useCanvasStore((s) => s.history);
  const workflows = useCanvasStore((s) => s.workflows);
  const loadWorkflow = useCanvasStore((s) => s.loadWorkflow);
  const deleteWorkflow = useCanvasStore((s) => s.deleteWorkflow);
  const renameWorkflow = useCanvasStore((s) => s.renameWorkflow);
  const activeSidebarTab = useCanvasStore((s) => s.activeSidebarTab);
  const sidebarCollapsed = useCanvasStore((s) => s.sidebarCollapsed);
  const setSidebarTab = useCanvasStore((s) => s.setSidebarTab);
  const selectNode = useCanvasStore((s) => s.selectNode);
  const requestViewportFocus = useCanvasStore((s) => s.requestViewportFocus);
  const openImportWorkflow = useCanvasStore((s) => s.openImportWorkflow);

  const [wfRenameId, setWfRenameId] = useState<string | null>(null);
  const [wfRenameVal, setWfRenameVal] = useState('');

  // ★性能：重面板（models / dcc）首次访问后保持挂载，切回时不再重复请求与 DOM 重建。
  const [visitedTabs, setVisitedTabs] = useState<Set<SidebarTab>>(() => new Set<SidebarTab>());
  useEffect(() => {
    setVisitedTabs((prev) => (prev.has(activeSidebarTab) ? prev : new Set(prev).add(activeSidebarTab)));
  }, [activeSidebarTab]);

  const mediaNodes = useMemo(
    () => canvas?.nodes.filter((node) => MEDIA_NODE_TYPES.has(node.type as NodeType)) || [],
    [canvas?.nodes],
  );

  const handleAddNode = (type: NodeType) => {
    if (!canvas) return;
    addNode(type);
  };

  const handleLocateNode = (nodeId: string) => {
    selectNode(nodeId);
    requestViewportFocus(nodeId);
  };

  const panelWidth = useMemo(() => {
    if (activeSidebarTab === 'assets') return 'w-0';
    if (activeSidebarTab === 'workflow' || activeSidebarTab === 'models') return 'w-[300px]';
    if (activeSidebarTab === 'dcc') return 'w-[360px]';
    return 'w-[260px]';
  }, [activeSidebarTab]);

  const renderAddPanel = () => (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-[#21262d] px-4 py-3">
        <h3 className="text-sm font-semibold text-[#e6edf3]">添加节点</h3>
        <button type="button" onClick={toggleSidebar} className="flex h-7 w-7 items-center justify-center rounded-lg text-[#8b949e] transition-colors hover:bg-[#21262d] hover:text-[#e6edf3]" title="收起侧栏">
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-3">
        <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">基础节点</div>
        {nodeItems.slice(0, 5).map((item) => (
          <button
            type="button"
            key={item.type}
            onClick={() => handleAddNode(item.type)}
            title={item.label}
            data-testid={`add-node-${item.type}`}
            className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-[#21262d]"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={iconTileStyle(item.color)}>
              <item.icon className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-[#c9d1d9]">{item.label}</div>
              <div className="truncate text-xs text-[#6e7681]">{item.desc}</div>
            </div>
          </button>
        ))}
        <div className="px-2 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">功能节点</div>
        {nodeItems.slice(5).map((item) => (
          <button
            type="button"
            key={item.type}
            onClick={() => handleAddNode(item.type)}
            title={item.label}
            data-testid={`add-node-${item.type}`}
            className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-[#21262d]"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={iconTileStyle(item.color)}>
              <item.icon className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-[#c9d1d9]">{item.label}</div>
              <div className="truncate text-xs text-[#6e7681]">{item.desc}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );

  const renderHistoryPanel = () => {
    const canUndo = historyIndex >= 0;
    const canRedo = historyIndex < history.length - 1;
    const jumpTo = (index: number) => {
      if (index === historyIndex) return;
      if (index < historyIndex) {
        undo(historyIndex - index);
      } else {
        redo(index - historyIndex);
      }
    };
    return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-[#21262d] px-4 py-3">
        <h3 className="text-sm font-semibold text-[#e6edf3]">操作历史</h3>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => undoSteps(10)} disabled={!canUndo} className="flex h-7 w-7 items-center justify-center rounded-lg text-[#8b949e] transition-colors hover:bg-[#21262d] hover:text-[#e6edf3] disabled:opacity-30" title="回退 10 步">
            <RotateCcw className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => undo()} disabled={!canUndo} className="flex h-7 w-7 items-center justify-center rounded-lg text-[#8b949e] transition-colors hover:bg-[#21262d] hover:text-[#e6edf3] disabled:opacity-30" title="撤销">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => redo()} disabled={!canRedo} className="flex h-7 w-7 items-center justify-center rounded-lg text-[#8b949e] transition-colors hover:bg-[#21262d] hover:text-[#e6edf3] disabled:opacity-30" title="重做">
            <ChevronRight className="h-4 w-4" />
          </button>
          <button type="button" onClick={clearHistory} disabled={history.length === 0} className="flex h-7 w-7 items-center justify-center rounded-lg text-[#8b949e] transition-colors hover:bg-[#21262d] hover:text-[#f85149] disabled:opacity-30" title="清除历史记录">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {history.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-[#6e7681]">
            <History className="mb-3 h-10 w-10 opacity-30" />
            <p className="text-sm">暂无操作记录</p>
            <p className="mt-1 text-[10px]">添加节点后将自动记录</p>
          </div>
        ) : (
          <div className="space-y-1">
            {history.map((entry, index) => (
              <button
                type="button"
                key={`${entry.timestamp}-${index}`}
                onClick={() => jumpTo(index)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors ${index === historyIndex ? 'bg-[#00d4aa]/10 text-[#00d4aa]' : 'text-[#8b949e] hover:bg-[#21262d]'}`}
              >
                <div className={`h-1.5 w-1.5 shrink-0 rounded-full ${index === historyIndex ? 'bg-[#00d4aa]' : 'bg-[#3a3a3c]'}`} />
                <span className="capitalize">{entry.type}</span>
                {entry.nodes ? <span className="text-[#6e7681]">({entry.nodes.length} 节点)</span> : null}
                <span className="ml-auto text-[#6e7681]">{new Date(entry.timestamp).toLocaleTimeString()}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
    );
  };

  const renderWorkflowPanel = () => (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-[#21262d] px-4 py-3">
        <h3 className="mb-3 text-sm font-semibold text-[#e6edf3]">工作流模板</h3>
        <p className="mb-3 text-xs leading-relaxed text-[#8b949e]">
          模板已整合到统一「导入工作流」面板，支持 ComfyUI 导入、画布 JSON 与模板一键加载（含可绑定 ComfyUI 工作流的模板）。
        </p>
        <button
          type="button"
          onClick={openImportWorkflow}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#00d4aa]/10 px-3 py-2.5 text-sm font-medium text-[#00d4aa] ring-1 ring-[#00d4aa]/30 transition-all hover:bg-[#00d4aa]/20"
        >
          <Plus className="h-4 w-4" />
          打开导入工作流面板
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[#6e7681]">已保存</span>
          <span className="text-[10px] text-[#6e7681]">{workflows.length} 个</span>
        </div>
        {workflows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-[#6e7681]">
            <GitBranch className="mb-2 h-8 w-8 opacity-30" />
            <p className="text-xs">暂无保存的工作流</p>
          </div>
        ) : (
          <div className="space-y-2">
            {workflows.map((workflow) => (
              <div key={workflow.id} className="group flex items-center gap-3 rounded-xl bg-[#161b22] px-3 py-2 ring-1 ring-[#21262d] transition-all hover:ring-[#3a3a3c]">
                <div className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: workflow.color || '#00d4aa' }} />
                <div className="min-w-0 flex-1">
                  {wfRenameId === workflow.id ? (
                    <input
                      value={wfRenameVal}
                      onChange={(event) => setWfRenameVal(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          renameWorkflow(workflow.id, wfRenameVal);
                          setWfRenameId(null);
                        }
                      }}
                      onBlur={() => {
                        renameWorkflow(workflow.id, wfRenameVal);
                        setWfRenameId(null);
                      }}
                      autoFocus
                      aria-label="重命名工作流"
                      className="w-full rounded border border-[#00d4aa] bg-[#0d1117] px-2 py-0.5 text-xs text-[#e6edf3] outline-none"
                    />
                  ) : (
                    <p className="truncate text-xs font-medium text-[#c9d1d9]">{workflow.name}</p>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-[#6e7681]">{workflow.nodes.length} 节点</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button type="button" onClick={() => loadWorkflow(workflow.id)} className="rounded bg-[#00d4aa]/10 px-2 py-1 text-[10px] text-[#00d4aa] hover:bg-[#00d4aa]/20" title="加载工作流">加载</button>
                  <button type="button" onClick={() => { setWfRenameId(workflow.id); setWfRenameVal(workflow.name); }} className="text-[#8b949e] hover:text-[#e6edf3]" title="重命名">
                    <Edit3 className="h-3 w-3" />
                  </button>
                  <button type="button" onClick={() => deleteWorkflow(workflow.id)} className="text-[#8b949e] hover:text-[#ef4444]" title="删除工作流">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const renderDirectorPanel = () => (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-[#21262d] px-4 py-3">
        <h3 className="text-sm font-semibold text-[#e6edf3]">导演台</h3>
        <p className="mt-0.5 text-[10px] text-[#6e7681]">管理脚本、分镜和媒体节点</p>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {mediaNodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-[#6e7681]">
            <Clapperboard className="mb-3 h-10 w-10 opacity-30" />
            <p className="text-sm">暂无媒体节点</p>
            <p className="mt-1 text-[10px]">添加脚本、分镜或图片视频节点后会显示在这里</p>
          </div>
        ) : (
          mediaNodes.map((node) => {
            const typeConfig = NODE_TYPE_CONFIG[node.type] || NODE_TYPE_CONFIG.storyboard;
            const TypeIcon = typeConfig.icon;
            return (
              <div key={node.id} className="flex items-center gap-3 rounded-xl bg-[#161b22] px-3 py-2 ring-1 ring-[#21262d]">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={iconTileStyle(typeConfig.color)}>
                  <TypeIcon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-[#c9d1d9]">{String(node.data?.label || '') || node.type}</p>
                  <p className="text-[10px] text-[#6e7681]">{node.type}</p>
                </div>
                <button type="button" onClick={() => handleLocateNode(node.id)} className="text-[10px] text-[#8b949e] hover:text-[#00d4aa]" title="定位到节点">定位</button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  const renderPanelContent = () => {
    switch (activeSidebarTab) {
      case 'add':
        return renderAddPanel();
      case 'assets':
        return null;
      case 'history':
        return renderHistoryPanel();
      case 'workflow':
        return renderWorkflowPanel();
      case 'director':
        return renderDirectorPanel();
      case 'models':
      case 'dcc':
        // 由下方「常驻重面板容器」渲染（懒加载 + 首访后保持挂载）
        return null;
      default:
        return renderAddPanel();
    }
  };

  return (
    <div className="flex h-full shrink-0">
      <div className="z-20 flex w-14 flex-col items-center gap-1 border-r border-[#21262d] bg-[#0d1117] py-3">
        <button
          type="button"
          onClick={() => {
            if (sidebarCollapsed) toggleSidebar();
            setSidebarTab('add');
          }}
          className={`mb-2 flex h-10 w-10 items-center justify-center rounded-xl transition-all ${activeSidebarTab === 'add' && !sidebarCollapsed ? 'bg-[#00d4aa]/15 text-[#00d4aa]' : 'text-[#8b949e] hover:bg-[#21262d] hover:text-white'}`}
          title="添加节点"
        >
          <Plus className="h-5 w-5" />
        </button>
        <div className="my-1 h-px w-8 bg-[#21262d]" />
        {navItems.map((item) => (
          <button
            type="button"
            key={item.tab}
            onClick={() => {
              if (sidebarCollapsed) toggleSidebar();
              setSidebarTab(item.tab);
            }}
            data-testid={`sidebar-tab-${item.tab}`}
            className={`flex h-10 w-10 items-center justify-center rounded-xl transition-all ${activeSidebarTab === item.tab && !sidebarCollapsed ? 'bg-[#00d4aa]/15 text-[#00d4aa]' : 'text-[#8b949e] hover:bg-[#21262d] hover:text-white'}`}
            title={item.label}
          >
            <item.icon className="h-5 w-5" />
          </button>
        ))}
        <div className="flex-1" />
        <div className="my-1 h-px w-8 bg-[#21262d]" />
        <button
          type="button"
          onClick={toggleSidebar}
          className="flex h-10 w-10 items-center justify-center rounded-xl text-[#8b949e] transition-all hover:bg-[#21262d] hover:text-white"
          title={sidebarCollapsed ? '展开' : '收起'}
        >
          {sidebarCollapsed ? <ChevronRight className="h-5 w-5" /> : <ChevronLeft className="h-5 w-5" />}
        </button>
      </div>

      {!sidebarCollapsed ? (
        <div className={`${panelWidth} flex flex-col overflow-hidden border-r border-[#21262d] bg-[#161b22]`}>
          {renderPanelContent()}
          {/* ★性能：重面板首次访问后常驻，用 hidden 切换（避免切回时重复请求 / 重建 DOM） */}
          <Suspense fallback={<PanelSkeleton />}>
            {visitedTabs.has('models') ? (
              <div className={activeSidebarTab === 'models' ? 'flex h-full min-h-0 flex-col overflow-hidden' : 'hidden'}>
                <MemoModelPanel active={activeSidebarTab === 'models'} />
              </div>
            ) : null}
            {visitedTabs.has('dcc') ? (
              <div className={activeSidebarTab === 'dcc' ? 'flex h-full min-h-0 flex-col overflow-hidden' : 'hidden'}>
                <MemoDccPanel active={activeSidebarTab === 'dcc'} />
              </div>
            ) : null}
          </Suspense>
        </div>
      ) : null}

      {activeSidebarTab === 'assets' && !sidebarCollapsed ? (
        <ResizableAssetPanel isOpen={true} onClose={() => setSidebarTab('add')} title="资产库">
          <Suspense fallback={<PanelSkeleton />}>
            <MemoAssetLibrary />
          </Suspense>
        </ResizableAssetPanel>
      ) : null}
    </div>
  );
}
