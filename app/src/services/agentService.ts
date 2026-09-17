/**
 * HMDao Agent 服务 — LLM 调用 + 意图识别 + 工作流规划
 *
 * 支持多 Provider 降级：主模型失败 → 备用模型 → 本地关键词回退
 */

import type { WorkflowPlan, WorkflowStep } from '@/store/useCanvasStore';
import type { NodeType } from '@/types';

// ===== Agent 配置 =====

export interface AgentConfig {
  provider: 'openai' | 'zhipu' | 'local';
  apiKey: string;
  baseUrl?: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

const DEFAULT_CONFIG: AgentConfig = {
  provider: 'local',
  apiKey: '',
  model: 'qwen3.7-flash',
  temperature: 0.7,
  maxTokens: 2048,
};

// ===== 意图检测结果 =====

export interface IntentResult {
  skillId: string;
  skillName: string;
  confidence: number;
  extractedParams: Record<string, string>;
  suggestedSteps: { type: NodeType; label: string; prompt: string }[];
}

// ===== LLM 调用 =====

async function callLLM(
  config: AgentConfig,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  if (config.provider === 'local' || !config.apiKey) {
    throw new Error('LLM 未配置，使用本地关键词回退');
  }

  const baseUrl = config.baseUrl ||
    (config.provider === 'openai' ? 'https://api.openai.com/v1' : 'https://open.bigmodel.cn/api/paas/v4');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s 超时

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`LLM API 错误 ${response.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM 返回空内容');
    return content;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ===== 意图识别 Prompt =====

const INTENT_SYSTEM_PROMPT = `你是一个 AI 工作流规划助手。根据用户的自然语言输入，识别意图并规划工作流步骤。

可用技能领域：
- ecom: 电商产品宣传（商品图、主图、详情页、SKU、卖货）
- social: 社交媒体海报（小红书、朋友圈、封面、配图、种草）
- shortfilm: 剧情短片创作（剧本、分镜、电影、故事）
- brand: 品牌宣传片（品牌、VI、Logo、企业、广告）
- interior: 室内设计（装修、空间、效果图、家居）
- comic: 智能漫剧（漫画、角色、动画、二次元）
- marketing: 营销视频（广告、投放、转化、获客）
- poster: 海报设计（活动、促销、Banner、展架）
- lab: 爆款内容拆解（热点、趋势、流量、viral）

可用节点类型：text（文本/文案）、image（图片生成）、video（视频生成）、audio（音频生成）、script（脚本生成）、storyboard（分镜）

返回严格的 JSON 格式：
{
  "skillId": "领域ID",
  "skillName": "领域中文名",
  "confidence": 0.0-1.0,
  "extractedParams": {"主题": "...", "风格": "..."},
  "suggestedSteps": [
    {"type": "节点类型", "label": "步骤名称", "prompt": "该步骤的提示词"}
  ]
}`;

// ===== 关键词回退（本地） =====

interface KeywordTemplate {
  skillId: string;
  skillName: string;
  keywords: string[];
  steps: { type: NodeType; label: string; promptTemplate: string }[];
}

const KEYWORD_TEMPLATES: KeywordTemplate[] = [
  {
    skillId: 'ecom', skillName: '电商产品宣传',
    keywords: ['电商', '产品', '宣传', '商品', '主图', '详情页', 'SKU', '卖货', '店铺', '带货'],
    steps: [
      { type: 'text', label: '产品文案', promptTemplate: '{input}，产品卖点分析与文案创作' },
      { type: 'image', label: '产品场景图', promptTemplate: '{input}，高质量产品场景图，专业电商摄影' },
      { type: 'video', label: '产品宣传视频', promptTemplate: '{input}，产品动态展示，专业广告' },
    ],
  },
  {
    skillId: 'social', skillName: '社交媒体海报',
    keywords: ['社交媒体', '小红书', '朋友圈', '海报', '封面', '配图', '种草', '推文', '分享'],
    steps: [
      { type: 'text', label: '文案创意', promptTemplate: '{input}，社交媒体文案创作' },
      { type: 'image', label: '主视觉海报', promptTemplate: '{input}，社交媒体海报设计，竖版9:16' },
      { type: 'image', label: '封面图', promptTemplate: '{input}，封面头图设计，16:9横版' },
    ],
  },
  {
    skillId: 'shortfilm', skillName: '剧情短片创作',
    keywords: ['剧情', '短片', '剧本', '分镜', '电影', '故事', '创作', '导演', '拍摄', '短片'],
    steps: [
      { type: 'text', label: '故事大纲', promptTemplate: '{input}，故事大纲与三幕结构' },
      { type: 'script', label: '分镜脚本', promptTemplate: '为"{input}"创作专业分镜脚本' },
      { type: 'video', label: '片段预览', promptTemplate: '{input}，电影感视频片段' },
    ],
  },
  {
    skillId: 'brand', skillName: '品牌宣传片',
    keywords: ['品牌', '宣传片', 'VI', 'Logo', '视觉', '企业', '广告', '营销', '推广', '品牌宣传'],
    steps: [
      { type: 'text', label: '品牌策略', promptTemplate: '{input}，品牌定位与策略分析' },
      { type: 'image', label: '品牌视觉', promptTemplate: '{input}，品牌视觉设计，高端大气' },
      { type: 'video', label: '宣传片', promptTemplate: '{input}，品牌宣传片，高端质感' },
    ],
  },
  {
    skillId: 'interior', skillName: '室内设计',
    keywords: ['室内', '设计', '装修', '空间', '效果图', '家居', '家装', '软装', '硬装', '房间'],
    steps: [
      { type: 'text', label: '设计需求', promptTemplate: '{input}，空间类型与设计需求分析' },
      { type: 'image', label: '概念参考图', promptTemplate: '{input}，室内设计概念图，mood board' },
      { type: 'image', label: '效果图', promptTemplate: '{input}，室内设计效果图，photorealistic' },
    ],
  },
  {
    skillId: 'comic', skillName: '智能漫剧',
    keywords: ['漫画', '漫剧', '角色', '动画', '二次元', '动漫', '卡通', '手绘', '漫画'],
    steps: [
      { type: 'text', label: '剧本故事', promptTemplate: '{input}，故事梗概与角色设定' },
      { type: 'image', label: '角色设计', promptTemplate: '{input}，角色设定图，character design' },
      { type: 'video', label: '漫剧片段', promptTemplate: '{input}，漫画动画片段，anime style' },
    ],
  },
  {
    skillId: 'marketing', skillName: '营销视频',
    keywords: ['营销', '广告', '投放', '转化', '获客', '运营', '短视频广告', '推广'],
    steps: [
      { type: 'text', label: '营销策略', promptTemplate: '{input}，营销策略与目标人群分析' },
      { type: 'script', label: '广告脚本', promptTemplate: '为"{input}"创作广告脚本，黄金3秒钩子' },
      { type: 'video', label: '广告成片', promptTemplate: '{input}，营销短视频，fast-paced' },
    ],
  },
  {
    skillId: 'poster', skillName: '海报设计',
    keywords: ['海报', 'Banner', '活动', '促销', '宣传页', '展架', '易拉宝', '邀请函', '设计'],
    steps: [
      { type: 'text', label: '文案内容', promptTemplate: '{input}，活动主题与文案策划' },
      { type: 'image', label: '主视觉', promptTemplate: '{input}，活动海报主视觉，bold typography' },
      { type: 'image', label: 'Banner设计', promptTemplate: '{input}，网页Banner设计，wide format' },
    ],
  },
  {
    skillId: 'lab', skillName: '爆款内容拆解',
    keywords: ['爆款', '热点', '拆解', '分析', '趋势', '流量', 'viral', '模仿', '对标', '爆款'],
    steps: [
      { type: 'text', label: '热点分析', promptTemplate: '{input}，热点趋势与受众画像分析' },
      { type: 'text', label: '爆款公式', promptTemplate: '分析{input}领域的爆款内容公式' },
      { type: 'video', label: '成片预览', promptTemplate: '{input}，爆款短视频，trending style' },
    ],
  },
];

// ===== 主入口：意图识别 =====

/**
 * 检测用户意图，优先使用 LLM，失败时回退到关键词匹配
 * @returns IntentResult 或 null（无法识别时）
 */
export async function detectIntent(
  userInput: string,
  config: AgentConfig = DEFAULT_CONFIG,
): Promise<IntentResult | null> {
  // 输入校验
  if (!userInput || userInput.trim().length === 0) return null;
  const input = userInput.trim();

  // 尝试 LLM 调用
  if (config.provider !== 'local' && config.apiKey) {
    try {
      const rawJson = await callLLM(config, INTENT_SYSTEM_PROMPT, input);
      const parsed = JSON.parse(rawJson);
      return normalizeIntentResult(parsed, input);
    } catch (err) {
      console.warn('[AgentService] LLM 调用失败，回退到关键词匹配:', err);
      // 继续回退
    }
  }

  // 关键词回退
  return keywordFallback(input);
}

/** 关键词匹配回退 */
function keywordFallback(input: string): IntentResult | null {
  const lower = input.toLowerCase();
  let bestMatch: KeywordTemplate | null = null;
  let bestScore = 0;

  for (const template of KEYWORD_TEMPLATES) {
    let score = 0;
    for (const kw of template.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        score += kw.length; // 更长关键词权重更高
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = template;
    }
  }

  if (!bestMatch) return null;

  return {
    skillId: bestMatch.skillId,
    skillName: bestMatch.skillName,
    confidence: Math.min(bestScore / 20, 0.8), // 最高 0.8 置信度
    extractedParams: { 主题: input },
    suggestedSteps: bestMatch.steps.map((s) => ({
      type: s.type,
      label: s.label,
      prompt: s.promptTemplate.replace('{input}', input),
    })),
  };
}

/** 归一化 LLM 返回的意图结果 */
function normalizeIntentResult(raw: Record<string, unknown>, input: string): IntentResult {
  return {
    skillId: typeof raw.skillId === 'string' ? raw.skillId : 'unknown',
    skillName: typeof raw.skillName === 'string' ? raw.skillName : '自定义工作流',
    confidence: typeof raw.confidence === 'number' ? Math.min(Math.max(raw.confidence, 0), 1) : 0.5,
    extractedParams: typeof raw.extractedParams === 'object' && raw.extractedParams !== null
      ? raw.extractedParams as Record<string, string>
      : { 主题: input },
    suggestedSteps: Array.isArray(raw.suggestedSteps)
      ? raw.suggestedSteps.map((s: Record<string, unknown>) => ({
          type: (s.type as NodeType) || 'text',
          label: typeof s.label === 'string' ? s.label : '未命名步骤',
          prompt: typeof s.prompt === 'string' ? s.prompt : input,
        }))
      : [],
  };
}

/**
 * 将意图结果转换为 WorkflowPlan
 */
export function intentToWorkflowPlan(intent: IntentResult): WorkflowPlan {
  const NODE_WIDTH = 380;
  const NODE_GAP_X = 120;
  const NODE_GAP_Y = 60;
  const yBase = 200;

  return {
    id: `plan-${Date.now()}`,
    name: intent.skillName,
    description: Object.entries(intent.extractedParams)
      .map(([k, v]) => `${k}: ${v}`)
      .join('；'),
    steps: intent.suggestedSteps.map((s, i) => ({
      type: s.type,
      label: s.label,
      position: {
        x: 100 + i * (NODE_WIDTH + NODE_GAP_X),
        y: yBase + (i % 2 === 0 ? 0 : NODE_GAP_Y),
      },
      data: {
        label: s.label,
        prompt: s.prompt,
        content: s.prompt,
        provider: s.type === 'image' || s.type === 'video' ? 'fal' : s.type === 'audio' ? 'minimax' : 'openai',
        model: s.type === 'image' ? 'flux-pro' : s.type === 'video' ? 'seedance-v2' : s.type === 'audio' ? 'speech-2.8-turbo' : 'qwen3.7-flash',
        status: 'idle' as const,
      },
    })),
    connections: intent.suggestedSteps.length > 1
      ? intent.suggestedSteps.slice(0, -1).map((_, i) => ({ from: i, to: i + 1 }))
      : [],
  };
}

/**
 * 获取 Agent 配置（从 localStorage 读取）
 */
export function getAgentConfig(): AgentConfig {
  try {
    const stored = localStorage.getItem('hmdao_agent_config');
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        provider: parsed.provider || 'local',
        apiKey: parsed.apiKey || '',
        baseUrl: parsed.baseUrl || undefined,
        model: parsed.model || 'qwen3.7-flash',
        temperature: parsed.temperature ?? 0.7,
        maxTokens: parsed.maxTokens ?? 2048,
      };
    }
  } catch { /* ignore corrupt storage */ }
  return DEFAULT_CONFIG;
}

/**
 * 保存 Agent 配置到 localStorage
 */
export function saveAgentConfig(config: Partial<AgentConfig>): void {
  try {
    const current = getAgentConfig();
    const merged = { ...current, ...config };
    localStorage.setItem('hmdao_agent_config', JSON.stringify(merged));
  } catch { /* ignore storage errors */ }
}
