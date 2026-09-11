/**
 * 本地 AI 推理（图像/视频/音频/后期）与通用代理路由组
 *
 * 由 hmdao-api.mjs 的 route() if 链逐字外移而来（分支体一字未改），
 * 通过 deps 注入访问主文件的模块级函数与常量，保证行为与迁移前完全一致。
 */

export function registerLocalAiRoutes(router, deps) {
  const {
    LOCAL_AUDIO_RESULT_DIR,
    LOCAL_POST_RESULT_DIR,
    LOCAL_VIDEO_RESULT_DIR,
    buildSafeInlineContentDisposition,
    executeGenerationRequest,
    getDccLocalArtifact,
    mediaMimeTypeFromExtension,
    path,
    previewGenerationRequest,
    processLocalAudioGenerateRequest,
    processLocalImageAnalyzeRequest,
    processLocalPostRequest,
    processLocalVideoEditRequest,
    processRemoteAudioGenerateRequest,
    readJson,
    readLocalImageAnalyzeMultipart,
    readLocalPostMultipart,
    sanitizeLocalAssetId,
    send,
    sendLocalFileStream,
    getUserFromRequest,
  } = deps;

  router.registerPrefix(['GET', 'HEAD'], '/api/dcc/local-artifacts/', async (req, res, url) => {
    const token = sanitizeLocalAssetId(url.pathname.slice('/api/dcc/local-artifacts/'.length));
    if (!token) {
      return send(res, 400, { success: false, error: { message: 'invalid-dcc-artifact-token' } });
    }
    const item = getDccLocalArtifact(token);
    if (!item?.filePath) {
      return send(res, 404, { success: false, error: { message: 'dcc-artifact-not-found' } });
    }
    await sendLocalFileStream(req, res, item.filePath, {
      mimeType: String(item.mimeType || mediaMimeTypeFromExtension(item.filePath, 'application/octet-stream')),
      contentDisposition: buildSafeInlineContentDisposition(item.filePath),
      headers: { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', Expires: '0' },
    });
    return;
  });

  router.register('POST', '/api/local-image/analyze', async (req, res, url) => {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const body = contentType.includes('multipart/form-data')
      ? await readLocalImageAnalyzeMultipart(req)
      : await readJson(req);
    const userId = getUserFromRequest(req);
    const analysis = await processLocalImageAnalyzeRequest(body, userId);
    return send(res, 200, { success: true, analysis });
  });

  router.register('POST', '/api/local-video/edit', async (req, res, url) => {
    const body = await readJson(req);
    const result = await processLocalVideoEditRequest(body);
    return send(res, 200, { success: true, ...result });
  });

  router.registerPrefix(['GET', 'HEAD'], '/api/local-video/result/', async (req, res, url) => {
    const assetId = sanitizeLocalAssetId(url.pathname.slice('/api/local-video/result/'.length));
    if (!assetId) {
      return send(res, 400, { success: false, error: { message: 'invalid-local-video-asset-id' } });
    }
    const filePath = path.join(LOCAL_VIDEO_RESULT_DIR, assetId);
    await sendLocalFileStream(req, res, filePath, {
      mimeType: mediaMimeTypeFromExtension(filePath, 'video/webm'),
      contentDisposition: `inline; filename="${assetId}"`,
    });
    return;
  });

  router.register('POST', '/api/local-audio/generate', async (req, res, url) => {
    const body = await readJson(req);
    const result = await processLocalAudioGenerateRequest(body);
    return send(res, 200, { success: true, ...result });
  });

  router.register('POST', '/api/audio/generate', async (req, res, url) => {
    try {
      const body = await readJson(req);
      const result = await processRemoteAudioGenerateRequest(body);
      return send(res, 200, { success: true, ...result });
    } catch (err) {
      return send(res, 502, { success: false, error: err instanceof Error ? err.message : 'remote-audio-generate-failed' });
    }
  });

  router.registerPrefix(['GET', 'HEAD'], '/api/local-audio/result/', async (req, res, url) => {
    const assetId = sanitizeLocalAssetId(url.pathname.slice('/api/local-audio/result/'.length));
    if (!assetId) {
      return send(res, 400, { success: false, error: { message: 'invalid-local-audio-asset-id' } });
    }
    const filePath = path.join(LOCAL_AUDIO_RESULT_DIR, assetId);
    await sendLocalFileStream(req, res, filePath, {
      mimeType: mediaMimeTypeFromExtension(filePath, 'audio/wav'),
      contentDisposition: `inline; filename="${assetId}"`,
    });
    return;
  });

  router.register('POST', '/api/local-post/process', async (req, res, url) => {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const body = contentType.includes('multipart/form-data')
      ? await readLocalPostMultipart(req)
      : await readJson(req);
    const result = await processLocalPostRequest(body);
    return send(res, 200, { success: true, ...result });
  });

  router.registerPrefix(['GET', 'HEAD'], '/api/local-post/result/', async (req, res, url) => {
    const assetId = sanitizeLocalAssetId(url.pathname.slice('/api/local-post/result/'.length));
    if (!assetId) {
      return send(res, 400, { success: false, error: { message: 'invalid-local-post-asset-id' } });
    }
    const filePath = path.join(LOCAL_POST_RESULT_DIR, assetId);
    await sendLocalFileStream(req, res, filePath, {
      mimeType: mediaMimeTypeFromExtension(filePath, 'application/octet-stream'),
      contentDisposition: `inline; filename="${assetId}"`,
    });
    return;
  });

  router.registerPrefix('POST', '/api/proxy-preview/', async (req, res, url) => {
    const provider = decodeURIComponent(url.pathname.split('/').pop() || '');
    const body = await readJson(req);
    const result = await previewGenerationRequest({
      provider,
      endpoint: body.endpoint,
      method: body.method || 'POST',
      body: body.body || {},
      timeout: body.timeout,
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
    });
    return send(res, 200, result);
  });

  router.registerPrefix('POST', '/api/proxy/', async (req, res, url) => {
    const provider = decodeURIComponent(url.pathname.split('/').pop() || '');
    const body = await readJson(req);
    const result = await executeGenerationRequest({
      provider,
      endpoint: body.endpoint,
      method: body.method || 'POST',
      body: body.body || {},
      timeout: body.timeout,
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
    });
    return send(res, 200, result);
  });
}

export default registerLocalAiRoutes;
