// Pure operation-dispatch helpers: config builders + routing/constraint primitives.
// Single-sourced from hmdao-api.mjs to keep the dispatch subsystem testable.
import { assetCoverageRoles } from './apimart-payload-utils.mjs';

// Auto-extracted pure operation-dispatch config builders.
// Safe to import anywhere (no module-level mutable state).

export const IMAGE_OPERATION_DISPATCH = {
  panorama_720: {
    label: '720 panorama generation',
    latestTechnique: 'Single-image spherical panorama using geometry-aware scene extension and seam-constrained diffusion outpainting.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  multi_angle_view: {
    label: 'consistent multi-angle generation',
    latestTechnique: 'Geometry-consistent multi-view diffusion with identity locking, camera-conditioned view synthesis, and reference feature anchoring.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  pbr_relight: {
    label: 'PBR relighting',
    latestTechnique: 'Relightable representation with intrinsic decomposition, normal-aware shading reconstruction, and material-preserving highlight transfer.',
    candidates: ['doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'flux-pro', 'gpt-image-2', 'lib-image'],
  },
  storyboard_grid: {
    label: 'cinematic storyboard batching',
    latestTechnique: 'Reference-consistent storyboard generation with shot-language prompting and panel-level composition control.',
    candidates: ['doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'flux-pro', 'gpt-image-2', 'lib-image', 'wanx-v1'],
  },
  hd_toolbox_enhance: {
    label: 'HD toolbox enhance',
    latestTechnique: 'Hybrid super-resolution and restoration using detail hallucination control with face-preserving refinement.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  hd_upscale: {
    label: 'HD upscale',
    latestTechnique: 'Super-resolution with face-aware detail preservation and texture-consistent sharpening.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  hd_outpaint: {
    label: 'HD outpaint',
    latestTechnique: 'Composition-aware outpainting with boundary extrapolation and perspective continuity control.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  hd_inpaint: {
    label: 'HD inpaint',
    latestTechnique: 'Localized inpainting with context-aware fill and subject boundary recovery.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  hd_erase: {
    label: 'HD erase',
    latestTechnique: 'Object removal with semantic masking and background completion.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  hd_cutout: {
    label: 'HD cutout',
    latestTechnique: 'Foreground extraction with matting refinement and edge fidelity recovery.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  hd_crop: {
    label: 'HD crop',
    latestTechnique: 'Cropping and reframing with composition-preserving subject alignment.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  hd_restore: {
    label: 'HD restore',
    latestTechnique: 'Restoration-first enhancement with denoise, deblur, and artifact suppression.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  smart_grid_split: {
    label: 'subject-aware grid split',
    latestTechnique: 'Subject-aware composition analysis with face-safe cut line planning and export-ready tile layout.',
    candidates: ['lib-image', 'gpt-image-2', 'flux-pro', 'wanx-v1'],
  },
  cinematic_camera_simulation: {
    label: 'cinematic camera simulation',
    latestTechnique: 'Lens-character post-simulation with depth-aware bokeh, optical aberration shaping, and filmic color-science LUT mapping.',
    candidates: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'lib-image'],
  },
  preserveCompositionReplaceSubject: {
    label: 'preserve composition replace subject',
    latestTechnique: 'Reference-conditioned image editing that locks composition, framing, and perspective while replacing only the hero subject using stronger identity and layout control.',
    candidates: ['wan2.7-image', 'flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'grok-imagine-1.5-edit-apimart', 'lib-image'],
  },
};

export function buildDefaultOperationDispatchConfig() {
  return {
    version: 1,
    global: {
      weights: {
        activation: 1200,
        preferredModel: 260,
        preferredProvider: 140,
        regionMatch: 90,
        regionMismatch: -80,
        cost: -22,
        latency: -9,
        disabled: -100000,
        referenceRole: 180,
        generationMode: 260,
      },
      referenceRouting: {
        image: {
          style: { preferredProviders: ['bailian', 'fal', 'openai', 'volcengine', 'siliconflow'], preferredModels: ['wan2.7-image', 'flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'Qwen/Qwen-Image'] },
          subject: { preferredProviders: ['bailian', 'fal', 'openai', 'volcengine', 'siliconflow'], preferredModels: ['wan2.7-image', 'flux-pro', 'gpt-image-2', 'grok-imagine-1.5-edit-apimart', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'Qwen/Qwen-Image'] },
          element: { preferredProviders: ['bailian', 'volcengine', 'openai', 'fal', 'siliconflow'], preferredModels: ['wan2.7-image', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'gpt-image-2', 'flux-pro', 'Qwen/Qwen-Image'] },
          composition: { preferredProviders: ['bailian', 'fal', 'openai', 'volcengine', 'siliconflow'], preferredModels: ['wan2.7-image', 'flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'Qwen/Qwen-Image'] },
          lighting: { preferredProviders: ['bailian', 'volcengine', 'fal', 'openai', 'siliconflow'], preferredModels: ['wan2.7-image', 'doubao-seedream-5-0-lite', 'doubao-seedream-5-0-pro', 'flux-pro', 'gpt-image-2', 'Qwen/Qwen-Image'] },
        },
        video: {
          style: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          subject: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          composition: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          lighting: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          motion: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          rhythm: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
        },
        videoGenerationModes: {
          textToVideo: { preferredProviders: ['siliconflow', 'bailian', 'kling', 'fal'], preferredModels: ['Wan-AI/Wan2.2-T2V-A14B', 'wan2.2-t2v-plus', 'kling-o3'] },
          imageToVideo: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-o3', 'happyhorse-11', 'seedance-v2', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          firstLastFrame: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-o3', 'happyhorse-11', 'seedance-v2', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          referenceVideo: { preferredProviders: ['kling', 'bailian', 'fal', 'siliconflow'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11', 'wan2.2-i2v-plus', 'Wan-AI/Wan2.2-I2V-A14B'] },
          videoStyleTransfer: { preferredProviders: ['kling', 'bailian', 'fal', 'replicate'], preferredModels: ['kling-v3-omni', 'seedance-v2', 'kling-o3', 'happyhorse-11'] },
        },
      },
      regionPreference: {
        CN: {
          preferredProviders: ['siliconflow', 'volcengine', 'bailian', 'kling'],
          secondaryProviders: ['openai', 'fal', 'replicate'],
        },
        US: {
          preferredProviders: ['openai', 'fal', 'replicate'],
          secondaryProviders: ['siliconflow', 'volcengine', 'bailian', 'kling'],
        },
        OTHER: {
          preferredProviders: ['openai', 'fal', 'replicate', 'siliconflow'],
          secondaryProviders: ['volcengine', 'bailian', 'kling'],
        },
      },
      disabledModels: [],
    },
    operations: Object.fromEntries(
      Object.entries(IMAGE_OPERATION_DISPATCH).map(([operation, strategy]) => [
        operation,
        {
          ...strategy,
          candidates: [...(strategy.candidates || [])],
          preferredProviders: [],
          disabledModels: [],
        },
      ]),
    ),
  };
}


export function normalizeOperationDispatchConfig(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const defaults = buildDefaultOperationDispatchConfig();
  const sourceGlobal = source.global && typeof source.global === 'object' && !Array.isArray(source.global) ? source.global : {};
  const sourceOperations = source.operations && typeof source.operations === 'object' && !Array.isArray(source.operations) ? source.operations : {};

  const operations = { ...defaults.operations };

  for (const [operation, strategy] of Object.entries(sourceOperations)) {
    const normalizedStrategy = strategy && typeof strategy === 'object' && !Array.isArray(strategy) ? strategy : {};
    const baseStrategy = defaults.operations[operation] || {
      label: operation,
      latestTechnique: '',
      candidates: [],
      preferredProviders: [],
      disabledModels: [],
    };

    operations[operation] = {
      ...baseStrategy,
      ...normalizedStrategy,
      candidates: Array.isArray(normalizedStrategy.candidates)
        ? normalizedStrategy.candidates.filter(Boolean)
        : [...(baseStrategy.candidates || [])],
      preferredProviders: Array.isArray(normalizedStrategy.preferredProviders)
        ? normalizedStrategy.preferredProviders.filter(Boolean)
        : [...(baseStrategy.preferredProviders || [])],
      disabledModels: Array.isArray(normalizedStrategy.disabledModels)
        ? normalizedStrategy.disabledModels.filter(Boolean)
        : [...(baseStrategy.disabledModels || [])],
    };
  }

  return {
    version: Number(source.version || defaults.version) || defaults.version,
    global: {
      weights: {
        ...defaults.global.weights,
        ...(sourceGlobal.weights && typeof sourceGlobal.weights === 'object' && !Array.isArray(sourceGlobal.weights) ? sourceGlobal.weights : {}),
      },
      referenceRouting: {
        ...defaults.global.referenceRouting,
        ...(sourceGlobal.referenceRouting && typeof sourceGlobal.referenceRouting === 'object' && !Array.isArray(sourceGlobal.referenceRouting) ? sourceGlobal.referenceRouting : {}),
      },
      regionPreference: {
        ...defaults.global.regionPreference,
        ...(sourceGlobal.regionPreference && typeof sourceGlobal.regionPreference === 'object' && !Array.isArray(sourceGlobal.regionPreference) ? sourceGlobal.regionPreference : {}),
      },
      disabledModels: Array.isArray(sourceGlobal.disabledModels)
        ? sourceGlobal.disabledModels.filter(Boolean)
        : [...defaults.global.disabledModels],
    },
    operations,
  };
}

function buildVideoSourceConstraint(primaryVideoProfile = null) {
  if (!primaryVideoProfile || !primaryVideoProfile.height) return null;
  if (primaryVideoProfile.height < 700) {
    return {
      kind: 'primary-video-min-height',
      severity: 'hard',
      reason: `Primary video height ${primaryVideoProfile.height}px is below the upstream Kling omni minimum of 700px.`,
      recommendedModels: ['seedance-v2'],
    };
  }
  return null;
}

function isApimartRelayEndpoint(value = '') {
  return /(apimart\.ai|suanliai\.top|comfly\.org)/i.test(String(value || '').trim());
}
function normalizeIdentityController(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    enabled: Boolean(input.enabled),
    identityLockMode: String(input.identityLockMode || 'off').trim(),
    fallbackPolicy: String(input.fallbackPolicy || 'reference_weight').trim(),
  };
}

function modelSupportsRequirement(item, requirement) {
  const capabilities = item?.capabilities || {};
  switch (requirement.key) {
    case 'generationMode':
      return Array.isArray(capabilities.generationModes) && capabilities.generationModes.includes(requirement.value);
    case 'referenceRole':
      return Array.isArray(capabilities.referenceRoles) && capabilities.referenceRoles.includes(requirement.value);
    case 'toolOperation':
      return Array.isArray(capabilities.toolOperations) && capabilities.toolOperations.includes(requirement.value);
    default:
      return Boolean(capabilities?.[requirement.key]);
  }
}

function capabilityPenalty(item, requirements = [], weights = {}) {
  if (!requirements.length) return 0;
  let penalty = 0;
  for (const requirement of requirements) {
    if (!modelSupportsRequirement(item, requirement)) {
      penalty += Math.abs(Number(weights.disabled || -100000));
    }
  }
  return penalty * -1;
}

function expandedReferenceRoles(asset = {}, options = {}) {
  return assetCoverageRoles(asset, options);
}

function referenceRoleRoutingScore(item, referenceAssets = [], routingConfig = {}, weights = {}, options = {}) {
  if (!referenceAssets.length) return 0;
  let score = 0;
  for (const asset of referenceAssets) {
    const weightFactor = Math.max(0, Math.min(1, Number(asset.weight || 0)));
    for (const role of expandedReferenceRoles(asset, options)) {
      const rule = routingConfig?.[role];
      if (!rule || typeof rule !== 'object') continue;
      const providerHit = (rule.preferredProviders || []).includes(item.provider);
      const modelHit = (rule.preferredModels || []).includes(item.id) || (rule.preferredModels || []).includes(item.upstreamModel);
      if (providerHit) score += Number(weights.referenceRole || 180) * Math.max(0.2, weightFactor);
      if (modelHit) score += Number(weights.referenceRole || 180) * 1.35 * Math.max(0.2, weightFactor);
    }
  }
  return score;
}

function videoGenerationModeRoutingScore(item, generationMode = '', routingConfig = {}, weights = {}) {
  const modeRule = routingConfig?.[generationMode];
  if (!modeRule || typeof modeRule !== 'object') return 0;
  let score = 0;
  if ((modeRule.preferredProviders || []).includes(item.provider)) {
    score += Number(weights.generationMode || 260);
  }
  if ((modeRule.preferredModels || []).includes(item.id) || (modeRule.preferredModels || []).includes(item.upstreamModel)) {
    score += Number(weights.generationMode || 260) * 1.35;
  }
  return score;
}

export {
  buildVideoSourceConstraint,
  isApimartRelayEndpoint,
  normalizeIdentityController,
  modelSupportsRequirement,
  capabilityPenalty,
  expandedReferenceRoles,
  referenceRoleRoutingScore,
  videoGenerationModeRoutingScore,
};
