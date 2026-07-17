import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  nodeId?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error?: Error;
}

/**
 * Node-level Error Boundary
 * Prevents a single node crash from bringing down the entire canvas
 */
export class NodeErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[NodeErrorBoundary${this.props.nodeId ? ` #${this.props.nodeId}` : ''}]`, error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="w-[240px] overflow-hidden rounded-xl bg-[#1c1c1e] ring-1 ring-red-500/30">
          <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="text-[11px] text-red-400">节点渲染失败</span>
          </div>
          <div className="px-3 py-2">
            <p className="mb-2 text-[10px] text-[#8b949e]">
              {this.state.error?.message || 'Unknown error'}
            </p>
            <button
              type="button"
              onClick={this.handleReset}
              className="rounded bg-[#2a2a2c] px-2 py-1 text-[10px] text-[#e6edf3] transition-colors hover:bg-[#3a3a3c]"
            >
              重试
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
