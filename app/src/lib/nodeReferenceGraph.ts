import type { Canvas, CanvasEdge, CanvasNode, MediaInput, MediaOutput, NodeType } from '@/types';

export type ReferenceChannel = 'primary' | 'image-reference' | 'video-reference';
export type ReferenceRole =
  | 'primary'
  | 'style'
  | 'subject'
  | 'element'
  | 'composition'
  | 'lighting'
  | 'motion'
  | 'rhythm'
  | 'omni';

export interface ReferenceRoleOption {
  value: ReferenceRole;
  label: string;
}

export interface ReferenceSettingsValue {
  role?: ReferenceRole;
  weight?: number;
  enabled?: boolean;
}

export interface ConnectedReferenceInput extends MediaInput {
  sourceNodeId: string;
  sourceNodeLabel: string;
  sourceNodeType: NodeType;
  edgeId: string;
  key: string;
  channel: ReferenceChannel;
  handleId: string;
  role: ReferenceRole;
  weight: number;
  enabled: boolean;
  roleOptions: ReferenceRoleOption[];
  isManualBinding?: boolean;
  /** 文本类输入（如 text 节点上游）承载的纯文本内容，用于注入提示词。 */
  text?: string;
}

export interface ReferenceBindingCandidate {
  sourceNodeId: string;
  sourceNodeLabel: string;
  sourceNodeType: NodeType;
  type: MediaInput['type'];
  url: string;
  metadata?: Record<string, unknown>;
}

const IMAGE_REFERENCE_ROLE_OPTIONS: ReferenceRoleOption[] = [
  { value: 'omni', label: '全能参考' },
  { value: 'style', label: '风格参考' },
  { value: 'subject', label: '主体参考' },
  { value: 'element', label: '元素参考' },
  { value: 'composition', label: '构图参考' },
  { value: 'lighting', label: '光影参考' },
];

const VIDEO_IMAGE_REFERENCE_ROLE_OPTIONS: ReferenceRoleOption[] = [
  { value: 'omni', label: '全能参考' },
  { value: 'style', label: '风格参考' },
  { value: 'subject', label: '主体参考' },
  { value: 'composition', label: '构图参考' },
  { value: 'lighting', label: '光影参考' },
];

const VIDEO_VIDEO_REFERENCE_ROLE_OPTIONS: ReferenceRoleOption[] = [
  { value: 'omni', label: '全能参考' },
  { value: 'motion', label: '运镜参考' },
  { value: 'rhythm', label: '节奏参考' },
  { value: 'style', label: '风格参考' },
];

const PREFERRED_MEDIA_TYPES_BY_NODE: Partial<Record<NodeType, Array<MediaInput['type']>>> = {
  image: ['image'],
  video: ['video', 'image'],
  audio: ['audio'],
  post: ['video', 'image'],
  script: ['text'],
  storyboard: ['text'],
  aiapp: ['text'],
  threed: ['image', 'video'],
  dcc: ['image', 'video'],
};

export function buildReferenceSettingsKey(edge: Pick<CanvasEdge, 'id' | 'source' | 'targetHandle'>, mediaType: string) {
  return `${edge.id}:${edge.source}:${edge.targetHandle || 'default'}:${mediaType}`;
}

function buildManualReferenceKey(handleId: string | undefined, sourceNodeId: string, mediaType: string) {
  return `manual:${sourceNodeId}:${handleId || 'default'}:${mediaType}`;
}

function buildReferenceIdentityKey(sourceNodeId: string, mediaType: string, channel: ReferenceChannel, handleId: string) {
  return `${sourceNodeId}:${mediaType}:${channel}:${handleId}`;
}

function matchesHandle(targetHandle: string | undefined, exact: string) {
  return targetHandle === exact || targetHandle?.startsWith(`${exact}-`);
}

function startsWithOneOf(targetHandle: string | undefined, prefixes: string[]) {
  return prefixes.some((prefix) => matchesHandle(targetHandle, prefix));
}

function parseIndexedHandle(targetHandle: string | undefined, prefix: string) {
  if (!matchesHandle(targetHandle, prefix)) return null;
  if (targetHandle === prefix) return 0;
  const suffix = Number.parseInt(String(targetHandle).slice(prefix.length + 1), 10);
  return Number.isFinite(suffix) ? suffix : 0;
}

function inferImageReferenceRoleFromHandle(targetHandle: string | undefined): ReferenceRole | null {
  if (matchesHandle(targetHandle, 'image-subject-reference')) return 'subject';
  if (matchesHandle(targetHandle, 'image-lighting-reference')) return 'omni';

  const legacyIndex = parseIndexedHandle(targetHandle, 'image-reference');
  if (legacyIndex === null) return null;
  if (legacyIndex === 0) return 'subject';
  if (legacyIndex === 1) return 'omni';
  return 'subject';
}

function clampWeight(value: unknown, fallback: number) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(0, Math.min(100, Math.round(next)));
}

function normalizeLabel(node: Pick<CanvasNode, 'data'> | null | undefined, mediaType: string) {
  const label = String(node?.data?.label || '').trim();
  if (label) return label;
  if (mediaType === 'video') return '视频素材';
  if (mediaType === 'image') return '图片素材';
  if (mediaType === 'audio') return '音频素材';
  return '参考素材';
}

function findNodeAsset(node: CanvasNode, preferredTypes: Array<MediaInput['type']>) {
  const outputs = Array.isArray(node.data.outputs) ? node.data.outputs : [];
  for (const type of preferredTypes) {
    const fromOutput = outputs.find((item) => item?.type === type && item.url) as MediaOutput | undefined;
    if (fromOutput?.url) {
      return { type, url: fromOutput.url, metadata: fromOutput.metadata };
    }
    if (type === 'image' && node.data.imageUrl) {
      return {
        type,
        url: node.data.imageUrl,
        metadata: outputs.find((item) => item?.url === node.data.imageUrl)?.metadata,
      };
    }
    if (type === 'video' && node.data.videoUrl) {
      return {
        type,
        url: node.data.videoUrl,
        metadata: outputs.find((item) => item?.url === node.data.videoUrl)?.metadata,
      };
    }
  }
  // text 节点的核心产物是纯文本（提示词/指令），无媒体 url，作为文本输入返回。
  // 注意：循环变量 type 在上面的 for 结束后已超出作用域，这里应判断 preferredTypes 是否包含 'text'。
  if (preferredTypes.includes('text')) {
    const text = (node.data as any)?.prompt ?? (node.data as any)?.text ?? '';
    if (text) return { type: 'text', text: String(text) };
  }
  return null;
}

function allowedMediaTypes(targetNodeType: NodeType, targetHandle: string | undefined): Array<MediaInput['type']> {
  if (targetNodeType === 'image') {
    // 主输入端口除图片参考外，也接受上游文本节点作为提示词指令。
    if (matchesHandle(targetHandle, 'image-main')) return ['image', 'text'];
    return ['image'];
  }
  if (targetNodeType === 'video') {
    if (matchesHandle(targetHandle, 'video-image-reference')) return ['image'];
    if (matchesHandle(targetHandle, 'video-video-reference')) return ['video'];
    return ['video', 'image'];
  }
  return ['image', 'video'];
}

function inferReferenceChannel(targetNodeType: NodeType, targetHandle: string | undefined): ReferenceChannel {
  if (targetNodeType === 'image') {
    return startsWithOneOf(targetHandle, ['image-reference', 'image-subject-reference', 'image-lighting-reference'])
      ? 'image-reference'
      : 'primary';
  }
  if (targetNodeType === 'video') {
    if (matchesHandle(targetHandle, 'video-image-reference')) return 'image-reference';
    if (matchesHandle(targetHandle, 'video-video-reference')) return 'video-reference';
    return 'primary';
  }
  return 'primary';
}

function prefersSubjectReplacement(
  targetNode: CanvasNode | undefined,
  targetNodeType: NodeType,
  channel: ReferenceChannel,
  mediaType: string,
) {
  if (channel === 'primary' || mediaType !== 'image') return false;
  const params = (targetNode?.data?.params && typeof targetNode.data.params === 'object')
    ? targetNode.data.params as Record<string, unknown>
    : {};
  const promptStrategy = String(params.promptStrategy || '').trim();
  if (promptStrategy === 'preserve-composition-replace-subject' || promptStrategy === 'preserve-camera-motion-replace-subject') {
    return true;
  }
  return targetNodeType === 'video' && channel === 'image-reference';
}

function defaultReferenceRole(
  targetNode: CanvasNode | undefined,
  targetNodeType: NodeType,
  channel: ReferenceChannel,
  mediaType: string,
  handleId: string | undefined,
): ReferenceRole {
  if (channel === 'primary') return 'primary';
  if (targetNodeType === 'image') {
    const explicitRole = inferImageReferenceRoleFromHandle(handleId);
    if (explicitRole) return explicitRole;
  }
  if (targetNodeType === 'video' && mediaType === 'video') return 'motion';
  if (prefersSubjectReplacement(targetNode, targetNodeType, channel, mediaType)) return 'subject';
  return 'style';
}

function roleOptionsFor(targetNodeType: NodeType, channel: ReferenceChannel, mediaType: string) {
  if (channel === 'primary') {
    return [{ value: 'primary', label: '主素材' }] satisfies ReferenceRoleOption[];
  }
  if (targetNodeType === 'video' && mediaType === 'video') return VIDEO_VIDEO_REFERENCE_ROLE_OPTIONS;
  if (targetNodeType === 'video') return VIDEO_IMAGE_REFERENCE_ROLE_OPTIONS;
  return IMAGE_REFERENCE_ROLE_OPTIONS;
}

function defaultWeightForRole(channel: ReferenceChannel, role: ReferenceRole) {
  if (channel === 'primary') return 100;
  if (role === 'omni') return 82;
  if (role === 'subject' || role === 'composition' || role === 'motion') return 92;
  if (role === 'lighting') return 70;
  return 60;
}

export function collectReferenceBindingCandidates(canvas: Canvas | null, targetNodeId: string, targetNodeType: NodeType) {
  if (!canvas) return [] as ReferenceBindingCandidate[];
  const candidates: ReferenceBindingCandidate[] = [];

  for (const node of canvas.nodes) {
    if (node.id === targetNodeId) continue;
    const preferredTypes = PREFERRED_MEDIA_TYPES_BY_NODE[node.type] || ['image', 'video'];
    const asset = findNodeAsset(node, preferredTypes);
    if (!asset?.url) continue;
    const compatible = targetNodeType === 'image'
      ? asset.type === 'image'
      : targetNodeType === 'video'
        ? asset.type === 'image' || asset.type === 'video'
        : asset.type === 'image' || asset.type === 'video';
    if (!compatible) continue;
    candidates.push({
      sourceNodeId: node.id,
      sourceNodeLabel: normalizeLabel(node, asset.type),
      sourceNodeType: node.type,
      type: asset.type,
      url: asset.url,
      metadata: asset.metadata,
    });
  }

  return candidates;
}

export function collectConnectedReferenceInputs(
  canvas: Canvas | null,
  targetNodeId: string,
  targetNodeType: NodeType,
  settings: Record<string, ReferenceSettingsValue> = {},
) {
  if (!canvas) return [] as ConnectedReferenceInput[];
  const targetNode = canvas.nodes.find((node) => node.id === targetNodeId);
  const incomingEdges = canvas.edges.filter((edge) => edge.target === targetNodeId);
  const manualInputs = Array.isArray(targetNode?.data?.inputs)
    ? targetNode.data.inputs.filter((item) => item && typeof item === 'object') as MediaInput[]
    : [];
  const items: ConnectedReferenceInput[] = [];
  const seenSettings = new Set<string>();
  const seenIdentities = new Set<string>();

  for (const edge of incomingEdges) {
    const sourceNode = canvas.nodes.find((node) => node.id === edge.source);
    if (!sourceNode) continue;
    const mediaTypes = allowedMediaTypes(targetNodeType, edge.targetHandle);
    const asset = findNodeAsset(sourceNode, mediaTypes);
    // 媒体输入需要 url；文本输入（如 text 节点）允许只有 text 内容。
    // 注意：findNodeAsset 可能返回 null/undefined（节点无对应媒体资产），
    // 必须先判空再使用 'text' in asset，否则 'text' in null 会抛 TypeError。
    if (!asset?.url && !(asset && 'text' in asset && (asset as any).text)) continue;

    const channel = inferReferenceChannel(targetNodeType, edge.targetHandle);
    const handleId = String(edge.targetHandle || '');
    const key = buildReferenceSettingsKey(edge, asset.type);
    const manualInput = manualInputs.find((item) => {
      const sourceNodeId = String(item.sourceNodeId || '').trim();
      const manualHandleId = String(item.handleId || '').trim();
      const inputChannel = (item.channel as ReferenceChannel | undefined) || inferReferenceChannel(targetNodeType, manualHandleId);
      return sourceNodeId === sourceNode.id
        && String(item.type || '') === asset.type
        && inputChannel === channel
        && manualHandleId === handleId;
    });
    const defaultRole = defaultReferenceRole(targetNode, targetNodeType, channel, asset.type, handleId);
    const roleOptions = roleOptionsFor(targetNodeType, channel, asset.type);
    const manualKey = buildManualReferenceKey(handleId, sourceNode.id, asset.type);
    const setting = {
      ...(settings[manualKey] || {}),
      ...(settings[key] || {}),
    };
    const role = roleOptions.some((option) => option.value === setting.role)
      ? (setting.role as ReferenceRole)
      : (typeof manualInput?.role === 'string' && roleOptions.some((option) => option.value === manualInput.role)
        ? manualInput.role as ReferenceRole
        : defaultRole);
    const identityKey = buildReferenceIdentityKey(sourceNode.id, asset.type, channel, handleId);
    if (seenIdentities.has(identityKey)) continue;

    items.push({
      id: `${sourceNode.id}:${edge.id}:${asset.type}`,
      type: asset.type as MediaInput['type'],
      url: asset.url ?? '',
      metadata: asset.metadata || manualInput?.metadata,
      label: String(manualInput?.label || normalizeLabel(sourceNode, asset.type)),
      sourceNodeId: sourceNode.id,
      sourceNodeLabel: String(manualInput?.label || normalizeLabel(sourceNode, asset.type)),
      sourceNodeType: sourceNode.type,
      edgeId: edge.id,
      key,
      channel,
      handleId,
      role,
      weight: clampWeight(setting.weight ?? manualInput?.weight, defaultWeightForRole(channel, role)),
      enabled: setting.enabled === undefined ? (manualInput?.enabled === undefined ? true : Boolean(manualInput.enabled)) : Boolean(setting.enabled),
      roleOptions,
      ...('text' in asset && (asset as any).text ? { text: String((asset as any).text) } : {}),
    });
    seenSettings.add(`${sourceNode.id}:${handleId}:${asset.type}:${channel}`);
    seenIdentities.add(identityKey);
  }

  for (const input of manualInputs) {
    const mediaType = input.type;
    const url = String(input.url || '').trim();
    const sourceNodeId = String(input.sourceNodeId || '').trim();
    const handleId = String(input.handleId || '').trim();
    if (!url || !sourceNodeId || !mediaType) continue;

    const channel = (input.channel as ReferenceChannel | undefined) || inferReferenceChannel(targetNodeType, handleId);
    const dedupeKey = `${sourceNodeId}:${handleId}:${mediaType}:${channel}`;
    const identityKey = buildReferenceIdentityKey(sourceNodeId, mediaType, channel, handleId);
    if (seenSettings.has(dedupeKey) || seenIdentities.has(identityKey)) continue;

    const sourceNode = canvas.nodes.find((node) => node.id === sourceNodeId);
    const sourceNodeType = sourceNode?.type || input.sourceNodeType || 'image';
    const roleOptions = roleOptionsFor(targetNodeType, channel, mediaType);
    const defaultRole = defaultReferenceRole(targetNode, targetNodeType, channel, mediaType, handleId);
    const key = buildManualReferenceKey(handleId, sourceNodeId, mediaType);
    const setting = settings[key] || {};
    const role = roleOptions.some((option) => option.value === setting.role)
      ? (setting.role as ReferenceRole)
      : (typeof input.role === 'string' && roleOptions.some((option) => option.value === input.role)
        ? input.role as ReferenceRole
        : defaultRole);

    items.push({
      ...input,
      id: String(input.id || `${sourceNodeId}:${handleId}:${mediaType}`),
      type: mediaType,
      url,
      metadata: input.metadata,
      label: String(input.label || normalizeLabel(sourceNode, mediaType)),
      sourceNodeId,
      sourceNodeLabel: String(input.label || normalizeLabel(sourceNode, mediaType)),
      sourceNodeType,
      edgeId: `manual:${sourceNodeId}:${handleId || 'default'}`,
      key,
      channel,
      handleId,
      role,
      weight: clampWeight(setting.weight ?? input.weight, defaultWeightForRole(channel, role)),
      enabled: setting.enabled === undefined ? (input.enabled === undefined ? true : Boolean(input.enabled)) : Boolean(setting.enabled),
      roleOptions,
      isManualBinding: true,
    });
    seenSettings.add(dedupeKey);
    seenIdentities.add(identityKey);
  }

  return items;
}

export function summarizeReferenceInputs(inputs: ConnectedReferenceInput[]) {
  const summary = {
    primary: 0,
    imageReference: 0,
    videoReference: 0,
  };
  for (const item of inputs) {
    if (!item.enabled) continue;
    if (item.channel === 'primary') summary.primary += 1;
    if (item.channel === 'image-reference') summary.imageReference += 1;
    if (item.channel === 'video-reference') summary.videoReference += 1;
  }
  return summary;
}
