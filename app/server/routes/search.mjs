/**
 * 免费素材搜索 / 网页抓取路由组
 *
 * 由 hmdao-api.mjs 的 route() if 链逐字外移而来（分支体一字未改），
 * 通过 deps 注入访问主文件的模块级函数与常量，保证行为与迁移前完全一致。
 */

export function registerSearchRoutes(router, deps) {
  const {
    OPENVERSE_BASE,
    PEXELS_BASE,
    PIXABAY_BASE,
    UNSPLASH_BASE,
    WIKIMEDIA_BASE,
    hashString,
    http,
    https,
    polyhavenCatalogCache,
    readJson,
    send,
  } = deps;

  router.register('POST', '/api/search/scrape-url', async (req, res, url) => {
    const body = await readJson(req).catch(() => ({}));
    const target = String(body?.url || '').trim();
    const mediaType = ['image', 'video', 'audio', 'model', 'all'].includes(body?.mediaType) ? body.mediaType : 'all';

    const classifyExt = (pathname = '') => {
      const p = decodeURIComponent(String(pathname)).toLowerCase().split('?')[0];
      if (/\.(jpe?g|png|gif|webp|bmp|svg|avif|tiff?)$/.test(p)) return 'image';
      if (/\.(mp4|webm|ogv|mov|m4v|mkv|avi)$/.test(p)) return 'video';
      if (/\.(mp3|wav|oga|ogg|m4a|aac|flac)$/.test(p)) return 'audio';
      if (/\.(glb|gltf|obj|fbx|blend|usdz|stl|3ds|dae)$/.test(p)) return 'model';
      return null;
    };
    const hashString = (s) => { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return h; };
    const decodeName = (u) => { try { return decodeURIComponent(String(u).split('/').pop().split('?')[0]); } catch { return String(u).split('/').pop().split('?')[0]; } };
    const makeScrapeResult = (rawUrl, base, type, host) => {
      const u = String(rawUrl || '');
      const name = decodeName(u) || `${type}_${Date.now()}`;
      return {
        id: `scrape-${Date.now()}-${Math.abs(hashString(u))}`,
        url: u,
        thumb: type === 'image' || type === 'model' ? u : '',
        previewUrl: u,
        title: name,
        source: 'scrape',
        sourceName: host || '网页直采',
        type,
        downloadUrl: u,
        tags: [],
      };
    };
    const pickAttr = (tag, attr) => {
      const re = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
      const mm = re.exec(tag);
      if (!mm) return '';
      return (mm[2] ?? mm[3] ?? mm[4] ?? '').trim();
    };
    const collectSrcset = (tag, push) => {
      const ss = pickAttr(tag, 'srcset');
      if (!ss) return;
      ss.split(',').forEach((part) => {
        const u = part.trim().split(/\s+/)[0];
        if (u) push(u);
      });
    };
    const scrapeAssetsFromHtml = (html, base, mType) => {
      const found = new Map();
      const push = (rawUrl, type) => {
        if (!rawUrl) return;
        let resolved;
        try { resolved = new URL(rawUrl, base).href; } catch { return; }
        const t = type || classifyExt(resolved) || 'image';
        if (mType !== 'all' && t !== mType) return;
        if (found.has(resolved)) return;
        found.set(resolved, makeScrapeResult(resolved, base, t, base.hostname));
      };
      let m;
      const imgRe = /<img\b[^>]*>/gi;
      while ((m = imgRe.exec(html))) {
        const tag = m[0];
        const src = pickAttr(tag, 'src');
        const dataSrc = pickAttr(tag, 'data-src') || pickAttr(tag, 'data-original') || pickAttr(tag, 'data-lazy-src') || pickAttr(tag, 'data-lazy');
        push(src, 'image');
        if (dataSrc) push(dataSrc, 'image');
        collectSrcset(tag, push);
      }
      const mediaRe = /<(video|audio)\b[^>]*>/gi;
      while ((m = mediaRe.exec(html))) {
        const tag = m[0];
        const type = m[1].toLowerCase() === 'video' ? 'video' : 'audio';
        push(pickAttr(tag, 'src'), type);
        collectSrcset(tag, push);
        const inner = html.slice(m.index + tag.length, html.indexOf(`</${m[1]}>`, m.index));
        const srcRe = /<source\b[^>]*>/gi;
        let sm;
        while ((sm = srcRe.exec(inner))) {
          const st = sm[0];
          const stype = (pickAttr(st, 'type') || '');
          const t = stype.includes('video') ? 'video' : stype.includes('audio') ? 'audio' : type;
          push(pickAttr(st, 'src'), t);
          collectSrcset(st, push);
        }
      }
      const srcRe2 = /<source\b[^>]*>/gi;
      while ((m = srcRe2.exec(html))) {
        const st = m[0];
        const stype = (pickAttr(st, 'type') || '').toLowerCase();
        if (stype.includes('video')) push(pickAttr(st, 'src'), 'video');
        else if (stype.includes('audio')) push(pickAttr(st, 'src'), 'audio');
        collectSrcset(st, push);
      }
      const linkRe = /<link\b[^>]*>/gi;
      while ((m = linkRe.exec(html))) {
        const st = m[0];
        if ((pickAttr(st, 'rel') || '').toLowerCase().includes('image_src')) push(pickAttr(st, 'href'), 'image');
      }
      const metaRe = /<meta\b[^>]*>/gi;
      while ((m = metaRe.exec(html))) {
        const st = m[0];
        const prop = ((pickAttr(st, 'property') || '') + ' ' + (pickAttr(st, 'name') || '')).toLowerCase();
        const content = pickAttr(st, 'content');
        if (/(og:image|twitter:image)/.test(prop)) push(content, 'image');
        else if (/(og:video|twitter:player:stream)/.test(prop)) push(content, 'video');
        else if (/og:audio/.test(prop)) push(content, 'audio');
      }
      const aRe = /<a\b[^>]*>/gi;
      while ((m = aRe.exec(html))) {
        const st = m[0];
        const href = pickAttr(st, 'href');
        if (href && /\.(jpe?g|png|gif|webp|svg|avif|bmp|mp4|webm|ogv|mov|m4v|mkv|mp3|wav|oga|ogg|m4a|aac|flac|glb|gltf|obj|fbx|blend|usdz|stl)$/i.test(href)) {
          push(href, classifyExt(href) || 'image');
        }
      }
      return Array.from(found.values());
    };

    if (!target) {
      return send(res, 400, { success: false, error: { message: 'url is required' } });
    }
    try {
      const parsed = new URL(target);
      if (!/^https?:$/i.test(parsed.protocol)) {
        return send(res, 400, { success: false, error: { message: '仅支持 http/https 开头的有效网址' } });
      }
    } catch {
      return send(res, 400, { success: false, error: { message: '网址格式不正确' } });
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      let resp;
      try {
        resp = await fetch(target, {
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
        });
      } finally {
        clearTimeout(timer);
      }
      const finalUrl = resp.url || target;
      const base = new URL(finalUrl);
      const contentType = String(resp.headers.get('content-type') || '');
      let results = [];
      if (resp.ok) {
        if (/^(image|video|audio)\//i.test(contentType) || /model\//i.test(contentType)) {
          const extType = classifyExt(base.pathname) || (contentType.startsWith('image/') ? 'image' : contentType.startsWith('video/') ? 'video' : contentType.startsWith('audio/') ? 'audio' : 'model');
          results = [makeScrapeResult(base.href, base, extType, base.hostname)];
        } else {
          const html = await resp.text();
          results = scrapeAssetsFromHtml(html, base, mediaType);
        }
      }
      return send(res, 200, { success: true, results, total: results.length, source: finalUrl });
    } catch (e) {
      const msg = String((e && e.message) ? e.message : e);
      return send(res, 200, { success: false, results: [], total: 0, error: msg || '抓取失败' });
    }
  });

  router.register('POST', '/api/search/free-images', async (req, res, url) => {
    const body = await readJson(req).catch(() => ({}));
    const query = String(body?.query || '').trim();
    const platform = String(body?.platform || 'unsplash').trim();
    const page = Math.max(1, parseInt(String(body?.page || '1'), 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(String(body?.perPage || '24'), 10) || 24));
    const requestedType = String(body?.type || 'image').trim();
    const mediaType = ['audio', 'model', 'video'].includes(requestedType) ? requestedType : 'image';


    if (!query) {
      return send(res, 400, { success: false, error: { message: 'query is required' } });
    }

    try {
      let results = [];
      let total = 0;

      switch (platform) {
        case 'unsplash': {
          const params = new URLSearchParams({
            query,
            page: String(page),
            per_page: String(perPage),
            order_by: 'relevant',
          });
          const apiResp = await fetch(`${UNSPLASH_BASE}/search/photos?${params}`, {
            headers: { 'Accept-Version': 'v1' },
          });
          const data = await apiResp.json();
          results = (data.results || []).map((item, i) => ({
            id: `unsplash-${item.id}`,
            url: item.urls?.regular || item.urls?.full || '',
            thumb: item.urls?.thumb || '',
            title: item.description || item.alt_description || `Unsplash ${i + 1}`,
            source: 'unsplash',
            sourceName: 'Unsplash',
            type: 'image',
            width: item.width,
            height: item.height,
            author: item.user?.name || '',
            tags: (item.tags || []).map((t) => t.title),
            uploadDate: item.created_at,
          }));
          total = data.total || results.length;
          break;
        }

        case 'pexels': {
          const pexelsKey = process.env.VITE_PEXELS_API_KEY || '';
          if (!pexelsKey) {
            return send(res, 200, { results: [], total: 0, notice: 'pexels requires API key' });
          }
          if (mediaType === 'video') {
            const params = new URLSearchParams({
              query,
              page: String(page),
              per_page: String(perPage),
            });
            const apiResp = await fetch(`${PEXELS_BASE}/videos/search?${params}`, {
              headers: { Authorization: pexelsKey },
            });
            const data = await apiResp.json();
            results = (data.videos || []).map((item, i) => {
              const file = [...(item.video_files || [])].sort((a, b) => (b.width || 0) - (a.width || 0))[0] || {};
              return {
                id: `pexels-v-${item.id}`,
                url: file.link || '',
                thumb: item.image || '',
                title: item.user?.name ? `视频 by ${item.user.name}` : `Pexels ${i + 1}`,
                source: 'pexels',
                sourceName: 'Pexels',
                type: 'video',
                width: file.width,
                height: file.height,
                author: item.user?.name || '',
                tags: [],
              };
            });
            total = data.total_results || results.length;
            break;
          }
          const params = new URLSearchParams({
            query,
            page: String(page),
            per_page: String(perPage),
          });
          const apiResp = await fetch(`${PEXELS_BASE}/v1/search?${params}`, {
            headers: { Authorization: pexelsKey },
          });
          const data = await apiResp.json();
          results = (data.photos || []).map((item, i) => ({
            id: `pexels-${item.id}`,
            url: item.src?.original || item.src?.large || '',
            thumb: item.src?.small || '',
            title: item.alt || `Pexels ${i + 1}`,
            source: 'pexels',
            sourceName: 'Pexels',
            type: 'image',
            width: item.width,
            height: item.height,
            author: item.photographer || '',
            tags: [],
          }));
          total = data.total_results || results.length;
          break;
        }

        case 'pixabay': {
          const pixabayKey = process.env.VITE_PIXABAY_API_KEY || '';
          if (!pixabayKey) {
            return send(res, 200, { results: [], total: 0, notice: 'pixabay requires API key' });
          }
          if (mediaType === 'video') {
            const params = new URLSearchParams({
              key: pixabayKey,
              q: query,
              page: String(page),
              per_page: String(perPage),
              video: 'true',
              safesearch: 'true',
            });
            const apiResp = await fetch(`${PIXABAY_BASE}/?${params}`);
            const data = await apiResp.json();
            results = (data.hits || []).map((item) => {
              const vid = [...(item.videos || [])].sort((a, b) => (b.width || 0) - (a.width || 0))[0] || {};
              return {
                id: `pixabay-v-${item.id}`,
                url: vid.url || '',
                thumb: item.previewURL || '',
                title: item.tags?.split(',')[0]?.trim() || `Pixabay ${item.id}`,
                source: 'pixabay',
                sourceName: 'Pixabay',
                type: 'video',
                width: vid.width,
                height: vid.height,
                author: item.user || '',
                tags: (item.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
              };
            });
            total = data.total || results.length;
            break;
          }
          const params = new URLSearchParams({
            key: pixabayKey,
            q: query,
            page: String(page),
            per_page: String(perPage),
            image_type: 'photo',
            safesearch: 'true',
          });
          const apiResp = await fetch(`${PIXABAY_BASE}/?${params}`);
          const data = await apiResp.json();
          results = (data.hits || []).map((item) => ({
            id: `pixabay-${item.id}`,
            url: item.largeImageURL || item.webformatURL || '',
            thumb: item.previewURL || '',
            title: item.tags?.split(',')[0]?.trim() || `Pixabay ${item.id}`,
            source: 'pixabay',
            sourceName: 'Pixabay',
            type: 'image',
            width: item.imageWidth,
            height: item.imageHeight,
            author: item.user || '',
            tags: (item.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
          }));
          total = data.total || results.length;
          break;
        }

        case 'openverse': {
          if (mediaType === 'audio') {
            const params = new URLSearchParams({
              q: query,
              page: String(page),
              page_size: String(Math.min(perPage, 50)),
              license: 'cc0,pdm,by',
            });
            const apiResp = await fetch(`${OPENVERSE_BASE}/audio/?${params}`, {
              headers: { Accept: 'application/json' },
            });
            if (!apiResp.ok) return send(res, 200, { results: [], total: 0, notice: 'openverse audio unavailable' });
            const data = await apiResp.json();
            results = (data.results || []).map((item, i) => ({
              id: `openverse-audio-${item.id}`,
              url: item.url || '',
              thumb: item.thumbnail || '',
              title: item.title || `Openverse Audio ${i + 1}`,
              source: 'openverse',
              sourceName: 'Openverse',
              type: 'audio',
              author: item.creator || '',
              license: item.license || 'CC0',
              tags: (item.tags || []).map((t) => (typeof t === 'string' ? t : t.name)).filter(Boolean),
              duration: item.duration ? `${Math.round(Number(item.duration) || 0)}s` : '',
              uploadDate: item.created_on,
            }));
            total = data.result_count || results.length;
            break;
          }
          const params = new URLSearchParams({
            q: query,
            page: String(page),
            page_size: String(Math.min(perPage, 50)),
            license: 'cc0,pdm,by',
            source: 'flickr,wikimedia,stocksnap,pexels',
          });
          const apiResp = await fetch(`${OPENVERSE_BASE}/images/?${params}`, {
            headers: { Accept: 'application/json' },
          });
          if (!apiResp.ok) return send(res, 200, { results: [], total: 0, notice: 'openverse unavailable' });
          const data = await apiResp.json();
          results = (data.results || []).map((item, i) => ({
            id: `openverse-${item.id}`,
            url: item.url || '',
            thumb: item.thumbnail || item.url || '',
            title: item.title || `Openverse ${i + 1}`,
            source: 'openverse',
            sourceName: 'Openverse',
            type: 'image',
            width: item.width,
            height: item.height,
            author: item.creator || '',
            license: item.license || 'CC0',
            tags: (item.tags || []).map((t) => (typeof t === 'string' ? t : t.name)).filter(Boolean),
            uploadDate: item.created_on,
          }));
          total = data.result_count || results.length;
          break;
        }

        case 'freesound': {
          const fsKey = process.env.HMDAO_FREESOUND_API_KEY || process.env.VITE_FREESOUND_API_KEY || '';
          if (!fsKey) return send(res, 200, { results: [], total: 0, notice: 'Freesound 需要 API Key（设置 HMDAO_FREESOUND_API_KEY）' });
          const params = new URLSearchParams({
            query,
            page: String(page),
            page_size: String(Math.min(perPage, 30)),
            token: fsKey,
            filter: 'license:cc0',
            fields: 'id,name,url,previews,images,duration,license,username',
          });
          const apiResp = await fetch(`https://freesound.org/apiv2/search/text/?${params}`);
          if (!apiResp.ok) return send(res, 200, { results: [], total: 0, notice: 'freesound unavailable' });
          const data = await apiResp.json();
          results = (data.results || []).map((item) => ({
            id: `freesound-${item.id}`,
            url: item.previews?.['preview-hq-mp3'] || item.previews?.['preview-lq-mp3'] || '',
            thumb: item.images?.waveform_m || item.images?.medium || '',
            title: item.name || `Freesound ${item.id}`,
            source: 'freesound',
            sourceName: 'Freesound',
            type: 'audio',
            duration: item.duration ? `${Math.round(Number(item.duration) || 0)}s` : '',
            author: item.username || '',
            license: item.license || 'CC0',
            tags: [],
            downloadUrl: `https://freesound.org/apiv2/sounds/${item.id}/download/?token=${fsKey}`,
          }));
          total = data.count || results.length;
          break;
        }

        case 'polyhaven': {
          try {
            // Poly Haven 列表接口忽略 query，需拉取全量目录后在后端按关键词过滤（免 key）
            let catalog = polyhavenCatalogCache.get('models');
            if (!catalog) {
              const catResp = await fetch('https://api.polyhaven.com/assets?type=models', {
                headers: { Accept: 'application/json' },
              });
              if (!catResp.ok) return send(res, 200, { results: [], total: 0, notice: 'polyhaven unavailable' });
              catalog = await catResp.json();
              polyhavenCatalogCache.set('models', catalog);
            }
            const kw = query.trim().toLowerCase();
            const entries = Object.entries(catalog);
            const matched = kw
              ? entries.filter(([id, m]) => {
                  const text = `${m.name || ''} ${(m.tags || []).join(' ')} ${id}`.toLowerCase();
                  return text.includes(kw);
                })
              : entries;
            const pageItems = matched.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
            const detailed = await Promise.all(
              pageItems.map(async ([id, m]) => {
                try {
                  let downloadUrl = '';
                  try {
                    const filesResp = await fetch(`https://api.polyhaven.com/files/${id}?type=models`, {
                      headers: { Accept: 'application/json' },
                    });
                    if (filesResp.ok) {
                      const files = await filesResp.json();
                      const pick = (fmt) => {
                        if (!fmt) return '';
                        const res = ['1k', '2k', '4k'].find((r) => fmt[r]);
                        const entry = res ? fmt[res][Object.keys(fmt[res])[0]] : null;
                        return entry?.url || '';
                      };
                      downloadUrl =
                        pick(files.gltf) || pick(files.fbx) || pick(files.blend) || pick(files.usd) || pick(files.obj);
                    }
                  } catch { /* ignore file fetch errors */ }
                  return {
                    id: `polyhaven-${id}`,
                    url: m.thumbnail_url || '',
                    thumb: m.thumbnail_url || '',
                    downloadUrl,
                    title: m.name || id,
                    source: 'polyhaven',
                    sourceName: 'Poly Haven',
                    type: 'model',
                    author: m.authors ? Object.keys(m.authors)[0] : '',
                    tags: (m.tags || []).map(String),
                  };
                } catch {
                  return null;
                }
              }),
            );
            results = detailed.filter(Boolean);
            total = matched.length;
          } catch {
            return send(res, 200, { results: [], total: 0, notice: 'polyhaven unavailable' });
          }
          break;
        }

        case 'sketchfab': {
          const skKey = process.env.HMDAO_SKETCHFAB_API_KEY || process.env.VITE_SKETCHFAB_API_KEY || '';
          if (!skKey) return send(res, 200, { results: [], total: 0, notice: 'Sketchfab 需要 API Key（设置 HMDAO_SKETCHFAB_API_KEY）' });
          const params = new URLSearchParams({
            type: 'models',
            q: query,
            page: String(page),
            per_page: String(perPage),
          });
          const apiResp = await fetch(`https://api.sketchfab.com/v3/search?${params}`, {
            headers: { Authorization: `Bearer ${skKey}` },
          });
          if (!apiResp.ok) return send(res, 200, { results: [], total: 0, notice: 'sketchfab unavailable' });
          const data = await apiResp.json();
          results = (data.results || []).map((item) => {
            const images = item.thumbnails?.images || [];
            const thumb = [...images].sort((a, b) => (b.size || 0) - (a.size || 0))[0]?.url || images[0]?.url || '';
            return {
              id: `sketchfab-${item.uid}`,
              url: thumb,
              thumb,
              downloadUrl: `https://api.sketchfab.com/v3/models/${item.uid}/download`,
              title: item.name || `Sketchfab ${item.uid}`,
              source: 'sketchfab',
              sourceName: 'Sketchfab',
              type: 'model',
              author: item.user?.username || '',
              tags: (item.tags || []).map(String),
            };
          });
          total = data.count || results.length;
          break;
        }

        case 'wikimedia': {
          const params = new URLSearchParams({
            action: 'query',
            generator: 'search',
            gsrsearch: query,
            gsrnamespace: '6',
            gsrlimit: String(Math.min(perPage, 50)),
            prop: 'imageinfo',
            iiprop: 'url|size|mime|extmetadata',
            iiurlwidth: '400',
            format: 'json',
            formatversion: '2',
          });
          const apiResp = await fetch(`${WIKIMEDIA_BASE}?${params}`, {
            headers: { 'User-Agent': 'HMDaoAssetCollector/1.0' },
          });
          if (!apiResp.ok) return send(res, 200, { results: [], total: 0, notice: 'wikimedia unavailable' });
          const data = await apiResp.json();
          const pages = data.query?.pages || [];
          const list = Array.isArray(pages) ? pages : Object.values(pages);
          results = list
            .map((item, i) => {
              const info = (item.imageinfo && item.imageinfo[0]) || {};
              const mime = String(info.mime || '').toLowerCase();
              const type = mime.startsWith('audio') ? 'audio' : mime.startsWith('video') ? 'video' : 'image';
              // 按素材类型过滤（图片搜索保留全部，音视频只保留对应 mime）
              if (mediaType === 'audio' && !mime.startsWith('audio')) return null;
              if (mediaType === 'video' && !mime.startsWith('video')) return null;
              if (mediaType === 'image' && mime.startsWith('audio')) return null;
              return {
                id: `wikimedia-${item.pageid || i}`,
                url: info.url || '',
                thumb: info.thumburl || info.url || '',
                title: String(item.title || `Wikimedia ${i + 1}`).replace(/^File:/, ''),
                source: 'wikimedia',
                sourceName: 'Wikimedia',
                type,
                width: info.width,
                height: info.height,
                author: (info.extmetadata?.Artist?.value || '').replace(/<[^>]+>/g, ''),
                license: info.extmetadata?.LicenseShortName?.value || 'CC',
                tags: [],
                uploadDate: info.extmetadata?.DateTimeOriginal?.value,
              };
            })
            .filter((r) => r && r.url);
          total = results.length;
          break;
        }

        default:
          return send(res, 200, { results: [], total: 0, notice: `unsupported platform: ${platform}` });
      }

      return send(res, 200, { success: true, results, total, page, query, mediaType });
    } catch (error) {
      console.error(`[free-search] ${platform} error:`, error.message);
      return send(res, 200, { success: true, results: [], total: 0, notice: 'search failed, try another platform' });
    }
  });
}

export default registerSearchRoutes;
