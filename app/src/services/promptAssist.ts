import { proxyRequest } from '@/api/proxy';
import { getPlatformConfig } from '@/config/api-config';
import { localTranslate, getLocalTranslateState } from '@/services/localTranslate';

export type PromptAssistAction = 'translate' | 'optimize';
export type PromptAssistTarget = 'image' | 'video';

type PromptLanguage = 'zh' | 'en';

const PROMPT_ASSIST_MODEL_BY_PROVIDER: Record<string, string> = {
  siliconflow: 'Qwen/Qwen2.5-7B-Instruct',
  deepseek: 'deepseek-chat',
  openai: 'gpt-4o-mini',
  bailian: 'qwen-plus',
  zhipu: 'glm-4-plus',
  modelscope: 'Qwen/Qwen2.5-7B-Instruct',
  minimax: 'abab6.5s-chat',
};

function detectPromptLanguage(prompt: string): PromptLanguage {
  const cjkChars = prompt.match(/[\u3400-\u9fff]/g)?.length || 0;
  const latinWords = prompt.match(/[A-Za-z]+/g)?.length || 0;
  return cjkChars >= Math.max(2, latinWords) ? 'zh' : 'en';
}

function languageName(language: PromptLanguage) {
  return language === 'zh' ? 'Chinese' : 'English';
}

// ── 提示词「详细程度」自动分级 ──
// 需求：不让用户手选风格/强度，而是根据【原文本身的详细程度】自动决定优化力度：
//   sparse（简略）→ 按结构补更多具体锚点（主体+光照+材质）；
//   moderate（中等）→ 仅按主体补 1 句具体质感；
//   rich（已详细）→ 只精修去套话，几乎不追加。
// 用户拿到优化结果后仍可在其基础上自由继续编辑。
export type PromptDetailLevel = 'sparse' | 'moderate' | 'rich';

// 各感官维度的信号词（中英混合）。命中越多，说明原文越"具体"，越不需要补。
const SIGNAL_LIGHT =
  /光|照明|逆光|顺光|柔光|暖光|冷光|阴影|投影|日落|黄昏|清晨|黎明|霓虹|烛光|light|lighting|backlit|rim ?light|golden hour|shadow|glow|neon|rembrandt|volumetric/i;
const SIGNAL_MATERIAL =
  /材质|质感|纹理|木|金属|布料|皮革|石|玻璃|丝绸|绒|锈|磨砂|陶|漆|texture|material|wood|metal|fabric|leather|stone|glass|silk|velvet|matte|glossy|rusty|weathered/i;
const SIGNAL_CAMERA =
  /镜头|焦段|景深|光圈|广角|长焦|微距|特写|远景|构图|俯拍|仰拍|\d{2,3}\s?mm|lens|depth of field|\bdof\b|bokeh|aperture|wide[- ]?angle|telephoto|macro|close[- ]?up|composition|f\/\d/i;
const SIGNAL_MOOD =
  /氛围|情绪|静谧|温馨|孤独|忧郁|神秘|宁静|萧瑟|mood|atmosphere|serene|cozy|melancholic|lonely|mysterious|tranquil|nostalgic/i;

export function assessPromptDetail(prompt: string): PromptDetailLevel {
  const p = (prompt || '').trim();
  const hasCJK = /[一-鿿]/.test(p);
  const lenChars = p.replace(/\s+/g, '').length;
  let dims = 0;
  if (SIGNAL_LIGHT.test(p)) dims++;
  if (SIGNAL_MATERIAL.test(p)) dims++;
  if (SIGNAL_CAMERA.test(p)) dims++;
  if (SIGNAL_MOOD.test(p)) dims++;
  // 已足够详细：多维度命中，或篇幅长且至少覆盖两维
  if (dims >= 3 || (dims >= 2 && lenChars >= (hasCJK ? 36 : 60))) return 'rich';
  // 有一定信息量：命中任一维度，或篇幅中等
  if (dims >= 1 || lenChars >= (hasCJK ? 18 : 40)) return 'moderate';
  return 'sparse';
}

function buildSystemPrompt(
  action: PromptAssistAction,
  target: PromptAssistTarget,
  language: PromptLanguage,
  detailLevel: PromptDetailLevel = 'moderate',
) {
  if (action === 'translate') {
    // 双向翻译：中文提示词→英文，英文提示词→中文
    const targetLang = language === 'zh' ? 'English' : 'Chinese (中文)';
    const domain = target === 'image' ? 'image-generation' : 'video-generation';
    return `You are a professional ${domain} prompt translator. Translate the user prompt into fluent ${targetLang}. Preserve all style, camera, lighting, composition, subject, motion, and technical details accurately. Return only the translated prompt, no explanations.`;
  }

  const outputLanguage = languageName(language);
  const sharedRules = [
    `Return ONLY the rewritten prompt in ${outputLanguage}. No explanations, no bullet lists, no version labels (such as "优化版" / "version" / "improved").`,
    'Stay faithful to the user intent; do not invent unrelated subjects or change the core meaning.',
    'Do NOT translate the prompt into another language while optimizing.',
    'Output a single, ready-to-use prompt (one paragraph, or comma/line separated phrases) that can be fed directly into an image/video generation model.',
  ].join(' ');

  // 去「AI 廉价感」的核心方法论（源自 Midjourney V7 官方 + 2026 市场实践）：
  //  - 用【具体】替代【空泛】：不要 "beautiful/cinematic"，要写出可落地的锚点
  //    （如 "late afternoon sun at a low angle casting long shadows" 而非 "dramatic lighting"）。
  //  - 遵循结构：主体 → 环境/上下文 → 光照 → 风格/媒介，主体前置、权重最高。
  //  - 善用真实摄影/绘画术语：焦段(85mm)、光位(Rembrandt/侧逆光)、景深、film grain、
  //    真实材质与轻微"不完美"细节，让画面脱离千篇一律的 AI 塑料感。
  const mjPrinciples = [
    'Follow the proven Midjourney-style principle: replace vague adjectives with CONCRETE, specific anchors.',
    'Never fix a generic prompt by stacking more hype adjectives — that only intensifies the generic "AI look".',
    'Prefer real photographic / art vocabulary when it fits (focal length like 85mm, a named light setup like soft side light or rim light, depth of field, a specific material, subtle real-world imperfections) over empty quality boosters.',
    'Keep the subject first and most weighted; do not bury it under stylistic words.',
  ].join(' ');

  // 按【原文详细程度】自动决定优化力度（用户无需手选风格/强度，之后仍可自行继续编辑）。
  const levelRule =
    detailLevel === 'rich'
      ? 'The prompt is ALREADY detailed and specific. Do NOT add new descriptors or scenes. Only: fix grammar, remove duplicated/contradictory words, and collapse stacked clichés. Keep the length roughly the same or SHORTER. This is a polish, not an expansion.'
      : detailLevel === 'sparse'
        ? 'The prompt is SPARSE (few concrete details). Enrich it following the structure Subject + Context + Lighting + Style: add a few CONCRETE, subject-appropriate anchors — a precise light quality, a named material/texture, and where natural one real photographic term (e.g. 85mm, shallow depth of field). Stay faithful to the original subject and language; still no hype words.'
        : 'The prompt has moderate detail. Add AT MOST ONE OR TWO concrete, subject-appropriate descriptors, only where a sensory dimension (light / material / texture) is clearly missing. Do not over-expand.';

  const optimizeRules = [
    `You are a prompt polisher. Refine the user's ${outputLanguage} prompt while staying faithful to its subject, language, tone and style. Do not rewrite it into a different scene or genre, and do not translate it.`,
    mjPrinciples,
    levelRule,
    'Remove empty degree adverbs / intensifiers (e.g. 非常, 十分, very, extremely, so, really, quite) — they add no concrete information and read as filler; keep only meaningful modifiers.',
    'FORBIDDEN (these read as cheap/generic AI filler — never use them): "masterpiece", "best quality", "8k", "4k", "ultra-detailed", "hyperrealistic", "photorealistic", "cinematic", "visually striking", "high quality", "award-winning", "epic", "stunning", "breathtaking". Also forbidden: switching the art style/genre, adding subjects or narrative not implied by the original, or translating into another language.',
    'The goal is a refined, specific, natural prompt — never a longer one padded with hype words.',
    target === 'image'
      ? 'The prompt is for image generation. Keep any visual descriptors consistent with the original, and APPEND at the very end the clean negative constraint `--no text, watermark, logo, blurry, low quality` (this is a parameter, keep it in English).'
      : 'The prompt is for video generation, so keep any motion/camera descriptors consistent with the original. Do NOT add image-style `--no` negative parameters.',
  ].join(' ');

  return `${optimizeRules} ${sharedRules}`;
}

function extractAssistContent(payload: unknown) {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;

  // 顶层 content 字段（简化响应格式）
  const directContent = record.content;
  if (typeof directContent === 'string') return directContent.trim();
  if (Array.isArray(directContent)) {
    return directContent.map((item) => (typeof item === 'string' ? item : '')).join('\n').trim();
  }

  // 后端代理返回 { success, data: { choices: [...] } } 格式
  const proxyData = record.data as Record<string, unknown> | undefined;
  const choices = (proxyData?.choices || record.choices) as Array<Record<string, unknown>> | undefined;
  if (choices && choices.length > 0) {
    const first = choices[0];
    // OpenAI 标准: choices[0].message.content
    const message = first?.message as Record<string, unknown> | undefined;
    if (typeof message?.content === 'string') return (message.content as string).trim();
    // 备选: choices[0].text
    if (typeof first?.text === 'string') return (first.text as string).trim();
  }

  return '';
}

export async function assistPrompt({
  prompt,
  action,
  target,
  provider,
  apiKey,
}: {
  prompt: string;
  action: PromptAssistAction;
  target: PromptAssistTarget;
  provider: string;
  apiKey?: string;
}) {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) return '';

  const platform = getPlatformConfig(provider);
  if (!platform?.chatEndpoint) {
    throw new Error(`当前平台 ${provider} 不支持提示词辅助。`);
  }

  const language = detectPromptLanguage(normalizedPrompt);
  const direction = action === 'translate'
    ? (language === 'zh' ? 'zh→en' : 'en→zh')
    : `${language} optimize`;

  // ── 翻译操作：本地模型（不触发下载，需先在模型面板安装） ──
  if (action === 'translate') {
    const localState = getLocalTranslateState();
    if (localState.status === 'ready') {
      try {
        // eslint-disable-next-line no-console
        console.log(`[promptAssist] ${direction} via LOCAL NLLB model`);
        const result = await localTranslate(normalizedPrompt, language);
        if (result) {
          // eslint-disable-next-line no-console
          console.log(`[promptAssist] local result (${result.length} chars):`, result.slice(0, 80));
          return result;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[promptAssist] local translate failed:', e);
        throw e;
      }
    }
    // 模型未安装或出错
    throw new Error(
      localState.status === 'idle'
        ? '本地翻译模型未安装。请在「模型下载」面板点击「安装」下载 NLLB-200 模型（~600MB，无需 API Key），安装完成后即可离线翻译。'
        : `本地翻译模型不可用：${localState.error || '状态异常，请在「模型下载」面板中重试安装。'}`
    );
  }

  // ── 优化提示词（LLM 优先：有 Key 走远端精修，质量上限更高；失败/无 Key 再降级离线兜底） ──
  if (action === 'optimize') {
    // 无 API Key：完全免费、无需联网，在原文案上做「原地润色」（增加质感 / 光影 / 氛围、
    // 去除 AI 套话与空程度副词，绝不翻译或改写主体）。
    if (!apiKey) {
      // eslint-disable-next-line no-console
      console.log('[promptAssist] optimize via FREE offline local polish (no apiKey)');
      return localPolishPrompt(normalizedPrompt, target);
    }

    const model = PROMPT_ASSIST_MODEL_BY_PROVIDER[provider] || platform.defaultTestModel;
    // 自动按原文详细程度决定优化力度（无需用户手选风格/强度）
    const detailLevel = assessPromptDetail(normalizedPrompt);
    const systemPrompt = buildSystemPrompt(action, target, language, detailLevel);
    // eslint-disable-next-line no-console
    console.log(`[promptAssist] ${direction} via ${provider}/${model}`, { language, detailLevel, inputLen: normalizedPrompt.length, inputPreview: normalizedPrompt.slice(0, 60) });

    const response = await proxyRequest(provider, {
      endpoint: platform.chatEndpoint,
      method: 'POST',
      apiKey,
      timeout: 45000,
      body: {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: normalizedPrompt },
        ],
        max_tokens: 520,
        // 优化使用低温度，抑制模型自由发挥导致偏离原风格
        temperature: 0.2,
      },
    });

    // eslint-disable-next-line no-console
    console.log(`[promptAssist] raw response keys:`, Object.keys(response as object));
    const content = extractAssistContent(response);
    // eslint-disable-next-line no-console
    console.log(`[promptAssist] extracted content (${content.length} chars):`, content.slice(0, 80));

    // 检测后端「无真实上游」的兜底占位：其 content 会以 "Generated content:" 开头，
    // 且会把 system+user 原文拼进去（典型表现就是把系统提示词当成结果返回给用户）。
    // 也可能返回 workflowFallback / mode=fallback / mode=local / fallbackReason 等标记。
    const record = response as Record<string, unknown>;
    const isPlaceholder = typeof content === 'string' && content.startsWith('Generated content:');
    const fallbackActivated =
      isPlaceholder
      || record.fallbackActivated === true
      || record.mode === 'fallback'
      || record.mode === 'local'
      || record.workflowFallback === true
      || (record.asset && (record.asset as Record<string, unknown>)?.metadata?.fallback === true)
      || typeof record.fallbackReason === 'string';

    if (fallbackActivated) {
      // eslint-disable-next-line no-console
      console.log('[promptAssist] upstream unavailable, falling back to free offline local polish');
      // 优化功能提供免费、离线的「原地润色」兜底：即便配置了 Key 但远端失败，
      // 也严格在原文案上微调，绝不把系统提示词那段占位文本返回给用户。
      return localPolishPrompt(normalizedPrompt, target);
    }

    if (!content) {
      throw new Error('提示词辅助没有返回可用文本。');
    }
    return content;
  }
}

/**
 * 免费、离线、确定性的提示词「原地润色」（无需 API Key）。
 * 严格在原文案上打磨：折叠空白、统一标点、去重 AI 套话（去除 AI 感）；
 * 仅「补全」原文缺失的质感 / 光影 / 氛围 / 视觉冲击维度，绝不改动词序、
 * 主体或原有风格，也不翻译。极短提示词仅补一个中性短语。
 */
const AI_CLICHE_RE = /\b(masterpiece|best quality|ultra[-\s]?detailed|highly detailed|8k|4k|uhd|hyperrealistic|photo[- ]?realistic)\b/gi;

// 空程度副词：去除「非常/十分/very/extremely」类无信息量修饰词，避免廉价感与画蛇添足。
// 注意：中文只取明确作程度副词的词，避免误删「超」这类成词语素（如「超现实主义」）。
const DEGREE_CN = ['非常', '十分', '极其', '极度', '格外', '超级', '颇为', '特别', '分外', '尤为', '甚为', '很'];
const DEGREE_EN_RE =
  /\b(very|extremely|highly|incredibly|super|ultra|absolutely|totally|really|overly|so|quite|rather|fairly)\b/gi;

function stripDegreeAdverbs(s: string, hasCJK: boolean): string {
  let out = s;
  for (const w of DEGREE_CN) {
    out = out.split(w).join('');
  }
  out = out.replace(DEGREE_EN_RE, '');
  // 折叠删除后残留的多余分隔符 / 空格
  out = out.replace(/\s+/g, ' ').trim();
  out = out
    .replace(/[，, ]{2,}/g, hasCJK ? '，' : ', ')
    .replace(/^[，, ]+|[，, ]+$/g, '')
    .trim();
  return out;
}

// 上下文增强：命中【主体/场景类型】时，补一句【具体】的质感/光影描述（中英文各一句，按原文语言选用）。
// 每条只取首个命中，绝不千篇一律地堆「视觉冲击力」套话——这是离线润色避免「AI 廉价感」的关键：
// 具体化、可落地，不空喊高级感。
interface ContextEnrich {
  re: RegExp;
  zh: string;
  en: string;
}
const CONTEXT_ENRICH: ContextEnrich[] = [
  {
    re: /\b(cat|dog|mouse|rabbit|animal|pet|bird|horse|wolf|fox|fish)\b|猫|狗|鼠|兔|动物|宠物|鸟|马|狼|狐狸|鱼/,
    zh: '，毛发蓬松有光泽，侧逆光勾出轮廓',
    en: ', soft rim light catching glossy fur',
  },
  {
    re: /\b(city|street|building|alley|neon|cyberpunk|rainy night)\b|城市|街道|建筑|楼|巷|霓虹|赛博|雨夜|夜景/,
    zh: '，湿润路面映出霓虹倒影，体积光穿过尘埃',
    en: ', wet pavement reflecting neon, volumetric haze',
  },
  {
    re: /\b(mountain|forest|sea|ocean|lake|river|landscape|sky|sunset|dawn|mist|snow)\b|山|森林|海|湖|河|自然|风景|天空|日落|清晨|雾|雪/,
    zh: '，空气透视柔和，暖光自薄雾透出',
    en: ', soft aerial perspective, warm light through mist',
  },
  {
    re: /\b(girl|boy|woman|man|portrait|person|child|face)\b|人|女孩|男孩|女人|男人|少女|人物|肖像|脸|孩子/,
    zh: '，皮肤质感细腻，眼神光自然',
    en: ', fine skin texture, natural catchlight in eyes',
  },
  {
    re: /\b(food|coffee|cake|fruit|meal|tea)\b|食物|美食|咖啡|蛋糕|水果|餐|茶/,
    zh: '，食材纹理清晰，暖光下质感诱人',
    en: ', crisp ingredient detail, appetizing warm light',
  },
  {
    re: /建筑|房屋|木屋|老屋|古堡|塔|桥|楼|房|屋|寺庙|教堂|室内|房间|窗台|街道/,
    zh: '，砖石与木质肌理清晰，自然光勾勒体积与轮廓',
    en: ', clear brick and wood grain, natural light shaping volume',
  },
  {
    re: /海|湖|河|瀑布|山|森林|花草|田野|雪|雾|暴雨|狂风|暴风|风雪|浪|云层|乌云|天空|风景|自然|夕阳|日出|星空|夜空/,
    zh: '，空气透视柔和，天气与氛围真实自然',
    en: ', soft aerial perspective, believable weather and atmosphere',
  },
];

export function localPolishPrompt(prompt: string, target: PromptAssistTarget): string {
  let p = (prompt || '').trim();
  if (!p) return p;

  // 1) 折叠多余空白与空行
  p = p.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  const hasCJK = /[一-鿿]/.test(p);

  // 1.5) 去除空程度副词（非常/十分/very/extremely…），避免廉价感与画蛇添足
  p = stripDegreeAdverbs(p, hasCJK);

  // 2) 统一标点（中文用全角逗号，英文用半角逗号+空格）
  if (hasCJK) {
    p = p.replace(/[，,]{2,}/g, '，').replace(/\s*，\s*/g, '，');
  } else {
    p = p.replace(/[，,]{2,}/g, ', ').replace(/[ ]*,[ ]*/g, ', ');
  }

  // 3) 去重重复的 AI 套话（仅删除重复出现者，保留首个，去除 AI 感）
  const seen = new Set<string>();
  p = p
    .replace(AI_CLICHE_RE, (m) => {
      const k = m.toLowerCase().replace(/[-\s]/g, '');
      if (seen.has(k)) return '';
      seen.add(k);
      return m;
    })
    .replace(/[，, ]{2,}/g, hasCJK ? '，' : ', ')
    .replace(/^[，, ]+|[，, ]+$/g, '')
    .trim();

  // 4) 极短且缺乏质感描述时，仅末尾追加一个中性、不改动风格的短语
  if (p.length < 12) {
    const suffix = target === 'video'
      ? (hasCJK ? '，画面清晰稳定' : ', clear and stable footage')
      : (hasCJK ? '，细节清晰' : ', clear fine detail');
    return ensureImageNegative(p + suffix, target);
  }

  // 5) 原地润色增强：按【原文详细程度】自动决定补多少，绝不堆砌固定套话。
  //    - rich（已详细）：不追加任何内容，只保留前面的去套话/标点归一（避免画蛇添足）；
  //    - moderate（中等）：按主体补 1 句「具体」质感/光影；
  //    - sparse（简略）：按主体补 1 句 + 若缺光照再补 1 句「具体」光照锚点（输入越少补越多）。
  p = p.replace(/[，,\s]+$/, '');
  if (p.endsWith('。') || p.endsWith('！') || p.endsWith('？')) {
    p = p.slice(0, -1);
  } else if (p.endsWith('.')) {
    p = p.slice(0, -1);
  }
  const connector = hasCJK ? '，' : ', ';
  const base = p;
  const level = assessPromptDetail(base);

  let enrichTail = '';
  if (level !== 'rich') {
    const clean = (s: string) => s.replace(/^[，, ]+/, '').replace(/[，, ]+$/, '');

    // 按主体类型补一句具体质感（首个命中）
    let matchedEnrich = '';
    for (const c of CONTEXT_ENRICH) {
      if (c.re.test(base)) {
        matchedEnrich = clean(hasCJK ? c.zh : c.en);
        break;
      }
    }
    if (matchedEnrich) enrichTail += connector + matchedEnrich;

    // sparse：输入极简，再补一个「具体」的光照/质感锚点（不空喊高级感）
    if (level === 'sparse') {
      if (!SIGNAL_LIGHT.test(base)) {
        enrichTail += connector + (hasCJK ? '柔和自然光，明暗过渡细腻' : 'soft natural light with gentle falloff');
      } else if (!matchedEnrich && !SIGNAL_MATERIAL.test(base)) {
        enrichTail += connector + (hasCJK ? '表面质感清晰可辨' : 'clear, tactile surface texture');
      }
    }

    // moderate 且未命中任何具体主体类别：补一句中性、正向的质感/氛围描述，
    // 避免「优化后只追加 --no、看起来什么都没做」的廉价感（仍不堆砌套话）。
    if (level === 'moderate' && !matchedEnrich) {
      enrichTail += connector + (hasCJK ? '主体细节清晰，质感自然真实' : 'clear subject detail with natural, believable texture');
    }
  }
  p += enrichTail;

  return ensureImageNegative(p, target);
}

// 图像场景自动补「干净化」负向约束（--no ...），规避水印/文字/模糊等脏元素。
// 该约束是参数语法，统一用英文；视频场景不添加（沿用各自负向字段）。
function ensureImageNegative(p: string, target: PromptAssistTarget): string {
  if (target === 'image' && !/--no\b/i.test(p)) {
    p += ' --no text, watermark, logo, blurry, low quality';
  }
  return p;
}
