import { useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Layers, Send, Sparkles, Zap } from 'lucide-react';
import { EditableNodeTitle } from './EditableNodeTitle';

export function AIAppNode(props: NodeProps) {
  const { selected, data } = props;
  const [prompt, setPrompt] = useState('');

  return (
    <div className={`relative w-[280px] rounded-xl bg-[#1c1c1e] transition-all duration-200 ${selected ? 'ring-2 ring-[#e6edf3]' : 'ring-1 ring-[#2a2a2c]'}`}>
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
        <EditableNodeTitle nodeId={props.id} icon={Layers} label={data?.label} fallback="AI 应用" />
      </div>

      <div className="px-3 pb-3">
        <div className="flex flex-col items-center gap-1.5 py-5">
          <div className="h-1 w-16 rounded-full bg-[#2a2a2c]" />
          <div className="h-1 w-20 rounded-full bg-[#2a2a2c]" />
          <div className="h-1 w-12 rounded-full bg-[#2a2a2c]" />
        </div>
        <div className="mb-2 text-xs text-[#6e7681]">尝试:</div>
        <div className="space-y-2">
          {['运行 AI 工作流', '自定义节点流程'].map((label) => (
            <button key={label} type="button" className="flex w-full items-center gap-2.5 text-left text-sm text-[#c9d1d9] transition-colors hover:text-[#e6edf3]" title={label}>
              <Layers className="h-3.5 w-3.5 text-[#8b949e]" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      {selected && (
        <div className="absolute left-0 top-full z-20 w-[380px] pt-2">
          <div className="overflow-hidden rounded-xl bg-[#1c1c1e] ring-1 ring-[#2a2a2c]">
            <textarea
              placeholder="描述 AI 工作流需求，例如：自动批量处理图片生成"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              aria-label="AI 工作流需求"
              className="min-h-[60px] w-full resize-none bg-transparent px-3 py-3 text-sm text-[#e6edf3] outline-none placeholder:text-[#6e7681]"
            />
            <div className="flex items-center justify-between border-t border-[#2a2a2c] px-3 py-2.5">
              <button type="button" className="flex items-center gap-1.5 text-xs text-[#8b949e] transition-colors hover:text-[#e6edf3]" title="选择模型">
                <Sparkles className="h-3.5 w-3.5" /> Agent
              </button>
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1 text-xs text-[#6e7681]"><Zap className="h-3.5 w-3.5" /> 10</span>
                <button type="button" className="flex h-7 w-7 items-center justify-center rounded-full bg-[#2a2a2c] transition-colors hover:bg-[#3a3a3c]" title="发送">
                  <Send className="h-3.5 w-3.5 text-[#e6edf3]" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <Handle type="target" position={Position.Left} className="image-node-handle" style={hL}><span className="text-xs font-bold leading-none text-[#6e7681]">+</span></Handle>
      <Handle type="source" position={Position.Right} className="image-node-handle" style={hR}><span className="text-xs font-bold leading-none text-[#6e7681]">+</span></Handle>
    </div>
  );
}

const hL: React.CSSProperties = { left: -9 };
const hR: React.CSSProperties = { right: -9 };
