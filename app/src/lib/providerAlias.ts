/**
 * Provider id 统一归一化（单一数据源）。
 *
 * 背景：同一平台在后端 catalog / runtime / byok-providers、以及前端节点、
 * ApiKeysPage 之间，provider id 可能以不同别名或大小写出现（例如火山方舟
 * 会以 volcengine / ark / doubao / volcano 等形式出现，硅基流动会以
 * siliconflow / silicon-flow / siliconcloud 出现）。
 *
 * 若「存储 key（setKey）」与「校验激活（isActive/findProviderKeyState/
 * resolveGenerationAccess）」两端使用的 provider id 归一化规则不一致，就会
 * 出现「明明已激活却反复要求激活」的 bug。
 *
 * 因此把归一化逻辑收敛到本模块，store 与 generation 服务共用，保证两端对称。
 */

/** provider 别名 → 规范 id 映射。key 必须为已去前缀 + 小写形式。 */
export const PROVIDER_ALIAS_MAP: Record<string, string> = {
  'silicon-flow': 'siliconflow',
  siliconflow: 'siliconflow',
  silicon_flow: 'siliconflow',
  siliconcloud: 'siliconflow',
  silicon: 'siliconflow',
  volc: 'volcengine',
  volcano: 'volcengine',
  volcengine: 'volcengine',
  volcengineark: 'volcengine',
  ark: 'volcengine',
  doubao: 'volcengine',
  'doubao-seedream-5-0-lite': 'volcengine',
  'doubao-seedream-5-0-pro': 'volcengine',
  'doubao-seedream-4-0': 'volcengine',
  bytedance: 'volcengine',
  wanx: 'bailian',
  wan: 'bailian',
  dashscope: 'bailian',
  bailian: 'bailian',
  aliyun: 'bailian',
  qwen: 'bailian',
  tongyi: 'bailian',
  kling: 'kling',
  kolors: 'kling',
  kwai: 'kling',
  minimax: 'minimax',
  hailuo: 'minimax',
  zhipu: 'zhipu',
  glm: 'zhipu',
  bigmodel: 'zhipu',
  deepseek: 'deepseek',
  openai: 'openai',
  gpt: 'openai',
  fal: 'fal',
  'fal-ai': 'fal',
  falai: 'fal',
  replicate: 'replicate',
  modelscope: 'modelscope',
  'model-scope': 'modelscope',
};

/**
 * 把任意 provider id 归一化为规范 id。
 * - 去掉 `hmdao-` 前缀
 * - 小写、去空白
 * - 命中别名表则映射为规范 id，否则原样返回（去前缀后的小写形式）
 */
export function normalizeProviderId(value?: string | null): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  const withoutPrefix = raw.startsWith('hmdao-') ? raw.slice('hmdao-'.length) : raw;
  return PROVIDER_ALIAS_MAP[withoutPrefix] ?? withoutPrefix;
}
