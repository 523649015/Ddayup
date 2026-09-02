/**
 * B站 WBI 签名 + 多分辨率枚举 测试（纯 Node，不依赖浏览器 / 不依赖后端）
 *
 * 验证 extension/background.js 里 HMDAO_BILI_LIST_QUALITIES 的核心逻辑：
 *   1) md5Hash（WBI w_rid 签名）实现是否正确（此前写错 → playurl 返回 -403）
 *   2) playurl?fnval=16 能否返回 dash.video[]（所有分辨率轨）
 *   3) playurl?fnval=1  能否返回 durl（整段含音画 MP4）
 *   4) durl / DASH 直链是否可下载（HEAD 看 status + content-length）
 *
 * 关键：WBI 的 wbi_img 密钥是【公开】的（nav API 无需登录即返回），
 *       故纯 Node 端即可完整验证签名逻辑，不需要浏览器/扩展。
 *
 * 用法：node test-bili-wbi.js [BV号|URL]
 */
const BVID = (process.argv[2] || 'BV1GJ411x7h7').match(/BV\w+/)?.[0] || 'BV1GJ411x7h7';

// ===== 与 background.js 完全一致的 md5Hash（已验证实现）=====
function md5Hash(str) {
  function sa(x, y) { const l = (x & 0xffff) + (y & 0xffff); const m = (x >> 16) + (y >> 16) + (l >> 16); return (m << 16) | (l & 0xffff); }
  function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
  function cmn(q, a, b, x, s, t) { return sa(rol(sa(sa(a, q), sa(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  function core(x, len) {
    x[len >> 5] |= 0x80 << (len % 32);
    x[(((len + 64) >>> 9) << 4) + 14] = len;
    let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (let i = 0; i < x.length; i += 16) {
      const oa = a, ob = b, oc = c, od = d;
      a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586);
      c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
      a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
      c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
      a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
      c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
      a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101);
      c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
      a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
      c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
      a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083);
      c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
      a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
      c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
      a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784);
      c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
      a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
      c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
      a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
      c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
      a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
      c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
      a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835);
      c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
      a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
      c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
      a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
      c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
      a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744);
      c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
      a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
      c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
      a = sa(a, oa); b = sa(b, ob); c = sa(c, oc); d = sa(d, od);
    }
    return [a, b, c, d];
  }
  function bin2rstr(i) { let o = ''; for (let k = 0; k < i.length * 32; k += 8) o += String.fromCharCode((i[k >> 5] >>> (k % 32)) & 0xff); return o; }
  function rstr2bin(i) { const o = []; for (let k = 0; k < (i.length >> 2) + 1; k++) o[k] = 0; for (let k = 0; k < i.length * 8; k += 8) o[k >> 5] |= (i.charCodeAt(k / 8) & 0xff) << (k % 32); return o; }
  function hex(i) { const t = '0123456789abcdef'; let o = ''; for (let k = 0; k < i.length; k++) { const x = i.charCodeAt(k); o += t.charAt((x >>> 4) & 0x0f) + t.charAt(x & 0x0f); } return o; }
  const s = unescape(encodeURIComponent(str));
  return hex(bin2rstr(core(rstr2bin(s), s.length * 8)));
}

const WBI_MIX_TABLE = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];
const getMixinKey = (imgKey, subKey) => { const s2 = imgKey + subKey; let r = ''; for (let i = 0; i < 32; i++) r += s2[WBI_MIX_TABLE[i]]; return r; };

function encWbi(params, wbi) {
  const mixinKey = getMixinKey(wbi.wbiImgKey, wbi.wbiSubKey);
  const wts = Math.round(Date.now() / 1000);
  const o = Object.assign({ wts }, params);
  const query = Object.keys(o).sort()
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(o[k]).replace(/[!'()*]/g, '')))
    .join('&');
  return query + '&w_rid=' + md5Hash(query + mixinKey);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';
async function biliGet(apiPath, params, wbi) {
  const q = wbi ? encWbi(params, wbi) : Object.keys(params).map((k) => k + '=' + encodeURIComponent(params[k])).join('&');
  const r = await fetch('https://api.bilibili.com' + apiPath + '?' + q, {
    headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' },
  });
  return r.json();
}

(async () => {
  console.log('================ B站 WBI / 分辨率 测试（纯 Node，无后端）================');
  console.log('测试视频:', BVID, '\n');

  // Step 1: 拿 WBI 密钥（nav API，公开）
  const nav = await biliGet('/x/web-interface/nav', {});
  const img = nav && nav.data && nav.data.wbi_img;
  if (!img || !img.img_url || !img.sub_url) {
    console.log('❌ 无法获取 WBI 密钥（nav 返回异常）:', nav && nav.code, nav && nav.message);
    return;
  }
  const wbi = {
    wbiImgKey: img.img_url.slice(img.img_url.lastIndexOf('/') + 1).split('.')[0],
    wbiSubKey: img.sub_url.slice(img.sub_url.lastIndexOf('/') + 1).split('.')[0],
  };
  console.log('✅ Step1 WBI 密钥获取成功');
  console.log('   imgKey:', wbi.wbiImgKey.slice(0, 16) + '...');

  // Step 2: bvid → aid/cid
  const view = await biliGet('/x/web-interface/view', { bvid: BVID }, wbi);
  if (!view || view.code !== 0 || !view.data) {
    console.log('❌ Step2 view 失败:', view && view.code, view && view.message);
    return;
  }
  const { aid, cid, title } = view.data;
  console.log(`✅ Step2 aid/cid 获取成功: aid=${aid} cid=${cid}`);
  console.log('   标题:', (title || '').slice(0, 50));

  // Step 3: playurl fnval=16（DASH，一次拿所有分辨率轨）
  const p = await biliGet('/x/player/playurl', {
    avid: aid, cid, qn: 120, fnval: 16, fnver: 0, fourk: 1, platform: 'html5', high_quality: 1,
  }, wbi);
  if (!p || p.code !== 0) {
    console.log('❌ Step3 WBI 签名失败！playurl code =', p && p.code, '| msg =', p && p.message);
    console.log('   → 若 code=-403 说明 w_rid 签名错误（md5Hash 实现有问题）');
    return;
  }
  console.log('✅ Step3 WBI 签名正确（playurl fnval=16 返回 code=0）');

  const d = p.data;
  const qName = {};
  (d.support_formats || []).forEach((f) => { if (f && f.quality != null) qName[f.quality] = f.new_description || f.display_desc || ''; });
  const vids = (d.dash && d.dash.video) || [];
  const audios = (d.dash && d.dash.audio) || [];
  const formats = vids
    .filter((v) => v && (v.baseUrl || (v.backup_urls && v.backup_urls[0])))
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  const audioUrl = audios.length ? (audios[0].baseUrl || (audios[0].backup_urls && audios[0].backup_urls[0]) || '') : '';

  console.log(`\n✅ Step4 枚举到 ${formats.length} 档 DASH 分辨率:`);
  formats.forEach((v) => {
    console.log(`   qn=${String(v.id).padEnd(4)} ${String(qName[v.id] || v.height + 'P').padEnd(14)} ${v.width}x${v.height}  ${v.codecs}`);
  });
  console.log('   accept_quality:', JSON.stringify(d.accept_quality || []));
  console.log('   音频轨:', audioUrl ? '✅ 已获取' : '❌ 无');

  // Step 4: playurl fnval=1（整段含音画 durl）
  const p1 = await biliGet('/x/player/playurl', {
    avid: aid, cid, qn: 80, fnval: 1, fnver: 0, fourk: 1, platform: 'html5', high_quality: 1,
  }, wbi);
  let durl = '';
  if (p1 && p1.code === 0 && p1.data && p1.data.durl && p1.data.durl.length) {
    durl = p1.data.durl[0].url || (p1.data.durl[0].backup_urls && p1.data.durl[0].backup_urls[0]) || '';
    console.log(`\n✅ Step5 durl(整段含音画) 获取成功: quality=${p1.data.quality} size=${Math.round((p1.data.durl[0].size || 0) / 1048576)}MB`);
  } else {
    console.log('\n⚠ Step5 durl 未获取（未登录时常见）: code =', p1 && p1.code, p1 && p1.message);
  }

  // Step 5: 验证直链可下载（HEAD）
  console.log('\n✅ Step6 直链可下载性验证（HEAD）:');
  const probe = async (u, label) => {
    if (!u) { console.log(`   ${label}: (无 URL，跳过)`); return; }
    try {
      const h = await fetch(u, {
        method: 'HEAD',
        headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' },
      });
      const cl = parseInt(h.headers.get('content-length') || '0', 10);
      console.log(`   ${label}: ${h.ok ? '✅' : '❌'} status=${h.status} size=${Math.round(cl / 1048576)}MB`);
    } catch (e) { console.log(`   ${label}: ❌ ${e.message}`); }
  };
  await probe(durl, 'durl(整段含音画)');
  if (formats.length) await probe(formats[0].baseUrl || (formats[0].backup_urls && formats[0].backup_urls[0]), 'DASH最高清视频轨');
  await probe(audioUrl, 'DASH音频轨');

  console.log('\n================ 结论 ================');
  console.log('WBI 签名（md5Hash）:', '✅ 正确（code=0 即证明）');
  console.log('多分辨率枚举:', formats.length ? `✅ 可行（${formats.length} 档）` : '❌ 失败');
  console.log('自定义分辨率下载:', formats.length ? '✅ 可行（选任一 qn 的 baseUrl 下载）' : '❌ 不可行');
  console.log('整段含音画(durl):', durl ? '✅ 可行（推荐，单文件直下）' : '⚠ 未登录时可能拿不到');
  console.log('======================================\n');
})().catch((e) => { console.error('测试异常:', e.message); process.exit(1); });
