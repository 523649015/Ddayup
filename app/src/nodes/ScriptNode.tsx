import { useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { FileEdit, FileText, User } from 'lucide-react';
import { EditableNodeTitle } from './EditableNodeTitle';
import DispatchInfoBadge from '@/components/DispatchInfoBadge';

/* ===== Storyboard Data Types ===== */
interface StoryboardRow {
  id: number;
  time: string;
  duration: string;
  shot: string;
  camera: string;
  style: string;
  content: string;
  light: string;
  line: string;
  sound: string;
}

export function ScriptNode(props: NodeProps) {
  const { selected, data } = props;
  const [prompt, setPrompt] = useState('');
  const [showStoryboard, setShowStoryboard] = useState(false);

  const scriptedContent = String(data?.content || '');

  const handleGenerate = () => {
    setShowStoryboard(true);
  };

  return (
    <div
      className={`rounded-xl transition-all duration-200 relative w-[320px] bg-[#1c1c1e] ${
        selected ? 'ring-2 ring-[#e6edf3]' : 'ring-1 ring-[#2a2a2c]'
      }`}
      data-testid={`script-node-${props.id}`}
    >
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
        <EditableNodeTitle nodeId={props.id} icon={FileText} label={data?.label} fallback="脚本节点" />
      </div>

      <DispatchInfoBadge data={data} />

      <div className="px-3 pb-3">
        {scriptedContent ? (
          <div className="rounded-lg border border-[#2a2a2c] bg-[#171717] px-3 py-3 text-[12px] leading-6 text-[#d7d7d7] whitespace-pre-wrap">
            {scriptedContent}
          </div>
        ) : (
          <>
            <div className="flex flex-col items-center gap-1.5 py-5">
              <div className="w-16 h-1 rounded-full bg-[#2a2a2c]" />
              <div className="w-20 h-1 rounded-full bg-[#2a2a2c]" />
              <div className="w-12 h-1 rounded-full bg-[#2a2a2c]" />
            </div>

            <div className="text-[#6e7681] text-xs mb-2">尝试：</div>
            <div className="space-y-2">
              <button
                type="button"
                onClick={handleGenerate}
                title="剧本生成分镜脚本"
                className="flex items-center gap-2.5 text-[#c9d1d9] text-sm hover:text-[#e6edf3] transition-colors w-full text-left"
              >
                <span className="text-[#8b949e]"><FileEdit className="w-3.5 h-3.5" /></span>
                <span>剧本生成分镜脚本</span>
              </button>
              <button type="button" className="flex items-center gap-2.5 text-[#c9d1d9] text-sm hover:text-[#e6edf3] transition-colors w-full text-left" title="角色生成分镜脚本">
                <span className="text-[#8b949e]"><User className="w-3.5 h-3.5" /></span>
                <span>角色生成分镜脚本</span>
              </button>
            </div>
          </>
        )}
      </div>

      {selected && !showStoryboard && !scriptedContent && (
        <div className="absolute left-0 pt-2 z-20 w-[380px] top-full">
          <div className="rounded-xl overflow-hidden ring-1 ring-[#2a2a2c] bg-[#1c1c1e]">
            <textarea
              placeholder="描述剧情或添加角色参考、视频参考等，为你生成分镜脚本"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              aria-label="剧情描述"
              className="w-full bg-transparent text-[#e6edf3] text-sm placeholder-[#6e7681] resize-none outline-none px-3 py-3 min-h-[60px]"
            />
            <div className="flex items-center justify-between px-3 py-2.5 border-t border-[#2a2a2c]">
              <button type="button" className="flex items-center gap-1.5 text-[#8b949e] text-xs hover:text-[#e6edf3] transition-colors" title="选择模型">
                <SparkleIcon />
                GVLM 3.1
              </button>
              <div className="flex items-center gap-2">
                <span className="text-[#6e7681] text-xs flex items-center gap-1">
                  <ZapSmall /> 6
                </span>
                <SendButton onClick={handleGenerate} />
              </div>
            </div>
          </div>
        </div>
      )}

      {showStoryboard && !scriptedContent && (
        <div className="absolute left-0 pt-2 z-20 w-[700px] top-full">
          <StoryboardTable />
        </div>
      )}

      <Handle type="target" position={Position.Left} className="image-node-handle" style={hL}>
        <span className="text-xs text-[#6e7681] font-bold leading-none">+</span>
      </Handle>
      <Handle type="source" position={Position.Right} className="image-node-handle" style={hR}>
        <span className="text-xs text-[#6e7681] font-bold leading-none">+</span>
      </Handle>
    </div>
  );
}

const hL: React.CSSProperties = { left: -9 };
const hR: React.CSSProperties = { right: -9 };

function StoryboardTable() {
  const storyboardData: StoryboardRow[] = [
    { id: 1, time: '00:00-00:01', duration: '1s', shot: '特写', camera: '快速推进', style: '清新商业', content: '带有冰凉水珠的饮料罐局部，Logo 隐约闪现', light: '明亮高调，天蓝背景，侧逆光突出水珠质感', line: '无', sound: '快节奏鼓点，水滴声' },
    { id: 2, time: '00:01-00:02', duration: '1s', shot: '中景', camera: '轻微缩放', style: '潮流波普', content: '饮料罐居中，背景出现重复的品牌文字动态排布', light: '亮蓝色调，高对比度', line: '无', sound: '强节奏低音' },
    { id: 3, time: '00:02-00:03', duration: '1s', shot: '全景', camera: '俯拍固定', style: '动感特写', content: '蓝色饮料罐落入冰块中，激起透明水花', light: '清透亮白，光影灵动', line: '无', sound: '清脆水花声' },
  ];

  const columns = [
    { key: 'id', label: '镜号', width: 30 },
    { key: 'time', label: '时间段', width: 70 },
    { key: 'duration', label: '时长', width: 35 },
    { key: 'shot', label: '景别', width: 40 },
    { key: 'camera', label: '镜头运动', width: 55 },
    { key: 'style', label: '画面风格', width: 50 },
    { key: 'content', label: '画面内容', width: 120 },
    { key: 'light', label: '光影色调', width: 100 },
    { key: 'line', label: '台词', width: 25 },
    { key: 'sound', label: '音效配乐', width: 70 },
  ];

  return (
    <div className="rounded-xl overflow-hidden ring-1 ring-[#2a2a2c] bg-[#1c1c1e]">
      <div className="overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="border-b border-[#2a2a2c]">
              {columns.map((col) => (
                <th key={col.key} className="px-2 py-2 text-left text-[#8b949e] font-medium whitespace-nowrap min-w-[var(--col-min-w)]" style={{ '--col-min-w': `${col.width}px` } as React.CSSProperties}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {storyboardData.map((row, i) => (
              <tr key={i} className="border-b border-[#2a2a2c]/50 hover:bg-[#21262d]">
                {columns.map((col) => (
                  <td key={col.key} className="px-2 py-2 text-[#c9d1d9] min-w-[var(--col-min-w)]" style={{ '--col-min-w': `${col.width}px` } as React.CSSProperties}>
                    {row[col.key as keyof StoryboardRow]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

function ZapSmall() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function SendButton({ onClick }: { onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className="w-7 h-7 rounded-full bg-[#2a2a2c] hover:bg-[#3a3a3c] flex items-center justify-center transition-colors" title="发送">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e6edf3" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="5 12 12 5 19 12" />
      </svg>
    </button>
  );
}
