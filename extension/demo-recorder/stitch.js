// 拼接两个窗口视频为最终演示视频（精确裁剪 + 紧贴布局）
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const [,, leftMp4, rightMp4, outMp4] = process.argv;
if (!leftMp4 || !rightMp4 || !outMp4) {
  console.log('用法: node stitch.js <main.webm> <side.webm> <out.mp4>');
  process.exit(1);
}

const MAIN_W = 1100, SIDE_W = 480, WIN_H = 720;
const SIDE_X = Math.floor((1280 - SIDE_W) / 2);  // 侧栏内容居中显示，从 (1280-480)/2 取

const args = [
  '-y',
  '-i', leftMp4,
  '-i', rightMp4,
  '-filter_complex',
    `[0:v]crop=${MAIN_W}:${WIN_H}:0:0,scale=${MAIN_W}:${WIN_H}:flags=lanczos[lf];` +
    `[1:v]crop=${SIDE_W}:${WIN_H}:${SIDE_X}:0,scale=${SIDE_W}:${WIN_H}:flags=lanczos[rf];` +
    `[lf][rf]hstack=inputs=2[v]`,
  '-map', '[v]',
  '-c:v', 'libopenh264',
  '-b:v', '2500k',
  '-pix_fmt', 'yuv420p',
  '-r', '25',
  '-shortest',
  outMp4,
];

console.log('ffmpeg 参数:', args.join(' '));
const ff = spawn('ffmpeg', args, { stdio: 'inherit' });
ff.on('exit', (c) => {
  if (c === 0) {
    const size = fs.statSync(outMp4).size / 1024 / 1024;
    console.log(`\n✅ 完成: ${outMp4}  (${size.toFixed(2)} MB)`);
  } else {
    console.log(`\n❌ ffmpeg 失败: exit ${c}`);
  }
});
ff.on('error', (e) => console.error('ffmpeg 错误:', e.message));
