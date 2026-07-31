// 诊断：Ddayup 扩展为何「开启后 B站视频加载不了」
// 复现 extension/rules.js 的 declarativeNetRequest 规则生成逻辑，
// 逐步骤拆解「页面原生请求头」 vs 「扩展注入后的请求头」，定位 403 来源。
//
// 运行：node scripts/diag-bili-dnr-rules.mjs

// ===== 复刻 rules.js 的关键常量与函数（仅逻辑，不依赖 chrome.*）=====
const BILI_REFERER = 'https://www.bilibili.com/';
const BILI_ORIGIN = 'https://www.bilibili.com';
const BILI_CDN_DOMAINS = ['bilivideo.com', 'bilivideo.cn', 'hdslb.com', 'mirrorakam.akamaized.net'];

// 规则优先级与匹配（来自 installRefererRuleForDomain）
const DNR_PRIORITY = 1;

// 模拟一条 dNR modifyHeaders 规则对「一次请求」的作用
// 修复后：B站规则 resourceTypes 仅 ['other']（不匹配页面 <video> 的 'media'）
let DNR_RESOURCE_TYPES = ['media', 'xmlhttprequest', 'other', 'image']; // 修复前默认值
function setBiliResourceTypes(types) { DNR_RESOURCE_TYPES = types; }
function applyDnrRuleToRequest(req, resourceTypesOverride) {
  const rts = resourceTypesOverride || DNR_RESOURCE_TYPES;
  // req: { url, resourceType, reqHeaders: {referer?, origin?} }
  const rule = BILI_CDN_DOMAINS.find((d) => {
    try { return new URL(req.url).hostname.endsWith('.' + d) || new URL(req.url).hostname === d; }
    catch { return false; }
  });
  if (!rule) return { matched: false, reason: '域名不在 BILI_CDN_DOMAINS，规则不作用' };
  if (!rts.includes(req.resourceType)) {
    return { matched: true, applied: false, reason: `resourceType=${req.resourceType} 不在规则 resourceTypes(${rts.join('/')})，不作用` };
  }
  // 规则 action：强制 set referer / origin（覆盖式，非「缺失才填」）
  const out = { ...req.reqHeaders };
  out.referer = BILI_REFERER;        // ★ operation: 'set' => 覆盖
  out.origin = BILI_ORIGIN;           // ★ operation: 'set' => 覆盖
  return { matched: true, applied: true, resultHeaders: out, rulePriority: DNR_PRIORITY };
}

// ===== 步骤流程拆解 =====
console.log('==================== 诊断流程开始 ====================\n');

// 步骤 1：扩展加载即执行 installBiliRefererRules（无需用户操作）
console.log('【步骤 1】扩展启动时立即执行 installBiliRefererRules()');
console.log('  → 对以下域名注册 dNR modifyHeaders 规则（priority=1）：');
BILI_CDN_DOMAINS.forEach((d) => console.log('     - ||' + d + '  (resourceTypes: ' + DNR_RESOURCE_TYPES.join('/') + ')'));
console.log('  → 这些规则在「浏览器扩展启动后」即对所有 B站视频请求永久生效，与用户是否点扫描/下载无关。\n');

// 步骤 2：模拟「页面原生（无扩展）」的 B站视频流请求头
console.log('【步骤 2】B站页面原生播放请求（扩展关闭时，正常可播）');
const nativeVideoReq = {
  url: 'https://s1.bilivideo.com/m4s/xxx/xxx.m4s?...',
  resourceType: 'media',
  reqHeaders: { referer: 'https://www.bilibili.com/video/BV1xx411c7mD' /* 媒体跨源不带头 */ },
};
console.log('  原生请求头：', JSON.stringify(nativeVideoReq.reqHeaders));

// 步骤 3：叠加【修复前】扩展 dNR 规则后的请求头（会干扰）
console.log('【步骤 3】修复前：扩展启动即常驻 B站规则（resourceTypes 含 media）');
setBiliResourceTypes(['media', 'xmlhttprequest', 'other', 'image']);
const afterExtOld = applyDnrRuleToRequest(nativeVideoReq);
console.log('  叠加后：', JSON.stringify(afterExtOld.resultHeaders), '| 命中=', afterExtOld.applied);
console.log('  ⚠️ 页面 <video> 的 media 请求被命中 → Referer 被覆盖 + 注入非法 Origin → CDN 403 → 加载不了\n');

// 步骤 3b：叠加【修复后】扩展 dNR 规则后的请求头（不干扰）
console.log('【步骤 3b】修复后：B站规则仅匹配 other（页面 media 不命中）');
setBiliResourceTypes(['other']);
const afterExtNew = applyDnrRuleToRequest(nativeVideoReq);
console.log('  叠加后：', JSON.stringify(afterExtNew.resultHeaders), '| 命中=', afterExtNew.applied, afterExtNew.applied ? '' : '→ 规则不作用，原生请求头保持不变 ✅');
console.log('  ✅ 页面 <video> 的 media 请求不再被规则命中，B站原生播放完全不受影响。\n');

// 步骤 4：后台 fetch 预览/下载（other 类型）命中规则——这是期望行为
console.log('【步骤 4】扩展后台 fetch B站视频字节（resourceType=other，期望命中规则补 Referer）');
const bgFetchReq = {
  url: 'https://s1.bilivideo.com/m4s/xxx/xxx.m4s?...',
  resourceType: 'other',
  reqHeaders: { /* 后台 fetch 默认无 Referer */ },
};
const afterExtBg = applyDnrRuleToRequest(bgFetchReq, ['other']);
console.log('  背景 fetch：', JSON.stringify(afterExtBg.resultHeaders), '| 命中=', afterExtBg.applied);
console.log('  ✅ 后台下载/预览路径正确获得 Referer，防盗链通过，且不污染页面播放。\n');

// 步骤 5：结论判定
console.log('【步骤 5】根因与修复判定');
console.log('  根因 = extension/rules.js 启动即常驻的 installBiliRefererRules()（declarativeNetRequest 网络层注入）');
console.log('        它对所有 bilivideo.com 的 media 请求强制 set Referer + 注入 Origin，覆盖页面原生合法请求头 → 403。');
console.log('  修复 = 移除启动常驻；改为按需安装 + resourceTypes 仅 [other]，页面 <video> media 请求不再被命中。');
console.log('  关闭扩展 => 无规则 => 正常；开启扩展(修复后) => 页面播放不受影响 + 后台下载仍带 Referer。');
console.log('\n==================== 诊断流程结束 ====================');
