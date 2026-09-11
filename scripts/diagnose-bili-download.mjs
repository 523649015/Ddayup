// 诊断：针对用户实测失败的视频 BV1WZKp6WEKH，复刻扩展代码路径，定位 403 根因
//  1. 抓页面 __INITIAL_STATE__ + wbi
//  2. playurl fnval=1（整段 MP4/durl）看是否有 durl
//  3. playurl fnval=16（DASH）看视频/音频轨
//  4. durl 无头下载（模拟 chrome.downloads）
//  5. dash m4s 无头下载（复现 403）+ 带 Referer 下载（证明需 Referer）
import { createHash } from 'node:crypto';

const BVID = process.argv[2] || 'BV1WZKp6WEKH';
const PAGE = `https://www.bilibili.com/video/${BVID}/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const WBI_MIX_TABLE = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13];
function getMixinKey(imgKey, subKey) { const s = imgKey + subKey; let r = ''; for (let i = 0; i < 32; i++) r += s[WBI_MIX_TABLE[i]]; return r; }
function md5Hash(str) { return createHash('md5').update(str, 'utf8').digest('hex'); }
function wbiSign(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey, subKey);
  const wts = Math.floor(Date.now() / 1000);
  const merged = Object.assign({}, params, { wts });
  const query = Object.keys(merged).sort().map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(merged[k])).join('&');
  const w_rid = md5Hash(query + mixinKey);
  return Object.assign({ wts, w_rid }, params);
}
async function biliWbiCall(apiPath, params, wbi) {
  const signed = wbiSign(params, wbi.wbiImgKey, wbi.wbiSubKey);
  const query = Object.keys(signed).sort().map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(signed[k])).join('&');
  const url = 'https://api.bilibili.com' + apiPath + '?' + query;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: PAGE } });
  return await r.json();
}

async function headNoRef(u) {
  try { const r = await fetch(u, { headers: { Range: 'bytes=0-1', 'User-Agent': UA } }); return r.status; } catch (e) { return 'ERR ' + e.message; }
}
async function headWithRef(u) {
  try { const r = await fetch(u, { headers: { Range: 'bytes=0-1', 'User-Agent': UA, Referer: PAGE, Origin: 'https://www.bilibili.com' } }); return r.status; } catch (e) { return 'ERR ' + e.message; }
}

async function main() {
  console.log('===== 诊断 B站下载 =====\n目标:', PAGE, '\n');

  const html = await (await fetch(PAGE, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } })).text();
  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?\});\s*\(function\(\)/s) || html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?\});/s);
  if (!m) { console.error('❌ 未找到 __INITIAL_STATE__'); process.exit(1); }
  const s0 = JSON.parse(m[1]);
  const wbi = (s0.videoData && s0.videoData.wbi) || s0.defaultWbiKey || (s0.loginInfo && s0.loginInfo.wbi) || {};
  const aid = s0.videoData && s0.videoData.aid;
  const cid = (s0.videoData && s0.videoData.cid) || (s0.videoData && s0.videoData.pages && s0.videoData.pages[0] && s0.videoData.pages[0].cid);
  console.log('title:', s0.videoData && s0.videoData.title);
  console.log('aid:', aid, '| cid:', cid, '| wbiImgKey:', (wbi.wbiImgKey || '缺失').slice(0, 12) + '…\n');
  if (!wbi.wbiImgKey) { console.error('❌ 无 wbi'); process.exit(1); }

  // --- fnval=1（整段 MP4/durl）---
  console.log('[A] playurl fnval=1（请求整段 MP4）');
  const p1 = await biliWbiCall('/x/player/playurl', { avid: aid, cid, qn: 80, fnval: 1, fnver: 0, fourk: 1, platform: 'html5', high_quality: 1 }, wbi);
  console.log('    code:', p1.code, '| message:', p1.message);
  if (p1.data) {
    console.log('    quality:', p1.data.quality, '| 支持清晰度:', JSON.stringify(p1.data.accept_quality));
    console.log('    有 durl:', !!(p1.data.durl && p1.data.durl.length), '| 有 dash:', !!p1.data.dash);
    if (p1.data.durl && p1.data.durl.length) {
      const u = p1.data.durl[0].url;
      console.log('    durl[0] size:', p1.data.durl[0].size, 'bytes');
      console.log('    durl 无头下载状态:', await headNoRef(u));
    }
  }

  // --- fnval=16（DASH）---
  console.log('\n[B] playurl fnval=16（DASH 分离轨）');
  const p16 = await biliWbiCall('/x/player/playurl', { avid: aid, cid, qn: 80, fnval: 16, fnver: 0, fourk: 1 }, wbi);
  console.log('    code:', p16.code, '| quality:', p16.data && p16.data.quality);
  if (p16.data && p16.data.dash) {
    const v = (p16.data.dash.video || []).sort((a, b) => (b.id || 0) - (a.id || 0))[0];
    const au = (p16.data.dash.audio || []).sort((a, b) => (b.id || 0) - (a.id || 0))[0];
    console.log('    视频轨 id:', v && v.id, '| 音频轨 id:', au && au.id);
    if (v) {
      console.log('    m4s 无头下载状态（复现用户 403）:', await headNoRef(v.baseUrl));
      console.log('    m4s 带 Referer 下载状态:', await headWithRef(v.baseUrl));
    }
  }
  console.log('\n===== 诊断结束 =====');
}
main().catch((e) => { console.error('异常:', e); process.exit(1); });
