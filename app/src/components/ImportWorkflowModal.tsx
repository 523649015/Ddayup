import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { NodeType } from '@/types';
import { useCanvasStore } from '@/store/useCanvasStore';
import type { WorkflowStep } from '@/store/useCanvasStore';
import { parseComfyUIWorkflow, parseComfyUIWorkflowAsSingleNode } from '@/services/workflowEngine';
import { comfyValidate, type ComfyValidateResult } from '@/services/comfyui/comfyuiClient';

/**
 * 统一的「导入工作流」面板：把原先分散的三处入口收敛到一起
 *  1) 从 ComfyUI 导入（粘贴/选择 JSON，支持「展开为节点」或「单个 ComfyUI 节点」两种模式）
 *  2) 导入 HMDao 画布 JSON（复用 importCanvas）
 *  3) 内置工作流模板（原生骨架模板 + 可绑定 ComfyUI 工作流的模板）
 */

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  nodes: { type: NodeType; x: number; y: number }[];
  tags: string[];
  comfyJson?: string;
  /** 是否允许「展开为节点」导入（展开后 LoadImage→图片端口、CLIPTextEncode→提示词端口，可上传/填写） */
  expandable?: boolean;
}

// 把 ComfyUI 节点类型归类为「输入来源」及其可读标签，用于在导入面板明确端口类型
// （图片 / 提示词 / 视频 / 音频），避免用户不知道该连什么、端口是文本还是图片。
function comfyInputSource(type: string): { kind: 'image' | 'text' | 'video' | 'audio'; label: string } | null {
  const t = (type || '').toLowerCase();
  if (t.startsWith('loadimage') || t.includes('inputimage') || t.includes('loadimagemask')) {
    return { kind: 'image', label: '原图/图片' };
  }
  if (t.startsWith('loadvideo') || t.includes('vhs_loadvideo')) {
    return { kind: 'video', label: '视频' };
  }
  if (t.startsWith('loadaudio')) {
    return { kind: 'audio', label: '音频' };
  }
  if (t.startsWith('cliptextencode') || t.includes('textencode') || t.includes('prompt')) {
    return { kind: 'text', label: '提示词' };
  }
  return null;
}

function comfyOutputSink(type: string): { kind: 'image' | 'text' | 'video' | 'audio'; label: string } | null {
  const t = (type || '').toLowerCase();
  if (t.startsWith('saveimage') || t.includes('previewimage') || t.startsWith('vaedecode')) {
    return { kind: 'image', label: '图片' };
  }
  if (t.includes('vhs_videocombine') || t.includes('savevideo')) {
    return { kind: 'video', label: '视频' };
  }
  if (t.startsWith('saveaudio')) {
    return { kind: 'audio', label: '音频' };
  }
  return null;
}

// Klein 一致性增强 v2（精简版）：保留 V2 生成分支（Klein 9B + 一致性V2/一致性增强 两个 LoRA + 4 步 distilled），
// 参考图经原生 LoadImage 暴露为图片端口、提示词经原生 CLIPTextEncode 暴露为文本端口；去掉 rgthree/LayerStyle/AlekPet
// 等展示层自定义节点，仅依赖原生节点 + 5 个模型（Flux-2-Klein-9b-fp8 / qwen_3_8b_fp8mixed / flux2-vae / 两个 LoRA）。
const COMFY_KLEIN_V2_LEAN = JSON.stringify(
  {
    151: { inputs: { sampler_name: 'euler' }, class_type: 'KSamplerSelect', _meta: { title: 'KSamplerSelect' } },
    152: { inputs: { steps: 4, width: ['157', 1], height: ['157', 1] }, class_type: 'Flux2Scheduler', _meta: { title: 'Flux2Scheduler' } },
    153: { inputs: { cfg: 1, model: ['358', 0], positive: ['159', 0], negative: ['160', 0] }, class_type: 'CFGGuider', _meta: { title: 'CFG Guider' } },
    154: { inputs: { noise: ['158', 0], guider: ['153', 0], sampler: ['151', 0], sigmas: ['152', 0], latent_image: ['156', 0] }, class_type: 'SamplerCustomAdvanced', _meta: { title: 'SamplerCustomAdvanced' } },
    155: { inputs: { samples: ['154', 0], vae: ['174', 0] }, class_type: 'VAEDecode', _meta: { title: 'VAE Decode' } },
    156: { inputs: { width: ['157', 0], height: ['157', 1], batch_size: 1 }, class_type: 'EmptyFlux2LatentImage', _meta: { title: 'Empty Flux 2 Latent' } },
    157: { inputs: { image: ['291', 0] }, class_type: 'GetImageSize', _meta: { title: 'GetImageSize' } },
    158: { inputs: { noise_seed: 402491872186975 }, class_type: 'RandomNoise', _meta: { title: 'RandomNoise' } },
    159: { inputs: { conditioning: ['168', 0], latent: ['162', 0] }, class_type: 'ReferenceLatent', _meta: { title: 'Set Reference Latent' } },
    160: { inputs: { conditioning: ['167', 0], latent: ['162', 0] }, class_type: 'ReferenceLatent', _meta: { title: 'Set Reference Latent' } },
    162: { inputs: { pixels: ['291', 0], vae: ['174', 0] }, class_type: 'VAEEncode', _meta: { title: 'VAE Encode' } },
    167: { inputs: { conditioning: ['168', 0] }, class_type: 'ConditioningZeroOut', _meta: { title: 'Conditioning Zero Out' } },
    168: { inputs: { text: '变为冬天', clip: ['361', 0] }, class_type: 'CLIPTextEncode', _meta: { title: 'CLIP Text Encode（提示词）' } },
    174: { inputs: { vae_name: 'flux2-vae.safetensors' }, class_type: 'VAELoader', _meta: { title: 'Load VAE' } },
    278: { inputs: { image: '5893a9a83a836aa9fe45b8e937c0b2be63d31a5e124591d1f2495002014dcd88.png' }, class_type: 'LoadImage', _meta: { title: 'Load Image（参考图）' } },
    281: { inputs: { images: ['155', 0] }, class_type: 'PreviewImage', _meta: { title: 'Preview Image' } },
    291: { inputs: { upscale_method: 'lanczos', megapixels: 1, resolution_steps: 1, image: ['278', 0] }, class_type: 'ImageScaleToTotalPixels', _meta: { title: 'Scale Image to Total Pixels' } },
    303: { inputs: { lora_name: 'Klein 一致性增强.safetensors', strength_model: ['359', 0], model: ['360', 0] }, class_type: 'LoraLoaderModelOnly', _meta: { title: 'Load LoRA（一致性增强）' } },
    358: { inputs: { lora_name: 'Flux2-Klein-9B-一致性V2.safetensors', strength_model: ['359', 0], model: ['360', 0] }, class_type: 'LoraLoaderModelOnly', _meta: { title: 'Load LoRA（一致性V2）' } },
    359: { inputs: { value: 0.8 }, class_type: 'JWFloat', _meta: { title: 'Float' } },
    360: { inputs: { unet_name: 'Flux-2-Klein-9b-fp8.safetensors', weight_dtype: 'default' }, class_type: 'UNETLoader', _meta: { title: 'Load Diffusion Model' } },
    361: { inputs: { clip_name: 'qwen_3_8b_fp8mixed.safetensors', type: 'qwen_image', device: 'default' }, class_type: 'CLIPLoader', _meta: { title: 'Load CLIP' } },
    362: { inputs: { filename_prefix: 'Klein-V2', images: ['155', 0] }, class_type: 'SaveImage', _meta: { title: 'Save Image' } },
  },
  null,
  2,
);

// 内置示例 ComfyUI 工作流（nodes 格式，文生图最小链路），用于演示「模板 ↔ ComfyUI」联动
const COMFY_SAMPLE = JSON.stringify(
  {
    last_node_id: 7,
    last_link_id: 0,
    nodes: [
      { id: 1, type: 'CheckpointLoaderSimple', pos: [0, 0], inputs: [], outputs: [{ name: 'MODEL' }, { name: 'CLIP' }, { name: 'VAE' }], widgets_values: ['sd_xl_base_1.0.safetensors'] },
      { id: 2, type: 'CLIPTextEncode', pos: [0, 120], inputs: [{ name: 'clip', link: null }], outputs: [{ name: 'CONDITIONING' }], widgets_values: ['a cat on a chair, masterpiece'] },
      { id: 3, type: 'CLIPTextEncode', pos: [0, 260], inputs: [{ name: 'clip', link: null }], outputs: [{ name: 'CONDITIONING' }], widgets_values: ['text, watermark'] },
      { id: 4, type: 'EmptyLatentImage', pos: [0, 400], inputs: [], outputs: [{ name: 'LATENT' }], widgets_values: [512, 512, 1] },
      { id: 5, type: 'KSampler', pos: [360, 0], inputs: [{ name: 'model', link: null }, { name: 'positive', link: null }, { name: 'negative', link: null }, { name: 'latent_image', link: null }], outputs: [{ name: 'LATENT' }], widgets_values: [156680208700286, 'randomize', 20, 8, 1, 'euler', 'normal', 1] },
      { id: 6, type: 'VAEDecode', pos: [680, 0], inputs: [{ name: 'samples', link: null }, { name: 'vae', link: null }], outputs: [{ name: 'IMAGE' }], widgets_values: [] },
      { id: 7, type: 'SaveImage', pos: [1000, 0], inputs: [{ name: 'images', link: null }], outputs: [], widgets_values: ['ComfyUI'] },
    ],
    links: [],
    version: 0.4,
  },
  null,
  2,
);

const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'ecom',
    name: '电商套图',
    description: '文本 → 图片 → 视频 → 音频，适合商品主图与短视频生产',
    nodes: [
      { type: 'text', x: 80, y: 80 },
      { type: 'image', x: 360, y: 80 },
      { type: 'video', x: 640, y: 80 },
      { type: 'audio', x: 920, y: 80 },
    ],
    tags: ['电商', '套图', '图文'],
  },
  {
    id: 'poster',
    name: '海报设计',
    description: '文本 → 图片 → 后期，适合海报与封面设计',
    nodes: [
      { type: 'text', x: 80, y: 80 },
      { type: 'image', x: 360, y: 80 },
      { type: 'post', x: 640, y: 80 },
    ],
    tags: ['海报', '设计', '封面'],
  },
  {
    id: 'brand',
    name: '品牌短片',
    description: '文本 → 图片 → 视频 → 音频 → 后期，端到端品牌内容',
    nodes: [
      { type: 'text', x: 80, y: 80 },
      { type: 'image', x: 320, y: 80 },
      { type: 'video', x: 560, y: 80 },
      { type: 'audio', x: 800, y: 80 },
      { type: 'post', x: 1040, y: 80 },
    ],
    tags: ['品牌', '短片', '营销'],
  },
  {
    id: 'shortvideo',
    name: '短视频脚本',
    description: '文本 → 分镜 → 视频 → 音频，适合剧情类短视频',
    nodes: [
      { type: 'text', x: 80, y: 80 },
      { type: 'storyboard', x: 320, y: 80 },
      { type: 'video', x: 560, y: 80 },
      { type: 'audio', x: 800, y: 80 },
    ],
    tags: ['短视频', '分镜', '脚本'],
  },
  {
    id: 'aigc',
    name: 'AIGC 内容矩阵',
    description: '文本 → 图片 → 视频 → 音频 → 后期，多平台内容矩阵',
    nodes: [
      { type: 'text', x: 80, y: 80 },
      { type: 'image', x: 320, y: 80 },
      { type: 'video', x: 560, y: 80 },
      { type: 'audio', x: 800, y: 80 },
      { type: 'post', x: 1040, y: 80 },
    ],
    tags: ['AIGC', '矩阵', '多平台'],
  },
  {
    id: 'educational',
    name: '知识科普',
    description: '文本 → 脚本 → 视频 → 音频，适合讲解类内容',
    nodes: [
      { type: 'text', x: 80, y: 80 },
      { type: 'script', x: 320, y: 80 },
      { type: 'video', x: 560, y: 80 },
      { type: 'audio', x: 800, y: 80 },
    ],
    tags: ['知识', '科普', '教育'],
  },
  {
    id: 'social',
    name: '社媒图文',
    description: '文本 → 图片 → 后期，适合小红书 / 朋友圈图文',
    nodes: [
      { type: 'text', x: 80, y: 80 },
      { type: 'image', x: 360, y: 80 },
      { type: 'post', x: 640, y: 80 },
    ],
    tags: ['社媒', '图文', '小红书'],
  },
  {
    id: 'podcast',
    name: '播客音频',
    description: '文本 → 音频，适合口播与播客',
    nodes: [
      { type: 'text', x: 80, y: 80 },
      { type: 'audio', x: 360, y: 80 },
    ],
    tags: ['播客', '音频', '口播'],
  },
  {
    id: 'comfy-sample',
    name: 'ComfyUI 示例（文生图）',
    description: '内置示例 ComfyUI 工作流：点击即以 ComfyUI 节点导入并运行',
    nodes: [],
    tags: ['comfyui', '示例'],
    comfyJson: COMFY_SAMPLE,
  },
  {
    id: 'comfy-klein-v2-lean',
    name: 'Klein 一致性增强 v2（精简）',
    description: 'FLUX.2 Klein 9B 图生图 + 两个一致性 LoRA，保持主体一致并增强细节。可展开为节点，暴露「参考图」与「提示词」端口直接编辑。',
    nodes: [],
    tags: ['comfyui', '一致性', 'klein', '图生图'],
    comfyJson: COMFY_KLEIN_V2_LEAN,
    expandable: true,
  },
];

type TabKey = 'comfy' | 'canvas' | 'template';
type ComfyMode = 'expand' | 'single';

export function ImportWorkflowModal() {
  const open = useCanvasStore((s) => s.importWorkflowOpen);
  const close = useCanvasStore((s) => s.closeImportWorkflow);
  const addNode = useCanvasStore((s) => s.addNode);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const createWorkflowFromPlan = useCanvasStore((s) => s.createWorkflowFromPlan);
  const importCanvas = useCanvasStore((s) => s.importCanvas);

  const [tab, setTab] = useState<TabKey>('comfy');
  const [comfyText, setComfyText] = useState('');
  const [comfyMode, setComfyMode] = useState<ComfyMode>('single');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ nodeCount: number; inputCount: number; outputCount: number; warnings: number; inputs: { kind: string; label: string }[]; outputs: { kind: string; label: string }[] } | null>(null);
  const [depCheck, setDepCheck] = useState<ComfyValidateResult | null>(null);
  const [depChecking, setDepChecking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  const resetMessages = () => {
    setError(null);
    setInfo(null);
  };

  // 粘贴/选择后立即分析结构（格式、节点数、输入/输出端、连接警告），不自动导入
  const analyzeComfy = (text: string) => {
    if (!text.trim()) {
      setSummary(null);
      return;
    }
    try {
      const { plan, warnings } = parseComfyUIWorkflow(text);
      const params = (s: WorkflowStep) => (s.data?.params as Record<string, unknown>) || {};
      const inputList = plan.steps
        .map((s) => comfyInputSource(String(params(s).comfyNodeType || '')))
        .filter((x): x is { kind: 'image' | 'video' | 'audio' | 'text'; label: string } => x != null);
      const outputList = plan.steps
        .map((s) => comfyOutputSink(String(params(s).comfyNodeType || '')))
        .filter((x): x is { kind: 'image' | 'video' | 'audio' | 'text'; label: string } => x != null);
      setSummary({
        nodeCount: plan.steps.length,
        inputCount: inputList.length,
        outputCount: outputList.length,
        warnings: warnings.length,
        inputs: inputList,
        outputs: outputList,
      });
    } catch {
      setSummary(null);
    }
  };

  // 对「单个 ComfyUI 节点」模式做导入前依赖预检（缺失插件 / 模型 / 磁盘空间）。
  const checkDeps = async (json: string) => {
    if (!json.trim()) {
      setDepCheck(null);
      return;
    }
    setDepChecking(true);
    try {
      const obj = JSON.parse(json);
      const res = await comfyValidate(obj).catch(() => null);
      setDepCheck(res);
    } catch {
      setDepCheck(null);
    } finally {
      setDepChecking(false);
    }
  };

  const readJsonFile = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') resolve(reader.result);
        else reject(new Error('文件读取失败'));
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsText(file);
    });

  const importComfySingle = (json: string) => {
    const step = parseComfyUIWorkflowAsSingleNode(json, { position: { x: 220, y: 160 } });
    const id = addNode(step.type, step.position);
    if (!id) throw new Error('创建 ComfyUI 节点失败');
    if (step.data) updateNodeData(id, step.data);
    setInfo('已作为单个 ComfyUI 节点导入，可在节点内粘贴/编辑 JSON 并经网关执行。');
  };

  const importComfyExpand = async (json: string) => {
    const { plan, warnings } = parseComfyUIWorkflow(json);
    const res = await createWorkflowFromPlan(plan);
    if (!res.success) throw new Error(res.error || '展开工作流失败');
    const params = (s: WorkflowStep) => (s.data?.params as Record<string, unknown>) || {};
    const inputList = plan.steps
      .map((s) => comfyInputSource(String(params(s).comfyNodeType || '')))
      .filter((x): x is { kind: 'image' | 'video' | 'audio' | 'text'; label: string } => x != null);
    const outputList = plan.steps
      .map((s) => comfyOutputSink(String(params(s).comfyNodeType || '')))
      .filter((x): x is { kind: 'image' | 'video' | 'audio' | 'text'; label: string } => x != null);
    const warnText = warnings.length ? `（${warnings.length} 条连接无法映射，已忽略）` : '';
    const inputText = inputList.length ? `输入 ${inputList.length} 个（${inputList.map((i) => i.label).join('、')}）` : '无显式输入';
    const outputText = outputList.length ? `输出 ${outputList.length} 个（${outputList.map((i) => i.label).join('、')}）` : '无显式输出';
    setInfo(
      `已展开为 ${plan.steps.length} 个节点并自动分组${warnText}。${inputText}、${outputText}。展开后可直接上传原图 / 填写提示词；若要整体经 ComfyUI 网关执行，建议用「单个 ComfyUI 节点」模式。`,
    );
  };

  const runComfyImport = async (json: string) => {
    resetMessages();
    if (!json.trim()) {
      setError('请粘贴 ComfyUI 工作流 JSON，或选择 .json 文件。');
      return;
    }
    try {
      if (comfyMode === 'single') importComfySingle(json);
      else await importComfyExpand(json);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'ComfyUI 导入失败';
      if (comfyMode === 'expand' && /nodes 数组/.test(msg)) {
        setError('当前为 ComfyUI API 格式（无 nodes 数组），请切换到「单个 ComfyUI 节点」模式导入。');
      } else {
        setError(msg);
      }
    }
  };

  const onComfyFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await readJsonFile(file);
      setComfyText(text);
      analyzeComfy(text);
      if (comfyMode === 'single') checkDeps(text);
      await runComfyImport(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取文件失败');
    } finally {
      e.target.value = '';
    }
  };

  const onCanvasFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    resetMessages();
    try {
      const text = await readJsonFile(file);
      importCanvas(text);
      setInfo('已导入画布 JSON（将替换当前画布）。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入画布失败');
    } finally {
      e.target.value = '';
    }
  };

  const loadTemplate = (tpl: WorkflowTemplate, mode: 'single' | 'expand' = 'single') => {
    resetMessages();
    if (tpl.comfyJson) {
      // 绑定了 ComfyUI 工作流的模板：走 ComfyUI 导入路径
      try {
        if (mode === 'expand' && tpl.expandable) {
          // 展开为节点：LoadImage→图片端口、CLIPTextEncode→提示词端口，可在画布直接上传/填写
          importComfyExpand(tpl.comfyJson);
        } else {
          importComfySingle(tpl.comfyJson);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '模板导入失败');
      }
      return;
    }
    tpl.nodes.forEach((n) => addNode(n.type, { x: n.x, y: n.y }));
    setInfo(`已添加模板「${tpl.name}」（${tpl.nodes.length} 个节点）。`);
  };

  const tabBtn = (key: TabKey, label: string) => (
    <button
      type="button"
      onClick={() => {
        setTab(key);
        resetMessages();
      }}
      className={`px-3 py-2 text-sm rounded-t-md border-b-2 transition-colors ${
        tab === key
          ? 'border-[#00d4aa] text-[#e6edf3]'
          : 'border-transparent text-[#8b949e] hover:text-[#e6edf3]'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto bg-black/60 p-4"
      onClick={close}
    >
      <div
        className="my-auto w-[680px] max-w-[92vw] max-h-[90vh] flex flex-col rounded-lg border border-[#30363d] bg-[#0d1117] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#30363d]">
          <h2 className="text-base font-semibold text-[#e6edf3]">导入工作流</h2>
          <button
            type="button"
            onClick={close}
            className="inline-flex items-center gap-1 rounded-md border border-[#30363d] bg-[#161b22] px-2.5 py-1 text-[11px] text-[#c9d1d9] transition-colors hover:bg-[#21262d]"
            aria-label="关闭"
          >
            关闭
            <span className="text-base leading-none">×</span>
          </button>
        </div>

        <div className="flex gap-1 px-4 pt-2 border-b border-[#30363d]">
          {tabBtn('comfy', '从 ComfyUI 导入')}
          {tabBtn('canvas', '导入画布 JSON')}
          {tabBtn('template', '工作流模板')}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
              {error}
            </div>
          )}
          {info && (
            <div className="text-sm text-[#00d4aa] bg-[#00d4aa]/10 border border-[#00d4aa]/30 rounded px-3 py-2">
              {info}
            </div>
          )}

          {tab === 'comfy' && (
            <div className="space-y-3">
              <p className="text-xs text-[#8b949e]">
                粘贴 ComfyUI 导出的工作流 JSON（支持 UI 的 nodes 格式与 API 的 prompt 格式），选择导入模式后导入。
              </p>
              <div className="flex gap-4 text-sm items-center">
                <label className="flex items-center gap-2 text-[#e6edf3] cursor-pointer">
                  <input
                    type="radio"
                    name="comfyMode"
                    checked={comfyMode === 'single'}
                    onChange={() => {
                      setComfyMode('single');
                      if (comfyText.trim()) checkDeps(comfyText);
                    }}
                  />
                  单个 ComfyUI 节点（保留完整执行语义，经网关运行）
                </label>
                <label className="flex items-center gap-2 text-[#e6edf3] cursor-pointer">
                  <input
                    type="radio"
                    name="comfyMode"
                    checked={comfyMode === 'expand'}
                    onChange={() => setComfyMode('expand')}
                  />
                  展开为原生节点（可视化骨架，UI/API 格式均支持）
                </label>
                {comfyMode === 'single' && (
                  <button
                    type="button"
                    onClick={() => checkDeps(comfyText)}
                    className="ml-auto rounded-md border border-[#30363d] bg-[#161b22] px-2 py-1 text-[11px] text-[#8b949e] hover:text-[#e6edf3]"
                  >
                    {depChecking ? '校验中…' : '校验依赖'}
                  </button>
                )}
              </div>
              {summary && (
                <div className="text-xs rounded border border-[#30363d] bg-[#010409] px-3 py-2 text-[#8b949e] space-y-1">
                  <div>
                    已识别：<span className="text-[#e6edf3]">{summary.nodeCount}</span> 个节点 · 输出{' '}
                    <span className="text-[#fbbf24]">{summary.outputCount}</span> 个
                    {summary.warnings > 0 && (
                      <> · <span className="text-[#f87171]">{summary.warnings} 条连接警告</span></>
                    )}
                  </div>
                  {summary.inputs.length > 0 ? (
                    <div>
                      需要输入（连线 / 填写）：
                      {(['image', 'video', 'audio', 'text'] as const).map((k) => {
                        const items = summary.inputs.filter((i) => i.kind === k);
                        if (items.length === 0) return null;
                        const color =
                          k === 'image' ? 'text-[#00d4aa]' : k === 'text' ? 'text-[#79c0ff]' : k === 'video' ? 'text-[#d2a8ff]' : 'text-[#ffa657]';
                        return (
                          <span key={k} className="ml-1">
                            <span className={color}>{items[0].label}</span>
                            {items.length > 1 ? ` ×${items.length}` : ''}
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-[#8b949e]">未识别到显式输入节点（如 LoadImage / CLIPTextEncode）。</div>
                  )}
                </div>
              )}
              {comfyMode === 'single' && summary && summary.inputs.length > 0 && (
                <div className="text-xs rounded border border-[#1f6feb]/30 bg-[#0d1b2a] px-3 py-2 text-[#9ecbff]">
                  提示：该工作流需要 {summary.inputs.map((i) => i.label).join('、')} 等输入。「单个 ComfyUI 节点」模式是黑盒、不暴露这些端口；
                  若需上传原图 / 填写提示词，请切换到「展开为节点」模式，导入后可见 LoadImage（图片输入）与 CLIPTextEncode（提示词）等节点并直接编辑。
                </div>
              )}
              {comfyMode === 'single' && depCheck && (
                <div className="text-xs rounded border border-[#30363d] bg-[#010409] px-3 py-2 space-y-1">
                  <div className="text-[#8b949e]">
                    依赖预检：
                    {depCheck.comfy_manager_installed === true ? (
                      <span className="text-[#00d4aa]">ComfyUI-Manager 已安装</span>
                    ) : depCheck.comfy_manager_installed === false ? (
                      <span className="text-[#fbbf24]">未安装 ComfyUI-Manager</span>
                    ) : (
                      <span className="text-[#8b949e]">（远程实例未检查）</span>
                    )}
                    {depCheck.disk_warning && depCheck.disk_free_gb != null ? (
                      <span className="text-[#fbbf24]"> · 磁盘剩余 {depCheck.disk_free_gb}GB</span>
                    ) : null}
                  </div>
                  {depCheck.missing_plugins && depCheck.missing_plugins.length > 0 ? (
                    <div className="text-[#f87171]">
                      缺失插件：{depCheck.missing_plugins.slice(0, 5).join('、')}
                      {depCheck.missing_plugins.length > 5 ? ` 等 ${depCheck.missing_plugins.length} 个` : ''}
                    </div>
                  ) : (
                    <div className="text-[#00d4aa]">插件依赖齐全</div>
                  )}
                  {depCheck.missing_models && depCheck.missing_models.length > 0 ? (
                    <div className="text-[#fbbf24]">
                      缺失模型/权重：
                      {depCheck.missing_models.slice(0, 5).map((m) => (
                        <span key={m.node_id + m.file} className="font-mono">
                          {m.file}
                          {m.subdir ? `（models/${m.subdir}）` : ''}
                          {depCheck.missing_models && depCheck.missing_models.length > 1 ? '，' : ''}
                        </span>
                      ))}
                      <div className="text-[#8b949e]">模型/VAE 等权重通常数 GB~数十 GB，请预留硬盘空间并下载后刷新。</div>
                    </div>
                  ) : (
                    (depCheck.missing_plugins?.length ?? 0) === 0 ? null : null
                  )}
                </div>
              )}
              <textarea
                value={comfyText}
                onChange={(e) => {
                  setComfyText(e.target.value);
                  analyzeComfy(e.target.value);
                }}
                placeholder='{ "nodes": [...] } 或 { "3": { "class_type": ... } }'
                className="w-full h-48 resize-none rounded border border-[#30363d] bg-[#010409] text-[#e6edf3] text-xs p-2 font-mono"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => runComfyImport(comfyText)}
                  className="px-3 py-1.5 rounded bg-[#00d4aa] text-black text-sm font-medium hover:bg-[#00b894]"
                >
                  导入
                </button>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="px-3 py-1.5 rounded border border-[#30363d] text-[#e6edf3] text-sm hover:bg-[#161b22]"
                >
                  选择 .json 文件
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={onComfyFile}
                />
              </div>
            </div>
          )}

          {tab === 'canvas' && (
            <div className="space-y-3">
              <p className="text-xs text-[#8b949e]">
                导入此前导出的 HMDao 画布 JSON 文件，将替换当前画布内容。
              </p>
              <button
                type="button"
                onClick={() => canvasFileRef.current?.click()}
                className="px-3 py-1.5 rounded border border-[#30363d] text-[#e6edf3] text-sm hover:bg-[#161b22]"
              >
                选择画布 JSON 文件
              </button>
              <input
                ref={canvasFileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={onCanvasFile}
              />
            </div>
          )}

          {tab === 'template' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {WORKFLOW_TEMPLATES.map((tpl) => (
                <div
                  key={tpl.id}
                  className="rounded border border-[#30363d] bg-[#010409] p-3 flex flex-col gap-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-[#e6edf3]">{tpl.name}</span>
                    {tpl.comfyJson && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#00d4aa]/15 text-[#00d4aa]">
                        ComfyUI
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[#8b949e] flex-1">{tpl.description}</p>
                  <div className="flex flex-wrap gap-1">
                    {tpl.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-[#21262d] text-[#8b949e]"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                  {tpl.expandable ? (
                    <div className="flex gap-2 mt-1">
                      <button
                        type="button"
                        onClick={() => loadTemplate(tpl, 'expand')}
                        className="flex-1 px-3 py-1.5 rounded bg-[#00d4aa]/20 text-[#00d4aa] text-sm hover:bg-[#00d4aa]/30"
                        title="展开为节点，暴露「参考图」与「提示词」端口直接在画布编辑"
                      >
                        展开导入（暴露接口）
                      </button>
                      <button
                        type="button"
                        onClick={() => loadTemplate(tpl, 'single')}
                        className="flex-1 px-3 py-1.5 rounded bg-[#21262d] text-[#e6edf3] text-sm hover:bg-[#30363d]"
                        title="作为单个 ComfyUI 节点导入（黑盒，需进节点改 JSON 才能换图/提示词）"
                      >
                        单节点导入
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => loadTemplate(tpl)}
                      className="mt-1 px-3 py-1.5 rounded bg-[#21262d] text-[#e6edf3] text-sm hover:bg-[#30363d]"
                    >
                      导入到画布
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
