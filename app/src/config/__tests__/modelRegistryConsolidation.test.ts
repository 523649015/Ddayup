/**
 * 依赖归集防回归测试 —— 防止再次出现「85 个 TS 错误」这类模型/插件漂移。
 *
 * 核心断言：
 *  1. 各节点功能（运动模糊 / 抠像 / 景深 / 新视角 / 翻译 / 放大 / 去背 / 修复）
 *     声明的 model id 必须全部登记在统一数据源（PRESET_MODELS / MODEL_PLUGINS / 运行时卡片）中，
 *     否则面板无法下载、功能不可用。
 *  2. NLLB-200 翻译必须作为单一数据源纳入 PRESET_MODELS（browserRuntime:'nllb'），
 *     且加载器内部 MODEL_PLUGINS 的 id 与之保持一致（防止双注册表再次漂移）。
 *  3. PRESET_MODELS 内部无重复 id。
 *  4. 每个 localRunner 模型都能在 PRESET_MODELS 找到约定 id（下载→激活对齐）。
 *
 * 该测试位于 src 内、以 .test.ts 结尾，因此：
 *  - 被 vitest 收录（CI 的 unit-tests 阶段执行）；
 *  - 但被 tsconfig.app.json 排除，不进入生产构建（部署构建不受测试类型漂移影响）。
 */

import { PRESET_MODELS } from '@/config/presetModels';
import { MODEL_PLUGINS } from '@/services/localTranslate';
import { RAFT_MODEL_ID } from '@/services/postFX/motionBlur';
import { MATTING_MODEL_IDS } from '@/services/postFX/matting';
import { NOVEL_VIEW_MODEL_ID } from '@/services/novelViewSynthesis';

// 后期运行时依赖卡片（G'MIC / OpenImageIO / OpenColorIO）—— 不在 PRESET_MODELS，属于面板运行时卡片
const RUNTIME_CARD_IDS = ['oiio', 'gmic', 'ocio'];

describe('模型/插件归集防回归（依赖漂移防护）', () => {
  const registeredIds = new Set<string>([
    ...PRESET_MODELS.map((m) => m.id),
    ...MODEL_PLUGINS.map((p) => p.id),
    ...RUNTIME_CARD_IDS,
  ]);

  // 节点功能声明的 model id（取自各 feature service 的常量导出，而非硬编码字符串）
  const declaredModelIds = [
    RAFT_MODEL_ID, // 'raft-optical-flow' — 运动模糊光流
    MATTING_MODEL_IDS.birefnet, // 'birefnet-matting' — 一键抠像
    NOVEL_VIEW_MODEL_ID, // 'novel-view-gen' — 新视角
    'depth-anything-v3-base', // 景深默认引擎（postEffectPresets / depthDof）
    'depth-anything-v2-small', // 景深兜底引擎（localInference 自动回退）
    'rife-frame-interpolation', // 客户端 GPU 运动模糊 framegen（gpuMotionBlur）
    'real-esrgan-x4', // 图片放大（imageModelRouting）
    'lama-inpaint', // 局部修复/去瑕疵（imageModelRouting）
    'imgly-bgremoval', // 智能去背（imageModelRouting）
    'webgpu-video-motion-blur', // 客户端 GPU 运动模糊管线能力
    'nllb-200-translation', // 提示词翻译（localTranslate）
  ];

  it('节点功能声明的 model id 全部登记在统一数据源（PRESET_MODELS / MODEL_PLUGINS / 运行时卡片）', () => {
    const missing = declaredModelIds.filter((id) => !registeredIds.has(id));
    expect(missing, `以下模型被节点功能依赖但不在任何面板数据源中：${missing.join(', ')}`).toEqual([]);
  });

  it("NLLB-200 翻译作为单一数据源纳入 PRESET_MODELS（browserRuntime:'nllb'），且与加载器注册表一致", () => {
    const nllb = PRESET_MODELS.find((m) => m.browserRuntime === 'nllb');
    expect(nllb, 'PRESET_MODELS 缺少 browserRuntime:"nllb" 的 NLLB 条目').toBeDefined();
    expect(MODEL_PLUGINS[0]?.id, '加载器 MODEL_PLUGINS 与 PRESET_MODELS 的 NLLB id 不一致').toBe(nllb!.id);
    expect(registeredIds.has(nllb!.id), 'NLLB id 未进入面板注册表集合').toBe(true);
  });

  it('PRESET_MODELS 内部无重复 id（防止面板数据漂移）', () => {
    const ids = PRESET_MODELS.map((m) => m.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates, `PRESET_MODELS 存在重复 id：${duplicates.join(', ')}`).toEqual([]);
  });

  it('每个 localRunner 模型都能在 PRESET_MODELS 找到约定 id（下载→激活对齐）', () => {
    const runnerToId: Record<string, string> = {
      esrgan: 'real-esrgan-x4',
      lama: 'lama-inpaint',
      imgly: 'imgly-bgremoval',
      'depth-anything-v2': 'depth-anything-v2-small',
      'depth-anything-v3': 'depth-anything-v3-base',
      rmbg: 'birefnet-matting',
      raft: 'raft-optical-flow',
    };
    for (const m of PRESET_MODELS) {
      if (!m.localRunner) continue;
      expect(runnerToId[m.localRunner], `PRESET_MODELS 中 localRunner "${m.localRunner}" 未映射到约定 id`).toBeDefined();
      expect(m.id, `模型 ${m.id} 的 localRunner 与约定 id 不一致`).toBe(runnerToId[m.localRunner]);
    }
  });
});
