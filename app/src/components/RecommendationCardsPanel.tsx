import { SourceBadge } from '@/components/SourceBadge';
import type { NodeModelRecommendationCard } from '@/components/NodeModelBrowser';

export function RecommendationCardsPanel({
  title,
  subtitle,
  cards,
  testId,
}: {
  title?: string;
  subtitle?: string;
  cards?: Array<NodeModelRecommendationCard | null>;
  testId?: string;
}) {
  const visibleCards = (cards || []).filter(Boolean);
  if (visibleCards.length === 0) return null;

  const normalizedTitle = testId === 'api-runtime-recommendation-panel'
    ? '按任务推荐模型'
    : title;
  const normalizedSubtitle = testId === 'api-runtime-recommendation-panel'
    ? '直接读取 runtime 返回的首推、备选和任务标签，让用户不用手动猜模型。'
    : subtitle;

  return (
    <div data-testid={testId} className="space-y-3 rounded-2xl border border-[#30363d] bg-[#0d1117] p-3">
      {normalizedTitle || normalizedSubtitle ? (
        <div>
          {normalizedTitle ? <div className="text-sm font-semibold text-[#eef3f8]">{normalizedTitle}</div> : null}
          {normalizedSubtitle ? <div className="mt-1 text-[11px] leading-5 text-[#8ea0b2]">{normalizedSubtitle}</div> : null}
        </div>
      ) : null}

      <div className="grid gap-2">
        {visibleCards.map((card) => (
          <article key={card!.id} className="rounded-xl border border-[#353b42] bg-[#171b20] px-3 py-2.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-xs font-semibold text-[#eef3f8]">{card!.title}</div>
                <div className="mt-1 text-[11px] leading-5 text-[#90a0ae]">{card!.summary}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {(card!.badges || []).filter(Boolean).map((badge) => (
                  <SourceBadge key={`${card!.id}-${badge!.label}`} label={badge!.label} tone={badge!.tone || 'neutral'} />
                ))}
              </div>
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

            {card!.primary ? (
              <div className="mt-2 rounded-lg border border-[#2d3741] bg-[#11161a] px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  {(card!.primary.badges || []).filter(Boolean).map((badge) => (
                    <SourceBadge key={`${card!.primary!.id}-${badge!.label}`} label={badge!.label} tone={badge!.tone || 'neutral'} />
                  ))}
                </div>
                <div className="mt-1 text-[11px] font-medium text-[#eef3f8]">{card!.primary.title}</div>
                {(card!.primary.providerLabel || card!.primary.modelLabel) ? (
                  <div className="mt-1 text-[11px] text-[#72e4d2]">
                    {[card!.primary.providerLabel, card!.primary.modelLabel].filter(Boolean).join(' 路 ')}
                  </div>
                ) : null}
                {card!.primary.meta?.length ? (
                  <div className="mt-1 text-[10px] leading-5 text-[#8ea0b2]">
                    {card!.primary.meta.join(' 路 ')}
                  </div>
                ) : null}
              </div>
            ) : null}

            {card!.alternates?.length ? (
              <div className="mt-2 rounded-lg border border-dashed border-[#2d3741] bg-[#11161a] px-2.5 py-2">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#8a98a8]">备选模型</div>
                <div className="mt-1 space-y-1.5">
                  {card!.alternates.map((candidate) => (
                    <div key={candidate.id} className="rounded-md bg-[#171c21] px-2 py-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        {(candidate.badges || []).filter(Boolean).map((badge) => (
                          <SourceBadge key={`${candidate.id}-${badge!.label}`} label={badge!.label} tone={badge!.tone || 'neutral'} />
                        ))}
                      </div>
                      <div className="mt-1 text-[11px] font-medium text-[#dce5ee]">{candidate.title}</div>
                      {(candidate.providerLabel || candidate.modelLabel) ? (
                        <div className="mt-1 text-[10px] text-[#72e4d2]">
                          {[candidate.providerLabel, candidate.modelLabel].filter(Boolean).join(' 路 ')}
                        </div>
                      ) : null}
                      {candidate.meta?.length ? (
                        <div className="mt-1 text-[10px] leading-5 text-[#7f90a0]">{candidate.meta.join(' 路 ')}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
