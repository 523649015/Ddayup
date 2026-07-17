/**
 * HMDao 全局错误边界 — React 渲染异常兜底
 * 
 * 功能：
 * 1. 捕获子组件树中未处理的渲染异常
 * 2. 显示友好降级 UI（而非白屏）
 * 3. 提供重试机制
 * 4. 上报错误日志
 */

import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorCount: number;
}

export class GlobalErrorBoundary extends Component<Props, State> {
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorCount: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[HMDao ErrorBoundary] 捕获到渲染异常:', error, errorInfo);
    this.props.onError?.(error, errorInfo);

    // 连续错误超过 3 次，建议刷新页面
    this.setState(prev => ({ errorCount: prev.errorCount + 1 }));
  }

  componentWillUnmount(): void {
    if (this.resetTimer) clearTimeout(this.resetTimer);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null, errorCount: 0 });
  };

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const isPersistent = this.state.errorCount >= 3;

      return (
        <div className="min-h-screen flex items-center justify-center bg-[#0d1117] p-8">
          <div className="max-w-md w-full text-center space-y-6">
            <div className="mx-auto w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center">
              <AlertTriangle className="w-8 h-8 text-red-400" />
            </div>

            <div className="space-y-2">
              <h2 className="text-xl font-semibold text-white">
                {isPersistent ? '应用出现持续异常' : '页面渲染异常'}
              </h2>
              <p className="text-sm text-slate-400">
                {isPersistent
                  ? '检测到多次连续错误，建议刷新页面以恢复。'
                  : '组件渲染过程中发生了意外错误，请尝试重试。'}
              </p>
              {this.state.error && (
                <details className="mt-3 text-left">
                  <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-400">
                    查看错误详情
                  </summary>
                  <pre className="mt-2 p-3 rounded-lg bg-[#161b22] text-xs text-red-400 overflow-auto max-h-32">
                    {this.state.error.message}
                  </pre>
                </details>
              )}
            </div>

            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={this.handleReset}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                重试
              </button>
              {isPersistent && (
                <button
                  type="button"
                  onClick={this.handleReload}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm transition-colors"
                >
                  刷新页面
                </button>
              )}
            </div>

            <p className="text-xs text-slate-600">
              如果问题持续存在，请清除浏览器缓存或联系技术支持
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
