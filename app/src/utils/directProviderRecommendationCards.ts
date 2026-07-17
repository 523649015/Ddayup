import {
  getDirectRecommendationTasks,
  getLocalizedTaskTags,
  getProviderGuide,
  type DirectRecommendationEntryPoint,
  type OfficialModelPreset,
  type ProviderGuideMode,
} from '@/config/providerGuides';
import type {
  NodeModelRecommendationCard,
  NodeModelRecommendationCardCandidate,
} from '@/components/NodeModelBrowser';

function localizeText(isZh: boolean, zh: string | undefined, en: string | undefined) {
  return (isZh ? zh : en) || zh || en || '';
}

function mapCandidate(
  preset: OfficialModelPreset | null | undefined,
  providerLabel: string,
  isZh: boolean,
  emphasisLabel: string,
  emphasisTone: 'recommended' | 'api',
): NodeModelRecommendationCardCandidate | null {
  if (!preset) return null;
  return {
    id: `${preset.id}:${preset.model}`,
    title: localizeText(isZh, preset.labelZh, preset.labelEn) || preset.model,
    providerLabel,
    modelLabel: preset.model,
    badges: [{ label: emphasisLabel, tone: emphasisTone }],
    meta: [localizeText(isZh, preset.noteZh, preset.noteEn)].filter(Boolean),
  };
}

export function getDirectRecommendationCards(
  providerId: string,
  mode: ProviderGuideMode,
  isZh: boolean,
  entryPoint?: DirectRecommendationEntryPoint,
): NodeModelRecommendationCard[] {
  const guide = getProviderGuide(providerId);
  if (!guide) return [];

  return getDirectRecommendationTasks(providerId, mode, entryPoint).map((task) => ({
    id: `${providerId}:${mode}:${task.id}`,
    title: localizeText(isZh, task.titleZh, task.titleEn),
    summary: localizeText(isZh, task.summaryZh, task.summaryEn),
    tags: getLocalizedTaskTags(task, isZh),
    badges: [
      { label: isZh ? '官方直连' : 'Official direct', tone: 'api' as const },
      { label: guide.officialName, tone: 'neutral' as const },
    ],
    primary: mapCandidate(task.primary, guide.officialName, isZh, isZh ? '首推' : 'Primary', 'recommended'),
    alternates: (task.alternates || [])
      .map((item) => mapCandidate(item, guide.officialName, isZh, isZh ? '备选' : 'Alternate', 'api'))
      .filter(Boolean) as NodeModelRecommendationCardCandidate[],
  }));
}
