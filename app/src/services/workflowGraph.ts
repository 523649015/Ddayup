import type {
  IdentityControllerConfig,
  MediaInput,
  ModelCapabilityMatrix,
  NodeType,
  WorkflowArtifact,
  WorkflowArtifactKind,
  WorkflowArtifactStorage,
  WorkflowCapabilityRequirement,
  WorkflowEnhancementStrategy,
  WorkflowExecutionMode,
  WorkflowGraph,
  WorkflowMemoryReference,
  WorkflowStageKind,
  WorkflowStageStatus,
} from '@/types';

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clamp01(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

export function readIdentityControllerConfig(
  value: unknown,
  referenceInputs: MediaInput[] = [],
): IdentityControllerConfig {
  const source = recordFrom(value);
  const hasSubjectReference = referenceInputs.some((item) => item.enabled !== false && item.role === 'subject');
  const rawMode = String(source.identityLockMode || (hasSubjectReference ? 'reference' : 'off')).trim();
  const identityLockMode: IdentityControllerConfig['identityLockMode'] = rawMode === 'embedding' || rawMode === 'lora' || rawMode === 'reference'
    ? rawMode
    : 'off';
  return {
    enabled: Boolean(source.enabled ?? (hasSubjectReference && identityLockMode !== 'off')),
    characterLibraryId: typeof source.characterLibraryId === 'string' ? source.characterLibraryId.trim() : '',
    identityLockMode,
    embeddingProvider: typeof source.embeddingProvider === 'string' ? source.embeddingProvider.trim() : '',
    loraAssetId: typeof source.loraAssetId === 'string' ? source.loraAssetId.trim() : '',
    fallbackPolicy: source.fallbackPolicy === 'subject_only' || source.fallbackPolicy === 'disable'
      ? source.fallbackPolicy
      : 'reference_weight',
    subjectLock: clamp01(source.subjectLock, hasSubjectReference ? 0.88 : 0.72),
    notes: typeof source.notes === 'string' ? source.notes.trim() : '',
  };
}

function uniqueRoleReferences(inputs: MediaInput[] = []) {
  const seen = new Set<string>();
  return inputs
    .filter((item) => item.enabled !== false && item.url)
    .map((item) => ({
      type: item.type,
      role: item.channel === 'primary'
        ? item.type === 'video'
          ? 'motion'
          : 'composition'
        : String(item.role || '').trim() || (item.type === 'video' ? 'motion' : 'style'),
      weight: typeof item.weight === 'number' ? Number((item.weight / 100).toFixed(2)) : undefined,
      channel: item.channel,
      sourceNodeId: item.sourceNodeId,
    }))
    .filter((item) => {
      const key = `${item.channel || ''}:${item.type}:${item.role}:${item.sourceNodeId || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function distinctActiveRoles(inputs: MediaInput[] = []) {
  return Array.from(new Set(
    uniqueRoleReferences(inputs)
      .map((item) => String(item.role || '').trim())
      .filter(Boolean),
  ));
}

function hasRole(inputs: MediaInput[] = [], role: string) {
  return distinctActiveRoles(inputs).includes(role);
}

function buildEnhancementStrategy(params: {
  nodeType: NodeType;
  primaryInputs: MediaInput[];
  referenceInputs: MediaInput[];
  identityController?: IdentityControllerConfig;
}): WorkflowEnhancementStrategy | undefined {
  const { nodeType, primaryInputs, referenceInputs, identityController } = params;
  const activePrimaryVideo = primaryInputs.some((item) => item.enabled !== false && item.type === 'video');
  const activePrimaryImage = primaryInputs.some((item) => item.enabled !== false && item.type === 'image');
  const roleSet = distinctActiveRoles(referenceInputs);
  const referenceCount = referenceInputs.filter((item) => item.enabled !== false && item.url).length;
  const hasSubject = roleSet.includes('subject') || roleSet.includes('omni');
  const hasComposition = roleSet.includes('composition') || roleSet.includes('omni');
  const hasLighting = roleSet.includes('lighting') || roleSet.includes('omni');
  const hasMotion = roleSet.includes('motion') || roleSet.includes('rhythm') || roleSet.includes('omni');
  const presets: WorkflowEnhancementStrategy['presets'] = [];

  if (referenceCount > 1 || roleSet.length > 1) {
    presets.push({
      id: 'multi-reference-fusion',
      enabled: true,
      mode: 'role-weighted-fusion',
      roleScope: roleSet,
      providerFallbacks: ['kling-o3', 'happyhorse-11', 'seedance-v2', 'flux-pro', 'gpt-image-2'],
      notes: 'Role-aware multi-reference fusion protocol keeps subject, style, composition, and lighting controls separated before merge.',
    });
  }

  if (nodeType === 'image' && activePrimaryImage && (hasSubject || hasComposition)) {
    presets.push({
      id: 'composition-lock',
      enabled: true,
      mode: 'primary-composition-lock',
      strength: hasSubject ? 0.96 : 0.88,
      roleScope: ['composition', 'subject'],
      providerFallbacks: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'grok-imagine-1.5-edit-apimart'],
      notes: 'Keep composition, framing, perspective, and layout from the primary image while editing only requested subject/style layers.',
    });
  }

  if ((nodeType === 'image' || nodeType === 'video') && (hasSubject || identityController?.enabled)) {
    presets.push({
      id: 'subject-consistency',
      enabled: true,
      mode: identityController?.enabled ? 'identity-controller-plus-reference' : 'reference-feature-anchor',
      strength: identityController?.enabled ? Number(identityController.subjectLock || 0.88) : 0.9,
      roleScope: ['subject', 'omni'],
      providerFallbacks: nodeType === 'video'
        ? ['kling-o3', 'happyhorse-11', 'seedance-v2']
        : ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'lib-image'],
      maxRetries: 0,
      notes: 'Protocol-only subject consistency contract for this round; execution remains native-first and cost-safe.',
    });
  }

  if (nodeType === 'video' && activePrimaryVideo) {
    presets.push({
      id: 'camera-motion-lock',
      enabled: true,
      mode: 'primary-video-camera-lock',
      strength: hasMotion || hasLighting ? 0.94 : 0.9,
      roleScope: hasMotion ? ['motion', 'rhythm', 'lighting'] : ['motion'],
      providerFallbacks: ['kling-o3', 'seedance-v2', 'happyhorse-11'],
      notes: 'Lock camera path, shot timing, framing, and spatial layout from the primary video before applying subject/style overrides.',
    });
  }

  if ((hasSubject || hasLighting || hasComposition || hasMotion) && (referenceCount > 0 || identityController?.enabled)) {
    presets.push({
      id: 'consistency-validation',
      enabled: true,
      mode: 'contract-check-only',
      roleScope: roleSet,
      maxRetries: 0,
      notes: 'This round only persists the consistency-validation contract. Real auto-regenerate loops stay disabled until explicit paid verification is approved.',
    });
  }

  if (!presets.length) return undefined;
  return {
    mode: 'native-first',
    contractVersion: 'hmdao.enhancement.v1',
    presets,
    costGuard: {
      imageMaxRetries: 0,
      videoSegmentMaxRetries: 0,
      waitTimeoutSec: nodeType === 'video' ? 900 : 180,
    },
  };
}

function createStage(stageId: string, kind: WorkflowStageKind, label: string, operation: string, requirements: WorkflowCapabilityRequirement[], providerHint = '', modelHint = '') {
  return {
    id: stageId,
    kind,
    label,
    status: 'ready' as const,
    operation,
    providerHint,
    modelHint,
    capabilityRequirements: requirements,
  };
}

function stageStatusForOutcome(kind: WorkflowStageKind, outcome: 'completed' | 'failed') {
  if (outcome === 'completed') return 'completed' as WorkflowStageStatus;
  if (kind === 'deliver') return 'pending' as WorkflowStageStatus;
  if (kind === 'validate' || kind === 'generate') return 'failed' as WorkflowStageStatus;
  return 'completed' as WorkflowStageStatus;
}

export function completeWorkflowGraph(
  graph: WorkflowGraph,
  options: {
    outcome?: 'completed' | 'failed';
    artifacts?: Array<{
      stageKind: WorkflowStageKind;
      label: string;
      kind: WorkflowArtifactKind;
      storage?: WorkflowArtifactStorage;
      status?: WorkflowArtifact['status'];
      mimeType?: string;
      url?: string;
      handle?: string;
      data?: Record<string, unknown>;
    }>;
  } = {},
): WorkflowGraph {
  const outcome = options.outcome || 'completed';
  const nextStages = graph.stages.map((stage) => ({
    ...stage,
    status: stageStatusForOutcome(stage.kind, outcome),
  }));
  const nextArtifacts = [...graph.artifacts];
  for (const artifact of options.artifacts || []) {
    const stage = nextStages.find((item) => item.kind === artifact.stageKind) || nextStages[nextStages.length - 1];
    nextArtifacts.push({
      id: `${graph.graphId}:artifact:${artifact.kind}:${nextArtifacts.length + 1}`,
      stageId: stage.id,
      label: artifact.label,
      kind: artifact.kind,
      storage: artifact.storage || (artifact.handle ? 'local-handle' : artifact.url ? 'remote-url' : 'inline'),
      status: artifact.status || 'ready',
      mimeType: artifact.mimeType,
      url: artifact.url,
      handle: artifact.handle,
      data: artifact.data,
      createdAt: Date.now(),
    });
  }
  return {
    ...graph,
    stages: nextStages,
    artifacts: nextArtifacts,
  };
}

export function buildVideoModelCapabilityRequirements(params: {
  generationMode: string;
  primaryInputs: MediaInput[];
  referenceInputs: MediaInput[];
  identityController?: IdentityControllerConfig;
}): WorkflowCapabilityRequirement[] {
  const requirements: WorkflowCapabilityRequirement[] = [];
  const {
    generationMode,
    primaryInputs = [],
    referenceInputs = [],
    identityController,
  } = params;
  const activePrimaryVideo = primaryInputs.some((item) => item.enabled !== false && item.type === 'video');
  const hasImageReference = referenceInputs.some((item) => item.enabled !== false && item.type === 'image');
  const hasVideoReference = referenceInputs.some((item) => item.enabled !== false && item.type === 'video');
  const roles = uniqueRoleReferences([...primaryInputs, ...referenceInputs]).map((item) => item.role).filter(Boolean);
  const referenceRoleSet = new Set(roles);
  const referenceCount = referenceInputs.filter((item) => item.enabled !== false && item.url).length;

  if (generationMode) {
    requirements.push({ key: 'generationMode', value: generationMode, required: true });
  }
  for (const role of roles) {
    requirements.push({ key: 'referenceRole', value: role, required: true });
  }
  if (generationMode === 'textToVideo') requirements.push({ key: 'supportsTextToVideo', value: true, required: true });
  if (generationMode === 'imageToVideo') requirements.push({ key: 'supportsImageToVideo', value: true, required: true });
  if (generationMode === 'firstLastFrame') requirements.push({ key: 'supportsFirstLastFrame', value: true, required: true });
  if (generationMode === 'referenceVideo' || hasVideoReference) requirements.push({ key: 'supportsReferenceVideo', value: true, required: true });
  if (hasImageReference || generationMode === 'imageToVideo' || generationMode === 'firstLastFrame') {
    requirements.push({ key: 'supportsReferenceImage', value: true, required: true });
  }
  if (activePrimaryVideo) requirements.push({ key: 'supportsPrimaryVideoMotionLock', value: true, required: true });
  if (activePrimaryVideo && hasVideoReference) requirements.push({ key: 'supportsActionTransfer', value: true, required: true });
  if (activePrimaryVideo && hasImageReference) requirements.push({ key: 'supportsVideoStyleTransfer', value: true, required: true });
  if (referenceCount > 1 || referenceRoleSet.size > 1) requirements.push({ key: 'supportsMultiReference', value: true, required: true });
  if (referenceRoleSet.has('omni')) requirements.push({ key: 'supportsOmniReference', value: true, required: true });
  if (referenceRoleSet.has('subject') || referenceRoleSet.has('omni')) requirements.push({ key: 'supportsSubjectLock', value: true, required: true });
  if ((referenceRoleSet.has('composition') || referenceRoleSet.has('omni')) && activePrimaryVideo) {
    requirements.push({ key: 'supportsCompositionLock', value: true, required: true });
  }
  if (referenceRoleSet.has('lighting') || referenceRoleSet.has('omni')) requirements.push({ key: 'supportsLightingControl', value: true, required: true });
  if (activePrimaryVideo && hasImageReference) requirements.push({ key: 'supportsCameraMotionLockEnhancement', value: true, required: true });
  if ((referenceRoleSet.has('subject') || referenceRoleSet.has('omni')) && hasImageReference) {
    requirements.push({ key: 'supportsConsistencyEnhancement', value: true, required: true });
  }
  if (identityController?.enabled && identityController.identityLockMode !== 'off') {
    requirements.push({ key: 'supportsIdentityController', value: true, required: true });
  }
  return requirements;
}

export function buildImageModelCapabilityRequirements(params: {
  toolOperation?: string;
  primaryInputs: MediaInput[];
  referenceInputs: MediaInput[];
  identityController?: IdentityControllerConfig;
}): WorkflowCapabilityRequirement[] {
  const requirements: WorkflowCapabilityRequirement[] = [];
  const {
    toolOperation,
    primaryInputs = [],
    referenceInputs = [],
    identityController,
  } = params;
  const hasPrimaryImage = primaryInputs.some((item) => item.enabled !== false && item.type === 'image');
  const roles = distinctActiveRoles(referenceInputs);
  const referenceCount = referenceInputs.filter((item) => item.enabled !== false && item.url).length;
  if (toolOperation) requirements.push({ key: 'toolOperation', value: toolOperation, required: true });
  for (const role of uniqueRoleReferences([...primaryInputs, ...referenceInputs]).map((item) => item.role).filter(Boolean)) {
    requirements.push({ key: 'referenceRole', value: role, required: true });
  }
  if (referenceCount > 1 || roles.length > 1) requirements.push({ key: 'supportsMultiReference', value: true, required: true });
  if (hasRole(referenceInputs, 'omni')) requirements.push({ key: 'supportsOmniReference', value: true, required: true });
  if (hasRole(referenceInputs, 'subject')) requirements.push({ key: 'supportsSubjectLock', value: true, required: true });
  if (hasRole(referenceInputs, 'composition') || (hasPrimaryImage && hasRole(referenceInputs, 'subject'))) {
    requirements.push({ key: 'supportsCompositionLock', value: true, required: true });
  }
  if (hasRole(referenceInputs, 'lighting')) requirements.push({ key: 'supportsLightingControl', value: true, required: true });
  if (hasPrimaryImage && hasRole(referenceInputs, 'subject')) requirements.push({ key: 'supportsConsistencyEnhancement', value: true, required: true });
  if (identityController?.enabled && identityController.identityLockMode !== 'off') {
    requirements.push({ key: 'supportsIdentityController', value: true, required: true });
  }
  return requirements;
}

export function evaluateModelCapabilitySupport(
  capabilities: ModelCapabilityMatrix | undefined,
  requirements: WorkflowCapabilityRequirement[],
): { supported: boolean; reason: string | null; missing: WorkflowCapabilityRequirement[] } {
  const matrix = capabilities || {};
  if (!Object.keys(matrix).length) {
    return { supported: true, reason: null, missing: [] };
  }
  const missing: WorkflowCapabilityRequirement[] = [];
  const inferCapability = (key: string) => {
    switch (key) {
      case 'supportsRegionPack':
        return Boolean(
          matrix.supportsRegionPack
          ?? matrix.supportsRemoteEditing
          ?? matrix.supportsLocalEditing
          ?? matrix.supportsReferenceImage
          ?? matrix.supportsReferenceVideo
        );
      case 'supportsRegionSpecificBindings':
        return Boolean(
          matrix.supportsRegionSpecificBindings
          ?? matrix.supportsMultiReference
          ?? matrix.supportsReferenceImage
          ?? matrix.supportsReferenceVideo
        );
      case 'supportsExactTransfer':
        return Boolean(
          matrix.supportsExactTransfer
          ?? (matrix.supportsSubjectLock && matrix.supportsCompositionLock)
        );
      case 'supportsBackgroundFuse':
        return Boolean(
          matrix.supportsBackgroundFuse
          ?? matrix.supportsOmniReference
          ?? matrix.supportsLightingControl
          ?? matrix.supportsRemoteEditing
        );
      case 'supportsMultiRegionExecution':
        return Boolean(
          matrix.supportsMultiRegionExecution
          ?? matrix.supportsMultiReference
          ?? matrix.supportsConsistencyEnhancement
        );
      case 'supportsTrackedVideoRegions':
        return Boolean(
          matrix.supportsTrackedVideoRegions
          ?? (matrix.supportsReferenceVideo && matrix.supportsPrimaryVideoMotionLock)
        );
      default:
        return false;
    }
  };
  for (const requirement of requirements) {
    const value = requirement.value;
    switch (requirement.key) {
      case 'generationMode':
        if (typeof value === 'string' && !(matrix.generationModes || []).includes(value)) missing.push(requirement);
        break;
      case 'referenceRole':
        if (typeof value === 'string' && !(matrix.referenceRoles || []).includes(value)) missing.push(requirement);
        break;
      case 'toolOperation':
        if (typeof value === 'string' && !(matrix.toolOperations || []).includes(value)) missing.push(requirement);
        break;
      case 'supportsIdentityController':
        if (!matrix.supportsIdentityController) missing.push(requirement);
        break;
      case 'supportsMultiReference':
        if (!matrix.supportsMultiReference) missing.push(requirement);
        break;
      case 'supportsOmniReference':
        if (!matrix.supportsOmniReference) missing.push(requirement);
        break;
      case 'supportsSubjectLock':
        if (!matrix.supportsSubjectLock) missing.push(requirement);
        break;
      case 'supportsCompositionLock':
        if (!matrix.supportsCompositionLock) missing.push(requirement);
        break;
      case 'supportsLightingControl':
        if (!matrix.supportsLightingControl) missing.push(requirement);
        break;
      case 'supportsConsistencyEnhancement':
        if (!matrix.supportsConsistencyEnhancement) missing.push(requirement);
        break;
      case 'supportsCameraMotionLockEnhancement':
        if (!matrix.supportsCameraMotionLockEnhancement) missing.push(requirement);
        break;
      case 'supportsTextToVideo':
        if (!matrix.supportsTextToVideo) missing.push(requirement);
        break;
      case 'supportsImageToVideo':
        if (!matrix.supportsImageToVideo) missing.push(requirement);
        break;
      case 'supportsFirstLastFrame':
        if (!matrix.supportsFirstLastFrame) missing.push(requirement);
        break;
      case 'supportsReferenceVideo':
        if (!matrix.supportsReferenceVideo) missing.push(requirement);
        break;
      case 'supportsReferenceImage':
        if (!matrix.supportsReferenceImage) missing.push(requirement);
        break;
      case 'supportsVideoStyleTransfer':
        if (!matrix.supportsVideoStyleTransfer) missing.push(requirement);
        break;
      case 'supportsPrimaryVideoMotionLock':
        if (!matrix.supportsPrimaryVideoMotionLock) missing.push(requirement);
        break;
      case 'supportsActionTransfer':
        if (!(matrix.supportsActionTransfer ?? (matrix.supportsReferenceVideo && matrix.supportsPrimaryVideoMotionLock))) {
          missing.push(requirement);
        }
        break;
      case 'supportsRegionPack':
      case 'supportsRegionSpecificBindings':
      case 'supportsExactTransfer':
      case 'supportsBackgroundFuse':
      case 'supportsMultiRegionExecution':
      case 'supportsTrackedVideoRegions':
        if (!inferCapability(requirement.key)) missing.push(requirement);
        break;
      default:
        break;
    }
  }

  if (!missing.length) {
    return { supported: true, reason: null, missing: [] };
  }

  const reason = missing[0]?.key === 'generationMode'
    ? `当前模型不支持 ${String(missing[0].value || '')} 工作流`
    : missing[0]?.key === 'toolOperation'
      ? `当前模型不支持 ${String(missing[0].value || '')} 工具链路`
      : missing[0]?.key === 'referenceRole'
        ? `当前模型不支持 ${String(missing[0].value || '')} 参考角色`
        : missing[0]?.key === 'supportsIdentityController'
          ? '当前模型不支持身份控制器'
          : missing[0]?.key === 'supportsActionTransfer'
            ? '当前模型不支持动作迁移，无法把参考视频动作稳定传递到目标视频'
          : '当前模型能力不足，无法满足当前链路要求';

  return {
    supported: false,
    reason,
    missing,
  };
}

export function buildNodeWorkflowGraph(params: {
  nodeId: string;
  nodeType: NodeType;
  executionMode: WorkflowExecutionMode;
  generationMode?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  sourceMediaType?: string;
  toolOperation?: string;
  primaryInputs?: MediaInput[];
  referenceInputs?: MediaInput[];
  identityController?: IdentityControllerConfig;
  sharedMemories?: WorkflowMemoryReference[];
}): WorkflowGraph {
  const {
    nodeId,
    nodeType,
    executionMode,
    generationMode,
    provider,
    model,
    prompt,
    sourceMediaType,
    toolOperation,
    primaryInputs = [],
    referenceInputs = [],
    identityController,
    sharedMemories = [],
  } = params;
  const graphId = `${nodeType}-${nodeId}-${executionMode}`;
  const capabilityRequirements = nodeType === 'video'
    ? buildVideoModelCapabilityRequirements({
        generationMode: generationMode || 'textToVideo',
        primaryInputs,
        referenceInputs,
        identityController,
      })
    : nodeType === 'image'
      ? buildImageModelCapabilityRequirements({
          toolOperation,
          primaryInputs,
          referenceInputs,
          identityController,
        })
      : [];
  const enhancementStrategy = buildEnhancementStrategy({
    nodeType,
    primaryInputs,
    referenceInputs,
    identityController,
  });

  const stages = [
    createStage(`${graphId}:plan`, 'plan', '需求规划', prompt ? 'prompt_contract_planning' : 'workflow_contract_planning', capabilityRequirements, provider, model),
    createStage(`${graphId}:preprocess`, 'preprocess', '参考预处理', toolOperation || `${nodeType}_reference_preprocess`, capabilityRequirements, provider, model),
    createStage(`${graphId}:generate`, 'generate', '核心生成', toolOperation || generationMode || `${nodeType}_generate`, capabilityRequirements, provider, model),
    createStage(`${graphId}:validate`, 'validate', '质量验证', nodeType === 'video' ? 'validate_identity_motion_delivery' : 'validate_identity_style_delivery', capabilityRequirements, provider, model),
    createStage(`${graphId}:deliver`, 'deliver', '结果交付', 'persist_result_and_publish', capabilityRequirements, provider, model),
  ];

  return {
    version: 'hmdao.workflow.v2',
    graphId,
    nodeType,
    executionMode,
    generationMode,
    stages,
    edges: [
      { from: stages[0].id, to: stages[1].id },
      { from: stages[1].id, to: stages[2].id },
      { from: stages[2].id, to: stages[3].id },
      { from: stages[3].id, to: stages[4].id },
    ],
    artifacts: [
      {
        id: `${graphId}:artifact:plan`,
        stageId: stages[0].id,
        label: '计划说明',
        kind: 'prompt-plan',
        storage: 'inline',
        status: prompt ? 'ready' : 'pending',
        data: {
          prompt: prompt || '',
          generationMode: generationMode || '',
          sourceMediaType: sourceMediaType || '',
        },
        createdAt: Date.now(),
      },
      {
        id: `${graphId}:artifact:memory`,
        stageId: stages[0].id,
        label: '共享记忆包',
        kind: 'memory-pack',
        storage: 'inline',
        status: sharedMemories.length ? 'ready' : 'pending',
        data: {
          memories: sharedMemories,
          count: sharedMemories.length,
        },
        createdAt: Date.now(),
      },
      {
        id: `${graphId}:artifact:reference`,
        stageId: stages[1].id,
        label: '参考素材包',
        kind: 'reference-pack',
        storage: 'inline',
        status: primaryInputs.length || referenceInputs.length ? 'ready' : 'pending',
        data: {
          primaryInputs: uniqueRoleReferences(primaryInputs),
          referenceInputs: uniqueRoleReferences(referenceInputs),
        },
        createdAt: Date.now(),
      },
      {
        id: `${graphId}:artifact:conditioning`,
        stageId: stages[1].id,
        label: '身份与控制条件',
        kind: 'conditioning-pack',
        storage: 'inline',
        status: 'ready',
        data: {
          identityController: identityController || null,
          capabilityRequirements,
        },
        createdAt: Date.now(),
      },
      {
        id: `${graphId}:artifact:enhancement`,
        stageId: stages[1].id,
        label: '一致性增强协议',
        kind: 'enhancement-pack',
        storage: 'inline',
        status: enhancementStrategy ? 'ready' : 'pending',
        data: enhancementStrategy || { presets: [], contractVersion: 'hmdao.enhancement.v1' },
        createdAt: Date.now(),
      },
      {
        id: `${graphId}:artifact:delivery`,
        stageId: stages[4].id,
        label: '交付占位',
        kind: 'delivery-package',
        storage: 'inline',
        status: 'pending',
        data: {
          provider: provider || '',
          model: model || '',
        },
        createdAt: Date.now(),
      },
    ],
    identityController,
    enhancementStrategy,
    sharedMemories,
    referenceRoles: uniqueRoleReferences([...primaryInputs, ...referenceInputs]),
    templateVersion: '2026.06-stage-dag',
  };
}
