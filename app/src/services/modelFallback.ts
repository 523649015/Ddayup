/**
 * modelFallback.ts — 智能机器人模型回退服务
 *
 * 核心目标（用户需求）：
 *   免费模型不能支持当前用户的任务时，自动切换到「能支持任务的模型」，按优先级执行。
 *
 * 两个层面：
 *   1) 规划期能力选择（resolveModelForTask）：免费优先，若免费模型不满足任务能力要求，
 *      自动回退到「下一个有能力、按优先级排列」的付费模型，并给出可读原因。
 *   2) 运行期错误回退（executeWithModelFallback）：执行某模型失败（报错/403/超时）时，
 *      按优先级尝试下一个有能力候选，记录每次尝试。
 *
 * 能力匹配复用 workflowGraph.evaluateModelCapabilitySupport（项目现成真源），
 * 回退候选链（FREE_FIRST_CHAINS）按「免费/便宜优先 → 能力强」排序，数据为真实模型。
 */

import {
  evaluateModelCapabilitySupport,
} from './workflowGraph';
import type { NodeType, ModelCapabilityMatrix, WorkflowCapabilityRequirement } from '@/types';

export interface ModelCandidate {
  id: string;
  provider: string;
  model: string;
  /** 该模型是否免费额度可用（决定是否免费优先） */
  isFree: boolean;
  label?: string;
  capabilities?: ModelCapabilityMatrix;
}

export interface ModelResolution {
  provider: string;
  model: string;
  modelId: string;
  isFree: boolean;
  /** 是否发生过「免费模型不满足能力 → 切换到付费模型」 */
  autoSwitched: boolean;
  /** 人类可读决策原因，便于面板展示与排错 */
  reason: string;
  /** 当前任务类型下，满足能力要求的候选总数 */
  capableCount: number;
  /** 其中免费的候选数 */
  freeCapableCount: number;
  /** 实际使用的候选在优先级链中的下标（0 表示首选） */
  chosenIndex: number;
  /** 完整回退链（已按能力过滤），供下游运行时回退消费 */
  fallbackChain: ModelCandidate[];
}

/**
 * 各任务类型的按优先级模型回退链（免费优先，其次能力强）。
 * 数据基于项目已知的免费额度模型（TokenHub / DeepSeek / SiliconFlow）与付费高质量模型。
 */
export const FREE_FIRST_CHAINS: Record<string, ModelCandidate[]> = {
  // 文本 / 脚本 / 分镜脚本：需要 textToText
  text: [
    { id: 'deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', isFree: true, label: 'DeepSeek 免费', capabilities: { generationModes: ['textToText'] } },
    { id: 'deepseek-v4-flash', provider: 'tokenhub', model: 'deepseek-v4-flash', isFree: true, label: '腾讯 TokenHub 免费', capabilities: { generationModes: ['textToText'] } },
    { id: 'qwen3.5-flash', provider: 'tokenhub', model: 'qwen3.5-flash', isFree: true, label: '通义千问免费', capabilities: { generationModes: ['textToText'] } },
    { id: 'glm-5.2', provider: 'tokenhub', model: 'glm-5.2', isFree: true, label: '智谱免费', capabilities: { generationModes: ['textToText'] } },
    { id: 'hy3', provider: 'tokenhub', model: 'hy3', isFree: true, label: '混元免费', capabilities: { generationModes: ['textToText'] } },
    { id: 'gpt-4o', provider: 'openai', model: 'gpt-4o', isFree: false, label: 'GPT-4o', capabilities: { generationModes: ['textToText'] } },
    { id: 'gpt-4.1', provider: 'openai', model: 'gpt-4.1', isFree: false, label: 'GPT-4.1 高保真', capabilities: { generationModes: ['textToText'] } },
  ],
  // 图片：需要 textToImage；含参考图需求时还需 imageToImage + referenceRoles
  image: [
    { id: 'qwen-image', provider: 'siliconflow', model: 'Qwen/Qwen-Image', isFree: true, label: '硅基流动免费文生图', capabilities: { generationModes: ['textToImage', 'imageToImage'], referenceRoles: ['style'], supportsMultiReference: true } },
    { id: 'flux-kontext-dev-i2i', provider: 'siliconflow', model: 'flux-kontext-dev-i2i', isFree: true, label: '硅基流动免费参考图(换主体/风格)', capabilities: { generationModes: ['imageToImage', 'textToImage'], referenceRoles: ['subject', 'style', 'composition'], supportsMultiReference: true, supportsSubjectLock: true } },
    { id: 'flux-kontext-pro-i2i', provider: 'siliconflow', model: 'flux-kontext-pro-i2i', isFree: true, label: '硅基流动免费参考图(高质)', capabilities: { generationModes: ['imageToImage', 'textToImage'], referenceRoles: ['subject', 'style', 'composition'], supportsMultiReference: true } },
    { id: 'flux-pro', provider: 'fal', model: 'flux-pro', isFree: false, label: 'Fal 高质量', capabilities: { generationModes: ['textToImage'] } },
    { id: 'flux-redux', provider: 'muapi', model: 'flux-redux', isFree: false, label: 'MuAPI 参考图(构图保持)', capabilities: { generationModes: ['imageToImage'], referenceRoles: ['subject', 'composition'], supportsSubjectLock: true } },
    { id: 'qwen-image-edit', provider: 'muapi', model: 'qwen-image-edit', isFree: false, label: 'MuAPI 参考图编辑', capabilities: { generationModes: ['imageToImage'], referenceRoles: ['subject'] } },
  ],
  // 视频：需要 textToVideo / imageToVideo
  video: [
    { id: 'wan2.2-i2v', provider: 'siliconflow', model: 'Wan-AI/Wan2.2-I2V-A14B', isFree: true, label: '硅基流动免费视频', capabilities: { generationModes: ['textToVideo', 'imageToVideo'] } },
    { id: 'seedance-v2', provider: 'fal', model: 'seedance-v2', isFree: false, label: 'Seedance 高质量', capabilities: { generationModes: ['textToVideo', 'imageToVideo'] } },
  ],
  // 音频：暂无已验证的免费模型数据，留空（resolveModelForTask 会明确返回不支持原因）
  audio: [
    { id: 'audio-placeholder', provider: 'fal', model: 'audio-generation', isFree: false, label: '音频生成', capabilities: { generationModes: ['textToAudio'] } },
  ],
};

/** 任务类型 → 默认能力要求（规划期按节点类型推导，可被参考图等覆盖）
 *  注意：evaluateModelCapabilitySupport 识别的能力键是 'generationMode'（单数），值取 generationModes 数组中的一项。 */
export function defaultRequirementsForTask(taskType: NodeType): WorkflowCapabilityRequirement[] {
  switch (taskType) {
    case 'text':
    case 'script':
    case 'storyboard':
      return [{ key: 'generationMode', value: 'textToText', required: true, reason: '需要文本生成能力' }];
    case 'image':
      return [{ key: 'generationMode', value: 'textToImage', required: true, reason: '需要文生图能力' }];
    case 'video':
      return [{ key: 'generationMode', value: 'textToVideo', required: true, reason: '需要视频生成能力' }];
    case 'audio':
      return [{ key: 'generationMode', value: 'textToAudio', required: true, reason: '需要音频生成能力' }];
    default:
      return [];
  }
}

/** 若步骤携带参考图输入，将其升级为 imageToImage 能力要求（参考图模型才满足） */
export function withReferenceRequirements(
  requirements: WorkflowCapabilityRequirement[],
): WorkflowCapabilityRequirement[] {
  return [
    ...requirements.filter((r) => !(r.key === 'generationMode' && r.value === 'textToImage')),
    { key: 'generationMode', value: 'imageToImage', required: true, reason: '检测到参考图输入，需要图生图能力' },
  ];
}

export interface ResolveModelOptions {
  /** 是否免费优先（默认 true）。false 时仅按能力选首个候选，不刻意挑免费。 */
  preferFree?: boolean;
  /** 覆盖默认能力要求（如带参考图时传入 withReferenceRequirements 结果） */
  requirements?: WorkflowCapabilityRequirement[];
  /** 覆盖默认回退链（便于测试或运行时按可用模型裁剪） */
  chain?: ModelCandidate[];
}

function candidateId(c: ModelCandidate): string {
  return `${c.provider}/${c.model}`;
}

/**
 * 规划期：为某任务类型解析「免费优先、能力满足、按优先级」的模型。
 *
 * @returns 解析结果；若没有任何候选满足能力要求，返回 null（reason 说明）。
 */
export function resolveModelForTask(
  taskType: NodeType,
  options: ResolveModelOptions = {},
): ModelResolution | null {
  const chain = options.chain ?? FREE_FIRST_CHAINS[taskType];
  if (!chain || chain.length === 0) {
    return {
      provider: '',
      model: '',
      modelId: '',
      isFree: false,
      autoSwitched: false,
      reason: `任务类型「${taskType}」暂无可用模型回退链（可能尚未接入免费模型数据）`,
      capableCount: 0,
      freeCapableCount: 0,
      chosenIndex: -1,
      fallbackChain: [],
    };
  }
  const requirements = options.requirements ?? defaultRequirementsForTask(taskType);

  // 能力过滤：只保留满足任务能力要求的候选（按原优先级顺序）
  const capable = chain.filter((c) => {
    const res = evaluateModelCapabilitySupport(c.capabilities ?? {}, requirements);
    return res.supported;
  });

  if (capable.length === 0) {
    return {
      provider: '',
      model: '',
      modelId: '',
      isFree: false,
      autoSwitched: false,
      reason: `所有候选模型均不满足任务能力要求：${requirements.map((r) => r.reason ?? r.key).join('；')}`,
      capableCount: 0,
      freeCapableCount: 0,
      chosenIndex: -1,
      fallbackChain: [],
    };
  }

  const preferFree = options.preferFree ?? true;
  const freeCapable = capable.filter((c) => c.isFree);
  const chosen = preferFree && freeCapable.length > 0 ? freeCapable[0] : capable[0];

  const autoSwitched = preferFree && freeCapable.length === 0;
  const chosenIndex = capable.findIndex((c) => c.id === chosen.id);

  let reason: string;
  if (preferFree && freeCapable.length > 0) {
    reason = `免费优先：选中免费模型 ${candidateId(chosen)}（${chosen.label ?? ''}），满足任务能力要求。`;
  } else if (autoSwitched) {
    reason = `免费模型均不满足任务能力要求（${requirements.map((r) => r.reason ?? r.key).join('；')}），已按优先级切换到付费模型 ${candidateId(chosen)}（${chosen.label ?? ''}）。`;
  } else {
    reason = `按能力选中模型 ${candidateId(chosen)}（${chosen.label ?? ''}）。`;
  }

  return {
    provider: chosen.provider,
    model: chosen.model,
    modelId: candidateId(chosen),
    isFree: chosen.isFree,
    autoSwitched,
    reason,
    capableCount: capable.length,
    freeCapableCount: freeCapable.length,
    chosenIndex,
    fallbackChain: capable,
  };
}

/**
 * 从节点 data 中提取智能体写入的回退链（modelFallbackChain）。
 * 该数组由 SmartAgent 的 applyRouteToPlan 写入，元素为 { provider, model, isFree }。
 * 返回 null 表示没有回退链（按普通逻辑执行）。
 */
export function extractFallbackChain(
  data: Record<string, unknown> | undefined,
): ModelCandidate[] | null {
  const raw = data?.modelFallbackChain;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const candidates: ModelCandidate[] = raw
    .filter((c) => c && typeof c === 'object' && typeof (c as Record<string, unknown>).model === 'string')
    .map((c) => {
      const rec = c as Record<string, unknown>;
      const provider = String(rec.provider || '');
      const model = String(rec.model || '');
      return {
        id: `${provider}/${model}`,
        provider,
        model,
        isFree: Boolean(rec.isFree),
        capabilities: {},
      };
    })
    .filter((c) => c.provider && c.model);
  return candidates.length > 0 ? candidates : null;
}

export interface FallbackAttempt {
  provider: string;
  model: string;
  modelId: string;
  isFree: boolean;
  ok: boolean;
  error?: string;
}

export interface ExecuteFallbackResult<T = unknown> {
  ok: boolean;
  provider?: string;
  model?: string;
  modelId?: string;
  isFree?: boolean;
  /** 实际命中的候选下标 */
  usedIndex?: number;
  result?: T;
  error?: string;
  attempts: FallbackAttempt[];
}

/**
 * 运行期：按回退链（已按能力过滤）依次尝试执行，某模型失败则切换到下一个。
 * runFn 抛出异常即视为该模型失败，进入下一个候选。
 *
 * @param runFn 用单个候选执行任务的异步函数，返回结果 T
 * @param chain 候选链（通常来自 resolveModelForTask().fallbackChain）
 * @param requirements 能力要求（用于再次过滤，确保运行期也只尝试有能力的模型）
 */
export async function executeWithModelFallback<T = unknown>(
  runFn: (candidate: ModelCandidate, index: number) => Promise<T>,
  chain: ModelCandidate[],
  requirements?: WorkflowCapabilityRequirement[],
): Promise<ExecuteFallbackResult<T>> {
  const runnable = requirements
    ? chain.filter((c) => evaluateModelCapabilitySupport(c.capabilities ?? {}, requirements).supported)
    : chain;
  const attempts: FallbackAttempt[] = [];

  if (runnable.length === 0) {
    return { ok: false, error: '回退链为空或不满足能力要求', attempts };
  }

  let lastError: string | undefined;
  for (let i = 0; i < runnable.length; i += 1) {
    const c = runnable[i];
    try {
      const result = await runFn(c, i);
      attempts.push({ provider: c.provider, model: c.model, modelId: candidateId(c), isFree: c.isFree, ok: true });
      return {
        ok: true,
        provider: c.provider,
        model: c.model,
        modelId: candidateId(c),
        isFree: c.isFree,
        usedIndex: i,
        result,
        attempts,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      lastError = msg;
      attempts.push({ provider: c.provider, model: c.model, modelId: candidateId(c), isFree: c.isFree, ok: false, error: msg });
      // 继续尝试下一个候选
    }
  }

  return {
    ok: false,
    error: lastError ? `所有候选模型均失败，最后错误：${lastError}` : '所有候选模型均失败',
    attempts,
  };
}

/**
 * 运行时动态链：根据「用户实际激活的平台」过滤静态 FREE_FIRST_CHAINS，
 * 只保留当前可用候选，避免规划期写入用户未激活的平台、运行期才回退。
 *
 * 这是「免费额度路由可视化」与「动态可用链」的核心：静态链是全集，
 * 实际可用链 = 静态链 ∩ 已激活平台。新增免费平台只需在 FREE_FIRST_CHAINS
 * 登记，无需改此处；未激活平台自动不出现在可用链中。
 *
 * @param taskType   任务类型（text/image/video/audio）
 * @param isProviderActive 判断某 provider 是否已激活（通常来自 useApiKeyStore.isActive）
 */
export function buildAvailableChain(
  taskType: NodeType,
  isProviderActive: (provider: string) => boolean,
): ModelCandidate[] {
  const base = FREE_FIRST_CHAINS[taskType] ?? [];
  if (base.length === 0) return [];
  return base.filter((candidate) => {
    try {
      return isProviderActive(candidate.provider);
    } catch {
      return false;
    }
  });
}
