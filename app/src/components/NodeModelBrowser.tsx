import type { ReactNode } from 'react';
import { AudioLines, BrainCircuit, Image as ImageIcon, Video } from 'lucide-react';
import { SourceBadge, type SourceBadgeTone } from '@/components/SourceBadge';

type BrowserBadge = { label: string; tone?: SourceBadgeTone } | null;

export interface NodeModelRecommendationCardCandidate {
  id: string;
  title: string;
  providerLabel?: string;
  modelLabel?: string;
  badges?: BrowserBadge[];
  meta?: Array<string>;
}

export interface NodeModelRecommendationCard {
  id: string;
  title: string;
  summary: string;
  providerLabel?: string;
  modelLabel?: string;
  badges?: BrowserBadge[];
  tags?: string[];
  primary?: NodeModelRecommendationCardCandidate | null;
  alternates?: NodeModelRecommendationCardCandidate[];
}

export interface NodeModelBrowserItem {
  id: string;
  title: string;
  providerLabel?: string;
  modelLabel?: string;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  badges?: BrowserBadge[];
  meta?: Array<string>;
  kind?: 'image' | 'video' | 'audio' | 'llm';
}

export interface NodeModelBrowserSection {
  id: string;
  title: string;
  hint?: string;
  items: NodeModelBrowserItem[];
  emptyMessage?: string;
}

function sectionCountLabel(count: number) {
  return `${count} \u9879`;
}

function kindIcon(kind?: NodeModelBrowserItem['kind']): ReactNode {
  if (kind === 'video') return <Video className="h-4 w-4" />;
  if (kind === 'audio') return <AudioLines className="h-4 w-4" />;
  if (kind === 'llm') return <BrainCircuit className="h-4 w-4" />;
  return <ImageIcon className="h-4 w-4" />;
}

function BadgeRow({ badges }: { badges?: BrowserBadge[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {(badges || []).filter(Boolean).map((badge) => (
        <SourceBadge key={badge!.label} label={badge!.label} tone={badge!.tone || 'neutral'} />
      ))}
    </div>
  );
}

function RecommendationCandidateBlock({
  candidate,
  dashed = false,
}: {
  candidate: NodeModelRecommendationCardCandidate;
  dashed?: boolean;
}) {
  return (
    <div className={`rounded-lg ${dashed ? 'border border-dashed border-[#2d3741]' : 'border border-[#2d3741]'} bg-[#11161a] px-2.5 py-2`}>
      <BadgeRow badges={candidate.badges} />
      <div className="mt-1 text-[11px] font-medium text-[#eef3f8]">{candidate.title}</div>
      {(candidate.providerLabel || candidate.modelLabel) ? (
        <div className="mt-1 text-[11px] text-[#72e4d2]">
          {[candidate.providerLabel, candidate.modelLabel].filter(Boolean).join(' · ')}
        </div>
      ) : null}
      {candidate.meta?.length ? (
        <div className="mt-1 text-[10px] leading-5 text-[#8ea0b2]">{candidate.meta.join(' · ')}</div>
      ) : null}
    </div>
  );
}

export function NodeModelBrowser({
  title,
  subtitle,
  recommendations,
  sections,
  onSelect,
  testId,
  itemTestIdPrefix,
}: {
  title: string;
  subtitle?: string;
  recommendations?: Array<NodeModelRecommendationCard | null>;
  sections: NodeModelBrowserSection[];
  onSelect?: (item: NodeModelBrowserItem) => void;
  testId?: string;
  itemTestIdPrefix?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="w-[min(96vw,680px)] max-w-full rounded-xl bg-[#242424] p-3 shadow-2xl ring-1 ring-[#4b4b4b]"
    >
      <div className="mb-3">
        <div className="text-sm font-semibold text-[#f4f4f4]">{title}</div>
        {subtitle ? (
          <div className="mt-1 text-[11px] leading-5 text-[#9ca9b6]">{subtitle}</div>
        ) : null}
      </div>

      {recommendations && recommendations.length > 0 ? (
        <div className="mb-3 grid gap-2">
          {recommendations.filter(Boolean).map((card) => (
            <div key={card!.id} className="rounded-xl border border-[#353b42] bg-[#171b20] px-3 py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold text-[#eef3f8]">{card!.title}</div>
                  <div className="mt-1 text-[11px] leading-5 text-[#90a0ae]">{card!.summary}</div>
                </div>
                <BadgeRow badges={card!.badges} />
              </div>

              {card!.tags?.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {card!.tags.map((tag) => (
                    <span
                      key={`${card!.id}-${tag}`}
                      className="rounded-full border border-[#31404e] bg-[#14191e] px-2 py-0.5 text-[10px] text-[#9bc8ff]"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}

              {card!.primary || card!.alternates?.length ? (
                <div className="mt-2 space-y-2">
                  {card!.primary ? <RecommendationCandidateBlock candidate={card!.primary} /> : null}
                  {card!.alternates?.length ? (
                    <div className="rounded-lg border border-dashed border-[#2d3741] bg-[#11161a] px-2.5 py-2">
                      <div className="text-[10px] uppercase tracking-[0.16em] text-[#8a98a8]">{'\u5907\u9009\u6a21\u578b'}</div>
                      <div className="mt-1 space-y-1.5">
                        {card!.alternates.map((candidate) => (
                          <RecommendationCandidateBlock key={candidate.id} candidate={candidate} dashed />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (card!.providerLabel || card!.modelLabel) ? (
                <div className="mt-2 text-[11px] text-[#72e4d2]">
                  {[card!.providerLabel, card!.modelLabel].filter(Boolean).join(' · ')}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="max-h-[68vh] space-y-3 overflow-y-auto pr-1">
        {sections.map((section) => (
          <section key={section.id} className="space-y-2 rounded-xl border border-[#313943] bg-[#171b20] p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8a98a8]">{section.title}</div>
                {section.hint ? (
                  <div className="mt-1 text-[11px] leading-5 text-[#667585]">{section.hint}</div>
                ) : null}
              </div>
              <span className="shrink-0 rounded-full border border-[#31404e] bg-[#14191e] px-2 py-0.5 text-[10px] text-[#9bc8ff]">
                {sectionCountLabel(section.items.length)}
              </span>
            </div>

            {section.items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[#353b42] bg-[#171b20] px-3 py-3 text-[11px] leading-5 text-[#7d8b99]">
                {section.emptyMessage || '\u5f53\u524d\u8fd8\u6ca1\u6709\u53ef\u663e\u793a\u7684\u6a21\u578b\u3002'}
              </div>
            ) : (
              <div className="space-y-2">
                {section.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      if (!item.disabled) onSelect?.(item);
                    }}
                    disabled={item.disabled}
                    data-testid={itemTestIdPrefix ? `${itemTestIdPrefix}-${item.id}` : undefined}
                    title={item.description || ''}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      item.disabled
                        ? 'cursor-not-allowed border-transparent opacity-45'
                        : item.disabledReason
                          ? 'border-amber-500/25 bg-[#2b2418] hover:bg-[#33281a]'
                          : item.selected
                            ? 'border-[#666] bg-[#555]'
                            : 'border-transparent hover:bg-[#333]'
                    }`}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#4a4a4a] text-[#efefef]">
                      {kindIcon(item.kind)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-[#f4f4f4]">{item.title}</span>
                      {(item.providerLabel || item.modelLabel) ? (
                        <span className="block truncate text-[11px] text-[#72e4d2]">
                          {[item.providerLabel, item.modelLabel].filter(Boolean).join(' · ')}
                        </span>
                      ) : null}
                      {item.disabledReason ? (
                        <span className={`mt-1 block text-[11px] ${item.disabled ? 'text-rose-300' : 'text-amber-300'}`}>
                          {item.disabledReason}
                        </span>
                      ) : null}
                      {(item.badges?.length || item.meta?.length) ? (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <BadgeRow badges={item.badges} />
                          {(item.meta || []).map((meta) => (
                            <span key={`${item.id}-${meta}`} className="text-[10px] text-[#f1d39f]">{meta}</span>
                          ))}
                        </div>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
