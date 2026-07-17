import { z } from 'zod';
import { IMAGE_TOOL_PRESETS, type ImageGenerationTool } from '@/config/imageToolPresets';

export type ToolFieldType = 'slider' | 'number' | 'select' | 'switch' | 'text';

export interface ToolFieldOption {
  label: string;
  value: string;
}

export interface ToolFieldSchema {
  key: string;
  label: string;
  type: ToolFieldType;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: ToolFieldOption[];
}

export interface ImageToolSchemaDefinition {
  tool: ImageGenerationTool;
  title: string;
  description: string;
  fields: ToolFieldSchema[];
  schema: z.ZodObject<Record<string, z.ZodTypeAny>>;
}

const panoramaSchema = z.object({
  fov: z.number().min(30).max(180),
  spatialFusion: z.number().min(0).max(1),
  panoramaResolution: z.enum(['4K', '6K', '8K']),
  localInpaint: z.boolean(),
  panoramaYaw: z.number().min(0).max(360),
  panoramaPitch: z.number().min(-75).max(75),
  panoramaZoom: z.number().min(0.7).max(1.6),
  panoramaAnchorX: z.number().min(0).max(1),
  panoramaAnchorY: z.number().min(0).max(1),
  panoramaLocalEditEnabled: z.boolean(),
  brushMode: z.enum(['paint', 'erase']).optional(),
  brushSize: z.number().min(1).max(120).optional(),
  maskStrength: z.number().min(0).max(1).optional(),
  maskPoints: z.array(z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    brushMode: z.enum(['paint', 'erase']).optional(),
    brushSize: z.number().min(1).max(120).optional(),
  })).optional(),
});

const multiAngleSchema = z.object({
  yaw: z.number().min(0).max(360),
  pitch: z.number().min(-90).max(90),
  shotScale: z.enum(['close', 'medium', 'wide']),
  consistency: z.number().min(0).max(1),
  framingZoom: z.number().min(0.78).max(1.5),
  cameraPreset: z.enum(['front', 'fish', 'tilt', 'top', 'low', 'orbit', 'detail']),
  keyframes: z.array(z.object({
    name: z.string().min(1),
    yaw: z.number().min(0).max(360),
    pitch: z.number().min(-90).max(90),
    shotScale: z.enum(['close', 'medium', 'wide']),
    framingZoom: z.number().min(0.78).max(1.5),
    consistency: z.number().min(0).max(1),
  })).optional(),
});

const lightingSchema = z.object({
  preset: z.enum(['rembrandt', 'butterfly', 'side_rim', 'studio_soft', 'golden_hour', 'noir', 'commercial', 'product']),
  activeLight: z.enum(['key', 'fill', 'rim', 'env']),
  keyLightAzimuth: z.number().min(-180).max(180),
  keyLightElevation: z.number().min(-90).max(90),
  keyLightIntensity: z.number().min(0).max(2),
  keyLightTemperature: z.number().min(2500).max(9000),
  fillLightIntensity: z.number().min(0).max(2),
  fillLightAzimuth: z.number().min(-180).max(180),
  fillLightElevation: z.number().min(-90).max(90),
  fillLightTemperature: z.number().min(2500).max(9000),
  rimLightEnabled: z.boolean(),
  rimLightAzimuth: z.number().min(-180).max(180).optional(),
  rimLightElevation: z.number().min(-90).max(90).optional(),
  rimLightIntensity: z.number().min(0).max(2),
  envLightIntensity: z.number().min(0).max(2),
  envLightRotation: z.number().min(0).max(360),
  hdri: z.boolean(),
  hdriUrl: z.string().optional(),
  hdriAssetName: z.string().optional(),
});

const gridSchema = z.object({
  template: z.enum(['nine_shot', 'four_panel_drama', 'three_view_character', 'twentyfive_continuity']),
  cells: z.number().int().min(3).max(25),
  consistency: z.number().min(0).max(1),
  exportLayout: z.enum(['2x2', '3x1', '3x3', '5x5']),
});

const hdSchema = z.object({
  upscale: z.enum(['1.5x', '2x', '4x']),
  restoration: z.boolean(),
  denoise: z.number().min(0).max(1),
  faceRestore: z.boolean(),
  preserveTexture: z.boolean(),
});

const splitSchema = z.object({
  rows: z.number().int().min(1).max(10),
  cols: z.number().int().min(1).max(10),
  mode: z.enum(['subject_aware', 'uniform']),
  avoidFaces: z.boolean(),
  exportZip: z.boolean(),
});

const cameraSchema = z.object({
  cameraBody: z.string().min(1),
  lens: z.string().min(1),
  focalLength: z.number().min(12).max(200),
  aperture: z.number().min(0.7).max(22),
  shutter: z.string().min(1),
  iso: z.number().int().min(50).max(25600),
  focusDistance: z.number().min(0.1).max(100),
  lut: z.enum(['ARRI LogC', 'Sony S-Cinetone', 'RED IPP2', 'Kodak 2383']),
});

export const IMAGE_TOOL_SCHEMAS: Record<ImageGenerationTool, ImageToolSchemaDefinition> = {
  panorama: {
    tool: 'panorama',
    title: `${IMAGE_TOOL_PRESETS.panorama.label}参数`,
    description: '控制全景视场角、空间融合和输出规格。',
    schema: panoramaSchema,
    fields: [
      { key: 'fov', label: '视场角', type: 'slider', min: 30, max: 180, step: 1, description: '控制球面全景覆盖角度。' },
      { key: 'spatialFusion', label: '空间融合', type: 'slider', min: 0, max: 1, step: 0.01, description: '平衡场景延展与原图一致性。' },
      { key: 'panoramaResolution', label: '分辨率', type: 'select', options: [{ label: '4K', value: '4K' }, { label: '6K', value: '6K' }, { label: '8K', value: '8K' }] },
      { key: 'localInpaint', label: '局部重绘', type: 'switch', description: '生成后允许对局部区域做修补。' },
      { key: 'panoramaYaw', label: '水平环视', type: 'slider', min: 0, max: 360, step: 1, description: '沉浸预览中的当前环绕角度。' },
      { key: 'panoramaPitch', label: '垂直俯仰', type: 'slider', min: -75, max: 75, step: 1, description: '沉浸预览中的当前俯仰角度。' },
      { key: 'panoramaZoom', label: '沉浸缩放', type: 'slider', min: 0.7, max: 1.6, step: 0.01, description: '控制全景预览中的局部放大。' },
      { key: 'brushMode', label: '画笔模式', type: 'select', options: [{ label: '涂抹', value: 'paint' }, { label: '擦除', value: 'erase' }] },
      { key: 'brushSize', label: '画笔大小', type: 'number', min: 1, max: 120, step: 1 },
      { key: 'maskStrength', label: '蒙版强度', type: 'slider', min: 0, max: 1, step: 0.01 },
    ],
  },
  multiAngle: {
    tool: 'multiAngle',
    title: `${IMAGE_TOOL_PRESETS.multiAngle.label}参数`,
    description: '控制机位环绕、俯仰和一致性。',
    schema: multiAngleSchema,
    fields: [
      { key: 'yaw', label: '水平环绕', type: 'slider', min: 0, max: 360, step: 1 },
      { key: 'pitch', label: '垂直俯仰', type: 'slider', min: -90, max: 90, step: 1 },
      { key: 'shotScale', label: '景别', type: 'select', options: [{ label: '特写', value: 'close' }, { label: '中景', value: 'medium' }, { label: '远景', value: 'wide' }] },
      { key: 'consistency', label: '一致性', type: 'slider', min: 0, max: 1, step: 0.01 },
      { key: 'framingZoom', label: '景别缩放', type: 'slider', min: 0.78, max: 1.5, step: 0.01, description: '与 3D 机位拖拽联动的镜头远近。' },
    ],
  },
  lighting: {
    tool: 'lighting',
    title: `${IMAGE_TOOL_PRESETS.lighting.label}参数`,
    description: '控制主光、辅光和环境光。',
    schema: lightingSchema,
    fields: [
      { key: 'preset', label: '布光预设', type: 'select', options: [
        { label: '伦勃朗光', value: 'rembrandt' },
        { label: '蝴蝶光', value: 'butterfly' },
        { label: '侧逆光', value: 'side_rim' },
        { label: '柔光棚拍', value: 'studio_soft' },
        { label: '金色时刻', value: 'golden_hour' },
        { label: '黑色电影', value: 'noir' },
        { label: '商业硬光', value: 'commercial' },
        { label: '产品展示', value: 'product' },
      ] },
      { key: 'keyLightAzimuth', label: '主光方位', type: 'slider', min: -180, max: 180, step: 1 },
      { key: 'keyLightElevation', label: '主光俯仰', type: 'slider', min: -90, max: 90, step: 1 },
      { key: 'keyLightIntensity', label: '主光强度', type: 'slider', min: 0, max: 2, step: 0.01 },
      { key: 'keyLightTemperature', label: '主光色温', type: 'number', min: 2500, max: 9000, step: 100 },
      { key: 'fillLightIntensity', label: '辅光强度', type: 'slider', min: 0, max: 2, step: 0.01 },
      { key: 'fillLightAzimuth', label: '辅光方位', type: 'slider', min: -180, max: 180, step: 1 },
      { key: 'fillLightElevation', label: '辅光俯仰', type: 'slider', min: -90, max: 90, step: 1 },
      { key: 'fillLightTemperature', label: '辅光色温', type: 'number', min: 2500, max: 9000, step: 100 },
      { key: 'rimLightEnabled', label: '轮廓光', type: 'switch' },
      { key: 'rimLightIntensity', label: '轮廓光强度', type: 'slider', min: 0, max: 2, step: 0.01 },
      { key: 'envLightIntensity', label: '环境光强度', type: 'slider', min: 0, max: 2, step: 0.01 },
      { key: 'envLightRotation', label: '环境光旋转', type: 'slider', min: 0, max: 360, step: 1 },
      { key: 'hdri', label: 'HDRI 环境光', type: 'switch' },
      { key: 'hdriUrl', label: 'HDRI 资源 URL', type: 'text', description: '可粘贴已上传 HDRI 资源地址。' },
    ],
  },
  grid: {
    tool: 'grid',
    title: `${IMAGE_TOOL_PRESETS.grid.label}参数`,
    description: '控制分镜模板、宫格数量和一致性。',
    schema: gridSchema,
    fields: [
      { key: 'template', label: '模板', type: 'select', options: [{ label: '九宫格', value: 'nine_shot' }, { label: '剧情四宫格', value: 'four_panel_drama' }, { label: '角色三视图', value: 'three_view_character' }, { label: '25 宫格连续分镜', value: 'twentyfive_continuity' }] },
      { key: 'cells', label: '画幅数量', type: 'number', min: 3, max: 25, step: 1 },
      { key: 'consistency', label: '一致性', type: 'slider', min: 0, max: 1, step: 0.01 },
      { key: 'exportLayout', label: '布局', type: 'select', options: [{ label: '2 x 2', value: '2x2' }, { label: '3 x 1', value: '3x1' }, { label: '3 x 3', value: '3x3' }, { label: '5 x 5', value: '5x5' }] },
    ],
  },
  hd: {
    tool: 'hd',
    title: `${IMAGE_TOOL_PRESETS.hd.label}参数`,
    description: '控制超分、修复和降噪。',
    schema: hdSchema,
    fields: [
      { key: 'upscale', label: '放大倍率', type: 'select', options: [{ label: '1.5x', value: '1.5x' }, { label: '2x', value: '2x' }, { label: '4x', value: '4x' }] },
      { key: 'restoration', label: '综合修复', type: 'switch' },
      { key: 'denoise', label: '降噪强度', type: 'slider', min: 0, max: 1, step: 0.01 },
      { key: 'faceRestore', label: '人脸修复', type: 'switch' },
      { key: 'preserveTexture', label: '保留纹理', type: 'switch' },
    ],
  },
  split: {
    tool: 'split',
    title: `${IMAGE_TOOL_PRESETS.split.label}参数`,
    description: '控制宫格行列与主体避让。',
    schema: splitSchema,
    fields: [
      { key: 'rows', label: '行数', type: 'number', min: 1, max: 10, step: 1 },
      { key: 'cols', label: '列数', type: 'number', min: 1, max: 10, step: 1 },
      { key: 'mode', label: '切分模式', type: 'select', options: [{ label: '智能避让', value: 'subject_aware' }, { label: '均匀切分', value: 'uniform' }] },
      { key: 'avoidFaces', label: '避让人脸', type: 'switch' },
      { key: 'exportZip', label: '导出压缩包', type: 'switch' },
    ],
  },
  camera: {
    tool: 'camera',
    title: `${IMAGE_TOOL_PRESETS.camera.label}参数`,
    description: '控制机身、镜头和光学参数。',
    schema: cameraSchema,
    fields: [
      { key: 'cameraBody', label: '相机机型', type: 'select', options: [{ label: 'ARRI Alexa 35', value: 'ARRI Alexa 35' }, { label: 'Sony Venice 2', value: 'Sony Venice 2' }, { label: 'RED V-Raptor', value: 'RED V-Raptor' }] },
      { key: 'lens', label: '镜头型号', type: 'text' },
      { key: 'focalLength', label: '焦距', type: 'number', min: 12, max: 200, step: 1 },
      { key: 'aperture', label: '光圈', type: 'slider', min: 0.7, max: 22, step: 0.1 },
      { key: 'shutter', label: '快门', type: 'select', options: [{ label: '1/48', value: '1/48' }, { label: '1/96', value: '1/96' }, { label: '1/125', value: '1/125' }] },
      { key: 'iso', label: 'ISO', type: 'number', min: 50, max: 25600, step: 50 },
      { key: 'focusDistance', label: '对焦距离', type: 'number', min: 0.1, max: 100, step: 0.1 },
      { key: 'lut', label: 'LUT', type: 'select', options: [{ label: 'ARRI LogC', value: 'ARRI LogC' }, { label: 'Sony S-Cinetone', value: 'Sony S-Cinetone' }, { label: 'RED IPP2', value: 'RED IPP2' }, { label: 'Kodak 2383', value: 'Kodak 2383' }] },
    ],
  },
};

export function getImageToolSchema(tool: unknown) {
  if (typeof tool !== 'string') return undefined;
  return IMAGE_TOOL_SCHEMAS[tool as ImageGenerationTool];
}
