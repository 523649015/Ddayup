import fs from 'node:fs/promises';
import path from 'node:path';

const APP_DIR = path.resolve(process.cwd());
const API_URL = process.env.HMDAO_API_TARGET || 'http://127.0.0.1:8792';
const SOURCE_SUMMARY = path.resolve(
  APP_DIR,
  'server',
  'artifacts',
  'browser-headless-2026-06-26T02-27-21-599Z',
  'summary.json',
);

function isSvgPlaceholderUrl(url) {
  return String(url || '').startsWith('data:image/svg+xml');
}

function assert(condition, message, detail) {
  if (!condition) {
    const error = new Error(message);
    error.detail = detail;
    throw error;
  }
}

function nowRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function pickImageAssetUrl(result) {
  return String(
    result?.asset?.url
    || result?.assets?.[0]?.url
    || '',
  ).trim();
}

function bufferFromDataUrl(url) {
  const match = String(url || '').match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
  if (!match) return null;
  const isBase64 = String(url || '').includes(';base64,');
  const payload = match[2] || '';
  return isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
}

async function writeAssetSnapshot(targetDir, fileName, assetUrl) {
  const outputPath = path.join(targetDir, fileName);
  const rawUrl = String(assetUrl || '').trim();
  if (!rawUrl) return null;

  const inlineBuffer = bufferFromDataUrl(rawUrl);
  if (inlineBuffer) {
    await fs.writeFile(outputPath, inlineBuffer);
    return outputPath;
  }

  const response = await fetch(rawUrl, { redirect: 'follow' });
  assert(response.ok, `Failed to download asset snapshot: HTTP ${response.status}`, { assetUrl: rawUrl });
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, buffer);
  return outputPath;
}

async function readReferenceSummary() {
  const raw = await fs.readFile(SOURCE_SUMMARY, 'utf8');
  const parsed = JSON.parse(raw);
  const state = parsed?.referenceConsistencyState || {};
  assert(state?.imageWorkflowBody, 'Missing imageWorkflowBody in reference consistency summary.', parsed);
  assert(state?.videoWorkflowBody, 'Missing videoWorkflowBody in reference consistency summary.', parsed);
  assert(state?.videoConditioningWorkflowBody, 'Missing videoConditioningWorkflowBody in reference consistency summary.', parsed);
  const candidateUrls = [
    state?.imageWorkflowBody?.source_url,
    state?.imageWorkflowBody?.reference_image_url,
    state?.videoWorkflowBody?.source_url,
    state?.videoWorkflowBody?.reference_image_url,
    state?.videoConditioningWorkflowBody?.source_url,
    state?.videoConditioningWorkflowBody?.reference_image_url,
    ...(Array.isArray(state?.imageWorkflowBody?.primary_assets) ? state.imageWorkflowBody.primary_assets.map((item) => item?.url) : []),
    ...(Array.isArray(state?.imageWorkflowBody?.reference_assets) ? state.imageWorkflowBody.reference_assets.map((item) => item?.url) : []),
    ...(Array.isArray(state?.videoWorkflowBody?.primary_assets) ? state.videoWorkflowBody.primary_assets.map((item) => item?.url) : []),
    ...(Array.isArray(state?.videoWorkflowBody?.reference_assets) ? state.videoWorkflowBody.reference_assets.map((item) => item?.url) : []),
    ...(Array.isArray(state?.videoConditioningWorkflowBody?.primary_assets) ? state.videoConditioningWorkflowBody.primary_assets.map((item) => item?.url) : []),
    ...(Array.isArray(state?.videoConditioningWorkflowBody?.reference_assets) ? state.videoConditioningWorkflowBody.reference_assets.map((item) => item?.url) : []),
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const placeholderUrls = candidateUrls.filter((item) => isSvgPlaceholderUrl(item));
  assert(
    placeholderUrls.length === 0,
    'Reference summary still contains SVG placeholder assets. Refusing to run real verification against fake inputs.',
    { sourceSummary: SOURCE_SUMMARY, placeholderUrls },
  );
  return state;
}

async function readActivatedRuntime() {
  const response = await fetch(`${API_URL}/api/byok/runtime`, { cache: 'no-store' });
  assert(response.ok, `Failed to read BYOK runtime: HTTP ${response.status}`);
  const payload = await response.json();
  const providers = Array.isArray(payload?.activatedProviders) ? payload.activatedProviders : [];
  const image = providers.find((item) => item?.provider === 'siliconflow' && item?.mode === 'image') || null;
  const video = providers.find((item) => item?.provider === 'siliconflow' && item?.mode === 'video') || null;
  assert(image?.apiKey, 'SiliconFlow image activation record is missing a usable API key.', payload);
  assert(video?.apiKey, 'SiliconFlow video activation record is missing a usable API key.', payload);
  return { payload, image, video };
}

async function callProxy(provider, endpoint, body, timeout = 420000) {
  const response = await fetch(`${API_URL}/api/proxy/${encodeURIComponent(provider)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      endpoint,
      method: 'POST',
      timeout,
      body,
    }),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

async function callProxySafe(provider, endpoint, body, timeout = 420000) {
  try {
    const result = await callProxy(provider, endpoint, body, timeout);
    return { ok: Boolean(result?.payload?.success), ...result };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: {
        success: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}

function buildRealImageBody(referenceState) {
  const body = deepClone(referenceState.imageWorkflowBody);
  body.model = 'Qwen/Qwen-Image';
  body.prompt = [
    '保持主素材的机位、构图、空间布局、镜头视角与画幅比例不变。',
    '只替换原主产品为参考主体，主体材质、轮廓、品牌识别与外观以 subject 参考为准。',
    '输出一张 16:9、720p 的真实商业产品图，不要偏移主体，不要新增无关元素。',
    '优先保证构图锁定和主体替换准确，不要黑边，不要错误文字。',
  ].join(' ');
  body.quality = '720p';
  body.resolution = '1280x720';
  body.width = 1280;
  body.height = 720;
  body.steps = 28;
  body.count = 1;
  return body;
}

function buildRealVideoBody(referenceState) {
  const base = deepClone(referenceState.videoConditioningWorkflowBody);
  const richVideoBody = deepClone(referenceState.videoWorkflowBody);
  const imageReferences = Array.isArray(richVideoBody.reference_assets)
    ? richVideoBody.reference_assets.filter((item) => item?.type === 'image')
    : [];
  const subjectReference = imageReferences.find((item) => item?.role === 'subject') || null;
  const omniReference = imageReferences.find((item) => item?.role === 'omni') || null;

  return {
    ...base,
    model: 'Wan-AI/Wan2.2-I2V-A14B',
    prompt: [
      '保持主图的机位、构图、取景范围和主体占比不变。',
      '生成 5 秒 480p 预览视频，主体替换为参考主体，整体氛围尽量向 omni 参考靠拢。',
      '优先稳定镜头与主体，不要明显漂移，不要无关元素。',
    ].join(' '),
    aspect_ratio: '16:9',
    quality: '480p',
    resolution: '854x480',
    width: 854,
    height: 480,
    fps: 24,
    duration: 5,
    steps: 24,
    generation_mode: 'imageToVideo',
    source_media_type: 'image',
    reference_image_url: omniReference?.url || subjectReference?.url || '',
    reference_assets: [
      ...(Array.isArray(base.reference_assets) ? base.reference_assets : []),
      ...imageReferences.filter((item) => item?.role === 'subject' || item?.role === 'omni'),
    ],
    conditioning_strategy: {
      operation: 'preserveCompositionReplaceSubject',
      wrapperLimitation: 'siliconflow-wan-single-conditioning-image',
    },
  };
}

function assessVideoWrapperLimitation(videoBody) {
  const hasPrimaryComposition = Array.isArray(videoBody?.primary_assets) && videoBody.primary_assets.some((item) => item?.role === 'composition');
  const hasSubjectReference = Array.isArray(videoBody?.reference_assets) && videoBody.reference_assets.some((item) => item?.role === 'subject');
  const hasOmniReference = Array.isArray(videoBody?.reference_assets) && videoBody.reference_assets.some((item) => item?.role === 'omni');
  return {
    requestedMultiModalControl: hasPrimaryComposition && hasSubjectReference && hasOmniReference,
    actualSiliconflowWanWrapperSupportsOnlySingleConditioningImage: true,
    limitationDetected: hasPrimaryComposition && (hasSubjectReference || hasOmniReference),
    detail: '当前 SiliconFlow Wan 视频包装会把上游请求折叠为单张 image conditioning，不能把 composition + subject + omni 同时送入上游。',
  };
}

async function main() {
  const runDir = path.resolve(APP_DIR, 'server', 'artifacts', `real-reference-${nowRunId()}`);
  await fs.mkdir(runDir, { recursive: true });

  const referenceState = await readReferenceSummary();
  const runtime = await readActivatedRuntime();

  const imageBody = buildRealImageBody(referenceState);
  const videoBody = buildRealVideoBody(referenceState);
  const videoWrapperAssessment = assessVideoWrapperLimitation(videoBody);
  const simpleVideoBody = {
    model: 'Wan-AI/Wan2.2-T2V-A14B',
    prompt: 'A premium product teaser shot, cinematic camera, controlled lighting, realistic materials, 5 second preview video.',
    aspect_ratio: '16:9',
    quality: '480p',
    resolution: '854x480',
    width: 854,
    height: 480,
    steps: 20,
    fps: 24,
    duration: 5,
    generation_mode: 'textToVideo',
  };

  const imageResponse = await callProxy('siliconflow', '/images/generations', imageBody, 240000);
  assert(imageResponse.payload?.success, 'Real image generation failed.', imageResponse);
  assert(!imageResponse.payload?.asset?.metadata?.fallback, 'Real image generation fell back to local placeholder.', imageResponse.payload);
  const imageUrl = pickImageAssetUrl(imageResponse.payload);
  assert(imageUrl, 'Real image generation did not return an image URL.', imageResponse.payload);
  const imageSnapshotPath = await writeAssetSnapshot(runDir, 'real-image-720p.png', imageUrl).catch(() => null);

  const targetVideoResponse = await callProxySafe('siliconflow', '/videos/generations', videoBody, 480000);
  const targetVideoUrl = targetVideoResponse.ok ? pickImageAssetUrl(targetVideoResponse.payload) : '';
  const targetVideoSnapshotPath = targetVideoUrl
    ? await writeAssetSnapshot(runDir, 'real-video-480p-target.mp4', targetVideoUrl).catch(() => null)
    : null;

  const simpleVideoResponse = await callProxySafe('siliconflow', '/videos/generations', simpleVideoBody, 480000);
  const simpleVideoUrl = simpleVideoResponse.ok ? pickImageAssetUrl(simpleVideoResponse.payload) : '';
  const simpleVideoSnapshotPath = simpleVideoUrl
    ? await writeAssetSnapshot(runDir, 'real-video-480p-simple.mp4', simpleVideoUrl).catch(() => null)
    : null;

  const summary = {
    mode: 'real-reference-chain',
    apiUrl: API_URL,
    runDir,
    activatedRuntime: {
      imageModel: runtime.image?.model || '',
      imageMaskedKey: runtime.image?.maskedKey || '',
      videoModel: runtime.video?.model || '',
      videoMaskedKey: runtime.video?.maskedKey || '',
    },
    imageVerification: {
      passed: true,
      provider: 'siliconflow',
      endpoint: '/images/generations',
      requestedModel: imageBody.model,
      quality: imageBody.quality,
      width: imageBody.width,
      height: imageBody.height,
      resultUrl: imageUrl,
      snapshotPath: imageSnapshotPath,
      requestBody: imageBody,
      response: imageResponse.payload,
    },
    videoVerification: {
      passed: Boolean(targetVideoResponse.ok),
      provider: 'siliconflow',
      endpoint: '/videos/generations',
      requestedModel: videoBody.model,
      quality: videoBody.quality,
      width: videoBody.width,
      height: videoBody.height,
      resultUrl: targetVideoUrl,
      snapshotPath: targetVideoSnapshotPath,
      requestBody: videoBody,
      response: targetVideoResponse.payload,
      wrapperAssessment: videoWrapperAssessment,
    },
    videoControlVerification: {
      passed: Boolean(simpleVideoResponse.ok),
      provider: 'siliconflow',
      endpoint: '/videos/generations',
      requestedModel: simpleVideoBody.model,
      quality: simpleVideoBody.quality,
      width: simpleVideoBody.width,
      height: simpleVideoBody.height,
      resultUrl: simpleVideoUrl,
      snapshotPath: simpleVideoSnapshotPath,
      requestBody: simpleVideoBody,
      response: simpleVideoResponse.payload,
    },
  };

  await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(async (error) => {
  const detail = error?.detail ? { detail: error.detail } : {};
  console.error(JSON.stringify({
    success: false,
    message: error instanceof Error ? error.message : String(error),
    ...detail,
  }, null, 2));
  process.exitCode = 1;
});
