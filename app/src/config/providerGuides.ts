export type ProviderGuideMode = 'llm' | 'image' | 'video' | 'audio';

export type DirectRecommendationEntryPoint =
  | 'api-page'
  | 'image-node'
  | 'video-node'
  | 'audio-node'
  | 'image-analysis'
  | 'video-analysis'
  | 'reverse-prompt';

export interface OfficialModelPreset {
  id: string;
  model: string;
  labelZh: string;
  labelEn: string;
  noteZh?: string;
  noteEn?: string;
}

export interface OfficialModelRecommendationTask {
  id: string;
  titleZh: string;
  titleEn: string;
  summaryZh: string;
  summaryEn: string;
  tagsZh?: string[];
  tagsEn?: string[];
  entryPoints?: DirectRecommendationEntryPoint[];
  primary: OfficialModelPreset;
  alternates?: OfficialModelPreset[];
}

export interface ProviderGuide {
  id: string;
  officialName: string;
  aliases?: string[];
  docsUrl: string;
  consoleUrl: string;
  supportsRelay: boolean;
  relayHintZh: string;
  relayHintEn: string;
  keyStepsZh: string[];
  keyStepsEn: string[];
  recommendedDirectTasks?: Partial<Record<ProviderGuideMode, OfficialModelRecommendationTask[]>>;
}

export interface RelayPreset {
  id: string;
  nameZh: string;
  nameEn: string;
  docsUrl: string;
  consoleUrl: string;
  baseUrlExample: string;
  descriptionZh: string;
  descriptionEn: string;
  endpointHintZh: string;
  endpointHintEn: string;
  recommendedProviders: string[];
  recommendedModels: Partial<Record<ProviderGuideMode, string[]>>;
}

function preset(
  id: string,
  model: string,
  labelZh: string,
  labelEn: string,
  noteZh?: string,
  noteEn?: string,
): OfficialModelPreset {
  return { id, model, labelZh, labelEn, noteZh, noteEn };
}

export const PROVIDER_GUIDES: Record<string, ProviderGuide> = {
  siliconflow: {
    id: 'siliconflow',
    officialName: '硅基流动',
    aliases: ['siliconflow', 'silicon flow', '硅基流动', 'sf'],
    docsUrl: 'https://cloud.siliconflow.cn/',
    consoleUrl: 'https://cloud.siliconflow.cn/',
    supportsRelay: true,
    relayHintZh: '如果聚合平台最终承载的是硅基流动模型，DDUp 会自动把匹配到的 Qwen、Wan 系列同步进画布模型菜单。',
    relayHintEn: 'If the relay ultimately serves SiliconFlow models, DDUp will surface matching Qwen and Wan models in the canvas automatically.',
    keyStepsZh: ['登录硅基流动控制台', '打开 API Key 页面', '创建新 Key 并填回 DDUp'],
    keyStepsEn: ['Sign in to SiliconFlow', 'Open the API Key page', 'Create a new key and paste it into DDUp'],
    recommendedDirectTasks: {
      llm: [
        {
          id: 'reasoning-assistant',
          titleZh: '智能体 / 文案推理',
          titleEn: 'Agent and reasoning',
          summaryZh: '适合把脚本、提词、策略路由先跑通，作为官方直连的稳定起点。',
          summaryEn: 'A stable official-direct starting point for scripts, prompts, and routing logic.',
          tagsZh: ['智能体', '脚本', '策略路由'],
          tagsEn: ['agents', 'scripts', 'routing'],
          entryPoints: ['api-page'],
          primary: preset('deepseek-r1', 'deepseek-ai/DeepSeek-R1', 'DeepSeek R1', 'DeepSeek R1'),
        },
      ],
      image: [
        {
          id: 'subject-replace-keep-composition',
          titleZh: '保构图换主体',
          titleEn: 'Keep composition, swap subject',
          summaryZh: '优先用于商品图、海报和主素材构图不变的换主体场景。',
          summaryEn: 'Best for product shots, posters, and subject swaps that keep the original framing.',
          tagsZh: ['保构图换主体', '商品图', '海报'],
          tagsEn: ['keep composition', 'product', 'poster'],
          entryPoints: ['api-page', 'image-node'],
          primary: preset(
            'qwen-image',
            'Qwen/Qwen-Image',
            'Qwen 图片',
            'Qwen Image',
            '适合商品图、海报图和保构图换主体。',
            'Strong for product shots, posters, and composition-preserving subject swaps.',
          ),
        },
        {
          id: 'omni-reference',
          titleZh: '全能参考融合',
          titleEn: 'Omni reference fusion',
          summaryZh: '适合把主体参考、风格参考和补充参考一起并入同一次图片生成。',
          summaryEn: 'Fits image generation that mixes subject, style, and supporting references in one run.',
          tagsZh: ['全能参考', '多参考', '风格融合'],
          tagsEn: ['omni reference', 'multi reference', 'style blend'],
          entryPoints: ['api-page', 'image-node'],
          primary: preset('qwen-image-omni', 'Qwen/Qwen-Image', 'Qwen 图片', 'Qwen Image'),
        },
      ],
      video: [
        {
          id: 'primary-asset-preview',
          titleZh: '主素材驱动预览',
          titleEn: 'Primary-asset preview',
          summaryZh: '适合图生视频预览、主素材驱动的动作延展和快速验证链路。',
          summaryEn: 'Good for image-to-video previews, motion extension, and quick pipeline validation.',
          tagsZh: ['图生视频', '主素材驱动', '预览验证'],
          tagsEn: ['image-to-video', 'primary asset', 'preview'],
          entryPoints: ['api-page', 'video-node'],
          primary: preset(
            'wan22-i2v',
            'Wan-AI/Wan2.2-I2V-A14B',
            'Wan 2.2 图生视频',
            'Wan 2.2 Image-to-Video',
            '适合主素材驱动的视频预览链路。',
            'Good for primary-asset-driven preview generation.',
          ),
          alternates: [
            preset('wan22-t2v', 'Wan-AI/Wan2.2-T2V-A14B', 'Wan 2.2 文生视频', 'Wan 2.2 Text-to-Video'),
          ],
        },
      ],
    },
  },
  deepseek: {
    id: 'deepseek',
    officialName: 'DeepSeek',
    aliases: ['deepseek'],
    docsUrl: 'https://platform.deepseek.com/api_keys',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    supportsRelay: true,
    relayHintZh: '如果聚合平台提供的是 DeepSeek 文本模型，DDUp 会优先把它们用于智能体、脚本和文案链路。',
    relayHintEn: 'If the relay provides DeepSeek text models, DDUp can surface them for agent and writing flows.',
    keyStepsZh: ['登录 DeepSeek 控制台', '打开 API Keys 页面', '创建新 Key 并复制到 DDUp'],
    keyStepsEn: ['Sign in to DeepSeek', 'Open API Keys', 'Create a new key and copy it'],
    recommendedDirectTasks: {
      llm: [
        {
          id: 'general-writing',
          titleZh: '脚本 / 文案',
          titleEn: 'Scripts and copy',
          summaryZh: '适合智能体计划、脚本草案、文案润色和节点参数整理。',
          summaryEn: 'A solid default for agent planning, script drafts, copy polishing, and parameter cleanup.',
          tagsZh: ['脚本', '文案', '智能体'],
          tagsEn: ['scripts', 'copy', 'agents'],
          entryPoints: ['api-page'],
          primary: preset('deepseek-chat', 'deepseek-chat', 'DeepSeek Chat', 'DeepSeek Chat'),
        },
      ],
    },
  },
  bailian: {
    id: 'bailian',
    officialName: '阿里云百炼',
    aliases: ['bailian', '百炼', '阿里云百炼', 'aliyun', 'dashscope'],
    docsUrl: 'https://bailian.console.aliyun.com/',
    consoleUrl: 'https://bailian.console.aliyun.com/',
    supportsRelay: true,
    relayHintZh: '如果聚合平台转发百炼 Wan 系列视频模型，DDUp 会同步图生视频、文生视频等能力到画布。',
    relayHintEn: 'If the relay forwards Bailian Wan models, DDUp will sync image-to-video and text-to-video options into the canvas.',
    keyStepsZh: ['登录百炼控制台', '进入 API Key 管理', '创建或复制可用 Key'],
    keyStepsEn: ['Sign in to Bailian', 'Open API key management', 'Create or copy a key'],
    recommendedDirectTasks: {
      llm: [
        {
          id: 'qwen37-multimodal',
          titleZh: 'Qwen3.7 多模态分析',
          titleEn: 'Qwen3.7 multimodal analysis',
          summaryZh: '百炼最新旗舰多模态模型，适合图片深度分析、提示词反推、构图风格解析和视频语义理解。',
          summaryEn: 'Latest flagship multimodal model for deep image analysis, prompt extraction, and video understanding.',
          tagsZh: ['深度分析', '多模态', '提示词反推', '视觉理解'],
          tagsEn: ['deep analysis', 'multimodal', 'prompt extraction', 'vision'],
          entryPoints: ['api-page'],
          primary: preset('qwen3.7-plus', 'qwen3.7-plus', 'Qwen3.7-Plus', 'Qwen3.7-Plus'),
        },
        {
          id: 'qwen-general',
          titleZh: '通义文本助手',
          titleEn: 'Qwen general assistant',
          summaryZh: '适合中文文案、脚本和与多模态链路配套的文本整理。',
          summaryEn: 'Good for Chinese copy, scripts, and textual support around multimodal workflows.',
          tagsZh: ['中文文案', '脚本', '参数整理'],
          tagsEn: ['Chinese copy', 'scripts', 'parameter cleanup'],
          entryPoints: ['api-page'],
          primary: preset('qwen-plus', 'qwen-plus', 'Qwen Plus', 'Qwen Plus'),
        },
      ],
      image: [
        {
          id: 'wanx-brand-image',
          titleZh: '商品图 / 广告图',
          titleEn: 'Product and ad image',
          summaryZh: '适合电商商品图、KV 和国内链路下的高效率图片生成。',
          summaryEn: 'A good domestic option for ecommerce product shots, brand key visuals, and fast image generation.',
          tagsZh: ['商品图', '广告图', '国内链路'],
          tagsEn: ['product', 'ad visual', 'domestic'],
          entryPoints: ['api-page', 'image-node'],
          primary: preset('wanx2-1', 'wanx2.1-t2i-turbo', '通义万相 Turbo', 'Wanx Turbo'),
        },
      ],
      video: [
        {
          id: 'happyhorse-video',
          titleZh: 'HappyHorse 多模态视频',
          titleEn: 'HappyHorse multimodal video',
          summaryZh: '百炼平台旗舰视频模型，支持文生视频、图生视频、动作迁移和视频编辑，比 wan 系列质量更高。',
          summaryEn: 'Flagship video model on Bailian, supporting T2V, I2V, action transfer and video editing with superior quality.',
          tagsZh: ['多模态视频', '动作迁移', '视频编辑', '高质量'],
          tagsEn: ['multimodal video', 'action transfer', 'video editing', 'high quality'],
          entryPoints: ['api-page', 'video-node'],
          primary: preset(
            'happyhorse-1.1',
            'happyhorse-1.1',
            'HappyHorse 1.1',
            'HappyHorse 1.1',
            '百炼旗舰视频模型，支持动作迁移和视频编辑，质量优于 wan 系列。',
            'Flagship video model on Bailian, superior to wan series in quality.',
          ),
        },
        {
          id: 'multimodal-video',
          titleZh: '多模态视频生成',
          titleEn: 'Multimodal video generation',
          summaryZh: '适合国内平台上的主体参考、全能参考和常规视频生成。',
          summaryEn: 'A strong domestic default for subject reference, omni reference, and standard video generation.',
          tagsZh: ['多模态视频', '主体参考', '全能参考'],
          tagsEn: ['multimodal video', 'subject reference', 'omni reference'],
          entryPoints: ['api-page', 'video-node'],
          primary: preset(
            'wan22-video',
            'wan2.2-video',
            'Wan 2.2 视频',
            'Wan 2.2 Video',
            '适合国内链路的多模态视频生成。',
            'Good default for domestic multimodal video generation.',
          ),
        },
      ],
    },
  },
  zhipu: {
    id: 'zhipu',
    officialName: '智谱 AI',
    aliases: ['zhipu', '智谱', 'bigmodel', 'glm'],
    docsUrl: 'https://open.bigmodel.cn/',
    consoleUrl: 'https://open.bigmodel.cn/',
    supportsRelay: true,
    relayHintZh: '适合通过聚合平台接入 GLM、CogView 等模型，后续也方便扩展更多国产多模态能力。',
    relayHintEn: 'Useful when a relay exposes GLM or CogView families that DDUp may map later.',
    keyStepsZh: ['登录智谱开放平台', '进入 API Key 页面', '创建并复制 Key'],
    keyStepsEn: ['Sign in to Zhipu', 'Open the API key page', 'Create and copy a key'],
    recommendedDirectTasks: {
      llm: [
        {
          id: 'glm-general',
          titleZh: '通用多轮助手',
          titleEn: 'General-purpose assistant',
          summaryZh: '适合作为国产替代的通用文本与策略推理入口。',
          summaryEn: 'A solid domestic option for general text and reasoning workflows.',
          tagsZh: ['通用助手', '文本', '推理'],
          tagsEn: ['assistant', 'text', 'reasoning'],
          entryPoints: ['api-page'],
          primary: preset('glm-4.5', 'glm-4.5', 'GLM-4.5', 'GLM-4.5'),
        },
      ],
      image: [
        {
          id: 'cogview-image',
          titleZh: '创意出图',
          titleEn: 'Creative image generation',
          summaryZh: '适合概念图、创意图和需要国产平台落地的图片场景。',
          summaryEn: 'Useful for concept art and creative image workflows on a domestic platform.',
          tagsZh: ['创意图', '概念图', '国产平台'],
          tagsEn: ['creative', 'concept', 'domestic'],
          entryPoints: ['api-page', 'image-node'],
          primary: preset('cogview-4', 'cogview-4', 'CogView 4', 'CogView 4'),
        },
      ],
      video: [
        {
          id: 'cogvideo-story-preview',
          titleZh: '视频预览与分镜验证',
          titleEn: 'Video preview and storyboard validation',
          summaryZh: '适合作为官方直连的视频预览、动效验证和轻量分镜生成入口。',
          summaryEn: 'A direct-provider entry for video preview, motion validation, and lightweight storyboard generation.',
          tagsZh: ['视频预览', '分镜验证', '国产视频'],
          tagsEn: ['video preview', 'storyboard', 'domestic video'],
          entryPoints: ['api-page', 'video-node'],
          primary: preset(
            'cogvideox-flash',
            'cogvideox-flash',
            'CogVideoX Flash',
            'CogVideoX Flash',
            '适合先打通智谱官方视频链路，再按能力矩阵决定是否开放更细的参考控制。',
            'Use this to light up Zhipu official video routing first, then unlock finer reference controls according to the capability matrix.',
          ),
          alternates: [
            preset('cogvideox-2', 'cogvideox-2', 'CogVideoX 2', 'CogVideoX 2'),
          ],
        },
      ],
    },
  },
  volcengine: {
    id: 'volcengine',
    officialName: '火山方舟',
    aliases: ['volcengine', '火山方舟', 'ark', 'doubao'],
    docsUrl: 'https://console.volcengine.com/ark',
    consoleUrl: 'https://console.volcengine.com/ark',
    supportsRelay: true,
    relayHintZh: '如果聚合平台里带有 Seedream 系列图片模型，DDUp 会把它们作为高质感商品图和广告图候选。',
    relayHintEn: 'If the relay contains Seedream image models, DDUp can surface them as premium product-image options.',
    keyStepsZh: ['登录火山方舟控制台', '进入 API Key 页面', '创建并复制 Key'],
    keyStepsEn: ['Sign in to Volcengine Ark', 'Open the API Key page', 'Create and copy a key'],
    recommendedDirectTasks: {
      image: [
        {
          id: 'premium-brand-visual',
          titleZh: '高质感品牌图',
          titleEn: 'Premium brand visual',
          summaryZh: '适合高质感商品图、广告图和品牌 KV 场景。',
          summaryEn: 'Best for premium product visuals, ad creatives, and brand key visuals.',
          tagsZh: ['高质感', '品牌 KV', '广告图'],
          tagsEn: ['premium', 'brand kv', 'ad visual'],
          entryPoints: ['api-page', 'image-node'],
          primary: preset(
            'doubao-seedream-5-0-pro',
            'doubao-seedream-5-0-pro',
            'Seedream 5.0 Pro',
            'Seedream 5.0 Pro',
            '火山方舟旗舰图片模型，最高质感与最强语义理解，适合品牌 KV 与广告大片。',
            'Ark flagship image model with top quality and strongest semantic understanding; ideal for brand KV and premium ad creatives.',
          ),
          alternates: [
            preset('doubao-seedream-5-0-lite', 'doubao-seedream-5-0-lite', 'Seedream 5.0 Lite', 'Seedream 5.0 Lite'),
            preset('seedream-4', 'seedream-4', 'Seedream 4.0', 'Seedream 4.0'),
          ],
        },
      ],
      video: [
        {
          id: 'seedance-subject-reference',
          titleZh: '参考角色与多模态视频',
          titleEn: 'Subject-reference and multimodal video',
          summaryZh: '适合主素材、参考角色和全能参考混合输入的视频生成与镜头延展。',
          summaryEn: 'Designed for mixed primary-asset, subject-reference, and omni-reference video generation.',
          tagsZh: ['参考角色', '多模态视频', '全能参考'],
          tagsEn: ['subject reference', 'multimodal video', 'omni reference'],
          entryPoints: ['api-page', 'video-node'],
          primary: preset(
            'doubao-seedance-2-0',
            'doubao-seedance-2-0',
            '豆包 Seedance 2.0',
            'Doubao Seedance 2.0',
            '火山方舟官方视频模型，支持文生/图生视频与首尾帧控制，适合中文商业片与角色参考。',
            'Ark official video model supporting T2V/I2V and first-last frame control; ideal for Chinese commercial films and subject reference.',
          ),
          alternates: [
            preset('seedance-v2', 'seedance-v2', 'Seedance V2', 'Seedance V2'),
          ],
        },
      ],
    },
  },
  minimax: {
    id: 'minimax',
    officialName: 'MiniMax',
    aliases: ['minimax'],
    docsUrl: 'https://platform.minimaxi.com/',
    consoleUrl: 'https://platform.minimaxi.com/',
    supportsRelay: true,
    relayHintZh: '适合把文本或音频相关模型挂到聚合平台，后续接入音频节点也更顺。',
    relayHintEn: 'Useful for text and audio-capable relays, especially for future audio-node expansion.',
    keyStepsZh: ['登录 MiniMax 平台', '打开 API Key 页面', '创建并复制 Key'],
    keyStepsEn: ['Sign in to MiniMax', 'Open the API key page', 'Create and copy a key'],
    recommendedDirectTasks: {
      llm: [
        {
          id: 'abab-general',
          titleZh: '文本助手',
          titleEn: 'Text assistant',
          summaryZh: '适合作为常规文本、脚本和摘要整理入口。',
          summaryEn: 'Useful for standard text, scripts, and summarization.',
          tagsZh: ['文本', '脚本', '摘要'],
          tagsEn: ['text', 'scripts', 'summary'],
          entryPoints: ['api-page'],
          primary: preset('abab6.5s', 'abab6.5s-chat', 'abab 6.5s', 'abab 6.5s'),
        },
      ],
      audio: [
        {
          id: 'speech-preview',
          titleZh: '音频 / 语音预览',
          titleEn: 'Audio and speech preview',
          summaryZh: '适合作为后续远程音频链路的官方直连候选。',
          summaryEn: 'A direct-provider starting point for future remote audio workflows.',
          tagsZh: ['音频', '语音', '预览'],
          tagsEn: ['audio', 'speech', 'preview'],
          entryPoints: ['api-page', 'audio-node'],
          primary: preset('speech-02', 'speech-02', 'Speech 02', 'Speech 02'),
        },
      ],
    },
  },
  modelscope: {
    id: 'modelscope',
    officialName: 'ModelScope',
    aliases: ['modelscope', '魔搭', 'model scope'],
    docsUrl: 'https://www.modelscope.cn/',
    consoleUrl: 'https://www.modelscope.cn/',
    supportsRelay: true,
    relayHintZh: '适合后续把更多开源模型通过兼容网关接入 DDUp，作为免费或本地链路补充。',
    relayHintEn: 'Useful when extending DDUp with more open-source models via a compatible gateway.',
    keyStepsZh: ['登录 ModelScope', '进入访问令牌设置', '创建并复制 Token'],
    keyStepsEn: ['Sign in to ModelScope', 'Open access token settings', 'Create and copy a token'],
    recommendedDirectTasks: {
      llm: [
        {
          id: 'open-source-general',
          titleZh: '开源文本助手',
          titleEn: 'Open-source text assistant',
          summaryZh: '适合本地化或开源优先的文本与策略链路。',
          summaryEn: 'A good fit for open-source-first text and reasoning workflows.',
          tagsZh: ['开源', '文本', '推理'],
          tagsEn: ['open source', 'text', 'reasoning'],
          entryPoints: ['api-page'],
          primary: preset('qwen2.5-72b', 'Qwen/Qwen2.5-72B-Instruct', 'Qwen 2.5 72B', 'Qwen 2.5 72B'),
        },
      ],
      image: [
        {
          id: 'open-image-generation',
          titleZh: '开源图片生成',
          titleEn: 'Open image generation',
          summaryZh: '适合把开源图片模型接进官方直连或后续兼容网关。',
          summaryEn: 'Useful when you want an open-model image path through a direct or compatible gateway.',
          tagsZh: ['开源图片', '兼容网关', '图片生成'],
          tagsEn: ['open image', 'gateway', 'image generation'],
          entryPoints: ['api-page', 'image-node'],
          primary: preset('qwen-image-open', 'Qwen/Qwen-Image', 'Qwen 图片', 'Qwen Image'),
        },
      ],
      video: [
        {
          id: 'wan-open-video',
          titleZh: '开源视频生成',
          titleEn: 'Open video generation',
          summaryZh: '适合作为开源优先的视频生成和多模态参考验证入口，方便后续接本地或兼容网关。',
          summaryEn: 'A good fit for open-source-first video generation and multimodal reference validation through direct or compatible gateways.',
          tagsZh: ['开源视频', '多模态参考', '兼容网关'],
          tagsEn: ['open video', 'multimodal reference', 'gateway'],
          entryPoints: ['api-page', 'video-node'],
          primary: preset(
            'wan22-i2v-open',
            'Wan-AI/Wan2.2-I2V-A14B',
            'Wan 2.2 图生视频',
            'Wan 2.2 Image-to-Video',
            '适合主素材驱动的视频预览和开源视频链路验证。',
            'Good for primary-asset-driven previews and open video pipeline validation.',
          ),
          alternates: [
            preset('wan22-t2v-open', 'Wan-AI/Wan2.2-T2V-A14B', 'Wan 2.2 文生视频', 'Wan 2.2 Text-to-Video'),
          ],
        },
      ],
    },
  },
  openai: {
    id: 'openai',
    officialName: 'OpenAI',
    aliases: ['openai', 'open ai'],
    docsUrl: 'https://platform.openai.com/api-keys',
    consoleUrl: 'https://platform.openai.com/api-keys',
    supportsRelay: true,
    relayHintZh: '大多数聚合平台兼容 OpenAI 协议，DDUp 会按模型能力而不是上游归属来映射画布节点。',
    relayHintEn: 'Most aggregators speak the OpenAI-compatible protocol, and DDUp maps canvas models by capability rather than raw ownership.',
    keyStepsZh: ['登录 OpenAI Platform', '打开 API Keys 页面', '创建 Secret Key 并复制'],
    keyStepsEn: ['Sign in to OpenAI Platform', 'Open API Keys', 'Create a secret key and copy it'],
    recommendedDirectTasks: {
      llm: [
        {
          id: 'prompt-interrogation',
          titleZh: '图片解析 / 提示词反推',
          titleEn: 'Image analysis and prompt interrogation',
          summaryZh: '适合作为图片解析、反推提示词和主体/构图理解的统一入口。',
          summaryEn: 'A unified direct-provider choice for image analysis, reverse prompting, and subject/composition understanding.',
          tagsZh: ['图片解析', '提示词反推', '主体 / 构图'],
          tagsEn: ['image analysis', 'reverse prompt', 'subject / composition'],
          entryPoints: ['api-page', 'image-analysis', 'reverse-prompt'],
          primary: preset('gpt-4.1-analysis', 'gpt-4.1', 'GPT-4.1', 'GPT-4.1'),
        },
        {
          id: 'video-semantic-analysis',
          titleZh: '视频语义解析',
          titleEn: 'Video semantic analysis',
          summaryZh: '适合作为关键帧理解、分镜拆解和视频语义补强的官方直连入口。',
          summaryEn: 'A direct-provider option for keyframe understanding, shot breakdown, and video semantic enhancement.',
          tagsZh: ['视频解析', '关键帧', '分镜拆解'],
          tagsEn: ['video analysis', 'keyframes', 'shot breakdown'],
          entryPoints: ['api-page', 'video-analysis'],
          primary: preset('gpt-4.1-video-analysis', 'gpt-4.1', 'GPT-4.1', 'GPT-4.1'),
        },
      ],
      image: [
        {
          id: 'high-fidelity-image-edit',
          titleZh: '高保真图片生成 / 编辑',
          titleEn: 'High-fidelity image generation and edit',
          summaryZh: '适合作为高质量图片生成、局部编辑和参考图融合的官方直连方案。',
          summaryEn: 'A direct-provider fit for high-quality image generation, local edits, and reference-based blends.',
          tagsZh: ['图片生成', '图片编辑', '参考融合'],
          tagsEn: ['image generation', 'image editing', 'reference blend'],
          entryPoints: ['api-page', 'image-node'],
          primary: preset('gpt-image-1', 'gpt-image-1', 'GPT Image 1', 'GPT Image 1'),
        },
      ],
    },
  },
  fal: {
    id: 'fal',
    officialName: 'fal.ai',
    aliases: ['fal', 'fal.ai'],
    docsUrl: 'https://fal.ai/dashboard/keys',
    consoleUrl: 'https://fal.ai/dashboard/keys',
    supportsRelay: false,
    relayHintZh: '通常更适合官方直连，尤其是 FLUX Pro、Seedance 等高质量图像/视频模型。',
    relayHintEn: 'Usually best used directly, especially for FLUX Pro and Seedance families.',
    keyStepsZh: ['登录 fal.ai Dashboard', '进入 Keys 页面', '创建并复制 API Key'],
    keyStepsEn: ['Sign in to fal.ai', 'Open Keys', 'Create and copy an API key'],
    recommendedDirectTasks: {
      image: [
        {
          id: 'flux-brand-visual',
          titleZh: '品牌图 / 广告图',
          titleEn: 'Brand and ad visual',
          summaryZh: '适合高质感商品图、海报和品牌视觉。',
          summaryEn: 'Strong for premium product visuals, posters, and branded creatives.',
          tagsZh: ['FLUX', '商品图', '品牌图'],
          tagsEn: ['FLUX', 'product', 'brand'],
          entryPoints: ['api-page', 'image-node'],
          primary: preset('flux-pro', 'flux-pro', 'FLUX Pro', 'FLUX Pro'),
        },
      ],
      video: [
        {
          id: 'seedance-subject-reference',
          titleZh: '参考角色 / 全能参考视频',
          titleEn: 'Reference subject and omni-reference video',
          summaryZh: '适合主体参考、参考角色和全能参考的视频链路。',
          summaryEn: 'Best for subject reference, character reference, and omni-reference video workflows.',
          tagsZh: ['参考角色', '主体参考', '全能参考'],
          tagsEn: ['character reference', 'subject reference', 'omni reference'],
          entryPoints: ['api-page', 'video-node'],
          primary: preset('seedance-v2', 'seedance-v2', 'Seedance V2', 'Seedance V2'),
        },
      ],
    },
  },
  replicate: {
    id: 'replicate',
    officialName: 'Replicate',
    aliases: ['replicate'],
    docsUrl: 'https://replicate.com/account/api-tokens',
    consoleUrl: 'https://replicate.com/account/api-tokens',
    supportsRelay: false,
    relayHintZh: '更适合官方直连，方便保持模型标识和账单来源清晰一致。',
    relayHintEn: 'Direct usage is usually clearer for model identity and billing.',
    keyStepsZh: ['登录 Replicate', '打开 API tokens 页面', '创建并复制 Token'],
    keyStepsEn: ['Sign in to Replicate', 'Open API tokens', 'Create and copy a token'],
    recommendedDirectTasks: {
      image: [
        {
          id: 'fast-open-image',
          titleZh: '快速开源出图',
          titleEn: 'Fast open image generation',
          summaryZh: '适合快速验证开源图片链路和低成本出图。',
          summaryEn: 'Good for quick open-model image validation and lower-cost image runs.',
          tagsZh: ['开源', '快速出图', '低成本'],
          tagsEn: ['open source', 'fast image', 'lower cost'],
          entryPoints: ['api-page', 'image-node'],
          primary: preset('flux-schnell', 'black-forest-labs/flux-schnell', 'FLUX Schnell', 'FLUX Schnell'),
        },
      ],
      video: [
        {
          id: 'wan-preview-video',
          titleZh: '视频预览链路',
          titleEn: 'Video preview flow',
          summaryZh: '适合视频预览、图生视频和低门槛验证链路。',
          summaryEn: 'A practical choice for preview video, image-to-video, and lower-friction validation.',
          tagsZh: ['预览视频', '图生视频', '验证链路'],
          tagsEn: ['preview', 'image-to-video', 'validation'],
          entryPoints: ['api-page', 'video-node'],
          primary: preset('wan21-i2v', 'wavespeedai/wan-2.1-i2v-720p', 'Wan 2.1 图生视频', 'Wan 2.1 Image-to-Video'),
        },
      ],
    },
  },
  kling: {
    id: 'kling',
    officialName: 'Kling AI',
    aliases: ['kling', 'kling ai', '可灵'],
    docsUrl: 'https://app.klingai.com/',
    consoleUrl: 'https://app.klingai.com/',
    supportsRelay: false,
    relayHintZh: '如果直接连接 Kling，DDUp 会优先把它用于强参考控制、主体一致性和全能参考视频链路。',
    relayHintEn: 'If you connect Kling directly, DDUp prefers it for strong reference control and subject consistency in video flows.',
    keyStepsZh: ['登录 Kling 开发平台', '进入 API / 凭证页面', '创建并复制 Key'],
    keyStepsEn: ['Sign in to Kling', 'Open the API / credentials page', 'Create and copy a key'],
    recommendedDirectTasks: {
      image: [
        {
          id: 'kling-image-reference-edit',
          titleZh: '参考图驱动图片编辑',
          titleEn: 'Reference-driven image edit',
          summaryZh: '适合主图 + 参考图的重组、换主体和视觉统一。',
          summaryEn: 'Useful for primary-image plus reference-image recomposition, subject swap, and visual unification.',
          tagsZh: ['参考图', '换主体', '视觉统一'],
          tagsEn: ['reference image', 'subject swap', 'visual consistency'],
          entryPoints: ['api-page', 'image-node'],
          primary: preset('kling-image-2', 'kling-image-2', 'Kling Image 2', 'Kling Image 2'),
        },
      ],
      video: [
        {
          id: 'subject-replace-keep-motion',
          titleZh: '保运镜换主体',
          titleEn: 'Keep motion, swap subject',
          summaryZh: '适合保留原运镜、镜头节奏和主体动作，再替换参考主体。',
          summaryEn: 'Best for preserving camera motion and timing while swapping in a reference subject.',
          tagsZh: ['保运镜换主体', '主体一致性', '镜头节奏'],
          tagsEn: ['keep motion', 'subject consistency', 'camera rhythm'],
          entryPoints: ['api-page', 'video-node'],
          primary: preset(
            'kling-video',
            'kling-video',
            'Kling Video',
            'Kling Video',
            '适合多模态视频生成、参考主体锁定和全能参考。',
            'Best for multimodal video generation, subject locking, and omni-reference flows.',
          ),
        },
        {
          id: 'omni-reference-keep-motion',
          titleZh: '主体 + 全能参考',
          titleEn: 'Subject plus omni reference',
          summaryZh: '适合把主体参考、风格参考和附加参考一起并入视频生成。',
          summaryEn: 'Best for combining subject, style, and supporting references in one video generation request.',
          tagsZh: ['全能参考', '主体参考', '多模态视频'],
          tagsEn: ['omni reference', 'subject reference', 'multimodal video'],
          entryPoints: ['api-page', 'video-node'],
          primary: preset('kling-video-omni', 'kling-video', 'Kling Video', 'Kling Video'),
        },
      ],
    },
  },
};

export const RELAY_PRESETS: RelayPreset[] = [
  {
    id: 'apimart',
    nameZh: 'APIMart 聚合平台',
    nameEn: 'APIMart Aggregator',
    docsUrl: 'https://apimart.ai/zh',
    consoleUrl: 'https://apimart.ai/zh',
    baseUrlExample: 'https://api.apimart.ai/v1',
    descriptionZh: '适合接入 APIMart 这类 OpenAI 兼容聚合平台。DDUp 会优先读取 /models，并把可映射到画布的主流多模态模型同步出来。',
    descriptionEn: 'Best for APIMart-style OpenAI-compatible aggregators. DDUp reads /models first and then syncs mainstream multimodal models that can map into the canvas.',
    endpointHintZh: 'APIMart 统一填写 https://api.apimart.ai/v1。即使控制台或文档里出现 apimart.ai、www.apimart.ai 或语言路径，系统也会自动归一化到这个地址。',
    endpointHintEn: 'Use https://api.apimart.ai/v1 for APIMart. Even if the console or docs show apimart.ai, www.apimart.ai, or locale paths, DDUp normalizes them to this endpoint.',
    recommendedProviders: ['openai', 'kling', 'fal', 'bailian', 'siliconflow'],
    recommendedModels: {
      image: ['qwen-image-2.0', 'grok-imagine-1.5-edit-apimart', 'gpt-image-2', 'doubao-seedream-5.0-lite', 'gemini-3-pro-image-preview'],
      video: ['kling-v3-omni', 'seedance-v2', 'happyhorse-1.1', 'veo3.1', 'runway'],
      llm: ['omni', 'gemini-3.1', 'deepseek-chat'],
      audio: ['suno_music'],
    },
  },
  {
    id: 'comfly',
    nameZh: 'Comfly 聚合平台',
    nameEn: 'Comfly Aggregator',
    docsUrl: 'https://ai.comfly.org/models',
    consoleUrl: 'https://ai.comfly.org/dashboard',
    baseUrlExample: 'https://ai.comfly.org/v1',
    descriptionZh: '适合用一个 Key 统一接入多家上游模型。DDUp 会自动拉取模型列表，筛出主流多模态模型，并同步进画布节点。',
    descriptionEn: 'Use one key to access multiple upstream model families. DDUp fetches the model list, recommends mainstream multimodal models, and syncs supported ones into the canvas.',
    endpointHintZh: '优先填写控制台显示的 OpenAI 兼容 Base URL；如果没有单独展示，通常可先用 https://ai.comfly.org/v1。',
    endpointHintEn: 'Prefer the OpenAI-compatible Base URL shown in your console. If none is listed, Comfly usually starts from https://ai.comfly.org/v1.',
    recommendedProviders: ['kling', 'siliconflow', 'fal', 'bailian', 'deepseek'],
    recommendedModels: {
      image: ['Qwen/Qwen-Image', 'doubao-seedream5-0', 'flux-pro', 'image2', 'nano-banana-pro', 'mj_relax'],
      video: ['kling-video', 'doubao-seedance-2-0', 'veo3.1', 'runway', 'grok-1.5-video', 'Wan-AI/Wan2.2-I2V-A14B'],
      llm: ['deepseek-chat', 'gemini-3.1', 'omni'],
      audio: ['suno_music'],
    },
  },
  {
    id: 'suanliai',
    nameZh: '算力聚合平台',
    nameEn: 'Suanliai Aggregator',
    docsUrl: 'https://www.suanliai.top/pricing',
    consoleUrl: 'https://www.suanliai.top/pricing',
    baseUrlExample: 'https://www.suanliai.top/v1',
    descriptionZh: '适合接入算力聚合平台这类 OpenAI 兼容中转。DDUp 会优先尝试读取 /models，并同步主流多模态模型到画布。',
    descriptionEn: 'Best for OpenAI-compatible relay platforms like Suanliai. DDUp tries /models first, then syncs mainstream multimodal models that can be mapped into the canvas.',
    endpointHintZh: '优先填写平台控制台给出的 Base URL；如果没有单独展示，可先尝试 https://www.suanliai.top/v1。模型目录以运行时发现结果为准。',
    endpointHintEn: 'Prefer the exact Base URL shown in the platform console. If none is shown, start with https://www.suanliai.top/v1. The model catalog is discovered at runtime.',
    recommendedProviders: ['kling', 'siliconflow', 'fal', 'bailian', 'deepseek'],
    recommendedModels: {
      image: ['Qwen/Qwen-Image', 'doubao-seedream5-0', 'flux-pro', 'image2', 'nano-banana-pro'],
      video: ['kling-video', 'doubao-seedance-2-0', 'veo3.1', 'runway', 'Wan-AI/Wan2.2-I2V-A14B'],
      llm: ['deepseek-chat', 'gemini-3.1', 'omni'],
      audio: ['suno_music'],
    },
  },
  {
    id: 'generic-openai-relay',
    nameZh: '通用 OpenAI 兼容聚合平台',
    nameEn: 'Generic OpenAI-Compatible Relay',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    consoleUrl: 'https://platform.openai.com/api-keys',
    baseUrlExample: 'https://your-relay.example.com/v1',
    descriptionZh: '用于任意 OpenAI 兼容中转站。DDUp 会先发现模型列表，再自动激活能映射到画布的模型。',
    descriptionEn: 'Works with any OpenAI-compatible relay. DDUp discovers the model list first, then activates models that can be mapped to the canvas.',
    endpointHintZh: '填写中转站文档提供的完整 Base URL，通常以 /v1 结尾。',
    endpointHintEn: 'Paste the full Base URL from your relay docs, usually ending with /v1.',
    recommendedProviders: ['kling', 'siliconflow', 'fal', 'bailian', 'openai'],
    recommendedModels: {
      image: ['Qwen/Qwen-Image', 'doubao-seedream5-0', 'flux-pro', 'image2', 'nano-banana-pro'],
      video: ['kling-video', 'doubao-seedance-2-0', 'veo3.1', 'runway', 'Wan-AI/Wan2.2-I2V-A14B'],
      llm: ['deepseek-chat', 'gemini-3.1', 'omni'],
      audio: ['suno_music'],
    },
  },
];

function normalizeProviderToken(value: string | null | undefined) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_/-]+/g, '');
}

function localizeTags(isZh: boolean, task: OfficialModelRecommendationTask) {
  return (isZh ? task.tagsZh : task.tagsEn) || task.tagsZh || task.tagsEn || [];
}

function collectRecommendedModels(tasks: OfficialModelRecommendationTask[]) {
  const ordered: OfficialModelPreset[] = [];
  const seen = new Set<string>();

  const push = (item?: OfficialModelPreset | null) => {
    if (!item) return;
    const key = `${item.id}::${item.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(item);
  };

  for (const task of tasks) {
    push(task.primary);
    for (const alternate of task.alternates || []) {
      push(alternate);
    }
  }

  return ordered;
}

export function getProviderGuide(providerId: string): ProviderGuide | null {
  return PROVIDER_GUIDES[providerId] || null;
}

export function getRelayPreset(presetId: string): RelayPreset | null {
  return RELAY_PRESETS.find((item) => item.id === presetId) || null;
}

export function resolveProviderGuideId(value: string | null | undefined): string | null {
  const normalized = normalizeProviderToken(value);
  if (!normalized) return null;

  for (const guide of Object.values(PROVIDER_GUIDES)) {
    if (normalizeProviderToken(guide.id) === normalized) return guide.id;
    if (normalizeProviderToken(guide.officialName) === normalized) return guide.id;
    if ((guide.aliases || []).some((alias) => normalizeProviderToken(alias) === normalized)) {
      return guide.id;
    }
  }

  return null;
}

export function getDirectRecommendationTasks(
  providerId: string,
  mode: ProviderGuideMode,
  entryPoint?: DirectRecommendationEntryPoint,
): OfficialModelRecommendationTask[] {
  const guide = PROVIDER_GUIDES[providerId];
  const tasks = guide?.recommendedDirectTasks?.[mode] || [];
  if (!entryPoint) return tasks;
  return tasks.filter((task) => !task.entryPoints?.length || task.entryPoints.includes(entryPoint));
}

export function getRecommendedDirectModels(
  providerId: string,
  mode: ProviderGuideMode,
  entryPoint?: DirectRecommendationEntryPoint,
): OfficialModelPreset[] {
  const tasks = getDirectRecommendationTasks(providerId, mode, entryPoint);
  return collectRecommendedModels(tasks);
}

export function getPrimaryDirectModel(
  providerId: string,
  mode: ProviderGuideMode,
  entryPoint?: DirectRecommendationEntryPoint,
): OfficialModelPreset | null {
  return getDirectRecommendationTasks(providerId, mode, entryPoint)[0]?.primary || null;
}

export function getLocalizedTaskTags(
  task: OfficialModelRecommendationTask,
  isZh: boolean,
): string[] {
  return localizeTags(isZh, task);
}
// PATCHED_MARKER_2026
