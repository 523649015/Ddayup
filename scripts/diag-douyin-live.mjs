// 真实 LIVE 诊断：针对用户提供的抖音精选页链接，提取 RENDER_DATA 中每个 aweme 的
// 视频/音频直链结构，定位「部分视频只有声音没有画面」的根因。
// 用法：node scripts/diag-douyin-live.mjs
import { chromium } from 'playwright';

const TARGET = process.env.DY_URL || 'https://www.douyin.com/jingxuan?modal_id=7666393797198204212';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  // 允许加载抖音真实页面（登录态为空，但精选页匿名可访问部分内容）
});
const page = await ctx.newPage();

// 收集真实 CDN 视频请求（network 层）
const cdnReq = new Map();
page.on('request', (req) => {
  const u = req.url();
  // 抖音真实视频/音频流：v26-web.douyinvod.com / sf*-cdn-tos.douyinstatic.com / ies-music
  if (/douyinvod|douyinstatic\.com|ies-music|v\d+-web/.test(u)) {
    const key = u.replace(/\?.*$/, '').slice(0, 120);
    cdnReq.set(key, { url: u.slice(0, 140), host: (() => { try { return new URL(u).hostname; } catch (_) { return ''; } })() });
  }
});

console.log('===== GOTO ' + TARGET + ' =====');
try {
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45000 });
} catch (e) {
  console.log('GOTO ERROR: ' + (e && e.message));
}
// 等待页面 JS 渲染 + 滚动触发懒加载
for (let k = 0; k < 4; k++) {
  await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
  await page.waitForTimeout(1500);
}
await page.waitForTimeout(4000);

// 在页面里提取 RENDER_DATA 中每个 aweme 的视频结构（这是 scan.js 实际读取的同源数据）
const diag = await page.evaluate(() => {
  const out = {
    title: document.title,
    hasRenderData: false,
    awemes: [],
    videosInDom: [],
  };
  // 页面内 <video> 标签（DOM 实测）
  document.querySelectorAll('video').forEach((v, i) => {
    out.videosInDom.push({
      i,
      src: (v.currentSrc || v.src || '').slice(0, 120),
      hasVideoTrack: v.videoWidth > 0,
      w: v.videoWidth, h: v.videoHeight,
      readyState: v.readyState,
    });
  });
  const els = document.querySelectorAll('script#RENDER_DATA, script[id="RENDER_DATA"]');
  if (!els.length) { out.hasRenderData = false; return out; }
  out.hasRenderData = true;
  let data;
  try { data = JSON.parse(decodeURIComponent(els[0].textContent)); } catch (_) { return out; }

  // 递归收集 aweme（与 scan.js tryDouyinWeixin.grab 同构）
  const awemes = [];
  // 同时收集「纯音频」music 对象（只有 music 没有 video.play_addr，会被误当视频资产）
  const musics = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    const hasV = o.video && (o.video.play_addr || o.video.download_addr);
    if (o.aweme_id || hasV) awemes.push(o);
    // 纯音频识别：有 music 对象且含 play_url，且自身无 video.play_addr
    if (o.music && o.music.play_url && o.music.play_url.url_list && o.music.play_url.url_list.length && !hasV) {
      musics.push(o.music);
    }
    for (const k in o) { try { walk(o[k]); } catch (_) {} }
  };
  walk(data);
  const byId = new Map();
  awemes.forEach((a) => { const id = String(a.aweme_id || ''); if (id && !byId.has(id)) byId.set(id, a); });

  // 定位当前 modal_id 目标
  let targetId = '';
  try {
    const uu = new URL(location.href);
    targetId = uu.searchParams.get('modal_id') || uu.searchParams.get('aweme_id') || '';
  } catch (_) {}

  byId.forEach((a, id) => {
    const v = a.video;
    if (!v) { out.awemes.push({ awemeId: id, hasVideoObj: false }); return; }
    const analyze = (label, addr) => {
      if (!addr) return null;
      const urls = (addr.url_list || []).map((x) => x.replace(/\\\//g, '/'));
      return {
        label,
        hasUrl: !!(urls && urls.length),
        url0: urls.length ? urls[0].slice(0, 110) : '',
        host: urls.length ? (() => { try { return new URL(urls[0]).hostname; } catch (_) { return ''; } })() : '',
        width: addr.width || 0, height: addr.height || 0,
        // 抖音 play_addr 关键点：data_size / bit_rate 是否存在
        bitRate: addr.bit_rate || 0,
        isH265: !!addr.is_h265,
      };
    };
    const play = analyze('play_addr', v.play_addr);
    const dl = analyze('download_addr', v.download_addr);
    const h265 = analyze('play_addr_h265', v.play_addr_h265);
    // 关键判断：是否"只有音频轨"（play_addr 缺失但 download_addr 存在，或 play_addr 的 url_list 为空）
    const videoTracks = [play, dl, h265].filter((x) => x && x.hasUrl);
    const cover = (v.cover && v.cover.url_list && v.cover.url_list[0]) || '';
    out.awemes.push({
      awemeId: id,
      isTarget: id === String(targetId),
      desc: (a.desc || '').slice(0, 40),
      hasVideoObj: true,
      hasPlayAddr: !!(v.play_addr && v.play_addr.url_list && v.play_addr.url_list.length),
      hasDownloadAddr: !!(v.download_addr && v.download_addr.url_list && v.download_addr.url_list.length),
      bitRateCount: (v.bit_rate || []).length,
      videoTracks,
      cover: cover.slice(0, 80),
      duration: v.duration || a.duration,
    });
  });
  out.targetId = targetId;
  out.awemeCount = byId.size;
  out.musicCount = musics.length;
  out.musics = musics.slice(0, 8).map((m) => ({
    id: m.id || '',
    title: (m.title || m.music_name || '').slice(0, 30),
    playUrl: (m.play_url && m.play_url.url_list && m.play_url.url_list[0] || '').slice(0, 100),
    isAudioOnly: true,
  }));
  return out;
});

console.log('title:', diag.title);
console.log('hasRenderData:', diag.hasRenderData);
console.log('targetId(modal_id):', diag.targetId);
console.log('awemeCount:', diag.awemeCount);
console.log('musicCount(纯音频):', diag.musicCount);
console.log('DOM <video> 数:', diag.videosInDom.length);
diag.videosInDom.forEach((v) => console.log('  video[' + v.i + '] w/h=' + v.w + 'x' + v.h + ' hasTrack=' + v.hasVideoTrack + ' readyState=' + v.readyState + ' src=' + v.src));
console.log('--- awemes（含目标标记）---');
diag.awemes.forEach((a) => {
  const flag = a.isTarget ? '<<<TARGET' : '';
  console.log(`  [${a.awemeId}]${flag} hasPlay=${a.hasPlayAddr} hasDl=${a.hasDownloadAddr} bitRate=${a.bitRateCount} desc="${a.desc}"`);
  (a.videoTracks || []).forEach((t) => {
    console.log(`      ${t.label}: host=${t.host} w=${t.width} h=${t.height} h265=${t.isH265} url=${t.url0}`);
  });
});
console.log('--- 纯音频 music（只有声音无画面，误当视频资产的根源）---');
(diag.musics || []).forEach((m) => console.log('  music id=' + m.id + ' title="' + m.title + '" playUrl=' + m.playUrl));

console.log('--- 真实 CDN 请求（network 层，去重）---');
const uniq = [...new Set([...cdnReq.values()].map((c) => c.host))];
console.log('CDN 主机:', JSON.stringify(uniq));
[...cdnReq.values()].slice(0, 20).forEach((c) => console.log('  ' + c.host + '  ' + c.url));

await browser.close();
console.log('\nDIAG DOUYIN LIVE DONE');
