import { Download, FileText, LayoutGrid, PenSquare, Rows3, Sparkles } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { exportStoryboardPdf, exportStoryboardZip } from '@/lib/imageToolExports';
import { toRenderableAssetUrl } from '@/services/generation';
import type { ToolCapabilityPanelProps } from './capabilityPanelTypes';

const TEMPLATE_OPTIONS = [
  { label: '九宫格分镜', value: 'nine_shot', cells: 9, layout: '3x3' },
  { label: '四格剧情', value: 'four_panel_drama', cells: 4, layout: '2x2' },
  { label: '角色三视图', value: 'three_view_character', cells: 3, layout: '3x1' },
  { label: '25 格连续镜头', value: 'twentyfive_continuity', cells: 25, layout: '5x5' },
];

const RESOLUTION_OPTIONS = ['1024', '1536', '2048'];
const EXPORT_FORMAT_OPTIONS = ['pdf', 'zip'];

function safeNumber(value: unknown, fallback: number) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export default function GridCapabilityPanel({ value, onChange, sourceImageUrl }: ToolCapabilityPanelProps) {
  const template = String(value.template ?? 'nine_shot');
  const cells = Math.max(1, Math.min(25, Math.round(safeNumber(value.cells, 9))));
  const consistency = Math.max(0, Math.min(1, safeNumber(value.consistency, 0.9)));
  const exportLayout = String(value.exportLayout ?? '3x3');
  const storyboardScript = String(value.storyboardScript ?? '');
  const shotPrompt = String(value.shotPrompt ?? '');
  const outputResolution = String(value.outputResolution ?? '1536');
  const exportFormat = String(value.exportFormat ?? 'pdf');
  const templateMeta = TEMPLATE_OPTIONS.find((item) => item.value === template) || TEMPLATE_OPTIONS[0];
  const [activePanel, setActivePanel] = useState(0);
  const renderSourceImageUrl = useMemo(() => toRenderableAssetUrl(sourceImageUrl || '', 'image'), [sourceImageUrl]);

  const panels = useMemo(() => {
    if (Array.isArray(value.panels) && value.panels.length > 0) return value.panels;
    return Array.from({ length: cells }).map((_, index) => ({ title: `分镜 ${index + 1}`, note: '' }));
  }, [value.panels, cells]);

  const activePanelIndex = Math.min(activePanel, Math.max(0, panels.length - 1));

  function updateValue(next: Record<string, unknown>) {
    onChange({ ...value, ...next });
  }

  function normalizePanels(nextCount: number, currentPanels: Array<Record<string, unknown>>) {
    return Array.from({ length: nextCount }).map((_, index) => {
      const existing = currentPanels[index];
      return existing || { title: `分镜 ${index + 1}`, note: '' };
    });
  }

  function updatePanel(index: number, next: Record<string, unknown>) {
    const merged = panels.map((item, itemIndex) => (itemIndex === index ? { ...(item as Record<string, unknown>), ...next } : item));
    updateValue({ panels: merged });
  }

  function selectTemplate(option: (typeof TEMPLATE_OPTIONS)[number]) {
    updateValue({
      template: option.value,
      cells: option.cells,
      exportLayout: option.layout,
      panels: normalizePanels(option.cells, panels as Array<Record<string, unknown>>),
    });
    setActivePanel(0);
  }

  function importScript() {
    const lines = storyboardScript.split(/\n+/).map((item) => item.trim()).filter(Boolean);
    const nextPanels = Array.from({ length: cells }).map((_, index) => ({
      title: `分镜 ${index + 1}`,
      note: lines[index] || '',
    }));
    updateValue({ panels: nextPanels });
  }

  async function handleExportPdf() {
    const items = panels.map((item, index) => ({
      title: String((item as Record<string, unknown>).title || `分镜 ${index + 1}`),
      note: String((item as Record<string, unknown>).note || '无备注'),
      imageUrl: typeof sourceImageUrl === 'string' ? sourceImageUrl : undefined,
    }));
    await exportStoryboardPdf(`storyboard-${template}.pdf`, items, {
      template,
      exportLayout,
      outputResolution,
      exportFormat,
      shotPrompt,
    });
    updateValue({ lastStoryboardExport: 'pdf', lastStoryboardExportAt: Date.now() });
  }

  async function handleExportZip() {
    const items = panels.map((item, index) => ({
      title: String((item as Record<string, unknown>).title || `分镜 ${index + 1}`),
      note: String((item as Record<string, unknown>).note || '无备注'),
      imageUrl: typeof sourceImageUrl === 'string' ? sourceImageUrl : undefined,
    }));
    await exportStoryboardZip(`storyboard-${template}.zip`, items, {
      template,
      exportLayout,
      outputResolution,
      exportFormat,
      shotPrompt,
    });
    updateValue({ lastStoryboardExport: 'zip', lastStoryboardExportAt: Date.now() });
  }

  return (
    <div className="mb-4 rounded-xl border border-[#353535] bg-[#242424] p-3">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-[#ededed]"><LayoutGrid className="h-4 w-4" />九宫格与分镜</div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        {TEMPLATE_OPTIONS.map((option) => {
          const active = template === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => selectTemplate(option)}
              data-testid={`grid-template-${option.value}`}
              className={`rounded-lg border px-3 py-2 text-left ${active ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}
            >
              <div className="font-medium">{option.label}</div>
              <div className="mt-1 text-[11px] opacity-70">{option.layout} / {option.cells} 格</div>
            </button>
          );
        })}
      </div>

      <div className="mt-4 rounded-lg border border-[#404040] bg-[#1c1c1c] p-3">
        <div className="mb-3 grid grid-cols-2 gap-1">
          {Array.from({ length: Math.min(cells, 25) }).map((_, index) => (
            <button
              key={index}
              type="button"
              data-testid={`grid-panel-${index}`}
              onClick={() => setActivePanel(index)}
              className={`relative aspect-video overflow-hidden rounded ring-1 ${activePanelIndex === index ? 'bg-[#4d4d4d] ring-[#8b8b8b]' : 'bg-[#353535] ring-[#4b4b4b]'}`}
            >
              {renderSourceImageUrl ? <img src={renderSourceImageUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-35" draggable={false} /> : null}
              <span className="absolute left-2 top-2 rounded bg-black/45 px-1.5 py-0.5 text-[10px] text-white">{index + 1}</span>
            </button>
          ))}
        </div>

        <RangeRow label="镜头数量" value={String(cells)}>
          <input
            type="range"
            min={3}
            max={25}
            step={1}
            value={cells}
            onChange={(event) => updateValue({ cells: Number(event.target.value), panels: normalizePanels(Number(event.target.value), panels as Array<Record<string, unknown>>) })}
            className="nodrag nopan nowheel w-full"
            data-testid="grid-cells-slider"
          />
        </RangeRow>
        <RangeRow label="一致性" value={consistency.toFixed(2)}>
          <input type="range" min={0} max={1} step={0.01} value={consistency} onChange={(event) => updateValue({ consistency: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="grid-consistency-slider" />
        </RangeRow>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <SelectCard label="版式布局" icon={<Rows3 className="h-4 w-4" />}>
            <select value={exportLayout} onChange={(event) => updateValue({ exportLayout: event.target.value })} className="nodrag nopan nowheel w-full rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-[#e6edf3] outline-none">
              {['2x2', '3x1', '3x3', '5x5'].map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </SelectCard>
          <SelectCard label="导出分辨率" icon={<Sparkles className="h-4 w-4" />}>
            <div className="grid grid-cols-3 gap-2 text-xs">
              {RESOLUTION_OPTIONS.map((option) => (
                <button key={option} type="button" onClick={() => updateValue({ outputResolution: option })} className={`rounded-lg border px-2 py-2 ${outputResolution === option ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}>{option}</button>
              ))}
            </div>
          </SelectCard>
          <SelectCard label="导出格式" icon={<Download className="h-4 w-4" />}>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {EXPORT_FORMAT_OPTIONS.map((option) => (
                <button key={option} type="button" onClick={() => updateValue({ exportFormat: option })} className={`rounded-lg border px-2 py-2 uppercase ${exportFormat === option ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}>{option}</button>
              ))}
            </div>
          </SelectCard>
        </div>

        <div className="mt-4 rounded-lg border border-[#3f3f3f] bg-[#181818] p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[#ededed]"><FileText className="h-4 w-4" />脚本导入</div>
          <textarea
            value={storyboardScript}
            onChange={(event) => updateValue({ storyboardScript: event.target.value })}
            data-testid="grid-script-input"
            placeholder="每行一条镜头描述，例如：主角特写 / 手部动作 / 广角场景"
            className="nodrag nopan nowheel min-h-[90px] w-full resize-none rounded-lg border border-[#303030] bg-[#0f0f0f] px-3 py-2 text-sm text-[#e8e8e8] outline-none"
          />
          <input
            value={shotPrompt}
            onChange={(event) => updateValue({ shotPrompt: event.target.value })}
            data-testid="grid-shot-prompt"
            placeholder="统一补充镜头风格、角色设定和美术要求"
            className="nodrag nopan nowheel mt-3 w-full rounded-lg border border-[#303030] bg-[#0f0f0f] px-3 py-2 text-sm text-[#e8e8e8] outline-none"
          />
          <button type="button" onClick={importScript} data-testid="grid-script-import" className="mt-2 rounded-lg border border-[#404040] px-3 py-2 text-sm text-[#cbcbcb] hover:bg-[#2f2f2f]">按脚本填充分镜</button>
        </div>

        <div className="mt-4 rounded-lg border border-[#3f3f3f] bg-[#181818] p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[#ededed]"><PenSquare className="h-4 w-4" />单格微调</div>
          <div className="mb-2 text-xs text-[#9a9a9a]">当前正在编辑第 {activePanelIndex + 1} 格</div>
          <input
            type="text"
            value={String((panels[activePanelIndex] as Record<string, unknown>)?.title ?? `分镜 ${activePanelIndex + 1}`)}
            onChange={(event) => updatePanel(activePanelIndex, { title: event.target.value })}
            data-testid="grid-panel-title"
            className="nodrag nopan nowheel mb-2 w-full rounded-lg border border-[#303030] bg-[#0f0f0f] px-3 py-2 text-sm text-[#e8e8e8] outline-none"
          />
          <textarea
            value={String((panels[activePanelIndex] as Record<string, unknown>)?.note ?? '')}
            onChange={(event) => updatePanel(activePanelIndex, { note: event.target.value })}
            data-testid="grid-panel-note"
            placeholder="补充构图、动作、镜头运动或字幕说明"
            className="nodrag nopan nowheel min-h-[84px] w-full resize-none rounded-lg border border-[#303030] bg-[#0f0f0f] px-3 py-2 text-sm text-[#e8e8e8] outline-none"
          />
        </div>

        <div className="mt-3 flex items-center justify-between rounded-lg border border-[#404040] bg-[#161616] px-3 py-2 text-xs text-[#b4b4b4]">
          <span>导出摘要</span>
          <span data-testid="grid-summary">{panels.length} 格 / {templateMeta.layout} / {outputResolution} / {exportFormat.toUpperCase()}</span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <button type="button" onClick={() => void handleExportPdf()} data-testid="grid-export-pdf" className="flex items-center justify-center gap-2 rounded-lg border border-[#404040] px-3 py-2 text-[#cbcbcb] hover:bg-[#2f2f2f]"><FileText className="h-4 w-4" />导出 PDF</button>
          <button type="button" onClick={() => void handleExportZip()} data-testid="grid-export-zip" className="flex items-center justify-center gap-2 rounded-lg border border-[#404040] px-3 py-2 text-[#cbcbcb] hover:bg-[#2f2f2f]"><Download className="h-4 w-4" />导出 ZIP</button>
        </div>
      </div>
    </div>
  );
}

function RangeRow({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-2 flex items-center justify-between text-xs text-[#b4b4b4]">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      {children}
    </div>
  );
}

function SelectCard({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-[#3f3f3f] bg-[#181818] p-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-[#b4b4b4]">{icon}<span>{label}</span></div>
      {children}
    </div>
  );
}

