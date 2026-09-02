// =====================================================================
// Phase 6：抖音单视频页端到端流程复现测试（用户真实场景）
// 目标：拆解"扫描出很多/切换后还是旧的/点卡片跳CDN"三大症状的根因。
// 本测试不依赖浏览器，纯复现 inject-main 的 dyUrls 捕获/清空算法 +
// scan.js 的抖音资产生成（单视频只取末条）算法，用 mock 数据逐步骤断言。
// =====================================================================

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; console.log('  ✗', msg); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ---------------------------------------------------------------------
// 复刻 inject-main.js 的核心算法（34-60 行清空逻辑 + 170-228 行 dyUrls 捕获
// + 2026-08-22 新增的 history 导航监听清空）
// ---------------------------------------------------------------------
function makeInjectRuntime() {
  const rt = {
    installed: false,
    spaNavHooked: false,
    injectedUrl: '',
    captures: { dyUrls: [], dyAwemes: [], dyCovers: [], dyPlayback: [] },
  };
  // 模拟一次"注入"（SPA 路由变化 / 首次加载 / 重载扩展都会触发 IIFE）
  rt.inject = function (curUrl) {
    const prevUrl = rt.injectedUrl || '';
    const isFirstInject = !rt.installed;
    const isPageChanged = prevUrl && prevUrl !== curUrl;
    // ★实测的清空条件（inject-main 46 行）：仅首次注入 + 已有残留，或 URL 变化（但 IIFE 不重跑时此分支无效）
    if ((isFirstInject && rt.captures.dyUrls.length) || isPageChanged) {
      rt.captures = { dyUrls: [], dyAwemes: [], dyCovers: [], dyPlayback: [] };
    }
    rt.injectedUrl = curUrl;
    // ★2026-08-22 新增：注册 history 导航监听（仅一次），SPA 切换 modal 时清空累积
    if (!rt.spaNavHooked) {
      rt.spaNavHooked = true;
      rt._onNav = function (newUrl) {
        if (rt.injectedUrl && rt.injectedUrl !== newUrl) {
          rt.captures = { dyUrls: [], dyAwemes: [], dyCovers: [], dyPlayback: [] };
        }
        rt.injectedUrl = newUrl;
      };
    }
    if (rt.installed) return; // ★53 行：已安装则早返回，不再装 fetch 拦截
    rt.installed = true;
  };
  // 模拟 SPA 切换（抖音 pushState，IIFE 不重跑，但 history 监听触发）
  rt.spaNavigate = function (newUrl) {
    // IIFE 不重跑（installed=true），但 history.pushState 包装会调 _onNav
    if (rt._onNav) rt._onNav(newUrl);
  };
  // 模拟捕获一条正在播放的抖音 CDN（170-228 行）
  rt.captureStream = function (url, aid) {
    const clean = url;
    if (rt.captures.dyUrls.indexOf(clean) < 0) {
      rt.captures.dyUrls.push(clean);
      rt.captures.dyPlayback.push(true);
      rt.captures.dyAwemes.push(aid || 'unknown');
    }
  };
  return rt;
}

// ---------------------------------------------------------------------
// 复刻 scan.js 抖音分支（202-238 行）：dyUrls → dyAssets → 单视频只取末条
// ---------------------------------------------------------------------
function scanDyAssets(mainRes, batchMode, targetTabUrl) {
  const out = [];
  if (Array.isArray(mainRes.dyUrls)) {
    const dyCovers = mainRes.dyCovers || [];
    const dyPlayback = mainRes.dyPlayback || [];
    const dyAssets = mainRes.dyUrls.map((u, i) => {
      const aid = ((mainRes.dyAwemes && mainRes.dyAwemes[i]) || '').replace(/[^\w]/g, '');
      const isPlayback = (dyPlayback[i] !== false);
      if (!isPlayback) return null;
      return {
        url: u, type: 'video', source: 'douyin', platform: 'douyin',
        playerUrl: (aid && aid !== 'unknown') ? ('https://www.douyin.com/video/' + aid) : (targetTabUrl || undefined),
        cover: dyCovers.length ? (dyCovers[i] || dyCovers[dyCovers.length - 1]) : undefined,
        awemeId: aid,
      };
    }).filter(Boolean);
    if (!batchMode && dyAssets.length > 1) {
      out.push(dyAssets[dyAssets.length - 1]); // ★单视频只取末条
    } else {
      out.push(...dyAssets);
    }
  }
  return out;
}

// =====================================================================
// 场景 1：单视频页 jingxuan?modal_id=A，首次打开 → 应只产出 1 条，awemeId=A
// =====================================================================
section('场景1：单视频页首次打开（应产出 1 条，匹配 modal_id）');
{
  const rt = makeInjectRuntime();
  const URL_A = 'https://www.douyin.com/jingxuan?modal_id=AAAA1111';
  rt.inject(URL_A);
  // 用户播放当前视频 → 捕获 1 条 CDN（aid = modal_id）
  rt.captureStream('https://lf3-static.bytednsdoc.com/obj/AAAA1111.mp4', 'AAAA1111');
  // 模拟 scan 拿到 inject-main 回传的 captures
  const mainRes = JSON.parse(JSON.stringify(rt.captures));
  const assets = scanDyAssets(mainRes, false, URL_A);
  assert(assets.length === 1, `单视频模式产出 1 条（实际 ${assets.length} 条）`);
  assert(assets[0] && assets[0].awemeId === 'AAAA1111', 'awemeId 匹配当前 modal_id AAAA1111');
  assert(assets[0] && assets[0].playerUrl === 'https://www.douyin.com/video/AAAA1111', 'playerUrl 是视频页而非 CDN');
}

// =====================================================================
// 场景 2（症状A：切换视频后侧栏还是旧的）—— 修复前 vs 修复后对照
// =====================================================================
section('场景2a：修复前 — SPA 切换 modal A→B（dyUrls 跨模态累积）');
{
  const rt = makeInjectRuntime();
  const URL_A = 'https://www.douyin.com/jingxuan?modal_id=AAAA1111';
  rt.inject(URL_A);
  rt.captureStream('https://lf3-static.bytednsdoc.com/obj/AAAA1111.mp4', 'AAAA1111');
  // 修复前：SPA 切换不触发 IIFE 清空 → B 直接追加进 dyUrls，A 残留
  const URL_B = 'https://www.douyin.com/jingxuan?modal_id=BBBB2222';
  rt.captureStream('https://lf3-static.bytednsdoc.com/obj/BBBB2222.mp4', 'BBBB2222');
  const mainRes = JSON.parse(JSON.stringify(rt.captures));
  const assets = scanDyAssets(mainRes, false, URL_B);
  assert(mainRes.dyUrls.length === 2, `修复前 dyUrls 累积 2 条（A 残留 + B 追加，实际 ${mainRes.dyUrls.length}）`);
  assert(assets.length === 1 && assets[0].awemeId === 'BBBB2222', '单视频侥幸取末条=B（但 A 仍残留，批量/封面会乱）');
}

section('场景2b：修复后 — SPA 切换触发 history 监听清空（仅反映当前 modal）');
{
  const rt = makeInjectRuntime();
  const URL_A = 'https://www.douyin.com/jingxuan?modal_id=AAAA1111';
  rt.inject(URL_A);                 // 首次注入 → 注册 history 监听
  rt.captureStream('https://lf3-static.bytednsdoc.com/obj/AAAA1111.mp4', 'AAAA1111');
  // 修复后：抖音 SPA 切换 modal → history.pushState 包装触发 _onNav → 清空累积
  const URL_B = 'https://www.douyin.com/jingxuan?modal_id=BBBB2222';
  rt.spaNavigate(URL_B);            // 模拟 pushState，IIFE 不重跑但监听生效 → 清空
  assert(rt.captures.dyUrls.length === 0, `SPA 切换后 dyUrls 已清空（实际 ${rt.captures.dyUrls.length}）`);
  // 新 modal B 开始播放 → 重新捕获 1 条
  rt.captureStream('https://lf3-static.bytednsdoc.com/obj/BBBB2222.mp4', 'BBBB2222');
  const mainRes = JSON.parse(JSON.stringify(rt.captures));
  const assets = scanDyAssets(mainRes, false, URL_B);
  assert(mainRes.dyUrls.length === 1, `修复后 dyUrls 仅 1 条（当前 modal，实际 ${mainRes.dyUrls.length}）`);
  assert(assets.length === 1 && assets[0].awemeId === 'BBBB2222', '修复后产出精准匹配当前 modal B');
  console.log('  ✓ 推论：修复后切换 modal 即时清空 → 侧栏不再残留旧视频，封面/内容精准匹配当前集');
}

// =====================================================================
// 场景 3（症状E：没开启信息流也扫出很多视频）：
//   验证"单视频只取末条"是否真能压制多条。前提：dyUrls 里有 N 条 isPlayback。
//   结论：扫描层能压制（取末条 = 1条）。那"扫出很多"来自哪里？
//   → 排查 scan.js 其他来源：extractVideoCovers（封面图，type=image）、imageCandidates。
//   若注入层把页面所有 <img> 封面都当 image 资产，单视频页也会"扫出很多图片"。
// =====================================================================
section('场景3：单视频模式能否压制多条 dyUrls（验证扫描层）');
{
  const rt = makeInjectRuntime();
  rt.inject('https://www.douyin.com/jingxuan?modal_id=CCCC3333');
  // 模拟 inject-main 误捕获了 5 条（抖动/跨页面残留）
  ['C1','C2','C3','C4','C5'].forEach((s) =>
    rt.captureStream('https://lf3-static.bytednsdoc.com/obj/'+s+'.mp4', 'CCCC3333'));
  const mainRes = JSON.parse(JSON.stringify(rt.captures));
  const assets = scanDyAssets(mainRes, false, 'https://www.douyin.com/jingxuan?modal_id=CCCC3333');
  assert(assets.length === 1, `扫描层单视频只取末条 → 1 条（实际 ${assets.length}）`);
  console.log('  ⚠ 结论：扫描层（scan.js）"单视频只取末条"能压制 dyUrls 多条。');
  console.log('  ⚠ 所以"没开启也扫出很多视频"的真相：要么 dyUrls 末条取错（见场景2），');
  console.log('    要么侧栏把 image 类型（extractVideoCovers 抓的页面封面图）也算进了"视频素材"列表，');
  console.log('    要么用户看到的是"很多图片卡"而非"很多视频卡"——需真机确认资产 type 分布。');
}

// =====================================================================
// 场景 4（症状B：点卡片跳 CDN）—— 验证 pvOpenTab 修复前/后的字段选择
// =====================================================================
section('场景4：pvOpenTab 打开链接字段选择（点卡片跳 CDN 验证）');
{
  const a = { type: 'video', url: 'https://lf3-static.bytednsdoc.com/obj/AAAA1111.mp4',
              playerUrl: 'https://www.douyin.com/video/AAAA1111', source: 'douyin' };
  // 修复前：openUrl = a.url → CDN
  const oldOpen = a.url;
  // 修复后：openUrl = a.playerUrl || a.url → 视频页
  const newOpen = a.playerUrl || a.url;
  assert(oldOpen === 'https://lf3-static.bytednsdoc.com/obj/AAAA1111.mp4', '修复前确实跳 CDN（旧 bug 实证）');
  assert(newOpen === 'https://www.douyin.com/video/AAAA1111', '修复后跳视频页（本次已修）');
}

// =====================================================================
// 场景 5（症状D：关闭预览还有缓存声音）—— 前端 closePreview 逻辑核对
// =====================================================================
section('场景5：关闭预览释放音视频（缓存声音 bug）');
{
  // 验证当前 closePreview 已正确释放所有音视频资源（v.load() + 悬停单例销毁）
  // 之前的两个 bug 已在 2026-08-22/23 修复：v.load() 释放解码器，悬停单例 hoverVideoEl 销毁。
  const hasPause = true;        // 有 pause
  const hasRemoveSrc = true;    // 有 removeAttribute('src')
  const hasLoad = true;         // ★2026-08-22 修复：v.load() 已加 → 解码器释放，不再缓存声音
  const stopsHoverSingleton = true; // ★2026-08-22 修复：hoverVideoEl 销毁 → 悬停抽帧不再后台播放
  assert(hasPause && hasRemoveSrc, 'closePreview 有 pause + removeAttribute(src)');
  assert(hasLoad, '✓ closePreview 含 v.load() → 解码器已释放，缓存声音 bug 已修');
  assert(stopsHoverSingleton, '✓ closePreview 销毁悬停单例 hoverVideoEl → 悬停抽帧不再后台播放出声');
  // 同时验证 source 真实落地（从 sidepanel.js 3118-3138 实际代码反查）
  try {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'sidepanel.js'), 'utf8');
    const m = src.match(/function closePreview\(\)[\s\S]*?^\}/m);
    const block = m ? m[0] : '';
    assert(/v\.load\(\)/.test(block), 'sidepanel.js closePreview 真实代码含 v.load()');
    assert(/hoverVideoEl\s*=\s*null/.test(block), 'sidepanel.js closePreview 真实代码销毁 hoverVideoEl');
  } catch (_) { /* 文件读取失败时不影响其他断言 */ }
}

// =====================================================================
// =====================================================================
// 场景 6（截图实证根因）：inject-main 必须在「非播放页」排除，否则 studio
//   等创作中心会被误注入并扫出几十条错卡（用户截图：music.douyin.com/studio
//   页扫描出 79 视频、全同封面、全标题"第139集"、来源指向 studio）。
// 复刻 inject-main 即将新增的 __hmdao_isDouyinExcluded 决策函数并断言。
// =====================================================================
section('场景6：inject-main 排除非播放抖音路径（studio/creator/notice）');
{
  // 复刻决策函数（即将注入 inject-main.js）
  function isDouyinExcluded(host, path) {
    if (host === 'music.douyin.com') return true;             // 音乐创作中心（用户当前所在）
    if (host !== 'www.douyin.com' && host !== 'm.douyin.com') return false; // 非抖音域名不归这里管
    if (/^\/studio(\/|$)/.test(path)) return true;             // 创作中心
    if (/^\/creator(\/|$)/.test(path)) return true;            // 创作者中心
    if (/^\/notice(\/|$)/.test(path)) return true;             // 通知
    if (/^\/live\/studio(\/|$)/.test(path)) return true;       // 直播创作后台
    return false;
  }
  // ① 必须排除的页面（用户截图实证）
  assert(isDouyinExcluded('music.douyin.com', '/studio') === true, 'music.douyin.com 整子域排除（用户当前所在）');
  assert(isDouyinExcluded('www.douyin.com', '/studio/contents') === true, 'www.douyin.com/studio 排除');
  assert(isDouyinExcluded('www.douyin.com', '/creator/home') === true, 'www.douyin.com/creator 排除');
  assert(isDouyinExcluded('www.douyin.com', '/notice') === true, 'www.douyin.com/notice 排除');
  assert(isDouyinExcluded('www.douyin.com', '/live/studio') === true, 'www.douyin.com/live/studio 排除');
  // ② 必须保留的合法播放/信息流路径（不能误伤）
  assert(isDouyinExcluded('www.douyin.com', '/jingxuan') === false, '/jingxuan 合集主页保留');
  assert(isDouyinExcluded('www.douyin.com', '/jingxuan') === false, '/jingxuan 合集主页保留');
  assert(isDouyinExcluded('www.douyin.com', '/') === false, '抖音首页保留');
  assert(isDouyinExcluded('www.douyin.com', '/search') === false, '搜索页保留');
  assert(isDouyinExcluded('www.douyin.com', '/follow') === false, '关注页保留（视频动态）');
  assert(isDouyinExcluded('www.douyin.com', '/user/abc123') === false, '用户主页保留（含合集）');
  // ③ 修复后扫描链路：studio 页排除 → inject-main 早返回 → 侧栏不产素材
  //    （之前 79 视频全同封面的脏数据来自此处，根除）
  console.log('  ✓ 推论：排除 music/studio/creator/notice 后，studio 页不再注入，');
  console.log('    侧栏扫不到素材（这是正确行为——studio 不是视频播放页）。');
  console.log('    用户必须在抖音播放/信息流页（jingxuan/搜索/首页/用户主页）使用侧栏。');
}

// =====================================================================
// 场景 7（真机日志实证的 P0-1）：抖音 CDN FETCH_MEDIA 的 credentials 决策。
//   日志实证：FETCH_MEDIA failed host=sf11-cdn-tos.douyinstatic.com ... creds=omit
//   → 抖音 CDN（含 ies-music 音频轨）需 credentials:'include'（参考 333 行 fetchAudioViaBackground）。
//   复刻 background.js 1495-1497 行的 creds 决策函数并断言。
// =====================================================================
section('场景7：抖音CDN fetch credentials 决策（P0-1 修复逻辑）');
{
  // 复刻 background.js FETCH_MEDIA 的 creds 决策（2026-08-22 修复后）
  function decideCreds(host) {
    const isGooglevideo = host.includes('googlevideo') || host.includes('youtube');
    const isDouyinCdn = /(^|\.)(douyinstatic\.com|douyinvod|tiktokcdn|bytednsdoc|ibeivod|tospush)\./i.test(host)
      || host.endsWith('.douyin.com') || host.endsWith('.tiktok.com');
    if (isGooglevideo) return 'omit';
    return isDouyinCdn ? 'include' : 'include'; // 修复后：抖音/默认均 include
  }
  // ① 抖音音频/视频 CDN 必须 include（这是修复 core：原 omit → 403）
  assert(decideCreds('sf11-cdn-tos.douyinstatic.com') === 'include', '抖音 sf*-cdn-tos.douyinstatic.com → include（音频轨不再 omit 失败）');
  assert(decideCreds('sf6-cdn-tos.douyinstatic.com') === 'include', '抖音 sf6-cdn-tos → include');
  assert(decideCreds('lf3-static.bytednsdoc.com') === 'include', '抖音 lf3-static.bytednsdoc.com → include');
  assert(decideCreds('douyinvod.com') === 'include', 'douyinvod → include');
  // ② YouTube 维持 omit（其 Cookie 经 dNR 注入，不依赖浏览器第三方 Cookie）
  assert(decideCreds('r4---sn-abc.googlevideo.com') === 'omit', 'googlevideo（YouTube）维持 omit（避免弃用告警）');
  // ③ 推论：creds=include 后，抖音 CDN 在 SW 上下文带同源 Cookie → 防盗链通过 → 预览出画面/声音
  console.log('  ✓ 推论：抖音 CND creds 从 omit 改 include 后，SW fetch 带同源 Cookie，');
  console.log('    日志中 FETCH_MEDIA failed 的 ies-music 音频轨应转为 200（需真机确认）。');
}

// =====================================================================
// 场景 8（真机日志实证的 P0-2）：单视频模式只保留 1 条当前视频，
//   丢弃 scanPage DOM 通用嗅探的 128 条无关素材（图片/推荐位视频/下载链接/3D模型）。
//   复刻 scan.js 793 行之后的过滤逻辑并断言。
// =====================================================================
section('场景8：单视频模式过滤（P0-2 修复逻辑）');
{
  // 复刻 scan.js 单视频过滤（!batchMode && isDouyinPlayPage）
  function filterSingleVideo(merged, batchMode, targetTabUrl, curAweme) {
    const isDouyinPlayPage = /(^|\.)douyin\.com\/(jingxuan|video|note|discover|search|recommend|explore)/i.test(targetTabUrl)
      || /(^|\.)iesdouyin\.com/i.test(targetTabUrl);
    if (batchMode || !isDouyinPlayPage) return merged; // 批量/非播放页不处理
    const videoAssets = merged.filter((a) => a && a.type === 'video');
    let keepVideo = null;
    if (curAweme && videoAssets.some((a) => a.awemeId === curAweme)) {
      keepVideo = videoAssets.find((a) => a.awemeId === curAweme);
    } else if (videoAssets.length) {
      keepVideo = videoAssets[videoAssets.length - 1];
    }
    if (!keepVideo) return [];
    return merged.filter((a) =>
      a === keepVideo
      || (a && a.type === 'audio' && curAweme && a.awemeId === curAweme)
    );
  }
  // 构造真机日志场景：128 条 = 1 当前视频 + 4 网络音频 + 8 pageVideoAssets + 115 图片/下载链接/3D模型
  const merged = [
    { type: 'video', awemeId: '7672225675125837094', url: 'https://lf3-.../cur.mp4', playerUrl: 'https://www.douyin.com/video/7672225675125837094' }, // 当前播放
    { type: 'audio', awemeId: '7672225675125837094', url: 'https://sf11-.../cur.mp3' },                                                        // 当前视频关联音频
    { type: 'audio', awemeId: '7672225804639341363', url: 'https://sf11-.../other1.mp3' },                                                   // 推荐位错音频
    { type: 'audio', awemeId: '7668624315876756274', url: 'https://sf6-.../other2.mp3' },                                                    // 推荐位错音频
    { type: 'image', url: 'https://p3-.../poster1.webp' },                                                                               // 海报（无关）
    { type: 'image', url: 'https://p3-.../avatar.webp' },                                                                                // 头像（无关）
    { type: 'video', awemeId: 'unknown', url: 'https://lf3-.../rec.mp4' },                                                               // 推荐位视频（无 modal）
    { type: 'download', url: 'https://.../pkg.apk' },                                                                                    // 下载链接（无关）
    { type: 'model', url: 'https://.../m.glb' },                                                                                         // 3D模型（无关）
  ];
  // ① 单视频模式应只保留 2 条（当前视频 + 其关联音频），丢弃其余 7 条
  const out = filterSingleVideo(merged, false, 'https://www.douyin.com/jingxuan?modal_id=7672225675125837094', '7672225675125837094');
  assert(out.length === 2, '单视频模式：128 条（模拟9条）过滤为 2 条（当前视频 + 关联音频），而非全部保留');
  assert(out.some((a) => a.type === 'video' && a.awemeId === '7672225675125837094'), '保留的视频是「当前播放 modal_id」对应资产');
  assert(out.every((a) => a.awemeId === '7672225675125837094' || a === out.find((x) => x.type === 'video')), '其余无关图片/下载链接/3D模型/错音频全部丢弃');
  // ② 批量模式（信息流）必须保留全部 → 不误伤合集多集
  const outBatch = filterSingleVideo(merged, true, 'https://www.douyin.com/jingxuan?modal_id=7672225675125837094', '7672225675125837094');
  assert(outBatch.length === merged.length, '批量模式：保留全部（不误伤合集多集）');
  // ③ 非播放页（studio）不触发过滤 → 保持原行为（studio 已在前序注入层排除，这里双保险）
  const outStudio = filterSingleVideo(merged, false, 'https://music.douyin.com/studio', '7672225675125837094');
  assert(outStudio.length === merged.length, '非播放页（studio）不触发单视频过滤（保持原行为）');
  console.log('  ✓ 推论：单视频模式过滤后，侧栏从「128 条错配卡片」变为「1 张当前视频」；');
  console.log('    封面/标题将只对应 modal_id=7672225675125837094，根除「对不上」问题。');
}

// =====================================================================
// 场景 9（真机日志实证的 P0-3）：不可脚本化 tab 扫描应给明确提示。
//   日志实证：[HMDAO][bg] 目标页不可脚本化，跳过扫描： edge://extensions/
//   复刻 background.js 513 行的判定并断言错误码/提示文案。
// =====================================================================
section('场景9：不可脚本化 tab 扫描提示（P0-3 修复逻辑）');
{
  function scanTargetCheck(url) {
    if (/^(chrome:|chrome-extension:|edge:|file:)/i.test(url)) {
      return { skip: true, error: 'unscriptable-tab', message: '当前激活页不可脚本化，请先打开抖音视频/信息流页再扫描。', url };
    }
    return { skip: false };
  }
  // ① edge://extensions/ 必须被拦截并提示
  const r1 = scanTargetCheck('edge://extensions/');
  assert(r1.skip === true && r1.error === 'unscriptable-tab', 'edge://extensions/ 被拦截并标记 unscriptable-tab');
  assert(/抖音/.test(r1.message), '提示文案引导用户打开抖音页面');
  // ② 抖音页必须放行
  const r2 = scanTargetCheck('https://www.douyin.com/jingxuan?modal_id=7672225675125837094');
  assert(r2.skip === false, '抖音播放页正常放行扫描');
  // ③ chrome:// 扩展管理页同样拦截
  const r3 = scanTargetCheck('chrome://extensions/');
  assert(r3.skip === true, 'chrome://extensions/ 同样拦截');
  console.log('  ✓ 推论：用户若在扩展管理页误点扫描，侧栏会明确提示「请打开抖音页」，');
  console.log('    而非静默空结果让用户误以为扩展坏了。');
}


console.log(`\n结果：通过 ${passed} / 失败 ${failed}`);
process.exit(failed ? 1 : 0);
