import type {
  ByokRuntimeRecommendationCandidate,
  ByokRuntimeRecommendationSummary,
  ByokRuntimeTaskRecommendation,
} from '@/api/byok';
import type {
  NodeModelRecommendationCard,
  NodeModelRecommendationCardCandidate,
} from '@/components/NodeModelBrowser';
import type { SourceBadgeTone } from '@/components/SourceBadge';

function relayBadge(relaySource?: string | null) {
  if (!relaySource) return null;
  return {
    label: relaySource === 'Comfly'
      ? 'via Comfly'
      : relaySource === 'Suanliai'
        ? 'via Suanliai'
        : 'via Relay',
    tone: 'relay' as const,
  };
}

function pricingMeta(candidate?: ByokRuntimeRecommendationCandidate | null) {
  if (!candidate) return null;
  if (candidate.pricingSummary) return candidate.pricingSummary;
  if (typeof candidate.price === 'number') {
    const currency = String(candidate.currency || 'CNY').toUpperCase();
    const unit = candidate.priceUnit ? ` / ${candidate.priceUnit}` : '';
    return `${currency} ${candidate.price}${unit}`;
  }
  return null;
}

function mapCandidate(
  candidate: ByokRuntimeRecommendationCandidate | null | undefined,
  emphasisLabel: string,
  emphasisTone: SourceBadgeTone,
): NodeModelRecommendationCardCandidate | null {
  if (!candidate) return null;
  return {
    id: candidate.id,
    title: candidate.title || candidate.model || candidate.id,
    providerLabel: candidate.providerLabel || candidate.provider,
    modelLabel: candidate.model,
    badges: [
      { label: emphasisLabel, tone: emphasisTone },
      relayBadge(candidate.relaySource),
    ].filter(Boolean) as Array<{ label: string; tone?: SourceBadgeTone }>,
    meta: [
      candidate.recommendation || '',
      pricingMeta(candidate) || '',
    ].filter(Boolean),
  };
}

export function summaryToRecommendationCard(
  summary: ByokRuntimeRecommendationSummary | null | undefined,
  options?: {
    fallbackTitle?: string;
    purposeLabel?: string;
    purposeTone?: SourceBadgeTone;
  },
): NodeModelRecommendationCard | null {
  if (!summary) return null;

  const primaryCandidate = summary.primary || {
    id: summary.model || summary.key,
    provider: summary.provider,
    providerLabel: summary.providerLabel,
    mode: summary.mode,
    model: summary.model,
    title: summary.model || summary.title,
    relaySource: summary.relaySource,
    price: summary.price,
    currency: summary.currency,
    priceUnit: summary.priceUnit,
    pricingSummary: summary.pricingSummary,
    recommendation: summary.recommendation,
  };

  return {
    id: summary.key,
    title: summary.title || options?.fallbackTitle || summary.key,
    summary: summary.summary || summary.recommendation || '',
    tags: summary.tags || [],
    badges: [
      relayBadge(summary.relaySource),
      options?.purposeLabel ? { label: options.purposeLabel, tone: options.purposeTone || 'recommended' } : null,
    ].filter(Boolean) as Array<{ label: string; tone?: SourceBadgeTone }>,
    primary: mapCandidate(primaryCandidate, '首推', 'recommended'),
    alternates: (summary.alternates || summary.candidates || [])
      .filter((candidate) => candidate.id !== primaryCandidate.id || candidate.model !== primaryCandidate.model)
      .slice(0, 2)
      .map((candidate) => mapCandidate(candidate, '备选', 'api'))
      .filter(Boolean) as NodeModelRecommendationCardCandidate[],
  };
}

export function taskToRecommendationCard(
  task: ByokRuntimeTaskRecommendation | null | undefined,
  options?: {
    purposeLabel?: string;
    purposeTone?: SourceBadgeTone;
  },
): NodeModelRecommendationCard | null {
  if (!task) return null;

  return {
    id: task.id,
    title: task.title,
    summary: task.summary,
    tags: task.tags || [],
    badges: [
      options?.purposeLabel ? { label: options.purposeLabel, tone: options.purposeTone || 'recommended' } : null,
    ].filter(Boolean) as Array<{ label: string; tone?: SourceBadgeTone }>,
    primary: mapCandidate(task.primary || task.candidates?.[0], '首推', 'recommended'),
    alternates: (task.alternates || task.candidates?.slice(1) || [])
      .slice(0, 2)
      .map((candidate) => mapCandidate(candidate, '备选', 'api'))
      .filter(Boolean) as NodeModelRecommendationCardCandidate[],
  };
}

export function findRecommendationTask(
  summary: ByokRuntimeRecommendationSummary | null | undefined,
  taskId: string,
): ByokRuntimeTaskRecommendation | null {
  if (!summary?.tasks?.length) return null;
  return summary.tasks.find((task) => task.id === taskId) || null;
}
