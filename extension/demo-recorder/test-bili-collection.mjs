// 确定性验证：把整个 background.js 连同桩环境加载，取出真实的 extractFreshVideoUrl（B站分支），
// 喂入从 B站真实 API 抓到的数据结构，断言合集/分P 扫描与按 ?p= 取直链的正确性。
// 不依赖真实网络（fetch 全部 stub），因此可重复、稳定。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const bgPath = path.join(ROOT, 'background.js');
const src = fs.readFileSync(bgPath, 'utf8');

// ---- 1) 真实数据结构（来自 B站 view API，BV15z4C6SEHT 真实响应）----
const api = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo-recorder', 'bili_fixture.json'), 'utf8')).data;
// ★2026-09-11 范围隔离验证：故意注入「相关视频」(其他合集/其他平台推荐)，断言它们绝不进入批量卡。
const RELATED_BVIDS = ['BVREL111aaaa', 'BVREL222bbbb', 'BVREL333cccc'];
const fixtureState = {
  videoData: {
    aid: api.aid,
    bvid: api.bvid,
    cid: api.pages[0].cid,
    pic: api.pic,
    pages: api.pages, // 9 个分P：{cid,page,part}
    wbi: { wbiImgKey: 'imgkey', wbiSubKey: 'subkey' },
  },
  ugcSeason: api.ugc_season, // 合集：sections[].episodes[]，每集 ep.page 是对象 {cid,page,part}
  // 相关视频：单视频页底部推荐（旧逻辑会误当成「当前页所有视频」塞进批量卡 → 其他合集污染）
  relatedVideos: RELATED_BVIDS.map((bv, i) => ({ bvid: bv, title: '推荐视频' + (i + 1), arc: { bvid: bv, title: '推荐视频' + (i + 1), pic: '' } })),
};

// ---- 2) 桩：chrome（全代理 no-op）、fetch（按 URL 返回可控 JSON）----
const callLog = [];
const chromeStub = new Proxy(function () {}, {
  get() { return chromeStub; },
  apply() { return undefined; },
  construct() { return chromeStub; },
});
globalThis.fetch = async (url) => {
  const u = String(url);
  callLog.push(u);
  const json = () => {
    if (u.includes('/x/web-interface/nav')) {
      return Promise.resolve({ code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/wbi-img/imgkey.png', sub_url: 'https://i0.hdslb.com/wbi-img/subkey.png' } } });
    }
    if (u.includes('/x/web-interface/view')) {
      const m = u.match(/bvid=(BV\w+)/);
      const bvid = m ? m[1] : '';
      if (bvid === api.bvid) {
        return Promise.resolve({ code: 0, data: { aid: api.aid, cid: api.pages[0].cid, pages: api.pages } });
      }
      // 合集里另一个视频：单分P、独立 cid
      return Promise.resolve({ code: 0, data: { aid: 999, cid: 41394119999, pages: [{ cid: 41394119999, page: 1 }] } });
    }
    if (u.includes('/x/player/playurl')) {
      const m = u.match(/cid=(\d+)/);
      const cid = m ? m[1] : '0';
      // 把选中的 cid 编码进返回 URL，便于断言"选的是第几集"
      return Promise.resolve({ code: 0, data: { durl: [{ url: 'https://fake-cdn.bilibili.com/play?cid=' + cid + '&qn=80.mp4' }] } });
    }
    return Promise.resolve({ code: -1 });
  };
  return Promise.resolve({ json });
};

// ---- 3) 取出真实函数 ----
globalThis.window = { __INITIAL_STATE__: fixtureState, __hmdao_batchMode: true };
globalThis.location = { hostname: 'www.bilibili.com', href: 'https://www.bilibili.com/video/BV15z4C6SEHT/?p=2' };

let extractFreshVideoUrl;
try {
  // eslint-disable-next-line no-new-func
  const factory = new Function('chrome', 'window', 'location', 'fetch', src + '\n; return extractFreshVideoUrl;');
  extractFreshVideoUrl = factory(chromeStub, globalThis.window, globalThis.location, globalThis.fetch);
} catch (e) {
  console.error('加载 background.js 失败:', e.message);
  process.exit(2);
}
if (typeof extractFreshVideoUrl !== 'function') {
  console.error('未能取出 extractFreshVideoUrl');
  process.exit(2);
}

// ---- 4) 断言工具 ----
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

(async () => {
  // ===== 测试 1：批量扫描（hintUrl 为空）=====
  console.log('\n=== 测试1：批量扫描合集 + 分P ===');
  const r1 = await extractFreshVideoUrl('', []);
  check('返回 __biliMulti', r1 && r1.__biliMulti === true);
  const items = (r1 && r1.items) || [];
  check('卡片数 = 10（9 分P + 合集另一视频 BV1NCgVzoEG9）', items.length === 10, '实际=' + items.length);
  const urls = items.map((it) => it.url);
  const uniqUrls = new Set(urls);
  check('所有 URL 唯一（无重复卡）', uniqUrls.size === items.length, 'unique=' + uniqUrls.size);
  check('无 URL 含 /null', urls.every((u) => !/\/null/.test(u)), urls.find((u) => /\/null/.test(u)) || '');
  check('无 URL 含字面量 null', urls.every((u) => !/null/.test(u)));
  const p2 = items.find((it) => it.url.endsWith('?p=2'));
  check('存在 ?p=2 卡且 URL 正确', !!p2 && p2.url === 'https://www.bilibili.com/video/BV15z4C6SEHT?p=2', p2 && p2.url);
  const p9 = items.find((it) => it.url.endsWith('?p=9'));
  check('存在 ?p=9 卡', !!p9, p9 && p9.url);
  const p1 = items.find((it) => it.url === 'https://www.bilibili.com/video/BV15z4C6SEHT');
  check('分P1 卡无 ?p= 后缀', !!p1, p1 && p1.url);
  const titles = items.map((it) => it.title);
  const uniqTitles = new Set(titles);
  check('标题互不重复', uniqTitles.size === titles.length, 'unique=' + uniqTitles.size);
  check('分P2 标题带 "01 定义问题"', titles.some((t) => /01 定义问题/.test(t)), titles.slice(0, 3).join(' | '));
  const other = items.find((it) => it.url.includes('BV1NCgVzoEG9'));
  check('合集另一视频 BV1NCgVzoEG9 单独成卡', !!other, other && other.url);
  check('另一视频标题为合集 episode 标题', other && /完整合集/.test(other.title), other && other.title);
  // ★2026-09-11 范围隔离：所有卡必须属于「同一合集」，且绝不含相关视频(其他合集/平台推荐)
  const wantColl = 'bili-season:' + (api.ugc_season && (api.ugc_season.id || api.ugc_season.season_id));
  check('所有卡 collectionId 一致（同一合集范围隔离标记）', items.every((it) => it.collectionId === wantColl), 'coll=' + wantColl);
  check('未混入 relatedVideos（其他合集/平台推荐）', !items.some((it) => RELATED_BVIDS.some((bv) => it.url.includes(bv))), items.map((i) => i.url).filter((u) => RELATED_BVIDS.some((bv) => u.includes(bv))).join(','));

  // ===== 测试 2：点第 2 集播放（hintUrl 带 ?p=2），WBI 应选 pages[1].cid =====
  console.log('\n=== 测试2：WBI 按 ?p=2 选对第2集 cid ===');
  const wantCid2 = api.pages[1].cid;
  const wantCid1 = api.pages[0].cid;
  const r2 = await extractFreshVideoUrl('https://www.bilibili.com/video/BV15z4C6SEHT?p=2', []);
  const out2 = (typeof r2 === 'string') ? r2 : (r2 && r2.url) || '';
  check('返回了直链', /fake-cdn\.bilibili\.com\/play\?cid=/.test(out2), out2.slice(0, 80));
  check('直链 cid == 第2集 cid（不再永远第1集）', out2.includes('cid=' + wantCid2) && !out2.includes('cid=' + wantCid1), out2.slice(0, 120));

  // ===== 测试 3：点合集里另一个视频（跨 BV），WBI 应经 view API 取 cid =====
  console.log('\n=== 测试3：跨视频（合集另一 BV）经 view API 取直链 ===');
  const r3 = await extractFreshVideoUrl('https://www.bilibili.com/video/BV1NCgVzoEG9?p=1', []);
  const out3 = (typeof r3 === 'string') ? r3 : (r3 && r3.url) || '';
  check('返回了直链', /fake-cdn\.bilibili\.com\/play\?cid=41394119999/.test(out3), out3.slice(0, 80));
  check('用了 view API 拉取另一视频 cid', callLog.some((u) => u.includes('/x/web-interface/view') && u.includes('BV1NCgVzoEG9')), '');

  // ===== 测试 4：单视频页（无分P 无合集）但含相关视频 → 绝不能把推荐当批量卡 =====
  console.log('\n=== 测试4：单视频页范围隔离（relatedVideos 不再外溢）===');
  const prevHref = globalThis.location.href;
  globalThis.window.__INITIAL_STATE__ = {
    videoData: {
      aid: 555, bvid: 'BV_SINGLEcccc', cid: 777001, pic: 'p.jpg',
      pages: [{ cid: 777001, page: 1, part: '单集' }],
      wbi: { wbiImgKey: 'imgkey', wbiSubKey: 'subkey' },
    },
    relatedVideos: RELATED_BVIDS.map((bv, i) => ({ bvid: bv, title: '推荐' + (i + 1), arc: { bvid: bv, title: '推荐' + (i + 1), pic: '' } })),
  };
  globalThis.location.href = 'https://www.bilibili.com/video/BV_SINGLEcccc';
  const r4 = await extractFreshVideoUrl('', []);
  const out4 = (typeof r4 === 'string') ? r4 : (r4 && r4.url) || '';
  check('单视频(无分P无合集) 仍返回单一直链', /fake-cdn\.bilibili\.com\/play\?cid=777001/.test(out4), out4.slice(0, 80));
  check('单视频页未把 relatedVideos 当批量卡（无 /null、无推荐 bvid）', !RELATED_BVIDS.some((bv) => out4.includes(bv)), out4.slice(0, 80));
  globalThis.location.href = prevHref;

  console.log('\n========================================');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试运行异常:', e); process.exit(2); });
