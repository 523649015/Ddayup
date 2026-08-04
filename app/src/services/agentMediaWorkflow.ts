import type { WorkflowPlan, WorkflowStep, NodeType, MediaInput } from '@/types';

export interface MediaAwarePlanInput {
  kind: 'image' | 'video';
  asset: { id: string; url: string; name?: string };
  /** 图片分析结果（已整理为可读文本） */
  analysisText?: string;
  /** 视频推理结果（已整理为可读文本） */
  reasoningText?: string;
  /** 用户的文字指令（可为空，表示只做分析） */
  userText: string;
}

const IMAGE_GEN_HINTS = ['生成', '画', '改', '风格', '换', '重绘', '扩', '出图', '创作', '设计', '海报', '图生', '变体', '二次'];
const VIDEO_GEN_HINTS = ['生成', '做', '剪辑', '运镜', '动起来', '视频', '改', '风格', '转', '重制', '续写', '二创', '生成视频'];

// 明确的分析动词：用户想「看/读懂」素材内容，而非基于素材再生成。
// 注意：'风格' 同时出现在生成提示词里，若只用关键字匹配，"分析参考图的风格元素"
// 会被误判为生成意图，从而建立「生成工作流」而非「分析工作流」。
const ANALYSIS_VERBS = ['分析', '识别', '理解', '描述', '解读', '解读', '总结', '说明', '讲讲', '讲解', '是什么', '解析'];
// 强生成动词：出现时即便带分析动词也仍视为生成（如"描述风格并生成类似图"）。
const STRONG_GEN_VERBS = ['生成', '画', '出图', '出视频', '创作', '再创作', '做', '剪辑'];

/** 判断用户文字是否希望「基于该媒体再生成」，否则视为「只分析/推理」。 */
export function wantGenerationFromMedia(text: string, kind: 'image' | 'video'): boolean {
  const hints = kind === 'image' ? IMAGE_GEN_HINTS : VIDEO_GEN_HINTS;
  if (!text.trim()) return false;
  const hasAnalysisVerb = ANALYSIS_VERBS.some((v) => text.includes(v));
  const hasStrongGenVerb = STRONG_GEN_VERBS.some((v) => text.includes(v));
  // 明确以分析动词表达意图（且不带强生成动词）时，视为纯分析，即便命中"风格"等提示词。
  if (hasAnalysisVerb && !hasStrongGenVerb) return false;
  return hints.some((h) => text.includes(h));
}

/**
 * 把用户上传/拖入的图片或视频，连同视觉分析/推理结果，组装成一个可执行的智能体工作流计划。
 *
 * 这是「机器人面板分析图片 / 推理视频」的核心编排逻辑（纯函数，无 DOM 依赖，便于测试）：
 * - 媒体作为工作流第一个节点的「主输入」（channel: 'primary'）；
 * - 若用户表达生成意图，则建立「基于媒体生成」的工作流；否则建立「分析媒体」的工作流；
 * - 视觉分析/推理文本与用户指令合并为节点提示词，确保模型理解上下文。
 *
 * 注意：手动输入的 sourceNodeId 在 createWorkflowFromPlan 中会被回填为节点自身 id，
 * 以便 collectConnectedReferenceInputs 能正确将其识别为可用主输入。
 */
export function buildMediaAwarePlan(input: MediaAwarePlanInput): WorkflowPlan {
  const isGen = wantGenerationFromMedia(input.userText, input.kind);
  const context = input.kind === 'image' ? input.analysisText : input.reasoningText;
  const composed = [context, input.userText].filter(Boolean).join('\n');
  const nodeType: NodeType = input.kind === 'image' ? 'image' : 'video';

  const primaryInput: MediaInput = {
    id: input.asset.id,
    type: input.kind,
    url: input.asset.url,
    channel: 'primary',
    role: 'primary',
    enabled: true,
    sourceNodeId: '',
    handleId: '',
  };

  const label = isGen
    ? input.kind === 'image'
      ? '基于图片生成'
      : '基于视频生成'
    : input.kind === 'image'
      ? '分析图片'
      : '分析视频';

  const fallbackPrompt = input.kind === 'image'
    ? '分析这张图片，并基于此进行创作。'
    : '分析这段视频，并基于此进行创作。';

  const step: WorkflowStep = {
    type: nodeType,
    label,
    position: { x: 80, y: 80 },
    data: {
      inputs: [primaryInput],
      prompt: composed || fallbackPrompt,
      status: 'idle',
    },
  };

  const name = isGen
    ? input.kind === 'image'
      ? '图片创作工作流'
      : '视频创作工作流'
    : input.kind === 'image'
      ? '图片分析工作流'
      : '视频推理工作流';

  return {
    id: `media-${input.kind}-${Date.now()}`,
    name,
    description: (composed || fallbackPrompt).slice(0, 160),
    steps: [step],
    connections: [],
  };
}
