// Pure helpers extracted from verify-browser-flow.mjs for incremental decoupling.
// These are side-effect-free (no cdp/browser/process/ mutable appUrl dependency)
// and are re-imported by the main orchestrator. Do not add side effects here.
import { assert } from './verify-helpers.mjs';

const assetLibraryFakeCustomApiProvider = 'openai';
const assetLibraryFakeCustomApiMode = 'llm';

const VERIFY_VIDEO_TOOL_OPERATIONS = {
  clip: 'ffmpeg_lossless_trim_wavesurfer',
  crop: 'ffmpeg_pixel_crop_cropper',
  hd: 'real_cugan_rife_codeformer_enhance',
  parse: 'opencv_scenedetect_keyframe_parse',
  removeSubtitle: 'opencv_telea_subtitle_remove',
  audioSplit: 'demucs_v4_audio_split',
};

const UI_ONLY_WORKFLOW_BROWSER_HELPERS = String.raw`
      const hmdaoRecordFrom = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const hmdaoClamp01 = (value, fallback) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return fallback;
        return Math.max(0, Math.min(1, numeric));
      };
      function hmdaoReadIdentityControllerConfig(value, referenceInputs = []) {
        const source = hmdaoRecordFrom(value);
        const hasSubjectReference = referenceInputs.some((item) => item?.enabled !== false && item?.role === 'subject');
        const rawMode = String(source.identityLockMode || (hasSubjectReference ? 'reference' : 'off')).trim();
        const identityLockMode = rawMode === 'embedding' || rawMode === 'lora' || rawMode === 'reference'
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
          subjectLock: hmdaoClamp01(source.subjectLock, hasSubjectReference ? 0.88 : 0.72),
          notes: typeof source.notes === 'string' ? source.notes.trim() : '',
        };
      }
      function hmdaoUniqueRoleReferences(inputs = []) {
        const seen = new Set();
        return inputs
          .filter((item) => item?.enabled !== false && item?.url)
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
            const key = String(item.channel || '') + ':' + String(item.type || '') + ':' + String(item.role || '') + ':' + String(item.sourceNodeId || '');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
      }
      function hmdaoCreateStage(stageId, kind, label, operation, requirements, providerHint = '', modelHint = '') {
        return {
          id: stageId,
          kind,
          label,
          status: 'ready',
          operation,
          providerHint,
          modelHint,
          capabilityRequirements: requirements,
        };
      }
      function hmdaoStageStatusForOutcome(kind, outcome) {
        if (outcome === 'completed') return 'completed';
        if (kind === 'deliver') return 'pending';
        if (kind === 'validate' || kind === 'generate') return 'failed';
        return 'completed';
      }
      function hmdaoCompleteWorkflowGraph(graph, options = {}) {
        const outcome = options.outcome || 'completed';
        const nextStages = Array.isArray(graph.stages)
          ? graph.stages.map((stage) => ({
              ...stage,
              status: hmdaoStageStatusForOutcome(stage.kind, outcome),
            }))
          : [];
        const nextArtifacts = Array.isArray(graph.artifacts) ? [...graph.artifacts] : [];
        for (const artifact of options.artifacts || []) {
          const stage = nextStages.find((item) => item.kind === artifact.stageKind) || nextStages[nextStages.length - 1] || { id: graph.graphId + ':deliver', kind: 'deliver' };
          nextArtifacts.push({
            id: graph.graphId + ':artifact:' + String(artifact.kind || 'artifact') + ':' + String(nextArtifacts.length + 1),
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
      function hmdaoBuildVideoModelCapabilityRequirements(params) {
        const requirements = [];
        const generationMode = String(params?.generationMode || '');
        const primaryInputs = Array.isArray(params?.primaryInputs) ? params.primaryInputs : [];
        const referenceInputs = Array.isArray(params?.referenceInputs) ? params.referenceInputs : [];
        const identityController = params?.identityController || null;
        const activePrimaryVideo = primaryInputs.some((item) => item?.enabled !== false && item?.type === 'video');
        const hasImageReference = referenceInputs.some((item) => item?.enabled !== false && item?.type === 'image');
        const hasVideoReference = referenceInputs.some((item) => item?.enabled !== false && item?.type === 'video');
        const roles = hmdaoUniqueRoleReferences([...primaryInputs, ...referenceInputs]).map((item) => item.role).filter(Boolean);
        if (generationMode) requirements.push({ key: 'generationMode', value: generationMode, required: true });
        for (const role of roles) requirements.push({ key: 'referenceRole', value: role, required: true });
        if (generationMode === 'textToVideo') requirements.push({ key: 'supportsTextToVideo', value: true, required: true });
        if (generationMode === 'imageToVideo') requirements.push({ key: 'supportsImageToVideo', value: true, required: true });
        if (generationMode === 'firstLastFrame') requirements.push({ key: 'supportsFirstLastFrame', value: true, required: true });
        if (generationMode === 'referenceVideo' || hasVideoReference) requirements.push({ key: 'supportsReferenceVideo', value: true, required: true });
        if (hasImageReference || generationMode === 'imageToVideo' || generationMode === 'firstLastFrame') {
          requirements.push({ key: 'supportsReferenceImage', value: true, required: true });
        }
        if (activePrimaryVideo) requirements.push({ key: 'supportsPrimaryVideoMotionLock', value: true, required: true });
        if (activePrimaryVideo && hasImageReference) requirements.push({ key: 'supportsVideoStyleTransfer', value: true, required: true });
        if (identityController?.enabled && identityController?.identityLockMode !== 'off') {
          requirements.push({ key: 'supportsIdentityController', value: true, required: true });
        }
        return requirements;
      }
      function hmdaoBuildImageModelCapabilityRequirements(params) {
        const requirements = [];
        const toolOperation = typeof params?.toolOperation === 'string' ? params.toolOperation : '';
        const primaryInputs = Array.isArray(params?.primaryInputs) ? params.primaryInputs : [];
        const referenceInputs = Array.isArray(params?.referenceInputs) ? params.referenceInputs : [];
        const identityController = params?.identityController || null;
        if (toolOperation) requirements.push({ key: 'toolOperation', value: toolOperation, required: true });
        for (const role of hmdaoUniqueRoleReferences([...primaryInputs, ...referenceInputs]).map((item) => item.role).filter(Boolean)) {
          requirements.push({ key: 'referenceRole', value: role, required: true });
        }
        if (identityController?.enabled && identityController?.identityLockMode !== 'off') {
          requirements.push({ key: 'supportsIdentityController', value: true, required: true });
        }
        return requirements;
      }
      function hmdaoBuildNodeWorkflowGraph(params) {
        const nodeId = String(params?.nodeId || '');
        const nodeType = String(params?.nodeType || '');
        const executionMode = String(params?.executionMode || 'editing');
        const generationMode = typeof params?.generationMode === 'string' ? params.generationMode : '';
        const provider = typeof params?.provider === 'string' ? params.provider : '';
        const model = typeof params?.model === 'string' ? params.model : '';
        const prompt = typeof params?.prompt === 'string' ? params.prompt : '';
        const sourceMediaType = typeof params?.sourceMediaType === 'string' ? params.sourceMediaType : '';
        const toolOperation = typeof params?.toolOperation === 'string' ? params.toolOperation : '';
        const primaryInputs = Array.isArray(params?.primaryInputs) ? params.primaryInputs : [];
        const referenceInputs = Array.isArray(params?.referenceInputs) ? params.referenceInputs : [];
        const identityController = params?.identityController || null;
        const graphId = nodeType + '-' + nodeId + '-' + executionMode;
        const capabilityRequirements = nodeType === 'video'
          ? hmdaoBuildVideoModelCapabilityRequirements({ generationMode: generationMode || 'textToVideo', primaryInputs, referenceInputs, identityController })
          : nodeType === 'image'
            ? hmdaoBuildImageModelCapabilityRequirements({ toolOperation, primaryInputs, referenceInputs, identityController })
            : [];
        const stages = [
          hmdaoCreateStage(graphId + ':plan', 'plan', '需求规划', prompt ? 'prompt_contract_planning' : 'workflow_contract_planning', capabilityRequirements, provider, model),
          hmdaoCreateStage(graphId + ':preprocess', 'preprocess', '参考预处理', toolOperation || (nodeType + '_reference_preprocess'), capabilityRequirements, provider, model),
          hmdaoCreateStage(graphId + ':generate', 'generate', '核心执行', toolOperation || generationMode || (nodeType + '_generate'), capabilityRequirements, provider, model),
          hmdaoCreateStage(graphId + ':validate', 'validate', '质量验证', nodeType === 'video' ? 'validate_identity_motion_delivery' : 'validate_identity_style_delivery', capabilityRequirements, provider, model),
          hmdaoCreateStage(graphId + ':deliver', 'deliver', '结果交付', 'persist_result_and_publish', capabilityRequirements, provider, model),
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
              id: graphId + ':artifact:plan',
              stageId: stages[0].id,
              label: '计划说明',
              kind: 'prompt-plan',
              storage: 'inline',
              status: prompt ? 'ready' : 'pending',
              data: {
                prompt,
                generationMode,
                sourceMediaType,
              },
              createdAt: Date.now(),
            },
            {
              id: graphId + ':artifact:reference',
              stageId: stages[1].id,
              label: '参考素材包',
              kind: 'reference-pack',
              storage: 'inline',
              status: primaryInputs.length || referenceInputs.length ? 'ready' : 'pending',
              data: {
                primaryInputs: hmdaoUniqueRoleReferences(primaryInputs),
                referenceInputs: hmdaoUniqueRoleReferences(referenceInputs),
              },
              createdAt: Date.now(),
            },
            {
              id: graphId + ':artifact:conditioning',
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
              id: graphId + ':artifact:delivery',
              stageId: stages[4].id,
              label: '交付占位',
              kind: 'delivery-package',
              storage: 'inline',
              status: 'pending',
              data: {
                provider,
                model,
              },
              createdAt: Date.now(),
            },
          ],
          identityController,
          referenceRoles: hmdaoUniqueRoleReferences([...primaryInputs, ...referenceInputs]),
          templateVersion: '2026.06-stage-dag',
        };
      }
`;


function isLocalHostName(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}


function assertStableViewport(before, after, label) {
  assert(before && after, `${label}: viewport missing`, { before, after });
  assert(before.x === after.x && before.y === after.y && before.zoom === after.zoom, `${label}: canvas viewport changed`, { before, after });
}


function normalizeConsoleEntry(entry) {
  if (typeof entry === 'string') {
    return {
      type: 'log',
      text: entry,
      timestampMs: 0,
      isoTimestamp: '',
    };
  }
  const type = typeof entry?.type === 'string' ? entry.type : 'log';
  const text = typeof entry?.text === 'string' ? entry.text : '';
  const timestampMs = Number.isFinite(Number(entry?.timestampMs)) ? Number(entry.timestampMs) : 0;
  const isoTimestamp = typeof entry?.isoTimestamp === 'string' ? entry.isoTimestamp : '';
  return { type, text, timestampMs, isoTimestamp };
}


function summarizeConsoleWarnings(messages, options = {}) {
  const sinceMs = Number.isFinite(Number(options.sinceMs)) ? Number(options.sinceMs) : 0;
  const entries = Array.isArray(messages) ? messages.map(normalizeConsoleEntry) : [];
  const relevant = entries.filter((entry) => !sinceMs || entry.timestampMs >= sinceMs);
  const blockedPatterns = [
    /nan/i,
    /invalid value.*css style property.*width/i,
    /parent container needs a width and a height/i,
    /couldn't create edge/i,
  ];
  const blocked = relevant.filter((entry) =>
    blockedPatterns.some((pattern) => pattern.test(entry.text))
  );
  const reactFlowEdgeWarnings = blocked.filter((entry) => /couldn't create edge/i.test(entry.text));
  return {
    sinceMs,
    observedCount: relevant.length,
    blockedCount: blocked.length,
    reactFlowEdgeWarningCount: reactFlowEdgeWarnings.length,
    blocked,
    reactFlowEdgeWarnings,
    passed: blocked.length === 0,
  };
}


function assertNoConsoleWarnings(messages, label, options = {}) {
  const audit = summarizeConsoleWarnings(messages, options);
  assert(audit.passed, `${label}: console warnings detected`, audit.blocked);
  return audit;
}


function assertVideoOutputIntegrity(completedNode, requestBody, label) {
  if (!completedNode) return {
    videoUrl: '',
    remoteVideoUrl: '',
    outputMeta: {},
    expectsLocalPostMix: false,
  };
  const videoUrl = String(completedNode?.data?.videoUrl || completedNode?.data?.outputs?.[0]?.url || '');
  const outputMeta = completedNode?.data?.outputs?.[0]?.metadata || {};
  const params = completedNode?.data?.params || {};
  const remoteVideoUrl = String(outputMeta.originalUrl || outputMeta.remoteGeneratedUrl || videoUrl || '');
  const expectsLocalPostMix = Boolean(
    outputMeta.localAudioPostMix
    || params.remoteVideoPostMixApplied
    || String(requestBody?.linked_audio_url || requestBody?.linkedAudioSourceUrl || '').trim().length > 0,
  );
  const hasRenderableUrl = (
    videoUrl.startsWith('/api/media-proxy?')
    || videoUrl.startsWith('hmdao-local://')
    || /^https?:\/\//i.test(videoUrl)
  );

  assert(/^https?:\/\//i.test(remoteVideoUrl), `${label} did not preserve a remote upstream asset URL.`, { videoUrl, remoteVideoUrl, outputMeta, params });
  assert(hasRenderableUrl, `${label} did not expose a renderable or managed video URL.`, { videoUrl, remoteVideoUrl, outputMeta, params });
  assert(
    String(outputMeta.mimeType || '').includes('video/')
      || /\.mp4($|\?)/i.test(remoteVideoUrl)
      || /\.webm($|\?)/i.test(remoteVideoUrl),
    `${label} did not look like a real video asset.`,
    { videoUrl, remoteVideoUrl, outputMeta, params },
  );
  assert(!outputMeta.workflowFallback, `${label} fell back to a local placeholder result.`, outputMeta);
  assert(!outputMeta.workflowFallbackReason, `${label} returned a fallback reason instead of a real asset.`, outputMeta);

  if (expectsLocalPostMix) {
    assert(Boolean(outputMeta.localAudioPostMix), `${label} should have been post-mixed locally but metadata.localAudioPostMix is missing.`, {
      videoUrl,
      remoteVideoUrl,
      outputMeta,
      params,
      requestBody,
    });
    assert(Boolean(outputMeta.managedUrl) || videoUrl.startsWith('hmdao-local://'), `${label} should point to a managed local result after post-mix.`, {
      videoUrl,
      remoteVideoUrl,
      outputMeta,
      params,
      requestBody,
    });
    assert(videoUrl !== remoteVideoUrl, `${label} still points to the raw remote URL instead of the post-mixed local result.`, {
      videoUrl,
      remoteVideoUrl,
      outputMeta,
      params,
      requestBody,
    });
    assert(/^https?:\/\//i.test(String(outputMeta.remoteGeneratedUrl || remoteVideoUrl || '')), `${label} is missing remoteGeneratedUrl for post-mix traceability.`, {
      videoUrl,
      remoteVideoUrl,
      outputMeta,
      params,
      requestBody,
    });
    assert(Boolean(params.remoteVideoPostMixApplied || params.linkedAudioApplied), `${label} is missing node params that confirm linked audio was applied.`, {
      videoUrl,
      remoteVideoUrl,
      outputMeta,
      params,
      requestBody,
    });
  }

  return { videoUrl, remoteVideoUrl, outputMeta, expectsLocalPostMix };
}


function roundMetric(value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(digits));
}


function normalizeReferenceWeight(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric > 1 ? numeric / 100 : numeric;
}


function buildReferenceImageConsistencyResult(body) {
  const assets = Array.isArray(body?.reference_assets) ? body.reference_assets : [];
  const subjectAssets = assets.filter((item) => item?.role === 'subject');
  const compositionAssets = assets.filter((item) => item?.role === 'composition');
  const enhancementStrategy = body?.enhancement_strategy && typeof body.enhancement_strategy === 'object'
    ? body.enhancement_strategy
    : {};
  const enhancementPresets = Array.isArray(enhancementStrategy?.presets) ? enhancementStrategy.presets : [];
  const sourceUrl = String(body?.source_url || '');
  const prompt = String(body?.prompt || '');
  const hasSource = sourceUrl.startsWith('data:image/');
  const subjectWeights = subjectAssets.map((item) => normalizeReferenceWeight(item?.weight)).filter((item) => item > 0);
  const avgSubjectWeight = subjectWeights.length
    ? subjectWeights.reduce((sum, item) => sum + item, 0) / subjectWeights.length
    : 0;
  const failReasons = [];
  if (!hasSource) failReasons.push('图片节点缺少主素材 source_url。');
  if (assets.length < 3) failReasons.push('图片节点未带上至少 3 个参考素材，三视图链路不完整。');
  if (subjectAssets.length < 2) failReasons.push('图片节点主体参考数量不足，无法稳定约束主体一致性。');
  if (avgSubjectWeight < 0.88) failReasons.push('图片节点主体参考权重偏低，主体保持约束不够强。');
  if (!/主体|构图|三视图/.test(prompt)) failReasons.push('图片节点提示词未明确表达主体保持或三视图意图。');
  if (!enhancementPresets.some((item) => String(item?.id || '') === 'composition-lock' && item?.enabled)) {
    failReasons.push('图片节点未持久化 composition-lock 增强协议。');
  }
  if (!enhancementPresets.some((item) => String(item?.id || '') === 'subject-consistency' && item?.enabled)) {
    failReasons.push('图片节点未持久化 subject-consistency 增强协议。');
  }

  const chainConnectivityScore = roundMetric(
    (hasSource ? 0.3 : 0)
    + Math.min(assets.length, 3) / 3 * 0.3
    + (subjectAssets.length >= 2 ? 0.25 : subjectAssets.length * 0.125)
    + (compositionAssets.length >= 1 ? 0.15 : 0),
  );
  const subjectConsistencyScore = roundMetric(
    (hasSource ? 0.2 : 0)
    + Math.min(subjectAssets.length, 2) / 2 * 0.35
    + Math.min(avgSubjectWeight / 0.92, 1) * 0.3
    + (/主体|构图|三视图/.test(prompt) ? 0.15 : 0),
  );

  return {
    passed: failReasons.length === 0 && chainConnectivityScore >= 0.9 && subjectConsistencyScore >= 0.85,
    mode: 'subject-preserve',
    chainConnectivityScore,
    subjectConsistencyScore,
    failReasons,
    sourceUrl,
    prompt,
    referenceAssetCount: assets.length,
    subjectReferenceCount: subjectAssets.length,
    compositionReferenceCount: compositionAssets.length,
    averageSubjectWeight: roundMetric(avgSubjectWeight),
    enhancementPresetIds: enhancementPresets.map((item) => String(item?.id || '')),
    roles: assets.map((item) => ({
      role: item?.role || '',
      type: item?.type || '',
      weight: normalizeReferenceWeight(item?.weight),
      channel: item?.channel || '',
    })),
  };
}


function buildReferenceVideoConsistencyResult(body) {
  const assets = Array.isArray(body?.reference_assets) ? body.reference_assets : [];
  const styleAssets = assets.filter((item) => item?.role === 'style' && item?.type === 'image');
  const motionAssets = assets.filter((item) => item?.role === 'motion' && item?.type === 'video');
  const enhancementStrategy = body?.enhancement_strategy && typeof body.enhancement_strategy === 'object'
    ? body.enhancement_strategy
    : {};
  const enhancementPresets = Array.isArray(enhancementStrategy?.presets) ? enhancementStrategy.presets : [];
  const styleWeights = styleAssets.map((item) => normalizeReferenceWeight(item?.weight)).filter((item) => item > 0);
  const motionWeights = motionAssets.map((item) => normalizeReferenceWeight(item?.weight)).filter((item) => item > 0);
  const maxStyleWeight = styleWeights.length ? Math.max(...styleWeights) : 0;
  const maxMotionWeight = motionWeights.length ? Math.max(...motionWeights) : 0;
  const sourceUrl = String(body?.source_url || '');
  const referenceImageUrl = String(body?.reference_image_url || '');
  const referenceVideoUrl = String(body?.reference_video_url || '');
  const prompt = String(body?.prompt || '');
  const strategy = body?.conditioning_strategy && typeof body.conditioning_strategy === 'object'
    ? body.conditioning_strategy
    : {};
  const failReasons = [];
  if (!/^https?:\/\//i.test(sourceUrl)) failReasons.push('视频节点缺少主视频 source_url。');
  if (!referenceImageUrl.startsWith('data:image/')) failReasons.push('视频节点缺少风格参考图 reference_image_url。');
  if (!/^https?:\/\//i.test(referenceVideoUrl)) failReasons.push('视频节点缺少视频参考 reference_video_url。');
  if (String(strategy.operation || '') !== 'videoStyleTransfer') failReasons.push('视频节点没有走到 videoStyleTransfer 路由。');
  if (!String(strategy.image_reference_policy || '').includes('transfer_style')) failReasons.push('视频节点缺少风格迁移策略声明。');
  if (!String(strategy.primary_video_policy || '').includes('preserve_camera_motion')) failReasons.push('视频节点缺少保留运镜/构图策略声明。');
  if (maxStyleWeight < 0.8) failReasons.push('视频节点风格参考权重偏低，风格跟随约束不够强。');
  if (maxMotionWeight < 0.8) failReasons.push('视频节点运动参考权重偏低，运镜保持约束不够强。');
  if (!prompt.includes('FINAL INTENT: perform video style transfer')) failReasons.push('视频节点提示词未注入风格迁移意图合同。');
  if (!enhancementPresets.some((item) => String(item?.id || '') === 'camera-motion-lock' && item?.enabled)) {
    failReasons.push('视频节点未持久化 camera-motion-lock 增强协议。');
  }
  if (!enhancementPresets.some((item) => String(item?.id || '') === 'subject-consistency' && item?.enabled)) {
    failReasons.push('视频节点未持久化 subject-consistency 增强协议。');
  }

  const chainConnectivityScore = roundMetric(
    (/^https?:\/\//i.test(sourceUrl) ? 0.2 : 0)
    + (referenceImageUrl.startsWith('data:image/') ? 0.2 : 0)
    + (/^https?:\/\//i.test(referenceVideoUrl) ? 0.15 : 0)
    + (String(strategy.operation || '') === 'videoStyleTransfer' ? 0.2 : 0)
    + (styleAssets.length >= 1 ? 0.15 : 0)
    + (motionAssets.length >= 1 ? 0.1 : 0),
  );
  const styleConsistencyScore = roundMetric(
    Math.min(maxStyleWeight / 0.86, 1) * 0.3
    + (String(strategy.image_reference_policy || '').includes('transfer_style') ? 0.25 : 0)
    + (referenceImageUrl.startsWith('data:image/') ? 0.2 : 0)
    + (prompt.includes('FINAL INTENT: perform video style transfer') ? 0.15 : 0)
    + (/style, lighting, background atmosphere/.test(prompt) ? 0.1 : 0),
  );
  const compositionLockScore = roundMetric(
    (String(strategy.primary_video_policy || '').includes('preserve_camera_motion') ? 0.35 : 0)
    + Math.min(maxMotionWeight / 0.86, 1) * 0.25
    + (String(strategy.video_reference_policy || '').includes('reuse_motion') ? 0.2 : 0)
    + (prompt.includes('PRIMARY VIDEO: preserve ONLY camera motion') ? 0.2 : 0),
  );

  return {
    passed: failReasons.length === 0 && chainConnectivityScore >= 0.9 && styleConsistencyScore >= 0.85 && compositionLockScore >= 0.8,
    mode: 'style-follow-motion-lock',
    chainConnectivityScore,
    styleConsistencyScore,
    compositionLockScore,
    failReasons,
    sourceUrl,
    referenceImageUrl,
    referenceVideoUrl,
    prompt,
    conditioningStrategy: strategy,
    referenceAssetCount: assets.length,
    styleReferenceCount: styleAssets.length,
    motionReferenceCount: motionAssets.length,
    maxStyleWeight: roundMetric(maxStyleWeight),
    maxMotionWeight: roundMetric(maxMotionWeight),
    enhancementPresetIds: enhancementPresets.map((item) => String(item?.id || '')),
    roles: assets.map((item) => ({
      role: item?.role || '',
      type: item?.type || '',
      weight: normalizeReferenceWeight(item?.weight),
      channel: item?.channel || '',
    })),
  };
}


function buildConditioningRoleMappingResult(body, options = {}) {
  const label = String(options.label || 'node');
  const expectedPrimaryRole = String(options.expectedPrimaryRole || 'composition');
  const expectedReferenceRole = String(options.expectedReferenceRole || 'subject');
  const primaryAssets = Array.isArray(body?.primary_assets) ? body.primary_assets : [];
  const referenceAssets = Array.isArray(body?.reference_assets) ? body.reference_assets : [];
  const firstPrimaryRole = String(primaryAssets[0]?.role || '');
  const firstReferenceRole = String(referenceAssets[0]?.role || '');
  const failReasons = [];

  if (!primaryAssets.length) failReasons.push(`${label} 缺少 primary_assets。`);
  if (!referenceAssets.length) failReasons.push(`${label} 缺少 reference_assets。`);
  if (firstPrimaryRole !== expectedPrimaryRole) {
    failReasons.push(`${label} 的 primary_assets[0].role 不是 ${expectedPrimaryRole}。`);
  }
  if (firstReferenceRole !== expectedReferenceRole) {
    failReasons.push(`${label} 的 reference_assets[0].role 不是 ${expectedReferenceRole}。`);
  }

  return {
    passed: failReasons.length === 0,
    label,
    expectedPrimaryRole,
    expectedReferenceRole,
    firstPrimaryRole,
    firstReferenceRole,
    primaryAssetCount: primaryAssets.length,
    referenceAssetCount: referenceAssets.length,
    failReasons,
    primaryAssets: primaryAssets.map((item) => ({
      role: String(item?.role || ''),
      type: String(item?.type || ''),
      channel: String(item?.channel || ''),
      sourceNodeId: String(item?.source_node_id || ''),
    })),
    referenceAssets: referenceAssets.map((item) => ({
      role: String(item?.role || ''),
      type: String(item?.type || ''),
      channel: String(item?.channel || ''),
      sourceNodeId: String(item?.source_node_id || ''),
    })),
  };
}


function buildImageRouteExpectationResult(state) {
  const route = state?.route || {};
  const matchedModel = state?.matchedModel || {};
  const body = state?.body || {};
  const bestFor = Array.isArray(matchedModel.bestFor) ? matchedModel.bestFor : [];
  const failReasons = [];
  if (!state?.route) failReasons.push('图片节点未返回路由结果。');
  if (String(body?.conditioning_strategy?.operation || '') !== 'preserveCompositionReplaceSubject') {
    failReasons.push('图片节点未识别为保构图换主体意图。');
  }
  if (!bestFor.some((item) => ['保构图换主体', '全能参考', '参考主体锁定', '角色一致性'].includes(String(item)))) {
    failReasons.push('图片节点未路由到具备主体锁定/全能参考优势的模型。');
  }
  if (String(route.model || '') === 'wanx-v1') {
    failReasons.push('图片节点仍停留在弱多参考控制模型 wanx-v1。');
  }
  return {
    passed: failReasons.length === 0,
    route,
    matchedModel,
    conditioningOperation: String(body?.conditioning_strategy?.operation || ''),
    failReasons,
  };
}


function buildVideoRouteExpectationResult(state, options = {}) {
  const label = String(options.label || '视频节点');
  const route = state?.route || {};
  const bestFor = Array.isArray(route.bestFor) ? route.bestFor : [];
  const failReasons = [];
  if (!state?.route) failReasons.push(`${label} 未返回路由结果。`);
  if (!route.supportsPrimaryVideoMotionLock && options.expectMotionLock !== false) {
    failReasons.push(`${label} 未路由到支持主视频运镜锁定的模型。`);
  }
  const expectedRouteIds = Array.isArray(options.expectedRouteIds)
    ? options.expectedRouteIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (expectedRouteIds.length > 0 && !expectedRouteIds.includes(String(route.id || '').trim())) {
    failReasons.push(`${label} 未命中预期路由模型：${expectedRouteIds.join(' / ')}。`);
  }
  if (!route.supportsIdentityController && options.expectIdentityLock !== false) {
    failReasons.push(`${label} 未路由到支持身份控制器的模型。`);
  }
  if (options.expectStyleTransfer !== false && !route.supportsVideoStyleTransfer) {
    failReasons.push(`${label} 未路由到支持视频风格迁移的模型。`);
  }
  if (!bestFor.some((item) => ['主体锁定', '高要求参考视频编辑', '全能参考', '主视频运镜保留'].includes(String(item)))) {
    failReasons.push(`${label} 未命中主体锁定/高要求参考编辑/全能参考标签。`);
  }
  return {
    passed: failReasons.length === 0,
    label,
    route,
    selected: state?.selected || null,
    referenceRoleCount: Number(state?.referenceRoleCount || 0),
    failReasons,
  };
}


function buildCatalogAliasExpectationResult(state, options = {}) {
  const label = String(options.label || '模型目录别名');
  const expectedCatalogId = String(options.expectedCatalogId || '').trim();
  const failReasons = [];
  if (!state?.matched) {
    failReasons.push(`${label} 未解析到任何目录模型。`);
  }
  if (expectedCatalogId && String(state?.normalizedRequestedModel || '').trim() !== expectedCatalogId) {
    failReasons.push(`${label} 未先归一化到 ${expectedCatalogId}。`);
  }
  if (expectedCatalogId && String(state?.matched?.id || '').trim() !== expectedCatalogId) {
    failReasons.push(`${label} 未稳定落到 ${expectedCatalogId} 目录模型。`);
  }
  return {
    passed: failReasons.length === 0,
    label,
    expectedCatalogId,
    requestedModel: String(state?.requestedModel || ''),
    normalizedRequestedModel: String(state?.normalizedRequestedModel || ''),
    matched: state?.matched || null,
    matchedIds: Array.isArray(state?.matchedIds) ? state.matchedIds : [],
    failReasons,
  };
}

export {
  isLocalHostName, roundMetric, normalizeReferenceWeight, normalizeConsoleEntry,
  summarizeConsoleWarnings, buildReferenceImageConsistencyResult,
  buildReferenceVideoConsistencyResult, buildConditioningRoleMappingResult,
  buildImageRouteExpectationResult, buildVideoRouteExpectationResult,
  buildCatalogAliasExpectationResult, assertStableViewport, assertNoConsoleWarnings,
  assertVideoOutputIntegrity, VERIFY_VIDEO_TOOL_OPERATIONS,
  UI_ONLY_WORKFLOW_BROWSER_HELPERS, assetLibraryFakeCustomApiProvider,
  assetLibraryFakeCustomApiMode,
};
