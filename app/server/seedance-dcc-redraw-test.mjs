// 一次性真实调用测试：算力聚合平台(Suanliai) seedance-v2 视频重绘
// 输入：资产库 dcc-recording-1784202307590.mp4(首帧) + juese.png(参考人物)
// 约束：仅提交一次生成 API 请求；强制 720p(平台不支持 1080p)。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const SUANLIAI_BASE = 'https://www.suanliai.top/v1';
const SUANLIAI_KEY = 'sk-tBjNmO9m2hfh13lJGKUkjR7SbDuIrrlCBtRM7vgWwUGvR2Rd';
const SEEDANCE_MODEL = 'seedance-2.0-720p'; // 平台仅提供 480p/720p，不支持 1080p

const VIDEO_PATH = 'f:\\练习\\ue5\\5.7\\cs\\Saved\\HMDaoUnrealCapture\\Recordings\\capture-rec-1784202274123\\recording.mp4';
const JUESE_PATH = 'F:\\Work\\HMDAODAO\\app\\.hmdao-data\\asset-library-files\\image\\ef16245f-247b-41b4-8b5b-0dbe2ab12e8d-juese.png';
const OUT_DIR = 'F:\\Work\\HMDAODAO\\app\\.hmdao-data\\seedance-test';

const log = (...a) => console.log('[seedance-test]', ...a);

function firstStr(v) {
  if (Array.isArray(v)) return firstStr(v[0]);
  if (v && typeof v === 'object') return firstStr(v.url) || firstStr(Object.values(v)[0]);
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

function tmpfilesDirectDownloadUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (u.hostname !== 'tmpfiles.org') return raw;
    if (u.pathname.startsWith('/dl/')) return raw;
    u.pathname = `/dl${u.pathname}`;
    return u.toString();
  } catch {
    return raw;
  }
}

function fileToDataUrl(filePath, mime = 'image/png') {
  const b64 = fs.readFileSync(filePath).toString('base64');
  return `data:${mime};base64,${b64}`;
}

function extractFrame(videoPath, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-ss', '0', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', outPath], { stdio: 'ignore' });
}

function extractVideoUrl(task) {
  // 兼容多种返回结构
  return (
    firstStr(task?.video_url) ||
    firstStr(task?.video?.url) ||
    firstStr(task?.output?.video_url) ||
    firstStr(task?.outputs?.[0]) ||
    firstStr(task?.result?.video_url) ||
    firstStr(task?.data?.video_url)
  );
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1) 抽取首帧（作为 first_frame 条件图）
  log('抽取源视频首帧...');
  const framePath = path.join(OUT_DIR, 'first_frame.png');
  extractFrame(VIDEO_PATH, framePath);
  log('首帧已生成:', framePath);

  // 2) 条件图以 base64 内联（suanliai 接受 data URL，无需外部图床）
  log('将条件图编码为 base64 内联...');
  const firstFrameUrl = fileToDataUrl(framePath);
  const refUrl = fileToDataUrl(JUESE_PATH);
  log('first_frame bytes=%d, reference bytes=%d', framePath.length, JUESE_PATH.length);

  // 3) 构造 seedance-v2 负载（强制 720p）
  const prompt = [
    'Replace the yellow-colored dancing character in the source frame with the provided reference person (juese.png), preserving the original dance pose and motion.',
    'Replace the gray-colored character with a visually matching male character.',
    'Replace the original background with an early-morning seaside beach (soft sunlight, wet sand, light ocean waves).',
    'Keep all other cubes and polygon objects in their exact positions and shapes, unchanged.',
    'Generate realistic physical dynamics for the dancing motion.',
  ].join(' ');

  const payload = {
    model: SEEDANCE_MODEL,
    prompt,
    duration: 5,
    aspect_ratio: '16:9',
    generate_audio: false,
    image_with_roles: [
      { role: 'first_frame', url: firstFrameUrl },
      { role: 'reference_image', url: refUrl },
    ],
  };
  log('提交生成请求(model=%s, 720p)...', SEEDANCE_MODEL);

  // 4) 仅一次生成 API 请求
  const submitRes = await fetch(`${SUANLIAI_BASE}/video/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SUANLIAI_KEY}` },
    body: JSON.stringify(payload),
  });
  const submitText = await submitRes.text();
  let submitData = null;
  try { submitData = JSON.parse(submitText); } catch { submitData = { raw: submitText }; }
  log('提交 HTTP %s', submitRes.status);
  log('提交响应: %s', submitText.slice(0, 2000));

  if (!submitRes.ok) {
    fs.writeFileSync(path.join(OUT_DIR, 'submit-error.json'), JSON.stringify({ status: submitRes.status, body: submitData }, null, 2));
    log('生成请求失败，终止。');
    return;
  }

  const taskId = firstStr(submitData?.task_id) || firstStr(submitData?.task?.id) || firstStr(submitData?.id) || firstStr(submitData?.data?.task_id);
  log('task_id=%s', taskId || '(未返回，可能同步返回视频)');

  // 5) 轮询状态（GET，非生成请求）
  let finalUrl = '';
  if (taskId) {
    const statusCandidates = [
      `${SUANLIAI_BASE}/tasks/${taskId}`,
      `${SUANLIAI_BASE}/video/generations/${taskId}`,
      `${SUANLIAI_BASE}/video/generations/task/${taskId}`,
    ];
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      let done = false;
      for (const url of statusCandidates) {
        try {
          const r = await fetch(url, { headers: { Authorization: `Bearer ${SUANLIAI_KEY}` } });
          const t = await r.text();
          let d = null;
          try { d = JSON.parse(t); } catch { d = { raw: t }; }
          const status = String(d?.status || d?.task_status || d?.state || '').toLowerCase();
          log('状态轮询 %s -> %s', url.split('/').slice(-2).join('/'), status || t.slice(0, 120));
          const vid = extractVideoUrl(d);
          if (vid) { finalUrl = vid; done = true; break; }
          if (['success', 'succeeded', 'completed', 'done', 'finished'].includes(status)) { finalUrl = extractVideoUrl(d); done = true; break; }
          if (['failed', 'error', 'cancelled'].includes(status)) { throw new Error(`任务失败: ${t}`); }
        } catch (e) {
          if (String(e.message).startsWith('任务失败')) throw e;
        }
      }
      if (finalUrl) break;
      await new Promise((r) => setTimeout(r, 15000));
    }
  } else {
    finalUrl = extractVideoUrl(submitData) || firstStr(submitData?.video_url);
  }

  if (finalUrl) {
    log('获得视频 URL: %s', finalUrl);
    const vres = await fetch(finalUrl);
    const buf = Buffer.from(await vres.arrayBuffer());
    const outPath = path.join(OUT_DIR, 'seedance-output.mp4');
    fs.writeFileSync(outPath, buf);
    log('视频已保存: %s (%d bytes)', outPath, buf.length);
    fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify({ ok: true, taskId, videoUrl: finalUrl, localPath: outPath, model: SEEDANCE_MODEL }, null, 2));
  } else {
    fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify({ ok: false, taskId, submitData }, null, 2));
    log('未获取到视频 URL。');
  }
}

main().catch((e) => {
  console.error('[seedance-test] 错误:', e);
  process.exit(1);
});
