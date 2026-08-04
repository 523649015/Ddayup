// Migration banner leaf sub-components and edge/selection helpers extracted from CanvasBoard.tsx.
// Moved verbatim — no behavior change.
import type { CanvasMigrationIssue } from '@/services/generation';

export function LegacyMigrationIssuesBanner({
  issues,
  onDismiss,
  onFocusNode,
  onFocusNext,
  onSelectAll,
  onExportJson,
  onExportCsv,
  onBatchRegenerate,
  batchRegenerateCount,
  t,
}: {
  issues: CanvasMigrationIssue[];
  onDismiss: () => void;
  onFocusNode: (nodeId: string) => void;
  onFocusNext: () => void;
  onSelectAll: () => void;
  onExportJson: () => void;
  onExportCsv: () => void;
  onBatchRegenerate: () => void;
  batchRegenerateCount: number;
  t: (zh: string, en: string) => string;
}) {
  const visibleIssues = issues.slice(0, 6);
  const expiredCount = issues.filter((item) => item.category === 'remote-asset-expired').length;
  const legacyCount = issues.filter((item) => item.category === 'legacy-blob').length;
  return (
    <div
      data-testid="canvas-migration-banner"
      className="pointer-events-auto absolute left-1/2 top-4 z-30 w-[min(760px,calc(100%-32px))] -translate-x-1/2 rounded-2xl border border-amber-500/30 bg-[#17130c]/95 shadow-2xl backdrop-blur"
    >
      <div className="flex items-start justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-amber-100">
            {t(`检测到 ${issues.length} 个历史素材节点需要迁移`, `${issues.length} historical media nodes need migration`)}
          </div>
          <div className="mt-1 text-xs text-amber-100/80">
            {t('旧的 SiliconFlow 临时签名链接过期后将无法继续渲染；历史 blob 素材在浏览器重启后也会失效。建议重新生成、重新上传，或从最新结果节点重新取用素材。', 'Expired SiliconFlow signed URLs and old blob-backed assets can no longer render. Regenerate, re-upload, or reuse the latest result nodes.')}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
            {expiredCount > 0 ? (
              <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-amber-100">
                {t(`SiliconFlow 过期链接 ${expiredCount} 个`, `${expiredCount} expired SiliconFlow assets`)}
              </span>
            ) : null}
            {legacyCount > 0 ? (
              <span className="rounded-full bg-rose-500/15 px-2.5 py-1 text-rose-100">
                {t(`历史本地素材 ${legacyCount} 个`, `${legacyCount} legacy local assets`)}
              </span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          data-testid="canvas-migration-dismiss"
          onClick={onDismiss}
          className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-[#ececec] hover:bg-white/8"
        >
          {t('暂时隐藏', 'Dismiss')}
        </button>
      </div>
      <div className="border-t border-white/8 px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-[#f3ead1]">{t('需要处理的节点', 'Affected nodes')}</div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              data-testid="canvas-migration-focus-next"
              onClick={onFocusNext}
              className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-[#f1f1f1] hover:bg-white/8"
            >
              {t('定位下一个', 'Next issue')}
            </button>
            <button
              type="button"
              data-testid="canvas-migration-select-all"
              onClick={onSelectAll}
              className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-100 hover:bg-amber-500/16"
            >
              {t('选中这些节点', 'Select nodes')}
            </button>
          </div>
        </div>
        <div className="mb-3 flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="canvas-migration-export-json"
            onClick={onExportJson}
            className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-[#ececec] hover:bg-white/8"
          >
            {t('导出 JSON 清单', 'Export JSON')}
          </button>
          <button
            type="button"
            data-testid="canvas-migration-export-csv"
            onClick={onExportCsv}
            className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-[#ececec] hover:bg-white/8"
          >
            {t('导出 CSV 清单', 'Export CSV')}
          </button>
          <button
            type="button"
            data-testid="canvas-migration-batch-regenerate"
            onClick={onBatchRegenerate}
            disabled={batchRegenerateCount <= 0}
            className="rounded-md border border-emerald-500/20 bg-emerald-500/12 px-2.5 py-1 text-xs text-emerald-100 hover:bg-emerald-500/18 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {batchRegenerateCount > 0
              ? t(`批量重新生成 ${batchRegenerateCount} 个节点`, `Regenerate ${batchRegenerateCount} nodes`)
              : t('没有可批量重新生成的节点', 'No regeneratable nodes')}
          </button>
        </div>
        <div className="max-h-[220px] space-y-2 overflow-y-auto pr-1">
          {visibleIssues.map((issue) => (
            <div
              key={`${issue.nodeId}-${issue.category}-${issue.assetKind}`}
              data-testid={`canvas-migration-issue-${issue.nodeId}`}
              className="flex items-start justify-between gap-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-[#f7f7f7]">
                  {issue.nodeLabel}
                  <span className="ml-2 text-[11px] text-[#b9b9b9]">#{issue.nodeId.slice(0, 6)}</span>
                </div>
                <div className="mt-1 text-xs text-[#e6c98f]">{issue.summary}</div>
                <div className="mt-1 line-clamp-2 text-[11px] text-[#cfcfcf]">{issue.detail}</div>
              </div>
              <button
                type="button"
                data-testid={`canvas-migration-focus-${issue.nodeId}`}
                onClick={() => onFocusNode(issue.nodeId)}
                className="shrink-0 rounded-md border border-white/10 px-2.5 py-1 text-xs text-[#f1f1f1] hover:bg-white/8"
              >
                {t('定位', 'Focus')}
              </button>
            </div>
          ))}
          {issues.length > visibleIssues.length ? (
            <div className="text-center text-[11px] text-[#bba882]">
              {t(`还有 ${issues.length - visibleIssues.length} 个节点未展开显示`, `${issues.length - visibleIssues.length} more nodes are hidden`)}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export type MigrationIssueFilter = 'all' | 'remote-asset-expired' | 'legacy-blob';

export function sameNodeIdArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function orderNodeIdsByCanvas(nodes: Array<{ id: string }> | undefined, nodeIds: string[]) {
  const uniqueIds = Array.from(new Set(nodeIds)).filter(Boolean);
  if (!nodes || nodes.length === 0 || uniqueIds.length <= 1) return uniqueIds;
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  return [...uniqueIds].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
}

export function blurActiveEditableElement() {
  if (typeof document === 'undefined') return;
  const activeElement = document.activeElement as HTMLElement | null;
  if (!activeElement) return;
  const tag = activeElement.tagName.toLowerCase();
  const isEditable = activeElement.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
  if (isEditable && typeof activeElement.blur === 'function') {
    activeElement.blur();
  }
}

export function normalizeRenderableEdgeHandle(handleId: unknown, kind: 'source' | 'target') {
  if (typeof handleId !== 'string') return undefined;
  const trimmed = handleId.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return undefined;
  return trimmed;
}

export function hasMountedRenderableEdgeHandles(edge: { source: string; target: string; sourceHandle?: string; targetHandle?: string }) {
  if (typeof document === 'undefined') return true;
  const sourceHandle = normalizeRenderableEdgeHandle(edge.sourceHandle, 'source');
  const targetHandle = normalizeRenderableEdgeHandle(edge.targetHandle, 'target');
  const sourceSelector = sourceHandle
    ? `.react-flow__handle.source[data-nodeid="${edge.source}"][data-handleid="${sourceHandle}"]`
    : `.react-flow__handle.source[data-nodeid="${edge.source}"]`;
  const targetSelector = targetHandle
    ? `.react-flow__handle.target[data-nodeid="${edge.target}"][data-handleid="${targetHandle}"]`
    : `.react-flow__handle.target[data-nodeid="${edge.target}"]`;
  return Boolean(document.querySelector(sourceSelector) && document.querySelector(targetSelector));
}

export function resolveRenderableEdgeStyle(targetHandle: string | undefined) {
  if (!targetHandle) {
    return { stroke: '#39d2c0', strokeWidth: 2.2, opacity: 0.96 };
  }
  if (targetHandle === 'image-main' || targetHandle === 'video-main' || targetHandle === 'audio-input' || targetHandle === 'post-input') {
    return { stroke: '#39d2c0', strokeWidth: 2.2, opacity: 0.96 };
  }
  if (targetHandle.startsWith('image-reference') || targetHandle.startsWith('video-image-reference')) {
    return { stroke: '#f6b84c', strokeWidth: 2.2, opacity: 0.98 };
  }
  if (targetHandle.startsWith('video-video-reference')) {
    return { stroke: '#68a8ff', strokeWidth: 2.2, opacity: 0.98 };
  }
  return { stroke: '#39d2c0', strokeWidth: 2.2, opacity: 0.96 };
}

export function MigrationIssuesBanner({
  issues,
  allIssueCount,
  expiredCount,
  legacyCount,
  filter,
  onFilterChange,
  onDismiss,
  onFocusNode,
  onOpenNodePanel,
  onFocusNext,
  onSelectAll,
  onExportJson,
  onExportCsv,
  onBatchRegenerate,
  onBatchReupload,
  batchRegenerateCount,
  batchReuploadCount,
  batchReuploadActive,
  batchReuploadCurrentIndex,
  batchReuploadTotalCount,
  onCollapse,
  t,
}: {
  issues: CanvasMigrationIssue[];
  allIssueCount: number;
  expiredCount: number;
  legacyCount: number;
  filter: MigrationIssueFilter;
  onFilterChange: (filter: MigrationIssueFilter) => void;
  onDismiss: () => void;
  onFocusNode: (nodeId: string) => void;
  onOpenNodePanel: (nodeId: string) => void;
  onFocusNext: () => void;
  onSelectAll: () => void;
  onExportJson: () => void;
  onExportCsv: () => void;
  onBatchRegenerate: () => void;
  onBatchReupload: () => void;
  batchRegenerateCount: number;
  batchReuploadCount: number;
  batchReuploadActive: boolean;
  batchReuploadCurrentIndex: number;
  batchReuploadTotalCount: number;
  onCollapse: () => void;
  t: (zh: string, en: string) => string;
}) {
  const visibleIssues = issues.slice(0, 6);
  const batchReuploadRemainingCount = Math.max(batchReuploadTotalCount - batchReuploadCurrentIndex, 0);
  const batchReuploadProgressPercent = batchReuploadTotalCount > 0
    ? Math.min(100, Math.max(0, Math.round((batchReuploadCurrentIndex / batchReuploadTotalCount) * 100)))
    : 0;
  return (
    <div
      data-testid="canvas-migration-banner"
      onMouseLeave={onCollapse}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
      }}
      className="pointer-events-auto absolute right-4 top-16 z-30 w-[min(420px,calc(100%-24px))] rounded-2xl border border-rose-500/30 bg-[#1a1111]/96 shadow-2xl backdrop-blur"
    >
      <div className="flex items-start justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-rose-100">
            {t(`检测到 ${allIssueCount} 个历史素材节点需要迁移`, `${allIssueCount} historical media nodes need migration`)}
          </div>
          <div className="mt-1 text-xs text-rose-100/80">
            {t('旧的 SiliconFlow 临时签名链接过期后将无法继续渲染；历史 blob 素材在浏览器重启后也会失效。建议重新生成、重新上传，或复用最新结果节点。', 'Expired SiliconFlow signed URLs and old blob-backed assets can no longer render. Regenerate, re-upload, or reuse the latest result nodes.')}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
            <button
              type="button"
              data-testid="canvas-migration-filter-all"
              onClick={() => onFilterChange('all')}
              className={`rounded-full px-2.5 py-1 transition ${filter === 'all' ? 'bg-white/18 text-white' : 'bg-white/6 text-[#e5dcc6] hover:bg-white/10'}`}
            >
              {t(`全部 ${allIssueCount}`, `All ${allIssueCount}`)}
            </button>
            <button
              type="button"
              data-testid="canvas-migration-filter-expired"
              onClick={() => onFilterChange('remote-asset-expired')}
              className={`rounded-full px-2.5 py-1 transition ${filter === 'remote-asset-expired' ? 'bg-amber-500/24 text-amber-50' : 'bg-amber-500/10 text-amber-100 hover:bg-amber-500/16'}`}
            >
              {t(`只看过期链接 ${expiredCount}`, `Expired only ${expiredCount}`)}
            </button>
            <button
              type="button"
              data-testid="canvas-migration-filter-legacy"
              onClick={() => onFilterChange('legacy-blob')}
              className={`rounded-full px-2.5 py-1 transition ${filter === 'legacy-blob' ? 'bg-rose-500/24 text-rose-50' : 'bg-rose-500/10 text-rose-100 hover:bg-rose-500/16'}`}
            >
              {t(`只看历史 blob ${legacyCount}`, `Legacy blob only ${legacyCount}`)}
            </button>
          </div>
        </div>
        <button
          type="button"
          data-testid="canvas-migration-dismiss"
          onClick={onCollapse}
          className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-[#ececec] hover:bg-white/8"
        >
          {t('收起', 'Collapse')}
        </button>
      </div>
      <div className="border-t border-white/8 px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-[#f3ead1]">{t('需要处理的节点', 'Affected nodes')}</div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              data-testid="canvas-migration-focus-next"
              onClick={onFocusNext}
              className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-[#f1f1f1] hover:bg-white/8"
            >
              {t('定位下一个', 'Next issue')}
            </button>
            <button
              type="button"
              data-testid="canvas-migration-select-all"
              onClick={onSelectAll}
              className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-100 hover:bg-amber-500/16"
            >
              {t('选中这些节点', 'Select nodes')}
            </button>
          </div>
        </div>
        <div className="mb-3 flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="canvas-migration-export-json"
            onClick={onExportJson}
            className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-[#ececec] hover:bg-white/8"
          >
            {t('导出 JSON 清单', 'Export JSON')}
          </button>
          <button
            type="button"
            data-testid="canvas-migration-export-csv"
            onClick={onExportCsv}
            className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-[#ececec] hover:bg-white/8"
          >
            {t('导出 CSV 清单', 'Export CSV')}
          </button>
          <button
            type="button"
            data-testid="canvas-migration-batch-regenerate"
            onClick={onBatchRegenerate}
            disabled={batchRegenerateCount <= 0}
            className="rounded-md border border-emerald-500/20 bg-emerald-500/12 px-2.5 py-1 text-xs text-emerald-100 hover:bg-emerald-500/18 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {batchRegenerateCount > 0
              ? t(`批量重新生成 ${batchRegenerateCount} 个节点`, `Regenerate ${batchRegenerateCount} nodes`)
              : t('没有可批量重新生成的节点', 'No regeneratable nodes')}
          </button>
          <button
            type="button"
            data-testid="canvas-migration-batch-reupload"
            onClick={onBatchReupload}
            disabled={batchReuploadCount <= 0}
            className="rounded-md border border-sky-500/20 bg-sky-500/12 px-2.5 py-1 text-xs text-sky-100 hover:bg-sky-500/18 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {batchReuploadCount > 0
              ? batchReuploadActive
                ? t(`打开下一个待重传节点 ${batchReuploadCount} 个`, `Open next re-upload ${batchReuploadCount}`)
                : t(`批量重新上传 ${batchReuploadCount} 个节点`, `Batch re-upload ${batchReuploadCount} nodes`)
              : t('没有可批量重新上传的节点', 'No re-uploadable nodes')}
          </button>
        </div>
        {batchReuploadActive && batchReuploadTotalCount > 0 ? (
          <div className="mb-3 rounded-xl border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-[11px] text-sky-100">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-sky-50">
              <span>{t(`当前第 ${batchReuploadCurrentIndex} 项，还剩 ${batchReuploadRemainingCount} 项`, `Item ${batchReuploadCurrentIndex}, ${batchReuploadRemainingCount} remaining`)}</span>
              <span className="rounded-full bg-sky-500/18 px-2 py-0.5">{batchReuploadCurrentIndex}/{batchReuploadTotalCount}</span>
            </div>
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-black/25">
              <div className="h-full rounded-full bg-sky-400 transition-[width] duration-200" style={{ width: `${batchReuploadProgressPercent}%` }} />
            </div>
            {t('已进入批量重传队列。每次点击“打开下一个待重传节点”都会自动定位并打开对应节点面板，随后可在节点上重新上传本地文件或从素材库替换。', 'Batch re-upload queue is active. Each click on "Open next re-upload" focuses the next node and opens its panel so you can upload or replace media.')}
          </div>
        ) : null}
        <div className="max-h-[220px] space-y-2 overflow-y-auto pr-1">
          {visibleIssues.map((issue) => (
            <div
              key={`${issue.nodeId}-${issue.category}-${issue.assetKind}`}
              data-testid={`canvas-migration-issue-${issue.nodeId}`}
              className="flex items-start justify-between gap-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-[#f7f7f7]">
                  {issue.nodeLabel}
                  <span className="ml-2 text-[11px] text-[#b9b9b9]">#{issue.nodeId.slice(0, 6)}</span>
                </div>
                <div className="mt-1 text-xs text-[#e6c98f]">{issue.summary}</div>
                <div className="mt-1 line-clamp-2 text-[11px] text-[#cfcfcf]">{issue.detail}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  data-testid={`canvas-migration-focus-${issue.nodeId}`}
                  onClick={() => onFocusNode(issue.nodeId)}
                  className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-[#f1f1f1] hover:bg-white/8"
                >
                  {t('定位', 'Focus')}
                </button>
                <button
                  type="button"
                  data-testid={`canvas-migration-open-panel-${issue.nodeId}`}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenNodePanel(issue.nodeId);
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenNodePanel(issue.nodeId);
                  }}
                  className="rounded-md border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-xs text-sky-100 hover:bg-sky-500/16"
                >
                  {t('打开面板', 'Open panel')}
                </button>
              </div>
            </div>
          ))}
          {issues.length > visibleIssues.length ? (
            <div className="text-center text-[11px] text-[#bba882]">
              {t(`还有 ${issues.length - visibleIssues.length} 个节点未展开显示`, `${issues.length - visibleIssues.length} more nodes are hidden`)}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function MigrationIssuesToggle({
  count,
  onExpand,
  t,
}: {
  count: number;
  onExpand: () => void;
  t: (zh: string, en: string) => string;
}) {
  return (
    <button
      type="button"
      data-testid="canvas-migration-toggle"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onExpand();
      }}
      className="pointer-events-auto absolute right-4 top-24 z-30 flex items-center gap-2 rounded-l-2xl rounded-r-xl border border-rose-500/35 bg-[#2a1212]/95 px-3 py-2 text-xs text-rose-100 shadow-xl transition hover:bg-[#341616]"
    >
      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500/25 px-1.5 text-[11px] font-semibold text-rose-50">
        {count}
      </span>
      <span>{t('异常素材', 'Media issues')}</span>
    </button>
  );
}

