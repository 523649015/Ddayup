// =====================================================================
// 音频格式转码（可插拔独立路由）
// ---------------------------------------------------------------------
// 目的：豆包朗读采集到的是 ogg_opus（平台原始下发，零重编码损失），
//       部分剪辑/播放场景更想要 MP3。本路由用后端 ffmpeg 做一次转码。
//
// 设计约束（避免臃肿、避免引入新问题）：
//   · 独立文件、独立注册，不改动 media.mjs 任何既有逻辑；
//   · 只依赖 deps 里三个通用能力（readJson / runCommand / resolveLocalPostFfmpegBackend）；
//   · 全程 try/catch + finally 清临时文件；失败只返回错误，不抛异常、不影响其它路由；
//   · 输入限 24MB base64（≈18MB 原始音频，朗读场景远超需要），超限直接拒绝。
// =====================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_B64 = 24 * 1024 * 1024;

export function registerAudioTranscodeRoutes(router, deps) {
  const { readJson, runCommand, resolveLocalPostFfmpegBackend, send } = deps || {};

  function resolveBins() {
    let managed = '';
    try {
      managed = (resolveLocalPostFfmpegBackend && resolveLocalPostFfmpegBackend().detectedPath) || '';
    } catch (_) { managed = ''; }
    if (managed && fs.existsSync(managed)) {
      const probe = managed.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
      return { ffmpeg: managed, ffprobe: fs.existsSync(probe) ? probe : 'ffprobe' };
    }
    return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  }

  router.register('POST', '/api/media/audio-transcode', async (req, res) => {
    const ticket = crypto.randomBytes(6).toString('hex');
    const inPath = path.join(os.tmpdir(), `hmdao-audioin-${ticket}.ogg`);
    let outPath = path.join(os.tmpdir(), `hmdao-audioout-${ticket}.mp3`);
    try {
      let body = {};
      try { body = (await readJson(req)) || {}; } catch (_) { body = {}; }
      const b64 = String(body.b64 || '');
      if (!b64) return send(res, 400, { ok: false, error: '缺少音频数据（b64）' });
      if (b64.length > MAX_B64) return send(res, 413, { ok: false, error: '音频过大（上限 18MB）' });

      const bytes = Buffer.from(b64, 'base64');
      if (bytes.length < 1024) return send(res, 400, { ok: false, error: '音频内容为空，无法转码' });
      fs.writeFileSync(inPath, bytes);

      const bins = resolveBins();
      // 优先 libmp3lame；若该 ffmpeg 构建未启用，回退 AAC（.m4a），保证功能可用
      let mime = 'audio/mpeg';
      let ext = 'mp3';
      try {
        await runCommand(bins.ffmpeg, ['-y', '-i', inPath, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', outPath]);
      } catch (_) {
        outPath = path.join(os.tmpdir(), `hmdao-audioout-${ticket}.m4a`);
        mime = 'audio/mp4';
        ext = 'm4a';
        await runCommand(bins.ffmpeg, ['-y', '-i', inPath, '-vn', '-c:a', 'aac', '-b:a', '128k', outPath]);
      }
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
        throw new Error('ffmpeg 未产出有效音频文件');
      }

      // 自检：确认产物真有音频流（与 DASH 合并同样的"别把坏文件当成功交付"原则）
      try {
        const { stdout } = await runCommand(bins.ffprobe, [
          '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', outPath,
        ]);
        const types = String(stdout || '').split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
        if (types.length && !types.includes('audio')) throw new Error('转码产物无音频流');
      } catch (e) {
        // ffprobe 不可用时不阻断（本机可能只装了 ffmpeg）
        if (/无音频流/.test(String((e && e.message) || ''))) throw e;
      }

      const out = fs.readFileSync(outPath);
      return send(res, 200, {
        ok: true,
        b64: out.toString('base64'),
        mime,
        ext,
        size: out.length,
        engine: 'ffmpeg',
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      return send(res, 500, { ok: false, error: '转码失败：' + msg.slice(0, 240) });
    } finally {
      try { fs.rmSync(inPath, { force: true }); } catch (_) {}
      try { fs.rmSync(outPath, { force: true }); } catch (_) {}
      try {
        const alt = path.join(os.tmpdir(), `hmdao-audioout-${ticket}.m4a`);
        if (alt !== outPath) fs.rmSync(alt, { force: true });
      } catch (_) {}
    }
  });
}

export default registerAudioTranscodeRoutes;
