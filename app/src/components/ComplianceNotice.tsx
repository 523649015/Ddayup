import { useState } from 'react';
import { Shield, Info } from 'lucide-react';

interface ModelInfo {
  name: string;
  provider: string;
  registrationNumber: string;
  usage: string;
}

const REGISTERED_MODELS: ModelInfo[] = [
  {
    name: 'DeepSeek V4',
    provider: '深度求索人工智能科技（北京）有限公司',
    registrationNumber: '深度模型备 XXXXXXXX 号',
    usage: '文本生成 / 剧本解析 / 图像生成提示词',
  },
  {
    name: '通义千问 Qwen',
    provider: '阿里云计算有限公司',
    registrationNumber: '网信算备 XXXXXXXX 号',
    usage: '文本生成 / 图像生成提示词',
  },
  {
    name: '智谱 GLM-4',
    provider: '北京智谱华章科技有限公司',
    registrationNumber: '网信算备 XXXXXXXX 号',
    usage: '文本生成 / 图像生成',
  },
  {
    name: '混元大模型',
    provider: '深圳市腾讯计算机系统有限公司',
    registrationNumber: '网信算备 XXXXXXXX 号',
    usage: '文本生成 / AI 智能对话',
  },
];

const PLATFORM_RESPONSIBILITIES = [
  '平台会对生成内容进行基础安全过滤与合规审核。',
  '平台已对已接入模型进行备案信息登记。',
  '平台会按照隐私政策处理并保护用户数据。',
  '平台保留对违规内容进行处置的权利。',
];

const USER_RESPONSIBILITIES = [
  '用户应对生成内容的使用方式承担全部责任。',
  '用户不得使用本服务生成违法、侵权或有害内容。',
  '用户需遵守所在地法律法规及平台使用协议。',
  '用户应对账号安全及相关操作行为负责。',
];

const COMPLIANCE_CLAUSES = [
  '本服务依据《生成式人工智能服务管理暂行办法》等相关规定运行。',
  '当前接入模型已按要求完成备案信息登记。',
  'AI 生成内容可按平台策略叠加数字水印或来源标识。',
  '继续使用本服务，即表示您同意《服务条款》和《隐私政策》。',
];

interface ComplianceNoticeProps {
  mode: 'login' | 'register' | 'footer' | 'modal';
  defaultExpanded?: boolean;
  minimal?: boolean;
}

export function ComplianceNotice({ mode, defaultExpanded = false, minimal = false }: ComplianceNoticeProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (minimal) {
    return (
      <div className="flex items-start gap-2 px-1 text-xs text-slate-400">
        <Shield className="mt-0.5 h-3 w-3 flex-shrink-0 text-blue-400" />
        <span>
          本服务已接入完成备案的 AI 模型，生成内容默认会带有 AI 生成属性标识。继续使用即表示您同意{' '}
          <a href="/terms" className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">
            服务条款
          </a>{' '}
          和{' '}
          <a href="/privacy" className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">
            隐私政策
          </a>
          。
        </span>
      </div>
    );
  }

  if (mode === 'login' || mode === 'register') {
    return (
      <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-800/40 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
          <Shield className="h-4 w-4 text-green-400" />
          合规与备案信息
        </div>

        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            已备案模型（算法备案）
          </div>
          <div className="space-y-1.5">
            {REGISTERED_MODELS.map((model) => (
              <div key={model.name} className="flex items-start justify-between gap-2 text-xs">
                <div className="flex-1">
                  <span className="font-medium text-slate-300">{model.name}</span>
                  <span className="ml-1 text-slate-500">· {model.provider}</span>
                </div>
                <span className="mt-0.5 flex-shrink-0 font-mono text-[10px] text-blue-400">
                  {model.registrationNumber}
                </span>
              </div>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex items-center gap-1.5 text-xs text-blue-400 transition-colors hover:text-blue-300"
        >
          <Info className="h-3 w-3" />
          {expanded ? '收起' : '查看'}平台与用户责任边界
        </button>

        {expanded ? (
          <div className="space-y-3 border-t border-slate-700 pt-1">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">平台责任</div>
              <ul className="space-y-0.5">
                {PLATFORM_RESPONSIBILITIES.map((item) => (
                  <li key={item} className="flex items-start gap-1.5 text-xs text-slate-400">
                    <span className="mt-0.5 text-green-400">+</span>{item}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">用户责任</div>
              <ul className="space-y-0.5">
                {USER_RESPONSIBILITIES.map((item) => (
                  <li key={item} className="flex items-start gap-1.5 text-xs text-amber-300">
                    <span className="mt-0.5">!</span>{item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="border-t border-slate-700 pt-2">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">法律依据</div>
              <ul className="space-y-0.5">
                {COMPLIANCE_CLAUSES.map((item) => (
                  <li key={item} className="flex items-start gap-1.5 text-xs text-slate-400">
                    <span className="mt-0.5 text-blue-400">·</span>{item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-1 text-xs text-slate-500">
      <div className="flex items-center gap-1.5">
        <Shield className="h-3 w-3 text-blue-400" />
        <span>本平台已接入完成备案的 AI 模型，生成内容默认带有 AI 生成属性标识。</span>
      </div>
      <div className="flex gap-3">
        <a href="/terms" className="text-blue-400 hover:underline">服务条款</a>
        <a href="/privacy" className="text-blue-400 hover:underline">隐私政策</a>
        <a href="/compliance" className="text-blue-400 hover:underline">合规说明</a>
      </div>
    </div>
  );
}
