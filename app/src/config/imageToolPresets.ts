export type ImageGenerationTool = 'panorama' | 'multiAngle' | 'lighting' | 'grid' | 'hd' | 'split' | 'camera';

export interface ImageToolPreset {
  label: string;
  operation: string;
  capability: string;
  promptInstruction: string;
  defaultParams: Record<string, unknown>;
  preferredProviders: string[];
  preferredModels: string[];
  variantOperations?: Record<string, string>;
}

export const IMAGE_TOOL_ORDER: ImageGenerationTool[] = ['panorama', 'multiAngle', 'lighting', 'grid', 'hd', 'split', 'camera'];

export const IMAGE_TOOL_PRESETS: Record<ImageGenerationTool, ImageToolPreset> = {
  panorama: {
    label: '\u5168\u666f',
    operation: 'panorama_720',
    capability: 'single_image_to_720_panorama',
    promptInstruction:
      'Generate a seamless 720-degree spherical panorama from the reference image. Preserve spatial consistency, extend the scene naturally, avoid visible seams, and keep the original subject identity and style.',
    defaultParams: {
      fov: 120,
      spatialFusion: 0.75,
      panoramaResolution: '4K',
      localInpaint: true,
      panoramaYaw: 0,
      panoramaPitch: 0,
      panoramaZoom: 1,
      panoramaAnchorX: 0.5,
      panoramaAnchorY: 0.5,
      panoramaLocalEditEnabled: true,
      brushMode: 'paint',
      brushSize: 24,
      maskStrength: 0.8,
      maskPoints: [],
    },
    preferredProviders: ['fal', 'replicate', 'openai', 'siliconflow'],
    preferredModels: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-lite', 'lib-image'],
  },
  multiAngle: {
    label: '\u591a\u89d2\u5ea6',
    operation: 'multi_angle_view',
    capability: 'consistent_multi_angle_generation',
    promptInstruction:
      'Render a new camera angle from the reference image while keeping the subject, clothing, face, scene layout, and style consistent. Treat yaw, pitch, and shot scale as camera controls, not as a new character design.',
    defaultParams: {
      yaw: 45,
      pitch: 15,
      shotScale: 'medium',
      consistency: 0.85,
      framingZoom: 1,
      cameraPreset: 'front',
      keyframes: [],
    },
    preferredProviders: ['fal', 'replicate', 'kling', 'volcengine'],
    preferredModels: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-pro', 'doubao-seedream-5-0-lite', 'lib-image'],
  },
  lighting: {
    label: '\u6253\u5149',
    operation: 'pbr_relight',
    capability: 'pbr_material_relighting',
    promptInstruction:
      'Relight the reference image with physically plausible PBR lighting. Preserve geometry and texture detail, add coherent shadows and highlights, and avoid changing the subject identity.',
    defaultParams: {
      preset: 'rembrandt',
      activeLight: 'key',
      keyLightAzimuth: 45,
      keyLightElevation: 30,
      keyLightIntensity: 0.8,
      keyLightTemperature: 5200,
      fillLightAzimuth: -35,
      fillLightElevation: 15,
      fillLightIntensity: 0.35,
      fillLightTemperature: 5600,
      rimLightEnabled: true,
      rimLightAzimuth: 140,
      rimLightElevation: 10,
      rimLightIntensity: 0.45,
      envLightIntensity: 0.35,
      envLightRotation: 0,
      hdri: false,
      hdriUrl: '',
      hdriAssetName: '',
    },
    preferredProviders: ['fal', 'openai', 'siliconflow', 'volcengine'],
    preferredModels: ['doubao-seedream-5-0-pro', 'doubao-seedream-5-0-lite', 'flux-pro', 'gpt-image-2', 'lib-image'],
  },
  grid: {
    label: '\u4e5d\u5bab\u683c',
    operation: 'storyboard_grid',
    capability: 'cinematic_storyboard_batch',
    promptInstruction:
      'Generate a cinematic storyboard grid from the reference image. Keep characters and scene style consistent across panels, vary shot language deliberately, and arrange the result as a coherent grid.',
    defaultParams: {
      template: 'nine_shot',
      cells: 9,
      consistency: 0.9,
      exportLayout: '3x3',
    },
    preferredProviders: ['openai', 'fal', 'volcengine', 'bailian'],
    preferredModels: ['doubao-seedream-5-0-pro', 'doubao-seedream-5-0-lite', 'flux-pro', 'gpt-image-2', 'wanx-v1', 'lib-image'],
  },
  hd: {
    label: '\u9ad8\u6e05',
    operation: 'hd_toolbox_enhance',
    capability: 'image_restoration_upscale_editing',
    promptInstruction:
      'Enhance the reference image quality. Improve sharpness, recover details, reduce compression artifacts and noise, preserve natural faces and textures, and avoid overprocessed plastic skin.',
    defaultParams: {
      upscale: '2x',
      restoration: true,
      denoise: 0.25,
      detailBoost: 0.45,
      faceRestore: true,
      preserveTexture: true,
      hdMode: 'upscale',
      outpaintDirection: 'right',
      outpaintRatio: 0.35,
      outpaintFeather: 0.5,
      brushMode: 'paint',
      brushSize: 24,
      maskStrength: 0.8,
      maskPoints: [],
      eraseFeather: 0.55,
      cropRatio: '1:1',
      cropCenterX: 0.5,
      cropCenterY: 0.5,
      cropZoom: 1,
      subjectThreshold: 0.58,
      edgeFeather: 0.35,
      textureRecovery: 0.7,
      compareSplit: 0.55,
    },
    preferredProviders: ['openai', 'fal', 'siliconflow', 'volcengine'],
    preferredModels: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-pro', 'doubao-seedream-5-0-lite', 'lib-image'],
    variantOperations: {
      upscale: 'hd_upscale',
      outpaint: 'hd_outpaint',
      inpaint: 'hd_inpaint',
      erase: 'hd_erase',
      cutout: 'hd_cutout',
      crop: 'hd_crop',
      restore: 'hd_restore',
    },
  },
  split: {
    label: '\u5bab\u683c\u5207\u5206',
    operation: 'smart_grid_split',
    capability: 'subject_aware_grid_split',
    promptInstruction:
      'Prepare the image for subject-aware grid splitting. Keep the main subject away from cut lines, preserve composition balance, and return a clean grid-ready layout.',
    defaultParams: {
      rows: 3,
      cols: 3,
      mode: 'subject_aware',
      avoidFaces: true,
      exportZip: true,
    },
    preferredProviders: ['openai', 'fal', 'siliconflow', 'bailian'],
    preferredModels: ['lib-image', 'flux-pro', 'wanx-v1'],
  },
  camera: {
    label: '\u6444\u50cf\u673a',
    operation: 'cinematic_camera_simulation',
    capability: 'cinematic_lens_camera_postprocess',
    promptInstruction:
      'Apply cinematic camera and lens simulation. Preserve the source content while adding realistic optical depth of field, lens character, subtle vignetting, film grain, and professional color science.',
    defaultParams: {
      cameraBody: 'ARRI Alexa 35',
      lens: 'Cooke S4/i 50mm',
      focalLength: 50,
      aperture: 2.8,
      shutter: '1/48',
      iso: 800,
      focusDistance: 2.5,
      lut: 'ARRI LogC',
    },
    preferredProviders: ['openai', 'fal', 'volcengine', 'siliconflow'],
    preferredModels: ['flux-pro', 'gpt-image-2', 'doubao-seedream-5-0-pro', 'doubao-seedream-5-0-lite', 'lib-image'],
  },
};

export function getImageToolPreset(tool: unknown): ImageToolPreset | undefined {
  if (typeof tool !== 'string') return undefined;
  return IMAGE_TOOL_PRESETS[tool as ImageGenerationTool];
}

export function buildImageToolPrompt(prompt: string, tool: unknown) {
  const preset = getImageToolPreset(tool);
  if (!preset) return prompt;
  return `${prompt.trim()}\n\nImage tool: ${preset.label} (${preset.operation}).\nTool instruction: ${preset.promptInstruction}`;
}
