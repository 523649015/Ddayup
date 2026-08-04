/**
 * 本地开源模型运行器注册表（Phase 7）
 *
 * 统一的浏览器端模型运行器注册/查询入口。HD 放大、局部修复(LaMa)、智能去背(@imgly)
 * 等能力在「模型下载」面板安装后，把对应的运行器注册到这里；图片节点的各功能
 * 在运行时按需取用，未注册时给出友好提示而非崩溃。
 */

export interface LocalModelRunInput {
  imageUrl: string;
  options?: Record<string, unknown>;
}

export interface LocalModelRunOutput {
  /** 真实推理结果；depth/matting/raft 的「仅激活占位」stub 运行器可不返回 */
  blob?: Blob;
  width?: number;
  height?: number;
  url?: string;
  assetId?: string;
  engine: string;
}

export type LocalModelRunner = (input: LocalModelRunInput) => Promise<LocalModelRunOutput>;

const runners = new Map<string, LocalModelRunner>();

export function registerLocalModelRunner(id: string, runner: LocalModelRunner | null): void {
  if (runner) runners.set(id, runner);
  else runners.delete(id);
}

export function getLocalModelRunner(id: string): LocalModelRunner | undefined {
  return runners.get(id);
}

export function hasLocalModelRunner(id: string): boolean {
  return runners.has(id);
}
