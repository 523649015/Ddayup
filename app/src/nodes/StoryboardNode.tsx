import { useMemo, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { FileJson, FileSpreadsheet, LayoutGrid, ScrollText } from 'lucide-react';
import { useCanvasStore } from '@/store/useCanvasStore';
import { EditableNodeTitle } from './EditableNodeTitle';
import { ErrorDetailBlock, StatusBadge } from './NodeShellShared';

interface StoryboardRow {
  shotNumber: number;
  startTime: number;
  endTime: number;
  duration: number;
  subjectCount?: number;
  subjectSummary?: string;
  subjectTraits?: string;
  actionSummary?: string;
  sceneSetting?: string;
  storyboardPurpose?: string;
  lensSuggestion?: string;
  frameDescription: string;
  narrativeBeat: string;
  sceneType: string;
  cameraAngle: string;
  cameraMovement: string;
  focusDepth: string;
  lighting: string;
  soundDesign: string;
  cameraPrompt?: string;
  imagePrompt?: string;
  keyframePrompt?: string;
  keyframeTime?: number;
  visualKeywords?: string[];
  styleDescription?: string;
  lightingMood?: string;
  atmosphere?: string;
  subjectMotion?: string;
  cameraMotionDetail?: string;
  compositionDetail?: string;
  colorPalette?: string[];
  keyframeImageBase64?: string;
  keyframeMimeType?: string;
}

type StoryboardTableRow = StoryboardRow & {
  keyframeSrc: string;
  subjectText: string;
  sceneMoodText: string;
  motionText: string;
  cameraText: string;
  compositionText: string;
  keywordText: string;
};

function stopCanvasInteraction(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function csvEscape(value: unknown) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatTime(value: unknown) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
}

function joinText(values: unknown, divider = ' / ') {
  if (!Array.isArray(values)) return String(values || '');
  return values.filter(Boolean).map(String).join(divider);
}

function buildKeyframeSrc(row: StoryboardRow) {
  const base64 = String(row.keyframeImageBase64 || '').trim();
  if (!base64) return '';
  const mime = String(row.keyframeMimeType || 'image/jpeg').trim() || 'image/jpeg';
  return `data:${mime};base64,${base64}`;
}

function buildScriptContent(summary: string, analysisEngine: string, rows: StoryboardTableRow[]) {
  const sections = rows.map((row) => [
    `镜头 ${row.shotNumber}`,
    `时间：${formatTime(row.startTime)} - ${formatTime(row.endTime)}（时长 ${formatTime(row.duration)}）`,
    `角色与特征：${row.subjectText || '待补充'}`,
    `动作与主体运动：${row.motionText || '待补充'}`,
    `场景 / 风格 / 光影 / 氛围：${row.sceneMoodText || '待补充'}`,
    `景别 / 构图 / 景深：${row.compositionText || '待补充'}`,
    `机位 / 运镜 / 镜头建议：${[row.cameraText, row.lensSuggestion].filter(Boolean).join(' / ') || '待补充'}`,
    `叙事目的：${row.storyboardPurpose || row.narrativeBeat || '待补充'}`,
    `画面描述：${row.frameDescription || '待补充'}`,
    row.imagePrompt ? `画面提示词：${row.imagePrompt}` : '',
    row.cameraPrompt ? `运镜提示词：${row.cameraPrompt}` : '',
    row.keyframePrompt ? `关键帧提示词：${row.keyframePrompt}` : '',
    row.soundDesign ? `声音建议：${row.soundDesign}` : '',
  ].filter(Boolean).join('\n'));

  return [
    '视频分镜脚本',
    summary ? `解析摘要：${summary}` : '',
    analysisEngine ? `解析引擎：${analysisEngine}` : '',
    ...sections,
  ].filter(Boolean).join('\n\n');
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function sanitizeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'video-parse-storyboard';
}

export function StoryboardNode(props: NodeProps) {
  const { selected, data, id } = props;
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const params = data?.params && typeof data.params === 'object' ? data.params as Record<string, unknown> : {};
  const rows = Array.isArray(params.parseRows)
    ? params.parseRows.filter((item) => item && typeof item === 'object') as StoryboardRow[]
    : [];
  const summary = String(params.parseSummary || data?.content || '');
  const analysisEngine = String(params.analysisEngine || '');
  const status = (data?.status || 'idle') as 'idle' | 'generating' | 'completed' | 'error';

  const tableRows = useMemo<StoryboardTableRow[]>(() => rows.map((row) => ({
    ...row,
    keyframeSrc: buildKeyframeSrc(row),
    subjectText: [row.subjectSummary, row.subjectTraits].filter(Boolean).join(' / '),
    sceneMoodText: [
      row.sceneSetting,
      row.styleDescription,
      row.lightingMood || row.lighting,
      row.atmosphere,
    ].filter(Boolean).join(' / '),
    motionText: [row.actionSummary, row.subjectMotion].filter(Boolean).join(' / '),
    cameraText: [row.cameraAngle, row.cameraMovement, row.cameraMotionDetail].filter(Boolean).join(' / '),
    compositionText: [row.sceneType, row.focusDepth, row.compositionDetail].filter(Boolean).join(' / '),
    keywordText: [joinText(row.visualKeywords), joinText(row.colorPalette, ' / ')].filter(Boolean).join(' / '),
  })), [rows]);

  const stats = useMemo(() => ({
    shotCount: tableRows.length,
    totalDuration: tableRows.reduce((sum, row) => sum + Number(row.duration || 0), 0),
    keyframeCount: tableRows.filter((row) => row.keyframeSrc).length,
  }), [tableRows]);

  function exportJson() {
    const payload = {
      label: data?.label || '解析分镜',
      summary,
      analysisEngine,
      rows,
    };
    const fileName = `${sanitizeFileName(String(data?.label || 'video-parse-storyboard'))}.json`;
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), fileName);
  }

  function exportCsv() {
    const header = [
      '镜头号',
      '开始时间',
      '结束时间',
      '时长',
      '角色与特征',
      '动作与主体运动',
      '场景/风格/光影/氛围',
      '景别/构图/景深',
      '机位/运镜/镜头建议',
      '叙事目的',
      '画面描述',
      '画面提示词',
      '运镜提示词',
      '关键帧提示词',
      '声音建议',
      '视觉关键词',
    ].map(csvEscape).join(',');

    const body = tableRows.map((row) => [
      row.shotNumber,
      formatTime(row.startTime),
      formatTime(row.endTime),
      formatTime(row.duration),
      row.subjectText,
      row.motionText,
      row.sceneMoodText,
      row.compositionText,
      [row.cameraText, row.lensSuggestion].filter(Boolean).join(' / '),
      row.storyboardPurpose || row.narrativeBeat,
      row.frameDescription,
      row.imagePrompt,
      row.cameraPrompt,
      row.keyframePrompt,
      row.soundDesign,
      row.keywordText,
    ].map(csvEscape).join(',')).join('\n');

    const fileName = `${sanitizeFileName(String(data?.label || 'video-parse-storyboard'))}.csv`;
    downloadBlob(new Blob([`${header}\n${body}`], { type: 'text/csv;charset=utf-8' }), fileName);
  }

  function exportScriptNode() {
    const nextNodeId = addNode('script', {
      x: (props.positionAbsoluteX || 0) + 980,
      y: props.positionAbsoluteY || 0,
    });
    updateNodeData(nextNodeId, {
      label: `${String(data?.label || '解析分镜')} · 分镜脚本`,
      status: 'completed',
      content: buildScriptContent(summary, analysisEngine, tableRows),
      params: {
        sourceNodeId: id,
        sourceNodeType: 'storyboard',
        scriptMode: 'storyboard-parse',
        parseSummary: summary,
        parseRows: rows,
      },
    });
    addEdge(id, nextNodeId);
  }

  return (
    <div className="relative" data-testid={`storyboard-node-${id}`}>
      <div
        className={`relative w-[1480px] rounded-xl bg-[#1c1c1e] transition-all duration-200 ${
          selected ? 'ring-2 ring-[#e6edf3]' : 'ring-1 ring-[#2a2a2c]'
        }`}
      >
        <div className="flex items-center justify-between gap-3 px-3 pb-2 pt-2.5">
          <EditableNodeTitle nodeId={id} icon={LayoutGrid} label={data?.label} fallback="分镜节点" />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onPointerDown={stopCanvasInteraction}
              onClick={exportJson}
              className="rounded-lg border border-[#3b3b3b] p-2 text-[#d0d0d0] hover:bg-[#2b2b2b]"
              title="导出 JSON"
              data-testid={`storyboard-export-json-${id}`}
            >
              <FileJson className="h-4 w-4" />
            </button>
            <button
              type="button"
              onPointerDown={stopCanvasInteraction}
              onClick={exportCsv}
              className="rounded-lg border border-[#3b3b3b] p-2 text-[#d0d0d0] hover:bg-[#2b2b2b]"
              title="导出 CSV"
              data-testid={`storyboard-export-csv-${id}`}
            >
              <FileSpreadsheet className="h-4 w-4" />
            </button>
            <button
              type="button"
              onPointerDown={stopCanvasInteraction}
              onClick={exportScriptNode}
              className="rounded-lg border border-[#3b3b3b] p-2 text-[#d0d0d0] hover:bg-[#2b2b2b]"
              title="生成分镜脚本节点"
              data-testid={`storyboard-export-script-${id}`}
            >
              <ScrollText className="h-4 w-4" />
            </button>
            <StatusBadge status={status} />
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3 border-t border-[#2f2f2f] px-4 py-3">
          <div className="rounded-xl border border-[#2f2f2f] bg-[#181818] px-3 py-2" data-testid={`storyboard-shot-count-${id}`}>
            <div className="text-[11px] text-[#8f8f8f]">镜头数量</div>
            <div className="mt-1 text-lg font-semibold text-[#f2f2f2]">{stats.shotCount}</div>
          </div>
          <div className="rounded-xl border border-[#2f2f2f] bg-[#181818] px-3 py-2" data-testid={`storyboard-total-duration-${id}`}>
            <div className="text-[11px] text-[#8f8f8f]">总时长</div>
            <div className="mt-1 text-lg font-semibold text-[#f2f2f2]">{formatTime(stats.totalDuration)}</div>
          </div>
          <div className="rounded-xl border border-[#2f2f2f] bg-[#181818] px-3 py-2" data-testid={`storyboard-keyframe-count-${id}`}>
            <div className="text-[11px] text-[#8f8f8f]">关键帧数量</div>
            <div className="mt-1 text-lg font-semibold text-[#f2f2f2]">{stats.keyframeCount}</div>
          </div>
          <div className="rounded-xl border border-[#2f2f2f] bg-[#181818] px-3 py-2" data-testid={`storyboard-engine-${id}`}>
            <div className="text-[11px] text-[#8f8f8f]">解析引擎</div>
            <div className="mt-1 text-sm font-semibold text-[#cfe9ff]">{analysisEngine || '未记录'}</div>
          </div>
        </div>

        {summary ? (
          <div className="border-t border-cyan-500/20 bg-cyan-500/6 px-4 py-3 text-[12px] leading-6 text-cyan-100" data-testid={`storyboard-summary-${id}`}>
            <div className="font-semibold">解析摘要</div>
            <div className="mt-1 opacity-90">{summary}</div>
          </div>
        ) : null}

        {tableRows.length > 0 ? (
          <div className="overflow-x-auto border-t border-[#2f2f2f]">
            <table className="min-w-full text-left text-[12px] text-[#e5e5e5]">
              <thead className="bg-[#252525] text-[#bdbdbd]">
                <tr>
                  <th className="min-w-[72px] border-b border-[#333] px-3 py-3 font-medium">镜头</th>
                  <th className="min-w-[120px] border-b border-[#333] px-3 py-3 font-medium">时间范围</th>
                  <th className="min-w-[180px] border-b border-[#333] px-3 py-3 font-medium">氛围帧</th>
                  <th className="min-w-[220px] border-b border-[#333] px-3 py-3 font-medium">角色与特征</th>
                  <th className="min-w-[220px] border-b border-[#333] px-3 py-3 font-medium">动作与主体运动</th>
                  <th className="min-w-[240px] border-b border-[#333] px-3 py-3 font-medium">场景 / 风格 / 光影 / 氛围</th>
                  <th className="min-w-[220px] border-b border-[#333] px-3 py-3 font-medium">景别 / 构图 / 景深</th>
                  <th className="min-w-[240px] border-b border-[#333] px-3 py-3 font-medium">机位 / 运镜 / 镜头建议</th>
                  <th className="min-w-[280px] border-b border-[#333] px-3 py-3 font-medium">画面描述</th>
                  <th className="min-w-[260px] border-b border-[#333] px-3 py-3 font-medium">提示词 / 声音建议</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row, index) => (
                  <tr
                    key={`${row.shotNumber}-${index}`}
                    className="align-top odd:bg-[#1c1c1e] even:bg-[#181818]"
                    data-testid={`storyboard-row-${id}-${row.shotNumber}`}
                  >
                    <td className="border-b border-[#2b2b2b] px-3 py-3 leading-6">
                      <div className="font-semibold text-[#f3f3f3]">#{row.shotNumber}</div>
                      <div className="text-[11px] text-[#8f8f8f]">
                        {row.subjectCount ? `${row.subjectCount} 个主体` : '主体数量待补充'}
                      </div>
                    </td>
                    <td className="border-b border-[#2b2b2b] px-3 py-3 leading-6">
                      <div>{formatTime(row.startTime)} - {formatTime(row.endTime)}</div>
                      <div className="text-[11px] text-[#8f8f8f]">时长 {formatTime(row.duration)}</div>
                    </td>
                    <td className="border-b border-[#2b2b2b] px-3 py-3">
                      {row.keyframeSrc ? (
                        <div className="space-y-2">
                          <img
                            src={row.keyframeSrc}
                            alt={`镜头 ${row.shotNumber} 关键帧`}
                            className="h-[96px] w-[160px] rounded-lg object-cover ring-1 ring-[#3a3a3a]"
                            data-testid={`storyboard-keyframe-${id}-${row.shotNumber}`}
                          />
                          <div className="text-[11px] leading-5 text-[#b8c7d9]">
                            {row.keyframePrompt || '已提取关键帧缩略图'}
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-[#3a3a3a] px-3 py-6 text-center text-[11px] text-[#7f8792]">
                          当前解析链路未返回关键帧缩略图
                        </div>
                      )}
                    </td>
                    <td className="border-b border-[#2b2b2b] px-3 py-3 leading-6">
                      <div>{row.subjectText || '待补充主体解析'}</div>
                      {row.storyboardPurpose ? (
                        <div className="mt-2 text-[11px] text-[#8fb4d9]">镜头目的：{row.storyboardPurpose}</div>
                      ) : null}
                    </td>
                    <td className="border-b border-[#2b2b2b] px-3 py-3 leading-6">
                      <div>{row.motionText || '待补充动作描述'}</div>
                      {row.narrativeBeat ? (
                        <div className="mt-2 text-[11px] text-[#8f8f8f]">叙事作用：{row.narrativeBeat}</div>
                      ) : null}
                    </td>
                    <td className="border-b border-[#2b2b2b] px-3 py-3 leading-6">
                      <div>{row.sceneMoodText || '待补充场景氛围'}</div>
                      {row.keywordText ? <div className="mt-2 text-[11px] text-[#9adfd2]">{row.keywordText}</div> : null}
                    </td>
                    <td className="border-b border-[#2b2b2b] px-3 py-3 leading-6">
                      <div>{row.compositionText || '待补充构图信息'}</div>
                    </td>
                    <td className="border-b border-[#2b2b2b] px-3 py-3 leading-6">
                      <div>{[row.cameraText, row.lensSuggestion].filter(Boolean).join(' / ') || '待补充机位与运镜'}</div>
                      {row.cameraPrompt ? (
                        <div className="mt-2 text-[11px] text-[#9adfd2]">运镜提示词：{row.cameraPrompt}</div>
                      ) : null}
                    </td>
                    <td className="border-b border-[#2b2b2b] px-3 py-3 leading-6">
                      <div>{row.frameDescription || '待补充画面描述'}</div>
                    </td>
                    <td className="border-b border-[#2b2b2b] px-3 py-3 leading-6">
                      {row.imagePrompt ? <div className="text-[#e6e6e6]">画面提示词：{row.imagePrompt}</div> : null}
                      {row.soundDesign ? <div className="mt-2 text-[11px] text-[#c7d2e0]">声音建议：{row.soundDesign}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="border-t border-[#2f2f2f] px-4 py-8 text-center text-sm text-[#8d8d8d]">
            当前还没有可展示的分镜解析数据。
          </div>
        )}

        {data?.error ? (
          <div className="px-4 pb-4">
            <ErrorDetailBlock category={params.lastErrorCategory} message={data.error} />
          </div>
        ) : null}

        <Handle id="input" type="target" position={Position.Left} className="image-node-handle" style={handleLeft}>
          <span className="text-xs font-bold leading-none text-[#6e7681]">+</span>
        </Handle>
        <Handle id="storyboard-output" type="source" position={Position.Right} className="image-node-handle" style={handleRight}>
          <span className="text-xs font-bold leading-none text-[#6e7681]">+</span>
        </Handle>
      </div>
    </div>
  );
}

const handleLeft: CSSProperties = { left: -9 };
const handleRight: CSSProperties = { right: -9 };
