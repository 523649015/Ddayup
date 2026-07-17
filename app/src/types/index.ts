// ===== Node Types =====
export type NodeType = 'text' | 'image' | 'video' | 'audio' | 'storyboard' | 'aiapp' | 'threed' | 'script' | 'dcc' | 'post' | 'region';

export interface CanvasNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: NodeData;
  selected?: boolean;
}

export interface NodeData {
  label: string;
  content?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  status?: 'idle' | 'pending' | 'generating' | 'completed' | 'error';
  outputs?: MediaOutput[];
  inputs?: MediaInput[];
  imageUrl?: string;
  videoUrl?: string;
  error?: string;
  params?: Record<string, unknown>;
  aspectRatio?: string;
  quality?: string;
  duration?: number;
  cost?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface MediaOutput {
  id: string;
  type: 'image' | 'video' | 'audio' | 'text';
  url: string;
  thumbnail?: string;
  prompt?: string;
  metadata?: Record<string, unknown>;
}

export interface MediaInput {
  id: string;
  type: 'image' | 'video' | 'audio' | 'text';
  url: string;
  label?: string;
  role?: string;
  weight?: number;
  enabled?: boolean;
  sourceNodeId?: string;
  sourceNodeType?: NodeType;
  handleId?: string;
  channel?: 'primary' | 'image-reference' | 'video-reference';
  metadata?: Record<string, unknown>;
}

export type RegionTargetKind = 'subject' | 'prop' | 'companion' | 'background' | 'custom';
export type RegionEditIntent = 'replace_subject' | 'insert_element' | 'background_fuse' | 'remove_and_fill';
export type RegionStrictness = 'exact_transfer' | 'guided_generate' | 'harmonize_only';
export type RegionBindingMode = 'reference_required' | 'reference_optional' | 'text_only';
export type RegionBindingRole =
  | 'subject-reference'
  | 'element-reference'
  | 'background-reference'
  | 'style-reference'
  | 'video-reference';

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RegionMaskPoint {
  x: number;
  y: number;
  brushSize?: number;
}

export interface RegionKeyframe {
  frame: number;
  rect: RegionRect;
}

export interface RegionTrack {
  mode: 'static' | 'manual' | 'tracked';
  startFrame: number;
  endFrame: number;
  keyframes: RegionKeyframe[];
  occlusionPolicy: 'hold' | 'pause' | 'reacquire';
}

export interface RegionBinding {
  slotId: string;
  sourceNodeId: string;
  sourceAssetUrl: string;
  sourcePersistedAssetId?: string;
  sourceOriginalUrl?: string;
  sourceFilePath?: string;
  sourceMediaType: 'image' | 'video' | 'text';
  bindingRole: RegionBindingRole;
  preserveDetail: boolean;
  weight: number;
  sourceLabel?: string;
  description?: string;
}

export interface RegionSpec {
  regionId: string;
  label: string;
  geometry: {
    rect: RegionRect;
    maskPoints?: RegionMaskPoint[];
  };
  targetKind: RegionTargetKind;
  editIntent: RegionEditIntent;
  description: string;
  negativePrompt?: string;
  strictness: RegionStrictness;
  bindingMode: RegionBindingMode;
  bindings: RegionBinding[];
  enabled?: boolean;
  frameRange?: {
    startFrame: number;
    endFrame: number;
  };
  keyframes?: RegionKeyframe[];
  track?: RegionTrack;
}

export interface RegionPackContract {
  version: string;
  source: {
    nodeId?: string;
    nodeLabel?: string;
    url: string;
    persistedAssetId?: string;
    originalUrl?: string;
    filePath?: string;
    mediaType: 'image' | 'video';
    width?: number;
    height?: number;
    duration?: number;
  };
  regions: RegionSpec[];
  bindings: RegionBinding[];
  executionPlan: {
    orderedRegionIds: string[];
    strategy: 'region-contract-v1';
  };
  consistencyRequirements: string[];
  fallbackPolicy: 'switch-model' | 'reject';
  summary?: string;
  generatedAt?: number;
}

export interface WorkflowMemoryReference {
  id: string;
  layer: 'role' | 'brand' | 'style' | 'workflow';
  title: string;
  summary: string;
  routeName?: string;
  linkedSkillId?: string;
  nodeTypes?: NodeType[];
  tags?: string[];
  sourceTraceId?: string;
  sourceTemplateId?: string;
  updatedAt?: number;
}

// ===== Workflow / DAG =====
export type WorkflowStageKind = 'plan' | 'preprocess' | 'generate' | 'validate' | 'deliver';
export type WorkflowStageStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed';
export type WorkflowExecutionMode = 'generation' | 'editing' | 'analysis' | 'delivery';
export type WorkflowArtifactKind =
  | 'prompt-plan'
  | 'memory-pack'
  | 'reference-pack'
  | 'conditioning-pack'
  | 'enhancement-pack'
  | 'preview'
  | 'media'
  | 'validation-report'
  | 'delivery-package'
  | 'metadata';
export type WorkflowArtifactStorage = 'inline' | 'local-handle' | 'remote-url';

export interface WorkflowCapabilityRequirement {
  key: string;
  value?: string | number | boolean;
  required?: boolean;
  reason?: string;
}

export interface IdentityControllerConfig {
  enabled: boolean;
  characterLibraryId?: string;
  identityLockMode?: 'off' | 'reference' | 'embedding' | 'lora';
  embeddingProvider?: string;
  loraAssetId?: string;
  fallbackPolicy?: 'reference_weight' | 'subject_only' | 'disable';
  subjectLock?: number;
  notes?: string;
}

export interface WorkflowEnhancementPreset {
  id: 'subject-consistency' | 'composition-lock' | 'camera-motion-lock' | 'multi-reference-fusion' | 'consistency-validation';
  enabled: boolean;
  mode?: string;
  strength?: number;
  roleScope?: string[];
  providerFallbacks?: string[];
  maxRetries?: number;
  notes?: string;
}

export interface WorkflowEnhancementStrategy {
  [key: string]: unknown;
  mode: 'native-first' | 'pluggable-protocol';
  contractVersion: string;
  presets: WorkflowEnhancementPreset[];
  costGuard?: {
    imageMaxRetries?: number;
    videoSegmentMaxRetries?: number;
    waitTimeoutSec?: number;
  };
}

export interface WorkflowArtifact {
  id: string;
  stageId: string;
  label: string;
  kind: WorkflowArtifactKind;
  storage: WorkflowArtifactStorage;
  status: 'pending' | 'ready' | 'failed';
  mimeType?: string;
  url?: string;
  handle?: string;
  data?: Record<string, unknown>;
  createdAt: number;
}

export interface WorkflowStageNode {
  id: string;
  kind: WorkflowStageKind;
  label: string;
  status: WorkflowStageStatus;
  operation?: string;
  providerHint?: string;
  modelHint?: string;
  inputs?: string[];
  outputs?: string[];
  capabilityRequirements?: WorkflowCapabilityRequirement[];
  metadata?: Record<string, unknown>;
}

export interface WorkflowGraphEdge {
  from: string;
  to: string;
}

export interface WorkflowGraph {
  version: 'hmdao.workflow.v2';
  graphId: string;
  nodeType: NodeType;
  executionMode: WorkflowExecutionMode;
  generationMode?: string;
  stages: WorkflowStageNode[];
  edges: WorkflowGraphEdge[];
  artifacts: WorkflowArtifact[];
  identityController?: IdentityControllerConfig;
  enhancementStrategy?: WorkflowEnhancementStrategy;
  sharedMemories?: WorkflowMemoryReference[];
  referenceRoles?: Array<{
    type?: string;
    role?: string;
    weight?: number;
    channel?: string;
    sourceNodeId?: string;
  }>;
  templateVersion?: string;
}

export interface WorkflowPlan {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  connections: { from: number; to: number }[];
  schemaVersion?: string;
  executionMode?: WorkflowExecutionMode;
  workflowGraph?: WorkflowGraph;
}

export interface WorkflowStep {
  type: NodeType;
  label: string;
  position: { x: number; y: number };
  data?: Partial<NodeData>;
  stageKind?: WorkflowStageKind;
  operation?: string;
  capabilityRequirements?: WorkflowCapabilityRequirement[];
}

export interface ModelCapabilityMatrix {
  generationModes?: string[];
  referenceRoles?: string[];
  toolOperations?: string[];
  supportsMultiReference?: boolean;
  supportsOmniReference?: boolean;
  supportsSubjectLock?: boolean;
  supportsCompositionLock?: boolean;
  supportsLightingControl?: boolean;
  supportsConsistencyEnhancement?: boolean;
  supportsCameraMotionLockEnhancement?: boolean;
  supportsIdentityController?: boolean;
  supportsTextToVideo?: boolean;
  supportsImageToVideo?: boolean;
  supportsFirstLastFrame?: boolean;
  supportsReferenceVideo?: boolean;
  supportsReferenceImage?: boolean;
  supportsVideoStyleTransfer?: boolean;
  supportsPrimaryVideoMotionLock?: boolean;
  supportsActionTransfer?: boolean;
  supportsLocalEditing?: boolean;
  supportsRemoteEditing?: boolean;
  supportsStageValidation?: boolean;
  supportsRegionPack?: boolean;
  supportsRegionSpecificBindings?: boolean;
  supportsExactTransfer?: boolean;
  supportsBackgroundFuse?: boolean;
  supportsMultiRegionExecution?: boolean;
  supportsTrackedVideoRegions?: boolean;
  bestFor?: string[];
  limitations?: string[];
}

// ===== Edge / Connection =====
export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  type?: 'default' | 'smoothstep' | 'straight';
  pending?: boolean;
}

// ===== AI Provider =====
export type ProviderId = 'openai' | 'google' | 'replicate' | 'fal' | 'minimax' | 'elevenlabs' | 'comfyui' | 'volcengine';

export interface AIProvider {
  id: ProviderId;
  name: string;
  icon: string;
  models: AIModel[];
  supports: ('text' | 'image' | 'video' | 'audio')[];
}

export interface AIModel {
  id: string;
  name: string;
  cost: number;
  currency: string;
  supports: ('text' | 'image' | 'video' | 'audio')[];
  params?: ModelParam[];
}

export interface ModelParam {
  key: string;
  label: string;
  type: 'select' | 'slider' | 'toggle' | 'number' | 'text';
  options?: { label: string; value: string }[];
  min?: number;
  max?: number;
  step?: number;
  default: unknown;
}

// ===== Canvas =====
export interface Canvas {
  id: string;
  title: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport?: { x: number; y: number; zoom: number; width?: number; height?: number };
  createdAt: number;
  updatedAt: number;
}

// ===== App State =====
export type SidebarTab = 'assets' | 'workflow' | 'history' | 'director' | 'editor' | 'add' | 'models' | 'dcc';
export type ToolAction = 'hd' | 'clip' | 'capture' | 'parse' | 'audio-split' | 'video-fix' | 'download';

export interface AppState {
  // Canvas
  canvas: Canvas | null;
  selectedNodeIds: string[];
  selectionGuardUntil: number;
  pendingViewportFocusNodeId: string | null;
  pendingViewportFocusNonce: number;
  zoom: number;

  // UI
  activeSidebarTab: SidebarTab;
  sidebarCollapsed: boolean;
  showAIPanel: boolean;
  showAssetPanel: boolean;
  showTemplatePanel: boolean;
  showSettings: boolean;
  showShortcuts: boolean;
  darkMode: boolean;
  language: 'zh' | 'en';
  floatingPanel: FloatingPanelState | null;

  // History
  history: HistoryEntry[];
  historyIndex: number;

  // Generation
  generatingNodes: Set<string>;
  queueStatus: QueueStatus;

  // Assets
  assets: AssetItem[];
  assetCategories: string[];

  // Settings
  apiKeys: Record<string, string>;
  defaultProviders: Record<string, ProviderId>;
}

export interface HistoryEntry {
  type: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeIds: string[];
  timestamp: number;
}

export interface QueueStatus {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export interface AssetItem {
  id: string;
  type: 'image' | 'video' | 'audio';
  url: string;
  thumbnail: string;
  category: string;
  name: string;
  size: number;
  createdAt: number;
}

// ===== Workflow =====
export interface Workflow {
  id: string;
  name: string;
  description?: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  color: string;
  createdAt: number;
  updatedAt: number;
}

// ===== Node Group =====
export interface NodeGroup {
  id: string;
  name: string;
  color: string;
  nodeIds: string[];
  createdAt: number;
}

export interface FloatingPanelState {
  nodeId: string;
  kind: string;
}

// ===== i18n =====
export type TranslationKey =
  | 'app.title'
  | 'sidebar.addNode'
  | 'sidebar.assets'
  | 'sidebar.workflow'
  | 'sidebar.history'
  | 'sidebar.director'
  | 'sidebar.editor'
  | 'node.text'
  | 'node.image'
  | 'node.video'
  | 'node.audio'
  | 'node.3d'
  | 'node.storyboard'
  | 'node.aiapp'
  | 'node.dcc'
  | 'node.post'
  | 'node.textDesc'
  | 'node.imageDesc'
  | 'node.videoDesc'
  | 'node.audioDesc'
  | 'node.3dDesc'
  | 'node.storyboardDesc'
  | 'node.aiappDesc'
  | 'node.postDesc'
  | 'ai.try'
  | 'ai.writeContent'
  | 'ai.uploadDoc'
  | 'ai.textToVideo'
  | 'ai.imageToPrompt'
  | 'ai.imageToImage'
  | 'ai.imageToVideo'
  | 'ai.replaceBg'
  | 'ai.firstFrameToVideo'
  | 'ai.fullRef'
  | 'ai.imgToVideo'
  | 'ai.firstLastFrame'
  | 'ai.textToAudio'
  | 'ai.audioToAudio'
  | 'ai.generate'
  | 'toolbar.hd'
  | 'toolbar.clip'
  | 'toolbar.capture'
  | 'toolbar.parse'
  | 'toolbar.audioSplit'
  | 'toolbar.videoFix'
  | 'toolbar.download'
  | 'toolbar.settings'
  | 'toolbar.agent';
