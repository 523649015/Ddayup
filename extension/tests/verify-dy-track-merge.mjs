/**
 * 验证：抖音「按分辨率下载」的技术前提是否真实成立
 * ---------------------------------------------------------------------------
 * 要验证的三件事（缺一不可）：
 *   1) 后端 Node 进程能否【带 Referer】拉到 douyinvod 的【视频轨】字节
 *      （前端做不到：chrome.downloads 不能传 Referer，dNR 又会破坏签名）
 *   2) ffmpeg 能否把「视频轨 + 音频轨」合并成单文件
 *   3) 产物是否真的同时含 video 与 audio 流（用 ffprobe 客观判定）
 *
 * 输入：C:\Users\123\Downloads\hmdao_tracks.json（由侧栏控制台的导出脚本生成）
 * 用法：node extension/tests/verify-dy-track-merge.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const DOWNLOADS = process.env.HMDAO_DOWNLOADS || 'C:\\Users\\123\\Downloads';
const jsonPath = path.join(DOWNLOADS, 'hmdao_tracks.json');
const API = process.env.HMDAO_API || 'http://127.0.0.1:3000';
const FFPROBE = process.env.HMDAO_FFPROBE || 'C:\\FFMPEG\\bin\\ffprobe.exe';

function fail(msg) { console.error('\n❌ ' + msg); process.exit(1); }

if (!fs.existsSync(jsonPath)) fail('未找到 ' + jsonPath + '，请先在侧栏控制台运行导出脚本');

const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
console.log('=== 输入 ===');
console.log('awemeId   :', cfg.aid);
console.log('视频轨档位:', cfg.videoLabel);
console.log('videoUrl  :', String(cfg.videoUrl || '').slice(0, 90));
console.log('audioUrl  :', String(cfg.audioUrl || '').slice(0, 90));

if (!cfg.videoUrl) fail('JSON 里 videoUrl 为空，导出失败');
if (!cfg.audioUrl) fail('JSON 里 audioUrl 为空，音频轨没抓到');

console.log('\n=== 调用后端 /api/media/merge-dash（带 Referer 拉轨 + ffmpeg 合并）===');
const resp = await fetch(API + '/api/media/merge-dash', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    videoUrl: cfg.videoUrl,
    audioUrl: cfg.audioUrl,
    referer: 'https://www.douyin.com/',
  }),
});
const text = await resp.text();
let data = null;
try { data = JSON.parse(text); } catch (_) { fail('响应不是 JSON：' + String(text).slice(0, 400)); }
console.log('HTTP', resp.status, JSON.stringify(data, null, 1));

if (!data || !data.ok) fail('后端合并失败：' + (data && data.error) || String(text).slice(0, 300));

console.log('\n=== 取回合并且用 ffprobe 判定 ===');
const outPath = path.join(DOWNLOADS, 'hmdao_merged_test.mp4');
const r2 = await fetch(API + data.fileUrl);
if (!r2.ok) fail('下载合并产物失败 HTTP ' + r2.status);
const buf = Buffer.from(await r2.arrayBuffer());
fs.writeFileSync(outPath, buf);
console.log('产物:', outPath, buf.length, 'bytes');

const { stdout } = await execFileP(FFPROBE, [
  '-v', 'error',
  '-show_entries', 'stream=codec_type,codec_name,width,height',
  '-of', 'default=noprint_wrappers=1',
  outPath,
]);
console.log('--- ffprobe ---');
console.log(stdout.trim());

const hasVideo = /codec_type=video/.test(stdout);
const hasAudio = /codec_type=audio/.test(stdout);
const res = stdout.match(/width=(\d+)/);
console.log('\n=== 结论 ===');
console.log('含视频流:', hasVideo, ' 含音频流:', hasAudio, res ? ('分辨率 ' + res[1] + 'x' + (stdout.match(/height=(\d+)/) || [])[1]) : '');
if (hasVideo && hasAudio) {
  console.log('✅ 后端带 Referer 拉视频轨可行，ffmpeg 合并可行，产物含音画 —— 可按分辨率下载');
} else {
  console.log('❌ 产物不完整（video=' + hasVideo + ' audio=' + hasAudio + '）');
  process.exit(1);
}
