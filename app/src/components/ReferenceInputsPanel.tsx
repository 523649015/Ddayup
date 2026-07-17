import { useMemo, useState } from 'react';
import type { ConnectedReferenceInput, ReferenceBindingCandidate } from '@/lib/nodeReferenceGraph';

function stopCanvasInteraction(event: { preventDefault?: () => void; stopPropagation: () => void }) {
  event.stopPropagation();
}

export interface ReferenceBindingSection {
  key: string;
  label: string;
  description: string;
  emptyText: string;
  applyLabel: string;
  candidates: ReferenceBindingCandidate[];
}

function bindingCandidateKey(candidate: ReferenceBindingCandidate) {
  return `${candidate.sourceNodeId}:${candidate.type}`;
}

export function mediaTypeLabel(type: ConnectedReferenceInput['type']) {
  if (type === 'video') return '视频';
  if (type === 'image') return '图片';
  if (type === 'audio') return '音频';
  return '文本';
}

export function referenceRoleLabel(role: ConnectedReferenceInput['role']) {
  if (role === 'primary') return '主素材';
  if (role === 'subject') return '主体参考';
  if (role === 'omni') return '全能参考';
  if (role === 'style') return '风格参考';
  if (role === 'composition') return '构图参考';
  if (role === 'lighting') return '光影参考';
  if (role === 'motion') return '运镜参考';
  if (role === 'rhythm') return '节奏参考';
  if (role === 'element') return '元素参考';
  return role;
}

function referenceRoleTone(role: ConnectedReferenceInput['role']) {
  if (role === 'primary') return 'border-[#3b4a55] bg-[#1c242b] text-[#d7e9f7]';
  if (role === 'subject') return 'border-[#315f57] bg-[#18332d] text-[#aaf2df]';
  if (role === 'omni') return 'border-[#6b4c25] bg-[#302111] text-[#f6d089]';
  if (role === 'motion' || role === 'rhythm') return 'border-[#3a4474] bg-[#1b2240] text-[#b8c7ff]';
  return 'border-[#4a4a4a] bg-[#2b2b2b] text-[#d9d9d9]';
}

function sourceTypeLabel(item: Pick<ConnectedReferenceInput, 'type' | 'sourceNodeType'>) {
  return `${mediaTypeLabel(item.type)}来源 · ${item.sourceNodeType}`;
}

function looksCorruptedLabel(value: string) {
  return /[�]|(?:é.|å.|æ.)/.test(value);
}

function fallbackSourceLabel(item: Pick<ConnectedReferenceInput, 'role' | 'type'>) {
  if (item.role === 'primary') return `${mediaTypeLabel(item.type)}主素材`;
  return referenceRoleLabel(item.role);
}

function displaySourceLabel(item: Pick<ConnectedReferenceInput, 'sourceNodeLabel' | 'role' | 'type'>) {
  const label = String(item.sourceNodeLabel || '').trim();
  if (!label || looksCorruptedLabel(label)) return fallbackSourceLabel(item);
  return label;
}

export function ReferenceConditioningSummary({
  nodeId,
  primaryInputs,
  references,
  className = '',
}: {
  nodeId: string;
  primaryInputs: ConnectedReferenceInput[];
  references: ConnectedReferenceInput[];
  className?: string;
}) {
  if (primaryInputs.length === 0 && references.length === 0) return null;

  return (
    <div
      data-testid={`reference-conditioning-summary-${nodeId}`}
      className={`rounded-xl border border-[#3c4248] bg-[#1b1f24] p-3 ${className}`.trim()}
      onPointerDown={stopCanvasInteraction}
      onMouseDown={stopCanvasInteraction}
      onTouchStart={stopCanvasInteraction}
      onWheel={stopCanvasInteraction}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-[#f2f5f7]">当前参考链路</div>
          <div className="mt-1 text-[11px] leading-5 text-[#9ea7b3]">
            主素材 {primaryInputs.length} 路 · 参考素材 {references.length} 路
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-2">
        {primaryInputs.map((item, index) => (
          <div
            key={item.key}
            data-testid={`reference-conditioning-summary-primary-${nodeId}-${index}`}
            className="rounded-lg border border-[#36404a] bg-[#161a1f] px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-[#eef3f8]">{displaySourceLabel(item)}</div>
                <div className="mt-1 text-[11px] text-[#8ea0b2]">{sourceTypeLabel(item)}</div>
              </div>
              <span className={`rounded-full border px-2.5 py-1 text-[10px] ${referenceRoleTone('primary')}`}>
                主素材
              </span>
            </div>
          </div>
        ))}

        {references.map((item, index) => (
          <div
            key={item.key}
            data-testid={`reference-conditioning-summary-reference-${nodeId}-${index}`}
            className="rounded-lg border border-[#36404a] bg-[#161a1f] px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-[#eef3f8]">{displaySourceLabel(item)}</div>
                <div className="mt-1 text-[11px] text-[#8ea0b2]">{sourceTypeLabel(item)}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2.5 py-1 text-[10px] ${referenceRoleTone(item.role)}`}>
                  {referenceRoleLabel(item.role)}
                </span>
                <span className="rounded-full border border-[#454b51] bg-[#262b31] px-2.5 py-1 text-[10px] text-[#c7d2dd]">
                  权重 {item.weight}
                </span>
                <span className={`rounded-full border px-2.5 py-1 text-[10px] ${item.enabled ? 'border-[#315f57] bg-[#18332d] text-[#aaf2df]' : 'border-[#4a4a4a] bg-[#2b2b2b] text-[#9da6af]'}`}>
                  {item.enabled ? '已启用' : '已停用'}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReferenceInputsPanel({
  nodeId,
  title,
  hint,
  primaryInputs,
  references,
  bindingSections = [],
  onRoleChange,
  onWeightChange,
  onEnabledChange,
  onBindInput,
  onRemoveInput,
}: {
  nodeId: string;
  title: string;
  hint: string;
  primaryInputs: ConnectedReferenceInput[];
  references: ConnectedReferenceInput[];
  bindingSections?: ReferenceBindingSection[];
  onRoleChange: (key: string, role: ConnectedReferenceInput['role']) => void;
  onWeightChange: (key: string, weight: number) => void;
  onEnabledChange: (key: string, enabled: boolean) => void;
  onBindInput?: (sectionKey: string, candidate: ReferenceBindingCandidate) => void;
  onRemoveInput?: (key: string) => void;
}) {
  const [selectedCandidates, setSelectedCandidates] = useState<Record<string, string>>({});

  const candidatesBySection = useMemo(() => {
    const map = new Map<string, Map<string, ReferenceBindingCandidate>>();
    for (const section of bindingSections) {
      map.set(section.key, new Map(section.candidates.map((candidate) => [bindingCandidateKey(candidate), candidate])));
    }
    return map;
  }, [bindingSections]);

  return (
    <div
      className="nodrag nopan nowheel mx-4 mb-3 rounded-xl border border-[#404040] bg-[#202020] p-3"
      onPointerDown={stopCanvasInteraction}
      onMouseDown={stopCanvasInteraction}
      onTouchStart={stopCanvasInteraction}
      onWheel={stopCanvasInteraction}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[#f3f3f3]">{title}</div>
          <div className="mt-1 text-xs leading-5 text-[#a9a9a9]">{hint}</div>
        </div>
        <span className="rounded-full bg-[#323232] px-2.5 py-1 text-[11px] text-[#c9c9c9]">
          主素材 {primaryInputs.length} 路 · 参考 {references.length} 路
        </span>
      </div>

      <ReferenceConditioningSummary
        nodeId={`${nodeId}-panel`}
        primaryInputs={primaryInputs}
        references={references}
        className="mt-3"
      />

      {bindingSections.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {bindingSections.map((section) => {
            const fallbackCandidate = section.candidates[0] || {
              sourceNodeId: '',
              sourceNodeLabel: '',
              sourceNodeType: 'image' as const,
              type: 'image' as const,
              url: '',
            };
            const selectedKey = selectedCandidates[section.key] || bindingCandidateKey(fallbackCandidate);
            const selectedCandidate = candidatesBySection.get(section.key)?.get(selectedKey) || section.candidates[0] || null;
            return (
              <div key={section.key} className="rounded-lg border border-[#454545] bg-[#262626] px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[#f0f0f0]">{section.label}</div>
                    <div className="mt-1 text-[11px] text-[#9a9a9a]">{section.description}</div>
                  </div>
                  <button
                    type="button"
                    data-testid={`reference-bind-apply-${nodeId}-${section.key}`}
                    disabled={!selectedCandidate || !onBindInput}
                    onClick={() => {
                      if (!selectedCandidate || !onBindInput) return;
                      onBindInput(section.key, selectedCandidate);
                    }}
                    className="rounded-md border border-[#4a4a4a] px-3 py-1.5 text-xs text-[#f1f1f1] hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {section.applyLabel}
                  </button>
                </div>
                {section.candidates.length > 0 ? (
                  <label className="mt-3 grid gap-1 text-xs text-[#d9d9d9]">
                    <span>画布素材</span>
                    <select
                      data-testid={`reference-bind-select-${nodeId}-${section.key}`}
                      value={selectedKey}
                      onChange={(event) => setSelectedCandidates((current) => ({ ...current, [section.key]: event.target.value }))}
                      className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-2 outline-none"
                    >
                      {section.candidates.map((candidate) => (
                        <option key={bindingCandidateKey(candidate)} value={bindingCandidateKey(candidate)}>
                          {candidate.sourceNodeLabel} · {mediaTypeLabel(candidate.type)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div className="mt-3 rounded-md border border-dashed border-[#4a4a4a] px-3 py-2 text-xs text-[#9a9a9a]">
                    {section.emptyText}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="mt-3 grid gap-2">
        {primaryInputs.length > 0 ? (
          <div className="rounded-lg border border-[#454545] bg-[#262626] px-3 py-2 text-xs text-[#d6d6d6]">
            <div className="mb-1 text-[11px] uppercase tracking-[0.16em] text-[#8f8f8f]">主素材输入</div>
            <div className="flex flex-wrap gap-2">
              {primaryInputs.map((item) => (
                <span key={item.key} className="inline-flex items-center gap-2 rounded-full bg-[#343434] px-2.5 py-1 text-[11px] text-[#e6e6e6]">
                  <span>{displaySourceLabel(item)} · {mediaTypeLabel(item.type)}</span>
                  {item.isManualBinding && onRemoveInput ? (
                    <button
                      type="button"
                      data-testid={`reference-remove-${nodeId}-${item.key}`}
                      onClick={() => onRemoveInput(item.key)}
                      className="rounded-full bg-[#454545] px-1.5 py-0.5 text-[10px] text-white hover:bg-[#5a5a5a]"
                    >
                      移除
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {references.length > 0 ? (
          references.map((item, index) => (
            <div
              key={item.key}
              data-testid={`reference-card-${nodeId}-${index}`}
              className="rounded-lg border border-[#454545] bg-[#262626] px-3 py-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-[#f0f0f0]">{displaySourceLabel(item)}</div>
                  <div className="mt-1 text-[11px] text-[#9a9a9a]">
                    {mediaTypeLabel(item.type)}参考 · {item.sourceNodeType}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {item.isManualBinding && onRemoveInput ? (
                    <button
                      type="button"
                      data-testid={`reference-remove-${nodeId}-${item.key}`}
                      onClick={() => onRemoveInput(item.key)}
                      className="rounded-md border border-[#4a4a4a] px-2 py-1 text-[11px] text-[#d8d8d8] hover:bg-[#333]"
                    >
                      移除
                    </button>
                  ) : null}
                  <label className="flex items-center gap-2 text-xs text-[#d7d7d7]">
                    <span>启用</span>
                    <input
                      data-testid={`reference-enabled-${nodeId}-${index}`}
                      type="checkbox"
                      checked={item.enabled}
                      onChange={(event) => onEnabledChange(item.key, event.target.checked)}
                    />
                  </label>
                </div>
              </div>

              <div className="mt-3 grid gap-2 md:grid-cols-[160px_1fr_60px]">
                <label className="grid gap-1 text-xs text-[#d9d9d9]">
                  <span>用途</span>
                  <select
                    data-testid={`reference-role-${nodeId}-${index}`}
                    value={item.role}
                    onChange={(event) => onRoleChange(item.key, event.target.value as ConnectedReferenceInput['role'])}
                    className="rounded-md border border-[#444] bg-[#1f1f1f] px-2 py-1 outline-none"
                  >
                    {item.roleOptions.map((option) => (
                      <option key={option.value} value={option.value}>{referenceRoleLabel(option.value)}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs text-[#d9d9d9]">
                  <span>权重</span>
                  <input
                    data-testid={`reference-weight-${nodeId}-${index}`}
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={item.weight}
                    onChange={(event) => onWeightChange(item.key, Number(event.target.value))}
                  />
                </label>
                <div className="flex items-end justify-end text-sm font-semibold text-[#9ee6d9]">{item.weight}</div>
              </div>
            </div>
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-[#4a4a4a] px-3 py-4 text-xs text-[#9a9a9a]">
            暂无参考连线或手动绑定。你可以从上方画布素材里依次添加主素材、主体参考和光影/风格参考，逐步搭好更稳定的条件链。
          </div>
        )}
      </div>
    </div>
  );
}
