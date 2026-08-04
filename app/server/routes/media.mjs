/**
 * 媒体代理 / YouTube / 运行时静态资源路由组
 *
 * 由 hmdao-api.mjs 的 route() if 链逐字外移而来（分支体一字未改），
 * 通过 deps 注入访问主文件的模块级函数与常量，保证行为与迁移前完全一致。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function registerMediaRoutes(router, deps) {
  const {
    execFileAsync,
    handleCuratorPreviewProxy,
    https,
    proxyHuggingFace,
    proxyRemoteMediaAsset,
    resolveYtDlpPath,
    send,
    serveLocalModel,
    serveTransformersModule,
  } = deps;

  router.register('GET', '/api/curator/preview-proxy', async (req, res, url) => {
    return handleCuratorPreviewProxy(req, res, url);
  });

  router.register(['GET', 'HEAD'], '/api/media-proxy', async (req, res, url) => {
    const mediaUrl = String(url.searchParams.get('url') || '').trim();
    const kind = String(url.searchParams.get('kind') || '').trim().toLowerCase();
    const referer = String(url.searchParams.get('referer') || '').trim();
    const origin = String(url.searchParams.get('origin') || '').trim();
    return proxyRemoteMediaAsset(req, res, mediaUrl, kind, referer, origin);
  });

  router.register('GET', '/api/youtube/extract', async (req, res, url) => {
    const videoUrl = String(url.searchParams.get('url') || '').trim();
    if (!videoUrl || !/youtube\.com\/watch\?v=|youtu\.be\//i.test(videoUrl)) {
      return send(res, 400, { error: '请提供有效的 YouTube 视频链接' });
    }
    try {
      const ytdlp = resolveYtDlpPath();
      // 可选 format 参数：指定格式 ID 下载（如 137+140），不传则用默认最佳格式
      const reqFormat = String(url.searchParams.get('format') || '').trim();
      const fmtStr = reqFormat || 'best[ext=mp4]/bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best';
      const args = [
        '--no-playlist', '--no-warnings', '--no-check-certificates',
        '--format', fmtStr,
        '--get-url', '--print', 'title', '--print', 'duration', '--print', 'thumbnail',
        '--socket-timeout', '30',
        videoUrl,
      ];
      const { stdout, stderr } = await execFileAsync(ytdlp, args, { timeout: 35000, maxBuffer: 10 * 1024 * 1024 });
      const lines = (stdout || '').split(/\r?\n/).filter(Boolean);
      // yt-dlp 输出顺序（实测 2026-07-26）：--print 在前、--get-url 在后。
      //   行0: title（--print title）
      //   行1: duration（--print duration）
      //   行2: 缩略图 URL（--print thumbnail）
      //   行3: 视频直链（--get-url, bestvideo）
      //   行4: 音轨直链（--get-url, bestaudio, 分离格式时）
      // 旧逻辑 urls[0] 误取第 2 行(缩略图 .jpg) 返回给面板 → 下载成图片！
      const allUrls = [];
      let title = '', duration = '';
      for (const line of lines) {
        if (/^https?:\/\//.test(line)) allUrls.push(line);
        else if (!title) title = line;
        else if (!duration && /^\d+(\.\d+)?$/.test(line)) duration = line;
      }
      // 缩略图是 i.ytimg.com 域；视频/音轨是 googlevideo 域
      const thumbnail = allUrls.find((u) => /i\.ytimg\.com/.test(u)) || '';
      const downloadUrls = allUrls.filter((u) => u !== thumbnail);
      // downloadUrls[0] = 视频直链（bestvideo），downloadUrls[1] = 音轨直链（bestaudio）
      const directUrl = downloadUrls[0] || '';
      if (!directUrl) {
        return send(res, 500, { error: 'yt-dlp 未能提取直链', detail: (stderr || '').slice(0, 200) });
      }
      return send(res, 200, {
        url: directUrl,
        urls: downloadUrls,
        title,
        duration: parseFloat(duration) || 0,
        thumbnail,
      });
    } catch (e) {
      return send(res, 500, { error: 'yt-dlp 调用失败：' + (e.message || e) });
    }
  });

  router.register('GET', '/api/youtube/formats', async (req, res, url) => {
    const videoUrl = String(url.searchParams.get('url') || '').trim();
    if (!videoUrl || !/youtube\.com\/watch\?v=|youtu\.be\//i.test(videoUrl)) {
      return send(res, 400, { error: '请提供有效的 YouTube 视频链接' });
    }
    try {
      const ytdlp = resolveYtDlpPath();
      const { stdout } = await execFileAsync(ytdlp, [
        '--no-playlist', '--no-warnings', '--no-check-certificates',
        '--dump-json', '--socket-timeout', '30',
        videoUrl,
      ], { timeout: 35000, maxBuffer: 10 * 1024 * 1024 });
      const info = JSON.parse(stdout || '{}');
      const formats = (info.formats || []).map((f) => {
        const hasVideo = f.vcodec && f.vcodec !== 'none';
        const hasAudio = f.acodec && f.acodec !== 'none';
        const resolution = f.width ? `${f.width}x${f.height}` : (f.resolution || '');
        const fps = f.fps || 0;
        // 格式标签：有视频时有 resolution+fps，纯音频时标"仅音频"
        let label = resolution || '';
        if (hasVideo && !hasAudio) label += ' (仅视频)';
        else if (!hasVideo && hasAudio) label = f.abr ? `${f.abr}kbps 仅音频` : '仅音频';
        if (fps && hasVideo) label += ` ${fps}fps`;
        // 文件大小
        const filesize = f.filesize || f.filesize_approx || 0;
        return {
          format_id: f.format_id || '',
          ext: f.ext || '',
          resolution,
          width: f.width || 0,
          height: f.height || 0,
          fps,
          vcodec: f.vcodec || '',
          acodec: f.acodec || '',
          abr: f.abr || 0,
          has_video: hasVideo,
          has_audio: hasAudio,
          filesize,
          filesize_mb: filesize ? +(filesize / 1048576).toFixed(1) : 0,
          tbr: f.tbr || 0,
          format_note: f.format_note || '',
          label,
        };
      }).filter((f) => f.has_video || f.filesize > 0);
      // 排序：分辨率降序 → fps 降序 → 有音频优先
      formats.sort((a, b) => {
        const h = (b.height || 0) - (a.height || 0);
        if (h !== 0) return h;
        const fps = (b.fps || 0) - (a.fps || 0);
        if (fps !== 0) return fps;
        return (b.has_audio ? 1 : 0) - (a.has_audio ? 1 : 0);
      });
      return send(res, 200, {
        title: info.title || '',
        duration: info.duration || 0,
        thumbnail: info.thumbnail || '',
        formats,
      });
    } catch (e) {
      return send(res, 500, { error: 'yt-dlp 格式列表获取失败：' + (e.message || e) });
    }
  });

  router.register('GET', '/api/platform/ytdlp', async (req, res, url) => {
    const videoUrl = String(url.searchParams.get('url') || '').trim();
    if (!videoUrl || !/^https?:\/\//.test(videoUrl)) {
      return send(res, 400, { error: '请提供有效的视频链接' });
    }
    const action = String(url.searchParams.get('action') || 'extract').trim();
    const reqFormat = String(url.searchParams.get('format') || '').trim();
    const cookiesFile = String(url.searchParams.get('cookies_file') || '').trim();
    try {
      const ytdlp = resolveYtDlpPath();
      if (action === 'formats') {
        const args = [
          '--no-playlist', '--no-warnings', '--no-check-certificates',
          '--dump-json', '--socket-timeout', '30',
        ];
        if (cookiesFile) args.push('--cookies', cookiesFile);
        args.push(videoUrl);
        const { stdout } = await execFileAsync(ytdlp, args, { timeout: 35000, maxBuffer: 10 * 1024 * 1024 });
        const info = JSON.parse(stdout || '{}');
        const formats = (info.formats || []).map((f) => ({
          format_id: f.format_id || '',
          ext: f.ext || '',
          resolution: f.resolution || (f.width ? `${f.width}x${f.height}` : ''),
          width: f.width || 0,
          height: f.height || 0,
          fps: f.fps || 0,
          vcodec: f.vcodec || '',
          acodec: f.acodec || '',
          has_video: !!(f.vcodec && f.vcodec !== 'none'),
          has_audio: !!(f.acodec && f.acodec !== 'none'),
          filesize: f.filesize || f.filesize_approx || 0,
          filesize_mb: (f.filesize || f.filesize_approx) ? +((f.filesize || f.filesize_approx) / 1048576).toFixed(1) : 0,
          tbr: f.tbr || 0,
          format_note: f.format_note || '',
        })).filter((f) => f.has_video || f.has_audio);
        // 视频格式优先：分辨率降序 → 有音频优先
        formats.sort((a, b) => {
          const h = (b.height || 0) - (a.height || 0);
          if (h !== 0) return h;
          return (b.has_audio ? 1 : 0) - (a.has_audio ? 1 : 0);
        });
        return send(res, 200, { title: info.title || '', duration: info.duration || 0, thumbnail: info.thumbnail || '', formats });
      } else if (action === 'extract') {
      // 默认强制音视频合并：'best[ext=mp4]' 在没有整段 mp4 时回退到
      // 'bestvideo[ext=mp4]+bestaudio[ext=m4a]'（DASH 分轨），配合 --merge-output-format mp4
      // 让 yt-dlp 直接吐出【含音画】的单条直链，侧栏预览才有声音、能正常播放。
      // （旧字符串最后兜底的 'best' 会取纯视频轨 → 预览无声/黑屏，已改为带音轨兜底。）
      const fmtStr = reqFormat || 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bv*+ba/best';
      const args = [
        '--no-playlist', '--no-warnings', '--no-check-certificates',
        '--format', fmtStr,
        '--merge-output-format', 'mp4',
        '--get-url', '--print', 'title', '--print', 'duration', '--print', 'thumbnail',
        '--socket-timeout', '30',
      ];
      if (cookiesFile) args.push('--cookies', cookiesFile);
      args.push(videoUrl);
      const { stdout, stderr } = await execFileAsync(ytdlp, args, { timeout: 35000, maxBuffer: 10 * 1024 * 1024 });
      const lines = (stdout || '').split(/\r?\n/).filter(Boolean);
      const allUrls = [];
      let title = '', duration = '';
      for (const line of lines) {
        if (/^https?:\/\//.test(line)) allUrls.push(line);
        else if (!title) title = line;
        else if (!duration && /^\d+(\.\d+)?$/.test(line)) duration = line;
      }
      // 缩略图过滤：多平台兼容。yt-dlp --print thumbnail 输出 i.ytimg.com (YouTube) /
      // hdslb.com (B站) 等图片 CDN；--get-url 输出的是视频/音轨直链（在数组最后）。
      // ★2026-08-02 修复：补上优酷封面图域名 m.ykimg.com / ykimg.com —— 否则优酷的封面图
      //   （m.ykimg.com/...jpg）被误当成视频直链返回 front 端 → <video src=封面图> 黑屏，
      //   悬停/预览云桥网(yunqiaowang)等优酷嵌入视频时"播放不了"。
      const thumbDomains = ['i.ytimg.com', 'hdslb.com', '/pic.', 'i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com', 'm.ykimg.com', 'ykimg.com'];
      const isThumb = (u) => thumbDomains.some((d) => u.includes(d));
      const thumbUrls = allUrls.filter(isThumb);
      const downloadUrls = allUrls.filter((u) => !isThumb(u));
      const thumbnail = thumbUrls[0] || '';
      const directUrl = downloadUrls[0] || '';
      if (!directUrl) {
        return send(res, 500, { error: 'yt-dlp 未能提取直链', detail: (stderr || '').slice(0, 200) });
      }
      return send(res, 200, { url: directUrl, urls: downloadUrls, title, duration: parseFloat(duration) || 0, thumbnail });
    } else if (action === 'playlist') {
      // ★2026-08-02 借鉴 seekin.ai「抖音合集」能力：返回播放列表内全部视频条目
      // （标题 + 直链/播放页 URL），供扩展侧栏做「合集批量选择下载」。
      const args = [
        '--no-warnings', '--no-check-certificates',
        '--flat-playlist', '--dump-json', '--socket-timeout', '40',
      ];
      if (cookiesFile) args.push('--cookies', cookiesFile);
      args.push(videoUrl);
      const { stdout, stderr } = await execFileAsync(ytdlp, args, { timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
      const entries = (stdout || '').split(/\r?\n/).filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch (_) { return null; }
      }).filter(Boolean);
      if (!entries.length) {
        return send(res, 404, { error: '未识别到合集/列表，可能不是合集页', detail: (stderr || '').slice(0, 200) });
      }
      const items = entries.map((e, i) => ({
        index: i + 1,
        id: e.id || e.video_id || '',
        title: e.title || (e.description ? e.description.slice(0, 40) : '') || ('条目 ' + (i + 1)),
        url: e.url || e.webpage_url || e.original_url || '',
        duration: e.duration || 0,
        thumbnail: e.thumbnail || '',
      })).filter((it) => it.url);
      if (!items.length) {
        return send(res, 404, { error: '合集内无可下载条目', detail: (stderr || '').slice(0, 200) });
      }
      return send(res, 200, { type: 'playlist', count: items.length, items });
    } else if (action === 'download') {
      // ★ 合并音视频落盘（保证下载的文件"有声音"）。扩展选具体分辨率时走此分支。
      // 2026-08-02 新增 audio=1：仅提取 MP3 音频（借鉴 seekin.ai 的「MP3 音频提取」）。
      const audioOnly = String(url.searchParams.get('audio') || '').trim() === '1';
      const ytdlp = resolveYtDlpPath();
      let fmtStr;
      let mergeExt = 'mp4';
      const audioArgs = [];
      if (audioOnly) {
        // ★ 仅提取 MP3 音频（seekin.ai 的「MP3 音频提取」能力）
        // 注意：yt-dlp 的 --merge-output-format 只接受容器格式(mp4/mkv/webm/ogg)，
        // 不接受 'mp3'（会报 invalid merge output format）。音频提取必须用
        // --extract-audio --audio-format mp3，且不要 --merge-output-format。
        fmtStr = reqFormat && /^\d+$/.test(reqFormat) ? reqFormat : 'bestaudio';
        mergeExt = 'mp3';
        audioArgs.push('--extract-audio', '--audio-format', 'mp3');
      } else if (/^\d+$/.test(reqFormat)) {
        // 纯视频 format_id（如 137/313）→ 必须补音频轨，否则下载无声
        fmtStr = `${reqFormat}+bestaudio`;
      } else if (reqFormat) {
        fmtStr = (reqFormat.includes('+') || /bestaudio/i.test(reqFormat)) ? reqFormat : `${reqFormat}+bestaudio`;
      } else {
        fmtStr = 'bestvideo+bestaudio/best[ext=mp4]/best';
      }
      const ticket = crypto.randomBytes(12).toString('hex');
      const outPath = path.join(os.tmpdir(), `hmdao-ytdlp-${ticket}.%(ext)s`);
      const args = [
        '--no-playlist', '--no-warnings', '--no-check-certificates',
        '--format', fmtStr,
        '--restrict-filenames',
        '-o', outPath,
        '--socket-timeout', '60',
      ];
      // 音频模式追加 --extract-audio --audio-format mp3（必须放在 merge 相关参数之前/独立于之）
      if (audioOnly) args.push(...audioArgs);
      else args.push('--merge-output-format', mergeExt);
      if (cookiesFile) args.push('--cookies', cookiesFile);
      // 显式定位 ffmpeg（合并音视频/转码 mp3 必需），避免 API 进程 PATH 缺失导致失败
      try {
        const ff = require('child_process').spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
        const ffPath = (ff.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
        if (ffPath && fs.existsSync(ffPath)) {
          args.push('--ffmpeg-location', path.dirname(ffPath));
        }
      } catch (_) { /* 忽略，yt-dlp 自行查找 */ }
      args.push(videoUrl);
      const { stdout, stderr } = await execFileAsync(ytdlp, args, { timeout: 180000, maxBuffer: 20 * 1024 * 1024 });
      const dir = os.tmpdir();
      // 音频模式 extract-audio 实际扩展名可能是 mp3/m4a/opus/ogg/webm 之一（取决于音轨），
      // 视频模式是 mp4。这里把两者都纳入候选。
      const audioExts = ['.mp3', '.m4a', '.opus', '.ogg', '.webm'];
      const candidates = fs.readdirSync(dir).filter((f) => {
        if (!f.startsWith(`hmdao-ytdlp-${ticket}.`)) return false;
        if (audioOnly) return audioExts.some((e) => f.endsWith(e));
        return f.endsWith('.mp4');
      });
        if (!candidates.length) {
          return send(res, 500, { error: 'yt-dlp 合并下载未生成文件', detail: (stderr || '').slice(0, 300) });
        }
        const lines = (stdout || '').split(/\r?\n/).filter(Boolean);
        const meta = { title: '', duration: 0, thumbnail: '' };
        const thumbDomains = ['i.ytimg.com', 'hdslb.com', '/pic.', 'i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com'];
        for (const line of lines) {
          if (/^https?:\/\//.test(line) && thumbDomains.some((d) => line.includes(d))) meta.thumbnail = line;
          else if (!meta.title) meta.title = line;
          else if (!meta.duration && /^\d+(\.\d+)?$/.test(line)) meta.duration = parseFloat(line);
        }
        const stat = fs.statSync(path.join(dir, candidates[0]));
        return send(res, 200, {
          ticket,
          fileUrl: `/api/platform/ytdlp-file?ticket=${ticket}`,
          filename: candidates[0],
          title: meta.title,
          duration: meta.duration,
          thumbnail: meta.thumbnail,
          size: stat.size,
        });
    }
    } catch (e) {
      return send(res, 500, { error: 'yt-dlp 调用失败：' + (e.message || e) });
    }
  });

  // serve yt-dlp 合并落盘的临时文件（供扩展下载含音频的视频）
  router.register('GET', '/api/platform/ytdlp-file', async (req, res, url) => {
    const ticket = String(url.searchParams.get('ticket') || '').trim();
    if (!/^[a-f0-9]{24}$/.test(ticket)) return send(res, 400, { error: 'invalid ticket' });
    const dir = os.tmpdir();
    const audioExts = ['.mp3', '.m4a', '.opus', '.ogg', '.webm'];
    const candidates = fs.readdirSync(dir).filter((f) => f.startsWith(`hmdao-ytdlp-${ticket}.`) && (f.endsWith('.mp4') || audioExts.some((e) => f.endsWith(e))));
    if (!candidates.length) return send(res, 404, { error: '文件不存在或已过期' });
    const filePath = path.join(dir, candidates[0]);
    const isAudio = audioExts.some((e) => candidates[0].endsWith(e));
    const mimeMap = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.webm': 'audio/webm' };
    const ext = audioExts.find((e) => candidates[0].endsWith(e)) || '.mp4';
    res.setHeader('Content-Type', isAudio ? (mimeMap[ext] || 'audio/mpeg') : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${candidates[0]}"`);
    res.setHeader('Content-Length', String(fs.statSync(filePath).size));
    fs.createReadStream(filePath).pipe(res);
  });

  router.registerPrefix(['GET', 'HEAD'], '/api/transformers/', async (req, res, url) => {
    return serveTransformersModule(req, res, url);
  });

  router.registerPrefix(['GET', 'HEAD', 'POST'], '/api/local-model/', async (req, res, url) => {
    return serveLocalModel(req, res, url);
  });

  router.registerPrefix(['GET', 'HEAD', 'POST'], '/api/hf-proxy/', async (req, res, url) => {
    return proxyHuggingFace(req, res, url);
  });
}

export default registerMediaRoutes;
