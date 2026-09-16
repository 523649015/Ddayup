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
import { checkExtensionEntitlement } from './extension-license.mjs';
import { isTrustedLoopbackRequest } from '../lib/client-ip.mjs';

export function registerMediaRoutes(router, deps) {
  const {
    execFileAsync,
    handleCuratorPreviewProxy,
    https,
    proxyHuggingFace,
    proxyRemoteMediaAsset,
    readJson,
    resolveLocalPostFfmpegBackend,
    resolveYtDlpPath,
    runCommand,
    send,
    serveLocalModel,
    serveTransformersModule,
    DATA_DIR,
  } = deps;

  // ── 服务端授权闸门（优先级④：把闸门下沉到服务端，单条下载也不漏）──
  // 下载/采集代理（merge-dash/hls/file、save-to-dir、probe-dir、ytdlp/ytdlp-file）必须校验设备授权：
  // trial/paid 放行，none/expired 拒绝（402 LICENSE_REQUIRED）。
  // ★2026-09-13：改为复用 checkExtensionEntitlement 单一真源（此前本地复制了一份
  //   readExtensionLicenses + computeExtensionStatus，与授权侧漂移且不支持「订阅随账号」）。
  // 扩展端每次调用都会携带 deviceId（必要时 token），服务端据此判定，绕过扩展端 gate() 也无处遁形。
  async function gateEntitlement(res, deviceId) {
    const id = String(deviceId || '').trim();
    if (!id) {
      send(res, 402, { ok: false, code: 'LICENSE_REQUIRED', message: '缺少设备标识，无法校验授权（请更新扩展或在扩展内登录）' });
      return false;
    }
    const { entitled, mode } = await checkExtensionEntitlement(DATA_DIR, id);
    if (!entitled) {
      send(res, 402, {
        ok: false,
        code: 'LICENSE_REQUIRED',
        mode,
        message: mode === 'expired'
          ? '免费试用已结束，请登录或订阅后继续下载'
          : '设备未授权，请在扩展内注册开通试用',
      });
      return false;
    }
    return true;
  }

  // ★2026-09-13 F3=A 环回放行：probe-dir / save-to-dir 仅写本机磁盘、不碰外网，
  // 本机直连时跳过设备授权网关，远程(proxy/yt-dlp 等)端点保留 gateEntitlement。
  // ★2026-09-16 安全修复（隐藏缺陷）：原实现只看 req.socket.remoteAddress，
  //   而线上 nginx 反代到 127.0.0.1:8792 后它对【所有公网请求】都是 127.0.0.1
  //   → 等于公网匿名可绕过授权网关。现改用 XFF 首跳判定的 isTrustedLoopbackRequest。
  const isLoopback = (req) => isTrustedLoopbackRequest(req);

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
      if (!ytdlp) {
        return send(res, 503, { error: 'yt-dlp 未安装或不可执行', hint: '请在模型下载面板安装 yt-dlp 后端运行时（侧栏采集时会提示一键安装）', code: 'ytdlp-missing' });
      }
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
      const { stdout, stderr } = await execFileAsync(ytdlp, args, { timeout: 35000, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
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
      if (!ytdlp) {
        return send(res, 503, { error: 'yt-dlp 未安装或不可执行', hint: '请在模型下载面板安装 yt-dlp 后端运行时（侧栏采集时会提示一键安装）', code: 'ytdlp-missing' });
      }
      const { stdout } = await execFileAsync(ytdlp, [
        '--no-playlist', '--no-warnings', '--no-check-certificates',
        '--dump-json', '--socket-timeout', '30',
        videoUrl,
      ], { timeout: 35000, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
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
    if (!(await gateEntitlement(res, url.searchParams.get('deviceId')))) return;
    const videoUrl = String(url.searchParams.get('url') || '').trim();
    if (!videoUrl || !/^https?:\/\//.test(videoUrl)) {
      return send(res, 400, { error: '请提供有效的视频链接' });
    }
    const action = String(url.searchParams.get('action') || 'extract').trim();
    const reqFormat = String(url.searchParams.get('format') || '').trim();
    const cookiesFile = String(url.searchParams.get('cookies_file') || '').trim();
    try {
      const ytdlp = resolveYtDlpPath();
      if (!ytdlp) {
        return send(res, 503, { error: 'yt-dlp 未安装或不可执行', hint: '请在模型下载面板安装 yt-dlp 后端运行时（侧栏采集时会提示一键安装）', code: 'ytdlp-missing' });
      }
      if (action === 'formats') {
        const args = [
          '--no-playlist', '--no-warnings', '--no-check-certificates',
          '--dump-json', '--socket-timeout', '30',
        ];
        if (cookiesFile) args.push('--cookies', cookiesFile);
        args.push(videoUrl);
        const { stdout } = await execFileAsync(ytdlp, args, { timeout: 35000, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
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
      const { stdout, stderr } = await execFileAsync(ytdlp, args, { timeout: 35000, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
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
      const { stdout, stderr } = await execFileAsync(ytdlp, args, { timeout: 60000, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
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
      if (!ytdlp) {
        return send(res, 503, { error: 'yt-dlp 未安装或不可执行', hint: '请在模型下载面板安装 yt-dlp 后端运行时（侧栏采集时会提示一键安装）', code: 'ytdlp-missing' });
      }
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
      const { stdout, stderr } = await execFileAsync(ytdlp, args, { timeout: 180000, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
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
      // ★2026-09-10：yt-dlp 的真实失败原因在【stderr】（如 "Unsupported URL"、
      //   "ERROR: unable to download"、"Sign in to confirm"）。原先只返回 Node 层的
      //   e.message（多半是 "Command failed"），排障时完全看不出站点为何解析不了。
      //   这里把 stderr 尾部一并返回，供前端提示与日志定位。
      const detail = String((e && e.stderr) || (e && e.stdErr) || '').slice(-500);
      return send(res, 500, {
        error: 'yt-dlp 调用失败：' + ((e && e.message) || e),
        detail: detail || undefined,
      });
    }
  });

  // serve yt-dlp 合并落盘的临时文件（供扩展下载含音频的视频）
  router.register('GET', '/api/platform/ytdlp-file', async (req, res, url) => {
    if (!(await gateEntitlement(res, url.searchParams.get('deviceId')))) return;
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

  // ==================================================================
  // DASH 分轨后端合并（ffmpeg -c copy）→ 单文件 MP4
  // ------------------------------------------------------------------
  // 为什么必须由后端做（2026-09-02 实测结论，勿凭直觉改回前端方案）：
  //   1) chrome.downloads 直连 CDN 分轨必 403 —— declarativeNetRequest 注入的 Referer
  //      对 downloads 发起的请求完全无效（4 种 resourceTypes 组合实测全部 SERVER_FORBIDDEN，
  //      服务端收不到任何 Referer）。
  //   2) 前端 Worker 合并（dash-merge-worker.js）产出的 MP4 缺少 avcC，
  //      ffprobe 报 "No start code is found / Invalid data found"，是不可解码的坏文件。
  //   3) 后端 fetch 可自由设置 Referer（无 CORS / 禁止头限制），ffmpeg -c copy 合并零重编码，
  //      且落盘后能用 ffprobe 自检；扩展只需从本地 fileUrl 下载——本地直连无防盗链，
  //      浏览器流式写盘，不受浏览器内存限制（大文件同样适用）。
  // ==================================================================
  const DASH_MERGE_TTL_MS = 2 * 60 * 60 * 1000;
  const dashMergePath = (ticket, suffix) => path.join(os.tmpdir(), `hmdao-dashmerge-${ticket}${suffix}`);

  function resolveFfmpegBins() {
    let managed = '';
    try {
      managed = (resolveLocalPostFfmpegBackend && resolveLocalPostFfmpegBackend().detectedPath) || '';
    } catch (_) { managed = ''; }
    if (managed && fs.existsSync(managed)) {
      const probe = managed.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
      return { ffmpeg: managed, ffprobe: fs.existsSync(probe) ? probe : 'ffprobe' };
    }
    // 回退 PATH（本机已装 ffmpeg 时可用）
    return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  }

  function cleanupStaleDashMerges() {
    try {
      const dir = os.tmpdir();
      const now = Date.now();
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith('hmdao-dashmerge-')) continue;
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        if (now - st.mtimeMs > DASH_MERGE_TTL_MS) fs.rmSync(p, { force: true });
      }
    } catch (_) { /* 清理失败不影响主流程 */ }
  }

  function sanitizeDashMergeName(name, fallback) {
    const raw = String(name || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/[\r\n]+/g, '').trim();
    const clean = (raw.slice(0, 120) || fallback);
    return /\.mp4$/i.test(clean) ? clean : clean + '.mp4';
  }

  // 流式拉取分轨并落盘（不把整个文件读进内存，大文件安全）
  async function fetchTrackToDisk(trackUrl, referer, dest) {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    };
    if (referer) headers.Referer = referer;
    const resp = await fetch(trackUrl, { headers, redirect: 'follow' });
    if (!resp.ok) throw new Error(`拉取分轨失败 HTTP ${resp.status}`);
    if (!resp.body) throw new Error('分轨响应无数据流');
    const { Readable } = await import('node:stream');
    const { createWriteStream } = await import('node:fs');
    await new Promise((resolve, reject) => {
      const ws = createWriteStream(dest);
      ws.on('error', reject);
      ws.on('finish', resolve);
      Readable.fromWeb(resp.body).on('error', reject).pipe(ws);
    });
    const size = fs.statSync(dest).size;
    if (!size) throw new Error('分轨字节为空（可能被防盗链拦截）');
    return size;
  }

  router.register('POST', '/api/media/merge-dash', async (req, res) => {
    let body = {};
    try { body = (await readJson(req)) || {}; } catch (_) { body = {}; }
    if (!(await gateEntitlement(res, body.deviceId))) return;
    const videoUrl = String(body.videoUrl || '').trim();
    const audioUrl = String(body.audioUrl || '').trim();
    const referer = String(body.referer || '').trim();
    if (!/^https?:\/\//i.test(videoUrl)) {
      return send(res, 400, { ok: false, error: '缺少有效的 videoUrl' });
    }

    const ticket = crypto.randomBytes(12).toString('hex');
    const vPath = dashMergePath(ticket, '-video.m4s');
    const aPath = dashMergePath(ticket, '-audio.m4s');
    const outPath = dashMergePath(ticket, '.mp4');
    cleanupStaleDashMerges();
    const bins = resolveFfmpegBins();
    try {
      const videoSize = await fetchTrackToDisk(videoUrl, referer, vPath);
      let audioSize = 0;
      if (audioUrl) audioSize = await fetchTrackToDisk(audioUrl, referer, aPath);

      // -c copy 零重编码；+faststart 把 moov 前移，便于边下边播
      const args = audioSize
        ? ['-y', '-i', vPath, '-i', aPath, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', outPath]
        : ['-y', '-i', vPath, '-c', 'copy', '-movflags', '+faststart', outPath];
      await runCommand(bins.ffmpeg, args);
      if (!fs.existsSync(outPath)) throw new Error('ffmpeg 未产出合并文件');

      // ★合并自检：前端 Worker 合并正是因为缺了这一步，把「无 avcC 的坏 MP4」当成成功交付。
      //   这里必须确认产物真有视频流；提供了音轨时还必须有音频流，否则直接判失败。
      let types = [];
      try {
        const { stdout } = await runCommand(bins.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', outPath]);
        types = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      } catch (_) { types = []; }
      const hasVideo = types.includes('video');
      const hasAudio = types.includes('audio');
      if (!hasVideo) {
        return send(res, 500, { ok: false, error: '合并产物无视频流，已丢弃', detail: 'ffprobe 未检出 video 流' });
      }
      if (audioSize && !hasAudio) {
        return send(res, 500, { ok: false, error: '音频轨未合入产物，已丢弃', detail: '提供了 audioUrl 但输出无 audio 流' });
      }

      const filename = sanitizeDashMergeName(body.filename, `dashmerge-${ticket}.mp4`);
      return send(res, 200, {
        ok: true,
        ticket,
        fileUrl: `/api/media/merge-file?ticket=${ticket}`,
        filename,
        size: fs.statSync(outPath).size,
        hasVideo,
        hasAudio,
        trackSizes: { video: videoSize, audio: audioSize },
        engine: 'ffmpeg-copy',
      });
    } catch (e) {
      const message = String((e && e.message) || e);
      return send(res, 500, { ok: false, error: '后端合并失败：' + message.slice(0, 300) });
    } finally {
      // 合并产物保留（供下载），分轨中间文件清理
      for (const p of [vPath, aPath]) {
        try { fs.rmSync(p, { force: true }); } catch (_) { /* 忽略 */ }
      }
    }
  });

  // ==================================================================
  // HLS / m3u8 拉流合并（ffmpeg 直接拉 m3u8 → 单文件 MP4）
  // ------------------------------------------------------------------
  // 为什么必须单独开这条链路（2026-09-10）：
  //   1) m3u8 是【文本播放列表】。chrome.downloads 直连只会把几十 KB 文本存成"视频"
  //      —— 实测 4815.wumaheil13.icu：下载得到 42KB 假文件。
  //   2) 后端 yt-dlp 依赖【站点提取器】；私有影视站（index.php/vod/play/...）普遍不支持
  //      → /api/platform/ytdlp 直接 500，整条下载链路断掉。
  //   3) ffmpeg 原生支持 HLS（-i index.m3u8 即自动拉全部分片并拼接），
  //      与站点提取器无关，是这类站唯一可靠的下发方式；-c copy 零重编码。
  //   4) 防盗链：后端可用 -headers 自由携带 Referer / Origin（不受浏览器禁止头限制）。
  //   5) 产物走既有 /api/media/merge-file 下发（本地直连无防盗链，且默认不输出
  //      Content-Disposition → 保存路径与文件名仍由扩展完全控制）。
  // ==================================================================
  router.register('POST', '/api/media/merge-hls', async (req, res) => {
    let body = {};
    try { body = (await readJson(req)) || {}; } catch (_) { body = {}; }
    if (!(await gateEntitlement(res, body.deviceId))) return;
    const streamUrl = String(body.url || body.videoUrl || '').trim();
    const referer = String(body.referer || '').trim();
    const ua = String(body.userAgent || '').trim()
      || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    if (!/^https?:\/\//i.test(streamUrl)) {
      return send(res, 400, { ok: false, error: '缺少有效的 m3u8/mpd 地址' });
    }

    const ticket = crypto.randomBytes(12).toString('hex');
    const outPath = dashMergePath(ticket, '.mp4');
    cleanupStaleDashMerges();
    const bins = resolveFfmpegBins();
    try {
      const args = ['-y'];
      // HLS 必须放宽协议白名单：m3u8 内部会引用 http/https 的 ts 分片与 crypto 分片
      args.push('-protocol_whitelist', 'file,http,https,tcp,tls,crypto');
      const headers = [];
      if (referer) headers.push('Referer: ' + referer);
      headers.push('User-Agent: ' + ua);
      if (referer) {
        try { headers.push('Origin: ' + new URL(referer).origin); } catch (_) { /* 忽略非法 referer */ }
      }
      if (headers.length) args.push('-headers', headers.join('\r\n') + '\r\n');
      args.push('-i', streamUrl, '-c', 'copy', '-movflags', '+faststart', outPath);

      // 拉流可能很长（整部影视），给足 15 分钟；超时由 execFileAsync 直接 kill
      await execFileAsync(bins.ffmpeg, args, {
        timeout: 15 * 60 * 1000,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      });
      if (!fs.existsSync(outPath)) throw new Error('ffmpeg 未产出文件');

      // ★自检：与 merge-dash 同款 ffprobe 校验，避免把坏文件当成成功交付
      let types = [];
      try {
        const { stdout } = await runCommand(bins.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', outPath]);
        types = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      } catch (_) { types = []; }
      if (!types.includes('video')) {
        try { fs.rmSync(outPath, { force: true }); } catch (_) { /* 忽略 */ }
        return send(res, 500, {
          ok: false,
          error: '产物无视频流，已丢弃',
          detail: '可能是加密分片（EXT-X-KEY）或分片拉取被防盗链拦截',
        });
      }

      const filename = sanitizeDashMergeName(body.filename, `hls-${ticket}.mp4`);
      return send(res, 200, {
        ok: true,
        ticket,
        fileUrl: `/api/media/merge-file?ticket=${ticket}`,
        filename,
        size: fs.statSync(outPath).size,
        hasVideo: types.includes('video'),
        hasAudio: types.includes('audio'),
        engine: 'ffmpeg-hls-copy',
      });
    } catch (e) {
      try { fs.rmSync(outPath, { force: true }); } catch (_) { /* 忽略 */ }
      const message = String((e && e.message) || e);
      return send(res, 500, { ok: false, error: 'HLS 拉流失败：' + message.slice(0, 300) });
    }
  });

  // 提供后端合并落盘的单文件（供扩展下载；本地直连无防盗链，文件名由扩展指定）
  router.register(['GET', 'HEAD'], '/api/media/merge-file', async (req, res, url) => {
    if (!(await gateEntitlement(res, url.searchParams.get('deviceId')))) return;
    const ticket = String(url.searchParams.get('ticket') || '').trim();
    if (!/^[a-f0-9]{24}$/.test(ticket)) return send(res, 400, { error: 'invalid ticket' });
    const filePath = dashMergePath(ticket, '.mp4');
    if (!fs.existsSync(filePath)) return send(res, 404, { error: '文件不存在或已过期' });
    res.setHeader('Content-Type', 'video/mp4');
    // ★服务端只在调用方显式要名字时才输出 filename=。
    //   否则 Chrome 会用服务端的 Content-Disposition 文件名覆盖 chrome.downloads 指定的
    //   filename（实测：文件被保存成 dashmerge-<ticket>.mp4，扩展指定的 'Ddayup/videos/xx.mp4'
    //   子目录被丢弃）。默认不输出 → 由扩展完全控制保存路径与文件名。
    // 注意：一旦输出 Content-Disposition（哪怕不带 filename），Chrome 都会改用 URL 推导的文件名，
    // 覆盖 chrome.downloads.download 传入的 filename（实测得 dashmerge-<ticket>.mp4 / merge-file.mp4）。
    // 因此默认完全不输出该头，把命名权交回调用方（扩展），仅在调用方显式要名时才输出。
    const nameParam = String(url.searchParams.get('filename') || '').trim();
    if (nameParam) {
      const name = sanitizeDashMergeName(nameParam, `dashmerge-${ticket}.mp4`);
      const asciiName = name.replace(/[^\x20-\x7e]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    }
    res.setHeader('Content-Length', String(fs.statSync(filePath).size));
    fs.createReadStream(filePath).pipe(res);
  });

  // ==================================================================
  // 按类型「自定义绝对保存路径」——后端落盘通道（2026-09-12）
  // ------------------------------------------------------------------
  // 为什么必须由后端写盘：
  //   1) chrome.downloads.download 的 filename 只能是【浏览器默认下载目录】下的相对路径，
  //      根本无法写入任意绝对目录（如 D:\素材\图片）。
  //   2) File System Access API（showDirectoryPicker）在扩展 side panel 里不可靠
  //      （Chromium 已知缺陷：崩溃 / 伪 AbortError / 权限不持久）→ 句柄常为 null。
  //   故「用户填了绝对路径」这一路统一交后端：后端进程可直接 fs 写任意绝对路径，
  //   且 url 分支用【流式】落盘，不受浏览器 sendMessage 64MB 限制，支持 GB 级大文件。
  // ==================================================================

  // Windows 绝对路径 / POSIX 绝对路径 / UNC 判定
  function isAbsoluteDir(dir) {
    const s = String(dir == null ? '' : dir).trim();
    if (!s) return false;
    if (/^[a-zA-Z]:[\\/]/.test(s)) return true; // D:\... / D:/...
    if (/^\\\\[^\\]+\\/.test(s)) return true;    // \\server\share\...
    if (s.startsWith('/')) return true;          // POSIX /...
    return false;
  }

  // 文件名清洗：剥离路径分隔符 / .. / 控制字符 / Windows 非法字符 / 保留名，防目录穿越。
  const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
  function sanitizeFilename(name, fallback = 'download.bin') {
    let s = String(name == null ? '' : name);
    s = s.replace(/[\u0000-\u001f\u007f]/g, '');   // 控制字符
    s = s.replace(/[\\/]+/g, '_');                 // 路径分隔符 → 同一目录内
    s = s.replace(/\.{2,}/g, '_');                 // 防穿越（.. / ...）
    s = s.replace(/[<>:"|?*]/g, '_');              // Windows 非法字符
    s = s.replace(/^[.\s]+|[.\s]+$/g, '');         // 首尾点 / 空白
    if (!s) s = fallback;
    if (WIN_RESERVED.test(s)) s = '_' + s;
    if (s.length > 180) {
      const ext = path.extname(s).slice(0, 20);
      s = s.slice(0, 180 - ext.length) + ext;
    }
    return s || fallback;
  }

  // 解析后必须仍在 baseDir 之内；越界返回 null
  function resolveInsideDir(baseDir, filename) {
    const absDir = path.resolve(baseDir);
    const absFile = path.resolve(absDir, filename);
    const rel = path.relative(absDir, absFile);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return absFile;
  }

  // 落盘去重：目标文件已存在时，生成 base (2).ext / base (3).ext … 的不冲突唯一路径。
  // 解决「同一链接重复下载 / 不同链接推导出同名 → 静默覆盖已有文件」问题。
  function makeUniqueAbsPath(filePath) {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    let i = 2;
    let cand;
    do {
      cand = path.join(dir, `${base} (${i})${ext}`);
      i++;
    } while (fs.existsSync(cand));
    return cand;
  }

  router.register('POST', '/api/media/save-to-dir', async (req, res) => {
    let body = {};
    try { body = (await readJson(req)) || {}; } catch (_) { body = {}; }
    if (!isLoopback(req) && !(await gateEntitlement(res, body.deviceId))) return;

    const dir = String(body.dir || '').trim();
    if (!isAbsoluteDir(dir)) {
      return send(res, 400, { success: false, error: 'dir 必须是绝对路径（如 D:\\\\素材\\\\图片）' });
    }

    // 目标目录 = dir(/subdir)；subdir 同样清洗，禁止穿越
    let baseDir;
    try { baseDir = path.resolve(dir); } catch (_) {
      return send(res, 400, { success: false, error: 'dir 非法' });
    }
    const subdir = String(body.subdir || '').trim();
    if (subdir) {
      const saniSub = sanitizeFilename(subdir, '');
      if (saniSub) baseDir = path.resolve(baseDir, saniSub);
    }

    const filename = sanitizeFilename(String(body.filename || '').trim(), `ddayup-${Date.now()}.bin`);
    const absFile = resolveInsideDir(baseDir, filename);
    if (!absFile) {
      return send(res, 400, { success: false, error: '文件名非法（路径穿越被拒绝）' });
    }
    // ★2026-09-15（用户反馈：同名文件被静默覆盖）：落盘前若目标已存在，自动加 (2)/(3)… 后缀，
    // 保证「同一链接重复下载 / 不同链接推导出同名」都落为独立文件，绝不直接替换已有文件。
    let outFile = absFile;
    try {
      const exists = await fs.promises.access(outFile, fs.constants.F_OK).then(() => true).catch(() => false);
      if (exists) outFile = makeUniqueAbsPath(outFile);
    } catch (_) { outFile = absFile; }

    const url = String(body.url || '').trim();
    const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';
    if (!url && !dataBase64) {
      return send(res, 400, { success: false, error: '缺少 url 或 dataBase64' });
    }
    if (url && !/^https?:\/\//i.test(url)) {
      return send(res, 400, { success: false, error: 'url 仅支持 http(s)' });
    }

    try {
      await fs.promises.mkdir(baseDir, { recursive: true });
    } catch (e) {
      return send(res, 500, { success: false, error: '创建目录失败：' + String((e && e.message) || e) });
    }

    // 分支 1：dataBase64（侧栏已拿到字节，如 blob 资产）
    if (dataBase64) {
      try {
        const buf = Buffer.from(dataBase64, 'base64');
        if (!buf.length) return send(res, 400, { success: false, error: 'dataBase64 解码为空' });
        await fs.promises.writeFile(outFile, buf);
        return send(res, 200, { success: true, savedPath: outFile, bytes: buf.length });
      } catch (e) {
        return send(res, 500, { success: false, error: '写入失败：' + String((e && e.message) || e) });
      }
    }

    // 分支 2：url —— 后端带 Referer/UA 拉取，【流式】写盘（支持 GB 级大文件，不整体读内存）
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      };
      const referer = String(body.referer || '').trim();
      if (referer) headers.Referer = referer;
      // ★2026-09-13：第三方图床无响应/黑连接会无限挂起 → 前端点下载「无响应」。
      //   加 25s 超时（AbortController），超时/失败都返回可读错误，绝不静默挂起。
      const ctrl = new AbortController();
      const abortTimer = setTimeout(() => ctrl.abort(), 25000);
      let resp;
      try {
        resp = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
      } catch (fe) {
        clearTimeout(abortTimer);
        const timed = !!(fe && (fe.name === 'TimeoutError' || fe.name === 'AbortError'));
        return send(res, timed ? 504 : 502, {
          success: false,
          error: timed ? '拉取超时（第三方源无响应）' : `拉取失败：${String((fe && fe.message) || fe).slice(0, 160)}`,
        });
      }
      clearTimeout(abortTimer);
      if (!resp.ok) {
        return send(res, 502, { success: false, error: `拉取失败 HTTP ${resp.status}` });
      }
      if (!resp.body) {
        return send(res, 502, { success: false, error: '响应无数据流' });
      }
      const { Readable } = await import('node:stream');
      const { createWriteStream } = await import('node:fs');
      const bytes = await new Promise((resolve, reject) => {
        const ws = createWriteStream(outFile);
        const rs = Readable.fromWeb(resp.body);
        ws.on('error', reject);
        rs.on('error', reject);
        ws.on('finish', () => resolve(Number(ws.bytesWritten || 0)));
        rs.pipe(ws);
      });
      if (!bytes) {
        try { fs.rmSync(outFile, { force: true }); } catch (_) { /* 忽略 */ }
        return send(res, 502, { success: false, error: '拉取字节为空（可能被防盗链拦截）' });
      }
      return send(res, 200, { success: true, savedPath: outFile, bytes });
    } catch (e) {
      try { fs.rmSync(outFile, { force: true }); } catch (_) { /* 忽略 */ }
      return send(res, 500, { success: false, error: '写入失败：' + String((e && e.message) || e).slice(0, 200) });
    }
  });

  // 目录可写性探针：递归建目录 + 写一个探针文件再删除，供侧栏「测试」按钮校验
  router.register('POST', '/api/media/probe-dir', async (req, res) => {
    let body = {};
    try { body = (await readJson(req)) || {}; } catch (_) { body = {}; }
    if (!isLoopback(req) && !(await gateEntitlement(res, body.deviceId))) return;
    const dir = String(body.dir || '').trim();
    if (!isAbsoluteDir(dir)) {
      return send(res, 400, { success: false, ok: false, error: 'dir 必须是绝对路径（如 D:\\\\素材\\\\图片）' });
    }
    let absDir;
    try { absDir = path.resolve(dir); } catch (_) {
      return send(res, 400, { success: false, ok: false, error: 'dir 非法' });
    }
    try {
      await fs.promises.mkdir(absDir, { recursive: true });
      const probe = path.join(absDir, `.ddayup-dir-test-${crypto.randomBytes(4).toString('hex')}.txt`);
      await fs.promises.writeFile(probe, 'Ddayup 目录写入测试 ' + new Date().toISOString());
      const bytes = fs.statSync(probe).size;
      await fs.promises.rm(probe, { force: true });
      return send(res, 200, { success: true, ok: true, dir: absDir, bytes });
    } catch (e) {
      return send(res, 500, { success: false, ok: false, dir: absDir, error: String((e && e.message) || e).slice(0, 200) });
    }
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
