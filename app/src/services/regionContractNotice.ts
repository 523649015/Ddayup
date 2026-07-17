import type { RegionPackContract, RegionSpec } from '@/types';
import { summarizeRegionContract } from '@/services/regionContracts';

function summarizeRegionLine(region: RegionSpec) {
  const label = String(region.label || '').trim() || '未命名标签';
  const description = String(region.description || '').trim();
  return description ? `${label}：${description}` : label;
}

export function buildVerboseRegionContractNotice(contract: RegionPackContract | null | undefined, recommendedModel = '') {
  if (!contract) return '';
  const summary = summarizeRegionContract(contract);
  const detail = contract.regions
    .filter((region) => region.enabled !== false)
    .slice(0, 2)
    .map(summarizeRegionLine)
    .join('；');
  const baseNotice = detail ? `${summary}。${detail}` : summary;
  return recommendedModel
    ? `${baseNotice} · 将优先切换到 ${recommendedModel}`
    : baseNotice;
}
