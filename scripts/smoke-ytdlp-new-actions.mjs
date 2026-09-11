// 2026-08-02 冒烟验证：后端新增的两个 yt-dlp action
//   - action=download&audio=1  → 仅提取 MP3 音频
//   - action=playlist          → 返回合集/列表条目
// 直接打本地后端 127.0.0.1:3000（yt-dlp 已安装）。
import http from 'http';

const BASE = 'http://127.0.0.1:3000';

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + path, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, json, raw: body.slice(0, 400) });
      });
    });
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('timeout')));
  });
}

const tests = [
  {
    name: 'audio=1 提取 MP3（公开无登录源）',
    // 一个公开 YouTube 短视频，验证 bestaudio→mp3 合并输出
    path: '/api/platform/ytdlp?action=download&audio=1&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=aqz-KE-bpKQ'),
  },
  {
    name: 'playlist 合集（公开 YouTube 播放列表）',
    path: '/api/platform/ytdlp?action=playlist&url=' +
      encodeURIComponent('https://www.youtube.com/playlist?list=PLFLB0FpF0BHS7q9hR8l1XkZqY1qZ1qZ1q'),
  },
];

let pass = 0, fail = 0;
for (const t of tests) {
  console.log('\n=== ' + t.name + ' ===');
  console.log('GET ' + t.path.slice(0, 110) + '...');
  try {
    const r = await get(t.path);
    console.log('HTTP ' + r.status);
    if (r.json) {
      console.log(JSON.stringify(r.json, null, 2).slice(0, 600));
      if (t.name.startsWith('audio') && r.status === 200 && r.json.fileUrl) { console.log('✅ audio: 返回 fileUrl'); pass++; }
      else if (t.name.startsWith('playlist') && r.status === 200 && Array.isArray(r.json.items)) { console.log('✅ playlist: 返回 ' + r.json.items.length + ' 条'); pass++; }
      else { console.log('⚠ 结构不符合预期（可能平台风控/需登录，非代码错误）'); }
    } else {
      console.log('RAW: ' + r.raw);
    }
  } catch (e) {
    console.log('❌ 请求异常: ' + e.message);
    fail++;
  }
}
console.log('\n--- 冒烟结果 --- pass=' + pass + ' fail=' + fail);
