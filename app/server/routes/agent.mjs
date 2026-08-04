/**
 * 智能体 / 扩展 AI / 记忆 / 扩展清单路由组
 *
 * 由 hmdao-api.mjs 的 route() if 链逐字外移而来（分支体一字未改），
 * 通过 deps 注入访问主文件的模块级函数与常量，保证行为与迁移前完全一致。
 */

export function registerAgentRoutes(router, deps) {
  const {
    ASSET_LIBRARY_TEMP_DIR,
    collectFreeLlmCandidates,
    crypto,
    deleteMemory,
    extensionFromMimeType,
    formatSseEvent,
    fs,
    getMemory,
    nextFreeLlm,
    path,
    processAssetLibraryImportRequest,
    readJson,
    runAgentReasoning,
    sanitizeAssetFileBaseName,
    send,
    setAllMemory,
    setMemory,
    sendJson,
  } = deps;

  router.register('POST', '/api/extension-ai', async (req, res, url) => {
    const body = await readJson(req).catch(() => ({}));
    const userText = typeof body.text === 'string' ? body.text.trim() : '';
    const mode = typeof body.mode === 'string' ? body.mode : 'chat';
    if (!userText) {
      return send(res, 400, { ok: false, error: '缺少 text 参数' });
    }
    const systemPrompts = {
      summarize: '你是一个网页文案总结助手。请用简洁的中文总结下面的网页文案，列出 3-5 个要点，保留关键信息，不要编造。',
      translate: '你是一个翻译助手。请将下面的文案翻译成通顺、地道的英文，只输出译文，不要附加解释。',
      'reverse-prompt': '你是一个 AI 绘画提示词工程师。请根据下面关于图片/画面的描述（文案或自然语言），反推一段可用于文生图的英文提示词（prompt），包含主体、风格、构图、光线、画质等要素，用逗号分隔。只输出提示词本身。',
      chat: '你是 Ddayup 智能机器人，一个帮助用户创作与素材处理的 AI 助手。请用中文回答。',
    };
    const systemPrompt = systemPrompts[mode] || systemPrompts.chat;
    // P2.a：多轮对话上下文——扩展端传入 history（[{role,content}]），清洗后拼进 messages，
    // 让机器人具备"记住上文再思考"的对话能力（仅 chat 模式有意义，其余模式为单发任务）。
    const history = Array.isArray(body.history)
      ? body.history
        .filter((item) => item && typeof item === 'object'
          && (item.role === 'user' || item.role === 'assistant')
          && typeof item.content === 'string' && item.content.trim())
        .slice(-12)
        .map((item) => ({ role: item.role, content: String(item.content).slice(0, 4000) }))
      : [];
    const fbKey = process.env.HMDAO_AI_KEY || 'sk-dAViKE9mAm0RqXdfc8nFYn4xAYyOlMjp0l0LcfnmgYdfUcni';
    const fbUrl = process.env.HMDAO_AI_URL || 'https://tokenhub.tencentmaas.com/v1/chat/completions';
    const fbModel = process.env.HMDAO_AI_MODEL || 'hy3';
    // 轮换：优先用 nextFreeLlm 选中的那个免费模型，失败再依次回退其余候选
    const chatPool = collectFreeLlmCandidates('chat');
    const chatStart = nextFreeLlm('chat');
    const chatList = chatStart
      ? [chatStart, ...chatPool.filter((c) => `${c.provider}/${c.model}` !== `${chatStart.provider}/${chatStart.model}`)]
      : [{ provider: 'tokenhub', model: fbModel, endpoint: fbUrl, apiKey: fbKey }];
    let usedModel = fbModel;
    try {
      let data = null;
      let lastErr = null;
      for (const cand of chatList) {
        const apiKey = String(cand.apiKey || fbKey).trim();
        const apiUrl = String(cand.endpoint || fbUrl).trim();
        const model = String(cand.model || fbModel).trim();
        usedModel = model;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        try {
          const r = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                ...(mode === 'chat' ? history : []),
                { role: 'user', content: userText },
              ],
              temperature: 0.6,
              max_tokens: 1500,
            }),
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!r.ok) {
            const errText = await r.text().catch(() => '');
            throw new Error(`AI 服务错误 ${r.status}: ${errText.slice(0, 200)}`);
          }
          data = await r.json().catch(() => ({}));
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!data) throw lastErr || new Error('所有免费聊天模型均不可用');
      const message = data && data.choices && data.choices[0] && data.choices[0].message;
      const reply = message && message.content;
      // P2.a：思考过程透出——hy3/deepseek 系模型返回 reasoning_content 时随响应带回，
      // 扩展端以"💭 思考"形式展示，实现「对话思考」可见化。
      const thinking = message && typeof message.reasoning_content === 'string'
        ? message.reasoning_content.trim().slice(0, 2000)
        : '';
      if (!reply) return send(res, 200, { ok: false, error: 'AI 返回空内容' });
      return send(res, 200, { ok: true, text: reply, thinking, model: usedModel });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return send(res, 200, { ok: false, error: '调用 AI 失败：' + msg });
    }
  });

  router.register('POST', '/api/agent/chat', async (req, res, url) => {
    let agentBody = {};
    try { agentBody = await readJson(req); } catch { agentBody = {}; }
    const userText = typeof agentBody.text === 'string' ? agentBody.text.trim() : '';
    if (!userText) return send(res, 400, { ok: false, error: '缺少 text 参数' });

    const history = Array.isArray(agentBody.history)
      ? agentBody.history
        .filter((it) => it && typeof it === 'object' && (it.role === 'user' || it.role === 'assistant') && typeof it.content === 'string' && it.content.trim())
        .slice(-12)
        .map((it) => ({ role: it.role, content: String(it.content).slice(0, 4000) }))
      : [];
    const canvasSummary = typeof agentBody.canvasSummary === 'string' ? agentBody.canvasSummary.slice(0, 800) : '';
    const scope = typeof agentBody.scope === 'string' && agentBody.scope.trim() ? agentBody.scope.trim() : 'global';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });

    const sse = (name, data) => {
      try { res.write(formatSseEvent(name, data)); } catch { /* ignore broken pipe */ }
    };
    const flushChunks = (full, name) => {
      const chunks = String(full || '').match(/[\s\S]{1,40}/g) || [];
      for (const c of chunks) sse(name, { delta: c });
    };

    try {
      const result = await runAgentReasoning({ text: userText, history, canvasSummary, scope });
      flushChunks(result.thinking, 'thinking');
      flushChunks(result.text, 'message');
      sse('plan', result.plan);
      sse('done', { ok: true, usedModel: result.usedModel });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sse('error', { message: msg });
    } finally {
      try { res.end(); } catch { /* ignore */ }
    }
    return;
  });

  router.register('GET', '/api/agent/memory', async (req, res, url) => {
    const scope = url.searchParams.get('scope') || 'global';
    return sendJson(res, 200, { ok: true, scope, memory: getMemory(scope) });
  });

  router.register('POST', '/api/agent/memory', async (req, res, url) => {
    const body = await readJson(req).catch(() => ({}));
    const scope = body.scope || 'global';
    if (body.type && body.content !== undefined) {
      const r = setMemory({ type: body.type, content: String(body.content), scope });
      return sendJson(res, 200, { ok: true, ...r });
    }
    if (body.memory && typeof body.memory === 'object') {
      const r = setAllMemory({ ...body.memory, scope });
      return sendJson(res, 200, { ok: true, scope, memory: r });
    }
    return sendJson(res, 400, { ok: false, error: '需要 type+content 或 memory 对象' });
  });

  router.register('DELETE', '/api/agent/memory', async (req, res, url) => {
    const body = await readJson(req).catch(() => ({}));
    const scope = body.scope || 'global';
    if (!body.type) return sendJson(res, 400, { ok: false, error: '需要 type' });
    const r = deleteMemory({ type: body.type, scope });
    return sendJson(res, 200, { ok: true, ...r });
  });

  router.register('POST', '/api/extension-agent-upload', async (req, res, url) => {
    try {
      const body = await readJson(req).catch(() => ({}));
      const fileName = String(body.fileName || body.name || 'upload.bin').trim();
      const mime = String(body.mime || body.inputMimeType || '').trim();
      const rawData = String(body.data || body.base64 || '').trim();
      const userText = String(body.userText || '').trim();
      if (!rawData) {
        return send(res, 400, { ok: false, error: '缺少文件数据' });
      }
      // 支持纯 base64 或 data URL（data:image/png;base64,xxxx）
      const commaIdx = rawData.indexOf(',');
      const b64 = commaIdx >= 0 && /^data:/i.test(rawData) ? rawData.slice(commaIdx + 1) : rawData;
      let buffer;
      try {
        buffer = Buffer.from(b64, 'base64');
      } catch (e) {
        return send(res, 400, { ok: false, error: '文件数据不是合法的 base64' });
      }
      if (!buffer.length) {
        return send(res, 400, { ok: false, error: '文件内容为空' });
      }
      const ext = path.extname(fileName).replace(/^\.+/, '')
        || extensionFromMimeType(mime || 'application/octet-stream');
      const tmpName = `${crypto.randomUUID()}-${sanitizeAssetFileBaseName(fileName)}.${String(ext || 'bin').replace(/^\.+/, '')}`;
      await fs.mkdir(ASSET_LIBRARY_TEMP_DIR, { recursive: true });
      const tmpPath = path.join(ASSET_LIBRARY_TEMP_DIR, tmpName);
      await fs.writeFile(tmpPath, buffer);
      const explicitType = mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : '';
      const result = await processAssetLibraryImportRequest({
        inputPath: tmpPath,
        name: fileName,
        type: explicitType,
        inputMimeType: mime,
      });
      const item = result.item || {};
      const asset = {
        id: item.id || '',
        url: item.url || `/api/assets/content/${encodeURIComponent(String(item.id || ''))}`,
        name: item.name || fileName,
        type: item.type || explicitType || 'image',
      };
      return send(res, 200, { ok: true, asset, userText });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return send(res, 200, { ok: false, error: '上传失败：' + msg });
    }
  });

  router.registerPrefix('GET', '/api/extensions/', async (req, res, url) => {
    const extensionId = decodeURIComponent(url.pathname.slice('/api/extensions/'.length));
    const extensions = {
      'free-search-pack': {
        id: 'free-search-pack',
        name: '免费搜图扩展包',
        version: '1.0.0',
        description: '整合 Unsplash、Pexels、Pixabay、Openverse 等免费图库 API',
        features: ['关键词搜图', '以图搜图', '多平台聚合', '批量采集', '拖拽导入'],
        platforms: ['unsplash', 'pexels', 'pixabay', 'openverse'],
        status: 'active',
      },
      'asset-search-engine': {
        id: 'asset-search-engine',
        name: '智能搜索引擎',
        version: '1.0.0',
        description: '增强本地搜索：模糊匹配 + 拼音搜索 + 布尔语法',
        features: ['模糊匹配', '拼音搜索', '布尔搜索', '搜索历史', '实时建议', 'AI分析结果搜索'],
        status: 'active',
      },
      'ai-analysis-pack': {
        id: 'ai-analysis-pack',
        name: 'AI 深度分析扩展包',
        version: '1.0.0',
        description: '视觉大模型图片分析、提示词提取、相似图生成',
        features: ['光影分析', '风格识别', '构图解析', '运镜检测', '提示词提取', '相似图生成'],
        recommendedModels: ['qwen3.7-plus', 'gpt-4o', 'Qwen/Qwen2.5-VL-72B-Instruct'],
        status: 'active',
      },
    };

    const ext = extensions[extensionId];
    if (!ext) {
      return send(res, 404, { success: false, error: { message: `extension ${extensionId} not found` } });
    }
    return send(res, 200, { success: true, extension: ext });
  });
}

export default registerAgentRoutes;
