// 回归测试：图片卡标题与去重
// 目标：确保图片标题不再退化成 pageTitle，且同一封面不同尺寸/格式变体合并为一张。
// 注意：本文件镜像 scan.js / sidepanel.js 中的关键字符串处理逻辑，作为行为契约。

import assert from 'node:assert';

// ===== 镜像 scan.js 中的图片 pathname 规范化 =====
function normalizeImagePathname(p) {
  return String(p || '')
    .replace(/~tplv-[^/]*$/i, '')
    .replace(/!\w+$/i, '')
    .replace(/:\d{1,5}:\d{1,5}\.\w{2,5}$/i, '')
    .replace(/:\d{1,5}:\d{1,5}$/i, '')
    .replace(/@\d+w_\d+h(_\d+c)?\.\w+$/i, '')
    .replace(/@!?\w+\.\w+$/i, '')
    .replace(/[-_]\d{2,4}x\d{2,4}$/i, '');
}

// ===== 镜像 scan.js 中的 deriveImageName =====
function deriveImageName(a) {
  const alt = String(a.alt || '').trim();
  if (alt && alt.length > 2 && !/^\d+$/.test(alt) && !/\b(logo|icon|avatar|banner|spacer|placeholder|loading|default|cover|thumb)\b/i.test(alt)) {
    return alt;
  }
  try {
    const u = new URL(a.url);
    let name = decodeURIComponent(normalizeImagePathname(u.pathname).split('/').pop() || '');
    name = name.replace(/[-_]\d{2,4}x\d{2,4}$/i, '').replace(/[-_]?\d+$/, '').trim();
    if (name && name.length > 1) return name;
  } catch (_) {}
  return '';
}

// ===== 镜像 scan.js 去重键中的图片 URL 键 =====
function imageDedupKey(url) {
  try {
    const u = new URL(url);
    u.pathname = normalizeImagePathname(u.pathname);
    return u.href + '|image|';
  } catch (_) {
    return url + '|image|';
  }
}

// ===== 镜像 sidepanel.js displayName 中的图片回退 =====
function displayNameFallback(a) {
  if (a && a.type === 'image' && a.url) {
    try {
      const seg = decodeURIComponent(new URL(a.url).pathname.split('/').pop() || '');
      if (seg && seg.length > 1) return seg.replace(/[?#].*$/, '');
    } catch (_) {}
  }
  return '图片素材';
}

const pageTitle = '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili';

// ---- 用例 1：标题优先使用 alt ----
{
  const a = { type: 'image', url: 'https://i0.hdslb.com/bfs/archive/xxxx.jpg@672w_378h_1c.webp', alt: 'AI+UE5 建模教程封面' };
  const title = deriveImageName(a);
  assert.strictEqual(title, 'AI+UE5 建模教程封面', 'alt 应直接作为图片标题');
  assert.notStrictEqual(title, pageTitle, '图片标题不应 fallback 到 pageTitle');
}

// ---- 用例 2：无 alt 时从 URL 派生基文件名，并剥离 @ 处理后缀 ----
{
  const a = { type: 'image', url: 'https://i0.hdslb.com/bfs/archive/cover_2024.jpg@672w_378h_1c.webp', alt: '' };
  const title = deriveImageName(a);
  assert.strictEqual(title, 'cover_2024.jpg', '应剥离 B站 @ 处理后缀并保留基文件名');
  assert.notStrictEqual(title, pageTitle);
}

// ---- 用例 3：花瓣/又拍云/OSS 处理后缀同样剥离 ----
{
  const urls = [
    'https://gd-hbimg-other.huaban.com/a97ff44xxx~tplv-xxx-aigc_resize_loss:480:480.webp',
    'https://gd-hbimg-other.huaban.com/a97ff44xxx:480:480.webp',
    'https://hbimg.b0.upaiyun.com/abc.png!w600_webp',
    'https://example.com/img-480x360.jpg',
  ];
  for (const url of urls) {
    const a = { type: 'image', url, alt: '' };
    const title = deriveImageName(a);
    assert.ok(title && title.length > 1, `URL ${url} 应能派生出非空标题`);
    assert.notStrictEqual(title, pageTitle);
    assert.ok(!title.includes('~tplv') && !title.includes('!w600') && !title.includes(':480:480') && !title.includes('@672w'),
      `标题中不应残留处理后缀：${title}`);
  }
}

// ---- 用例 4：同一封面不同尺寸变体应得到相同去重键 ----
{
  const variants = [
    'https://i0.hdslb.com/bfs/archive/abc123.jpg@672w_378h_1c.webp',
    'https://i0.hdslb.com/bfs/archive/abc123.jpg@336w_189h_1c.webp',
    'https://i0.hdslb.com/bfs/archive/abc123.jpg@1280w_720h.webp',
  ];
  const keys = new Set(variants.map(imageDedupKey));
  assert.strictEqual(keys.size, 1, 'B站同一封面不同 @ 变体应合并为同一条去重键');
}

// ---- 用例 5：不同封面不应意外合并 ----
{
  const a = imageDedupKey('https://i0.hdslb.com/bfs/archive/abc123.jpg@672w_378h_1c.webp');
  const b = imageDedupKey('https://i0.hdslb.com/bfs/archive/def456.jpg@672w_378h_1c.webp');
  assert.notStrictEqual(a, b, '不同基文件不应合并');
}

// ---- 用例 6：同一页面多张图片的标题彼此不同 ----
{
  const assets = [
    { type: 'image', url: 'https://cdn.x/a.jpg', alt: '封面A' },
    { type: 'image', url: 'https://cdn.x/b.jpg', alt: '封面B' },
    { type: 'image', url: 'https://cdn.x/c.jpg', alt: '' },
  ];
  const titles = assets.map(deriveImageName);
  const unique = new Set(titles);
  assert.strictEqual(unique.size, titles.length, '不同图片应派生不同标题');
  for (const t of titles) assert.notStrictEqual(t, pageTitle);
}

// ---- 用例 7：displayName 对无标题无扩展名 CDN 图的回退 ----
{
  const a = { type: 'image', url: 'https://gd-hbimg-other.huaban.com/a97ff44xxx?x-oss-process=image/resize' };
  const fallback = displayNameFallback(a);
  assert.ok(fallback !== '图片素材' && fallback.length > 1, '无扩展名 CDN 图应回退到 URL 末段而不是"图片素材"');
}

console.log('✅ image-title-dedup tests passed');
