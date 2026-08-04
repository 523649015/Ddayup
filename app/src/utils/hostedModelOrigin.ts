/**
 * 借道模型（hosted / 托管第三方模型）识别工具。
 *
 * 背景：后端 MODEL_CATALOG 里，阿里云百炼(bailian)、火山方舟(volcengine)、硅基流动(siliconflow)
 * 这三个国内聚合平台补登了大量「别家厂商」的模型（如 DeepSeek、Kimi、GLM、MiniMax）。
 * 由于 `isCatalogModelActivated` 只按 `item.provider` 判定激活（hmdao-api.mjs:15051），
 * 激活这三个平台之一时，它托管的第三方模型会一并点亮。
 *
 * 本模块只做「只读推导 + 展示文案」，不参与任何激活/路由判定，不改变现有逻辑。
 */

/** 承载第三方模型的国内聚合平台（只有这些平台上的模型才可能是「借道」） */
export const HOSTED_PLATFORM_IDS = ['bailian', 'volcengine', 'siliconflow'] as const;

export type HostedPlatformId = (typeof HOSTED_PLATFORM_IDS)[number];

const HOSTED_PLATFORM_LABELS: Record<HostedPlatformId, { zh: string; en: string; short: string }> = {
  bailian: { zh: '阿里云百炼', en: 'Bailian', short: '百炼' },
  volcengine: { zh: '火山方舟', en: 'Volcengine Ark', short: '火山方舟' },
  siliconflow: { zh: '硅基流动', en: 'SiliconFlow', short: '硅基流动' },
};

interface VendorRule {
  id: string;
  zh: string;
  en: string;
  /** 该厂商自己的直连 provider id（为空表示平台内没有对应直连入口） */
  nativeProviders: string[];
  match: RegExp;
}

/**
 * 顺序敏感：先匹配「明确的第三方厂商」，最后才匹配 qwen / doubao
 * （它们分别是百炼、火山的自家模型，放最后避免误判）。
 */
const VENDOR_RULES: VendorRule[] = [
  { id: 'deepseek', zh: 'DeepSeek', en: 'DeepSeek', nativeProviders: ['deepseek'], match: /deepseek/i },
  { id: 'moonshot', zh: '月之暗面 Kimi', en: 'Moonshot Kimi', nativeProviders: ['moonshot'], match: /kimi|moonshot/i },
  { id: 'zhipu', zh: '智谱 AI', en: 'Zhipu AI', nativeProviders: ['zhipu'], match: /(^|[^a-z])glm|zhipu|智谱/i },
  { id: 'minimax', zh: 'MiniMax', en: 'MiniMax', nativeProviders: ['minimax'], match: /minimax|abab/i },
  { id: 'stepfun', zh: '阶跃星辰', en: 'StepFun', nativeProviders: ['stepfun'], match: /(^|[^a-z])step-/i },
  { id: 'baichuan', zh: '百川智能', en: 'Baichuan', nativeProviders: ['baichuan'], match: /baichuan/i },
  { id: 'internlm', zh: '上海 AI 实验室', en: 'Shanghai AI Lab', nativeProviders: [], match: /internvl|internlm/i },
  { id: 'qwen', zh: '阿里通义', en: 'Alibaba Qwen', nativeProviders: ['bailian', 'dashscope', 'aliyun'], match: /qwen|tongyi|wanx|wan2|通义|万相/i },
  { id: 'doubao', zh: '字节豆包', en: 'ByteDance Doubao', nativeProviders: ['volcengine', 'ark'], match: /doubao|seedream|seedance|seed-|豆包/i },
];

export interface HostedModelOriginInput {
  id?: string | null;
  name?: string | null;
  provider?: string | null;
  description?: string | null;
  upstreamModel?: string | null;
  requiresEndpoint?: boolean | null;
  endpointHint?: string | null;
}

export interface HostedModelOrigin {
  /** 是否为「借道模型」：托管在聚合平台上的其它厂商模型 */
  hosted: boolean;
  /** 托管平台 id，例如 'bailian' */
  hostPlatformId: string;
  /** 托管平台中文短名，例如 '百炼' */
  hostPlatformShort: string;
  hostPlatformZh: string;
  hostPlatformEn: string;
  /** 原厂 id，例如 'deepseek'；无法判定时为空串 */
  originVendorId: string;
  originVendorZh: string;
  originVendorEn: string;
  /** 原厂自己的直连 provider id（可引导用户去直连），无则为空串 */
  originNativeProviderId: string;
  /** 徽标文案，例如「经百炼托管 · DeepSeek」 */
  badgeZh: string;
  badgeEn: string;
  /** 是否还需要额外配置推理接入点（火山方舟 ep-xxxx） */
  requiresEndpoint: boolean;
  /** 一句话说明，用于 tooltip / 提示行 */
  noticeZh: string;
  noticeEn: string;
}

function isHostedPlatform(providerId: string): providerId is HostedPlatformId {
  return (HOSTED_PLATFORM_IDS as readonly string[]).includes(providerId);
}

const EMPTY_ORIGIN: HostedModelOrigin = {
  hosted: false,
  hostPlatformId: '',
  hostPlatformShort: '',
  hostPlatformZh: '',
  hostPlatformEn: '',
  originVendorId: '',
  originVendorZh: '',
  originVendorEn: '',
  originNativeProviderId: '',
  badgeZh: '',
  badgeEn: '',
  requiresEndpoint: false,
  noticeZh: '',
  noticeEn: '',
};

/**
 * 纯函数：判断一个目录模型是否为借道模型，并生成展示文案。
 * 不读取任何 store / 网络状态，可直接在 Node 里做单元测试。
 */
export function resolveHostedModelOrigin(model: HostedModelOriginInput | null | undefined): HostedModelOrigin {
  if (!model) return EMPTY_ORIGIN;
  const providerId = String(model.provider || '').trim();
  if (!isHostedPlatform(providerId)) return EMPTY_ORIGIN;

  const haystack = [model.id, model.upstreamModel, model.name, model.description]
    .map((value) => String(value || ''))
    .join(' ');

  const vendor = VENDOR_RULES.find((rule) => rule.match.test(haystack));
  if (!vendor) return EMPTY_ORIGIN;
  // 厂商自己就是这个平台（如 万相 @ 百炼、Seedream @ 火山），不算借道
  if (vendor.nativeProviders.includes(providerId)) return EMPTY_ORIGIN;

  const platform = HOSTED_PLATFORM_LABELS[providerId];
  const requiresEndpoint = Boolean(model.requiresEndpoint);
  const badgeZh = `经${platform.short}托管 · ${vendor.zh}`;
  const badgeEn = `via ${platform.en} · ${vendor.en}`;
  const endpointZh = requiresEndpoint ? '；调用前需在该平台创建推理接入点（ep-xxxx）' : '';
  const endpointEn = requiresEndpoint ? '; requires an inference endpoint (ep-xxxx) on that platform' : '';

  return {
    hosted: true,
    hostPlatformId: providerId,
    hostPlatformShort: platform.short,
    hostPlatformZh: platform.zh,
    hostPlatformEn: platform.en,
    originVendorId: vendor.id,
    originVendorZh: vendor.zh,
    originVendorEn: vendor.en,
    originNativeProviderId: vendor.nativeProviders[0] || '',
    badgeZh,
    badgeEn,
    requiresEndpoint,
    noticeZh: `原厂为 ${vendor.zh}，此处由 ${platform.zh} 托管转发，激活 ${platform.short} 即可使用，无需单独接入 ${vendor.zh}${endpointZh}。`,
    noticeEn: `Built by ${vendor.en}, served through ${platform.en}. Activating ${platform.en} is enough — no separate ${vendor.en} key needed${endpointEn}.`,
  };
}

export interface HostedModelSummary {
  /** 借道模型总数 */
  hostedCount: number;
  /** 原生模型总数 */
  nativeCount: number;
  /** 按托管平台分组：platformId -> { short, vendors: 原厂中文名去重, count } */
  byPlatform: Array<{
    platformId: string;
    platformShort: string;
    platformZh: string;
    platformEn: string;
    count: number;
    vendorsZh: string[];
    vendorsEn: string[];
    requiresEndpointCount: number;
  }>;
}

/** 纯函数：对一组目录模型做借道统计，供概览提示条使用。 */
export function summarizeHostedModels(models: Array<HostedModelOriginInput | null | undefined>): HostedModelSummary {
  const grouped = new Map<string, HostedModelSummary['byPlatform'][number]>();
  let hostedCount = 0;
  let nativeCount = 0;

  for (const model of models) {
    const origin = resolveHostedModelOrigin(model);
    if (!origin.hosted) {
      nativeCount += 1;
      continue;
    }
    hostedCount += 1;
    const current = grouped.get(origin.hostPlatformId) || {
      platformId: origin.hostPlatformId,
      platformShort: origin.hostPlatformShort,
      platformZh: origin.hostPlatformZh,
      platformEn: origin.hostPlatformEn,
      count: 0,
      vendorsZh: [] as string[],
      vendorsEn: [] as string[],
      requiresEndpointCount: 0,
    };
    current.count += 1;
    if (origin.requiresEndpoint) current.requiresEndpointCount += 1;
    if (!current.vendorsZh.includes(origin.originVendorZh)) current.vendorsZh.push(origin.originVendorZh);
    if (!current.vendorsEn.includes(origin.originVendorEn)) current.vendorsEn.push(origin.originVendorEn);
    grouped.set(origin.hostPlatformId, current);
  }

  return {
    hostedCount,
    nativeCount,
    byPlatform: Array.from(grouped.values()).sort((a, b) => b.count - a.count),
  };
}
