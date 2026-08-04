import { useMemo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  AudioLines,
  ChevronDown,
  FileEdit,
  FileText,
  Image,
  Languages,
  Send,
  Sparkles,
  Video,
  Zap,
} from 'lucide-react';
import { useCanvasStore } from '@/store/useCanvasStore';
import { EditableNodeTitle } from './EditableNodeTitle';
import DispatchInfoBadge from '@/components/DispatchInfoBadge';

interface TextModelOption {
  id: string;
  name: string;
  description: string;
  latency: string;
}

const TEXT_MODEL_OPTIONS: TextModelOption[] = [
  {
    id: 'auto-free',
    name: '免费优先（自动轮换）',
    description: '自动从免费额度池择优（Seed 2.1 / Qwen3 等），主模型失败自动轮换下一个',
    latency: '2s',
  },
  {
    id: 'gvlm-3.1',
    name: 'GVLM 3.1',
    description: '多模态文本模型Pro',
    latency: '20s',
  },
  {
    id: 'cvlm-5.5',
    name: 'CVLM 5.5',
    description: '视觉理解与长文本增强',
    latency: '10s',
  },
  {
    id: 'gvlm-3.1-flash',
    name: 'GVLM 3.1 Flash',
    description: '快速文本生成',
    latency: '15s',
  },
  {
    id: 'qwen-3-vl-flash',
    name: 'Qwen 3 VL Flash',
    description: '通义视觉语言模型',
    latency: '10s',
  },
];

export function TextNode(props: NodeProps) {
  const { selected, data, id } = props;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [prompt, setPrompt] = useState(String(data?.prompt || ''));
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  const selectedModelId = String(data?.model || TEXT_MODEL_OPTIONS[0].id);
  const selectedModel = useMemo(
    () => TEXT_MODEL_OPTIONS.find((model) => model.id === selectedModelId) || TEXT_MODEL_OPTIONS[0],
    [selectedModelId],
  );

  const tryItems = [
    { icon: FileEdit, label: '自己编写内容' },
    { icon: Video, label: '文生视频' },
    { icon: Image, label: '图片反推提示词' },
    { icon: AudioLines, label: '文字生音乐' },
  ];

  function chooseModel(model: TextModelOption) {
    updateNodeData(id, {
      model: model.id,
      provider: 'hmdao-text',
    });
    setModelMenuOpen(false);
  }

  function submitPrompt() {
    updateNodeData(id, {
      prompt,
      content: prompt,
      model: selectedModel.id,
      provider: 'hmdao-text',
      status: prompt.trim() ? 'completed' : 'idle',
    });
  }

  return (
    <div className="relative">
      <div
        className={`relative w-[300px] rounded-lg bg-[#262626] transition-all duration-150 ${
          selected
            ? 'ring-2 ring-[#9a9a9a] shadow-[0_0_0_1px_rgba(255,255,255,0.22)]'
            : 'ring-1 ring-[#343434]'
        }`}
      >
        <EditableNodeTitle nodeId={id} icon={FileText} label={data?.label} fallback="文本节点" className="absolute -top-7 left-0" />

        <div className="px-7 py-9">
          <div className="mb-8 flex flex-col items-center gap-1.5">
            <div className="h-5 w-12 rounded-sm border-y-[4px] border-[#5f5f5f]" />
            <div className="h-1 w-12 rounded-full bg-[#5f5f5f]" />
            <div className="h-1 w-8 rounded-full bg-[#5f5f5f]" />
          </div>

          <div className="mb-3 text-xs text-[#8f8f8f]">尝试:</div>
          <div className="space-y-4">
            {tryItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  type="button"
                  key={item.label}
                  title={item.label}
                  className="flex w-full items-center gap-2.5 text-left text-[13px] font-semibold text-[#ececec] transition-colors hover:text-white"
                >
                  <Icon className="h-3.5 w-3.5 text-[#f2f2f2]" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <Handle type="target" position={Position.Left} className="image-node-handle" style={hL}>
          <span className="text-xs font-bold leading-none text-[#8a8a8a]">+</span>
        </Handle>
        <Handle type="source" position={Position.Right} className="image-node-handle" style={hR}>
          <span className="text-xs font-bold leading-none text-[#8a8a8a]">+</span>
        </Handle>
      </div>

      {selected && (
        <div className="absolute left-1/2 top-full z-30 mt-4 w-[660px] -translate-x-[180px]">
          <div className="overflow-visible rounded-lg bg-[#2b2b2b] shadow-2xl ring-1 ring-[#3c3c3c]">
            <textarea
              placeholder="写下你想讲的故事、场景或角色设定。例如：一个来自未来的机器人，在城市屋顶看星星。"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              aria-label="文本提示词"
              className="min-h-[96px] w-full resize-none bg-transparent px-4 py-4 text-sm text-[#e6e6e6] outline-none placeholder:text-[#9a9a9a]"
            />

            <DispatchInfoBadge data={data} />

            <div className="relative flex items-center gap-3 border-t border-[#3a3a3a] px-4 py-3">
              <button
                type="button"
                onClick={() => setModelMenuOpen((open) => !open)}
                className="flex h-8 items-center gap-2 rounded-md bg-[#4b4b4b] px-3 text-sm font-semibold text-[#f0f0f0] transition-colors hover:bg-[#555]"
                title="选择加载的文本模型"
                aria-expanded={modelMenuOpen}
              >
                <Sparkles className="h-4 w-4" />
                <span>{selectedModel.name}</span>
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${modelMenuOpen ? 'rotate-180' : ''}`} />
              </button>

              {modelMenuOpen && (
                <div className="absolute bottom-[52px] left-3 w-[370px] rounded-xl bg-[#242424] p-3 shadow-2xl ring-1 ring-[#4b4b4b]">
                  <div className="space-y-2">
                    {TEXT_MODEL_OPTIONS.map((model) => (
                      <button
                        type="button"
                        key={model.id}
                        onClick={() => chooseModel(model)}
                        className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                          model.id === selectedModel.id ? 'bg-[#555]' : 'hover:bg-[#333]'
                        }`}
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#4a4a4a] text-[#efefef]">
                          <Sparkles className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-[#f4f4f4]">{model.name}</span>
                          <span className="block truncate text-xs text-[#9c9c9c]">{model.description}</span>
                        </span>
                        <span className="rounded-full bg-[#444] px-2 py-0.5 text-xs text-[#cfcfcf]">{model.latency}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="ml-auto flex items-center gap-4 text-[#d7d7d7]">
                <button type="button" className="rounded-md p-1.5 text-[#d7d7d7] hover:bg-[#3a3a3a]" title="翻译">
                  <Languages className="h-4 w-4" />
                </button>
                <span className="flex items-center gap-1 text-xs text-[#bdbdbd]">
                  <Zap className="h-3.5 w-3.5" />
                  6
                </span>
                <button
                  type="button"
                  onClick={submitPrompt}
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#bdbdbd] text-[#252525] transition-colors hover:bg-white"
                  title="发送"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const hL: React.CSSProperties = { left: -22 };
const hR: React.CSSProperties = { right: -22 };
