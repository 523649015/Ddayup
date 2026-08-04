// ComfyUI 中转网关前端客户端（调用 /api/comfyui/* 代理）
// 这些代理由 hmdao-api.mjs 提供，最终转发到 daydayupAPI 网关。

import { useApiKeyStore } from '@/store/useApiKeyStore';

export interface ComfyUiHealth {
  success: boolean;
  configured: boolean;
  reachable: boolean;
  gatewayUrl: string | null;
  detail: string;
  // 各 ComfyUI 实例可达性（用于判断"是否已安装/启动"）。
  instances?: Array<{ id: string; url: string; reachable: boolean }>;
  // 未安装时的指引信息（来自网关 /health）。
  guidance?: ComfyGuidance;
}

export interface ComfyGuidance {
  defaultPort?: string;
  downloadUrl?: string;
  docsUrl?: string;
  installHint?: string;
  installScript?: string;
}

export interface ComfyUiPlugins {
  success: boolean;
  configured: boolean;
  reachable?: boolean;
  plugins: string[];
}

export interface ComfySubmitResult {
  success: boolean;
  promptId?: string;
  outputs?: Array<{ type?: string; url: string; metadata?: Record<string, unknown> }>;
  error?: string;
  hint?: string;
}

export async function comfyHealth(signal?: AbortSignal): Promise<ComfyUiHealth> {
  const r = await fetch('/api/comfyui/health', { signal });
  return r.json();
}

export async function comfyPlugins(signal?: AbortSignal): Promise<ComfyUiPlugins> {
  const r = await fetch('/api/comfyui/plugins', { signal });
  return r.json();
}

export async function startComfyUi(): Promise<any> {
  try {
    const r = await fetch('/api/comfyui/start', { method: 'POST' });
    return await r.json().catch(() => ({ success: false, error: 'bad-response' }));
  } catch (e) {
    return { success: false, error: String((e as any)?.message || e) };
  }
}

export function openComfyUiWeb(port = 8188) {
  if (typeof window !== 'undefined') {
    window.open(`http://127.0.0.1:${port}`, '_blank', 'noopener');
  }
}

export async function installComfyUiManager(): Promise<any> {
  try {
    const r = await fetch('/api/comfyui/install-manager', { method: 'POST' });
    return await r.json().catch(() => ({ success: false, error: 'bad-response' }));
  } catch (e) {
    return { success: false, error: String((e as any)?.message || e) };
  }
}

export interface ComfyConfig {
  success: boolean;
  configured?: boolean;
  // 是否允许请求体携带 per-user provider_keys 覆盖服务端密钥。
  allowClientKeys?: boolean;
  // marker（节点 class_type 子串）-> provider 映射。
  markers?: Array<{ marker: string; provider: string }>;
  keyFields?: string[];
  baseUrlFields?: string[];
  providers?: Array<{ id: string; serverKeyConfigured: boolean }>;
  // 网关是否要求 server-to-server 密钥。
  gatewayKeyRequired?: boolean;
  // 网关是否以 HTTPS 提供服务（传输安全）。
  tls?: boolean;
  version?: string;
}

// 拉取网关下发的可配置项（UI 暴露 ALLOW_CLIENT_KEYS / MARKERS / 传输安全状态）。
export async function comfyConfig(signal?: AbortSignal): Promise<ComfyConfig> {
  const r = await fetch('/api/comfyui/config', { signal });
  return r.json();
}

export interface ComfySubmitOptions {
  providerKeys?: Record<string, string>;
  providerBaseUrls?: Record<string, string>;
  clientId?: string;
  // 可选：指定 ComfyUI 实例（URL 或索引）。为空时由网关默认轮询。
  instance?: string;
}

export async function comfySubmit(
  rawComfyJson: unknown,
  signal?: AbortSignal,
  opts?: ComfySubmitOptions,
): Promise<ComfySubmitResult> {
  const r = await fetch('/api/comfyui/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: rawComfyJson,
      providerKeys: opts?.providerKeys || {},
      providerBaseUrls: opts?.providerBaseUrls || {},
      clientId: opts?.clientId,
      instance: opts?.instance ?? null,
    }),
    signal,
  });
  return r.json();
}

// 轮询网关任务进度（/prompt 提交后非阻塞返回 promptId，进度经此端点获取）。
export interface ComfyTaskOutput {
  type?: string;
  url: string;
  metadata?: Record<string, unknown>;
}

export interface ComfyTaskStatus {
  prompt_id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  progress: { value: number; max: number; node: string | null; percent: number };
  current_node: string | null;
  outputs: ComfyTaskOutput[];
  error: string | null;
  created_at: number;
  updated_at: number;
}

export async function comfyTaskStatus(
  promptId: string,
  signal?: AbortSignal,
): Promise<ComfyTaskStatus> {
  const r = await fetch(`/api/comfyui/tasks/${encodeURIComponent(promptId)}`, { signal });
  return r.json();
}

/**
 * 提交工作流并轮询进度，直到 done / error 或超时。
 * 供"测试链路"按钮复用：提交 -> 实时进度 -> 返回最终结果。
 */
export interface RunComfyChainOptions {
  onProgress?: (st: ComfyTaskStatus) => void;
  signal?: AbortSignal;
  pollMs?: number;
  timeoutMs?: number;
  providerKeys?: Record<string, string>;
  providerBaseUrls?: Record<string, string>;
  instance?: string;
}

export async function runComfyChain(
  rawJson: unknown,
  opts: RunComfyChainOptions = {},
): Promise<ComfyTaskStatus> {
  const res = await comfySubmit(rawJson, opts.signal, {
    providerKeys: opts.providerKeys,
    providerBaseUrls: opts.providerBaseUrls,
    instance: opts.instance,
  });
  if (!res.success || !res.promptId) {
    throw new Error(res.error || 'comfy: 提交失败');
  }
  const pollMs = opts.pollMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  let last: ComfyTaskStatus | null = null;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    await new Promise((r) => setTimeout(r, pollMs));
    const st = await comfyTaskStatus(res.promptId, opts.signal).catch(() => null);
    if (!st) continue;
    last = st;
    opts.onProgress?.(st);
    if (st.status === 'done' || st.status === 'error') return st;
  }
  if (last) return last;
  throw new Error('comfy: 轮询超时');
}

// 扫描 ComfyUI 工作流 JSON 中引用到的云端大模型（如 kling/volcengine），
// 用于"key 自适应"：未激活对应 provider 时提示用户去 API 管理界面激活。
const CLOUD_NODE_MARKERS: Array<{ marker: string; provider: string }> = [
  { marker: 'Kling', provider: 'kling' },
  { marker: 'Volcengine', provider: 'volcengine' },
  { marker: 'Siliconflow', provider: 'siliconflow' },
  { marker: 'OneAPI', provider: 'openai' },
];

export function extractComfyCloudProviders(rawComfyJson: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const cls = typeof obj.class_type === 'string' ? obj.class_type : '';
    for (const m of CLOUD_NODE_MARKERS) {
      if (cls.includes(m.marker)) found.add(m.provider);
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') walk(v);
    }
  };
  const prompt = (rawComfyJson as { prompt?: unknown })?.prompt;
  if (prompt) walk(prompt);
  else walk(rawComfyJson);
  return Array.from(found);
}

/**
 * 返回工作流所需、但当前 BYOK 未激活的云端 provider 列表。
 * 用于提交前拦截与节点内提示，避免空跑一轮。
 * 注：服务端统一密钥场景可创建 metadata-only 激活，使 isActive 返回 true。
 */
export function getMissingComfyProviders(rawComfyJson: unknown): string[] {
  const required = extractComfyCloudProviders(rawComfyJson);
  if (required.length === 0) return [];
  const store = useApiKeyStore.getState();
  return required.filter((p) => !store.isActive(p));
}

// ---------------------------------------------------------------------------
// 工作流「插件缺失」检测（需求3）
// ---------------------------------------------------------------------------

export interface ComfyMissingNode {
  class_type: string;
  node_ids: string[];
  guess_plugin: string | null;
}

export interface ComfyMissingModel {
  node_id: string;
  class_type: string;
  file: string;
  subdir: string | null;
  note: string;
}

export interface ComfyValidateResult {
  success: boolean;
  configured?: boolean;
  reachable?: boolean;
  valid?: boolean;
  used_classes?: string[];
  available_classes?: number;
  missing?: ComfyMissingNode[];
  missing_plugins?: string[];
  // ComfyUI-Manager 是否已安装（仅本地实例；远程为 null）。
  comfy_manager_installed?: boolean | null;
  manager_github_url?: string;
  // 缺失的模型/权重文件。
  missing_models?: ComfyMissingModel[];
  // ComfyUI 所在磁盘剩余空间（GB，仅本地实例）。
  disk_free_gb?: number | null;
  disk_warning?: boolean;
  // 命中的 ComfyUI 实例地址，用于跳转 Manager / 设置页。
  instance_url?: string | null;
  model_note?: string;
  error?: string;
}

/** 提交前校验工作流：检测引用的节点类型是否都已安装，返回缺失的自定义节点（插件）。 */
export async function comfyValidate(
  rawComfyJson: unknown,
  signal?: AbortSignal,
): Promise<ComfyValidateResult> {
  const r = await fetch('/api/comfyui/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: rawComfyJson }),
    signal,
  });
  return r.json();
}

/**
 * 从 ComfyUI 工作流 JSON 中提取所有被引用的节点 class_type（去重）。
 * 支持两种形态：纯 prompt 图（{id:{class_type,inputs}}）或带 ui 的完整工作流。
 */
export function extractComfyUsedNodes(rawComfyJson: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const collectFromPrompt = (prompt: unknown): void => {
    if (!prompt || typeof prompt !== 'object') return;
    const obj = prompt as Record<string, unknown>;
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') {
        const node = v as Record<string, unknown>;
        const ct = typeof node.class_type === 'string' ? node.class_type : '';
        if (ct && !seen.has(ct)) {
          seen.add(ct);
          out.push(ct);
        }
      }
    }
  };
  const root = rawComfyJson as Record<string, unknown>;
  if (root && typeof root.prompt === 'object') {
    collectFromPrompt(root.prompt);
  } else if (root && typeof root.nodes === 'object') {
    // 完整工作流形态：{"nodes":[{type}], "links":[...]}
    const nodes = root.nodes as Array<{ type?: string }>;
    for (const n of nodes) {
      const ct = typeof n?.type === 'string' ? n.type : '';
      if (ct && !seen.has(ct)) {
        seen.add(ct);
        out.push(ct);
      }
    }
  } else {
    collectFromPrompt(root);
  }
  return out;
}
