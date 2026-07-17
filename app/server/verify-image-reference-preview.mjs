const API_URL = String(process.env.HMDAO_API_TARGET || 'http://127.0.0.1:8792').trim().replace(/\/$/, '');

function assert(condition, message, detail) {
  if (!condition) {
    const error = new Error(message);
    error.detail = detail;
    throw error;
  }
}

function buildPreviewBody() {
  const compositionUrl = 'https://example.com/assets/composition-car-scene.png';
  const subjectUrl = 'https://example.com/assets/subject-vintage-car.png';
  const lightingUrl = 'https://example.com/assets/lighting-cinematic-street.png';

  return {
    model: 'qwen-image-2.0',
    prompt: 'Keep the original street scene composition and replace the hero car with the referenced vintage car. Apply only the cinematic night lighting mood from the third image.',
    aspect_ratio: '16:9',
    quality: '720p',
    resolution: '1280x720',
    width: 1280,
    height: 720,
    count: 1,
    source_url: compositionUrl,
    source_media_type: 'image',
    primary_assets: [
      {
        type: 'image',
        role: 'composition',
        ui_role: 'primary',
        weight: 1,
        channel: 'primary',
        url: compositionUrl,
        preserve: ['composition', 'framing', 'camera_angle', 'spatial_layout', 'subject_scale'],
      },
    ],
    reference_image_url: subjectUrl,
    reference_assets: [
      {
        type: 'image',
        role: 'subject',
        ui_role: 'subject',
        weight: 0.96,
        channel: 'reference',
        url: subjectUrl,
        coverage_roles: ['subject'],
      },
      {
        type: 'image',
        role: 'omni',
        ui_role: 'omni',
        weight: 0.72,
        channel: 'reference',
        url: lightingUrl,
        coverage_roles: ['style', 'lighting'],
      },
    ],
    conditioning_strategy: {
      operation: 'preserveCompositionReplaceSubject',
      primary_image_policy: 'preserve_composition_camera_framing_and_spatial_layout_from_primary',
      subject_reference_policy: 'replace_primary_subject_with_reference_subject_when_requested',
      subject_replacement_policy: 'keep_primary_composition_replace_primary_subject_only',
      omni_reference_policy: 'single_reference_refines_style_lighting_material_and_atmosphere_without_overriding_locked_subject_or_composition',
    },
  };
}

async function main() {
  const body = buildPreviewBody();
  const response = await fetch(`${API_URL}/api/proxy-preview/siliconflow`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      endpoint: '/images/generations',
      method: 'POST',
      body,
    }),
  });
  const payload = await response.json();

  assert(response.ok, `Preview request failed with HTTP ${response.status}.`, payload);
  assert(payload?.success === true, 'Preview API did not return success.', payload);
  assert(payload?.apimartAsyncRequest === true, 'Preview did not detect the APIMart async image route.', payload);

  const upstreamBody = payload?.upstreamBody || {};
  const imageRoleEntries = Array.isArray(payload?.imageRoleEntries) ? payload.imageRoleEntries : [];
  const orderedImageUrls = Array.isArray(payload?.orderedImageUrls) ? payload.orderedImageUrls : [];

  assert(Array.isArray(upstreamBody.image_urls), 'Upstream payload is missing image_urls.', upstreamBody);
  assert(upstreamBody.image_urls.length === 3, 'Upstream payload did not keep exactly 3 ordered images.', upstreamBody);
  assert(
    upstreamBody.image_urls[0] === body.primary_assets[0].url,
    'image_urls[0] is not the locked composition image.',
    upstreamBody,
  );
  assert(
    upstreamBody.image_urls[1] === body.reference_assets[0].url,
    'image_urls[1] is not the subject reference image.',
    upstreamBody,
  );
  assert(
    upstreamBody.image_urls[2] === body.reference_assets[1].url,
    'image_urls[2] is not the omni lighting/style reference image.',
    upstreamBody,
  );
  assert(
    JSON.stringify(orderedImageUrls) === JSON.stringify(upstreamBody.image_urls),
    'Ordered image_urls preview does not match the upstream payload.',
    { orderedImageUrls, upstreamBody },
  );

  const omniRoles = imageRoleEntries
    .filter((item) => item?.url === body.reference_assets[1].url)
    .map((item) => item?.role)
    .filter(Boolean);
  assert(
    JSON.stringify(omniRoles) === JSON.stringify(['style', 'lighting']),
    'Omni reference expanded beyond style + lighting in strict subject swap mode.',
    { imageRoleEntries, omniRoles },
  );
  assert(
    !omniRoles.includes('subject') && !omniRoles.includes('composition'),
    'Omni reference still leaks into subject/composition roles.',
    { imageRoleEntries, omniRoles },
  );

  const prompt = String(upstreamBody.prompt || '');
  assert(prompt.includes('locked composition anchor'), 'Upstream prompt is missing the composition lock contract.', upstreamBody);
  assert(prompt.includes('only authority for the replacement hero product or object'), 'Upstream prompt is missing the subject authority contract.', upstreamBody);
  assert(prompt.includes('Do not introduce people or human faces'), 'Upstream prompt is missing the anti-portrait guard.', upstreamBody);
  assert(prompt.includes('refine only style palette, lighting mood'), 'Upstream prompt is missing the omni style/lighting contract.', upstreamBody);

  assert(
    String(upstreamBody.negative_prompt || '').includes('people'),
    'Strict subject swap negative prompt did not include person suppression.',
    upstreamBody,
  );
  assert(!('primary_assets' in upstreamBody), 'Upstream payload still leaks internal primary_assets.', upstreamBody);
  assert(!('reference_assets' in upstreamBody), 'Upstream payload still leaks internal reference_assets.', upstreamBody);
  assert(!('conditioning_strategy' in upstreamBody), 'Upstream payload still leaks conditioning_strategy.', upstreamBody);

  const summary = {
    passed: true,
    provider: payload.effectiveProvider,
    endpoint: payload.endpoint,
    requestBaseUrl: payload.requestBaseUrl,
    imageRoleEntries,
    orderedImageUrls,
    upstreamBody,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  const detail = error && typeof error === 'object' && 'detail' in error ? error.detail : null;
  console.error(JSON.stringify({
    passed: false,
    message: error instanceof Error ? error.message : String(error),
    detail,
  }, null, 2));
  process.exitCode = 1;
});
