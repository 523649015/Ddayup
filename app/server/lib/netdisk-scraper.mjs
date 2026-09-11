// Ddayup 网盘深度解析器（Playwright 托管）
// 适配：夸克网盘 / 百度网盘 / 迅雷云盘（分享页 + 个人盘）/ 电驴(ed2k/迅雷磁力)
// 能力：模拟浏览器访问、注入登录态 Cookie/localStorage、拦截网盘私有 API 响应
//      提取真实下载直链、处理动态加载、检测出验证码/登录墙时挂起任务等待人工回填。
// 复用：解析成功后直接通过 aria2-manager 触发 Aria2 RPC 下载。
//
// 设计要点（2026-08-11 重写）：
// 1) 个人盘（如迅雷 pan.xunlei.com/?path=，夸克/百度个人盘）的真实直链来自网盘私有
//    REST API（如 api-pan.xunlei.com/drive/v1/...）。这些接口需要登录态。我们注入从
//    扩展侧传来的 cookies + localStorage(迅雷 device-id/client-id) 后，用 Playwright
//    的 page.on('response') 拦截页面自身发起的 API 响应，从中提取 download_url 真直链。
//    这比硬编码每个 API 字段更稳，且自动复用已注入的登录态（同源 fetch 自动带 Cookie）。
// 2) 扩展名白名单放宽：只过滤明显非文件的链接（html 页面、js、css、登录页），其余真实
//    文件直链一律放行，避免把 pdf/docx/exe/jpg 等常见文件误杀。

import { chromium } from 'playwright';
import * as aria2Manager from './aria2-manager.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 任务挂起表：taskId -> { resolve, status, requireInteraction, platform, url }
const PENDING_TASKS = new Map();
const TASK_TTL_MS = 1000 * 60 * 15; // 15 分钟无回调自动过期

function taskKey() {
  return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export function detectPlatform(url) {
  const u = String(url || '').toLowerCase();
  // 本地测试/调试钩子：?mockPlatform=quark|baidu|xunlei 强制指定平台（不影响生产真实域名判定）
  try {
    const q = new URL(url).searchParams.get('mockPlatform');
    if (q && ['quark', 'baidu', 'xunlei'].includes(q)) return q;
  } catch {}
  if (u.includes('quark')) return 'quark';
  if (u.includes('pan.baidu') || u.includes('baidu')) return 'baidu';
  if (u.includes('xunlei') || u.includes('pan.xunlei')) return 'xunlei';
  if (u.startsWith('ed2k://') || u.includes('emule') || u.includes('edonkey')) return 'ed2k';
  if (u.startsWith('thunder://') || u.startsWith('magnet:')) return 'magnet';
  return 'unknown';
}

// 判断是个人盘页还是分享页
function isSharePage(url, platform) {
  const u = String(url || '').toLowerCase();
  if (platform === 'xunlei') return /\/s\/|\/share|\?share|sharecode|survey/.test(u);
  if (platform === 'quark') return /\/s\//.test(u);
  if (platform === 'baidu') return /\/s\//.test(u) || /share/.test(u);
  return false;
}

// 把扩展/前端传来的 Cookie 字符串解析成 Playwright 可用的数组
function parseCookieString(cookieStr, domain) {
  if (!cookieStr) return [];
  const out = [];
  for (const part of String(cookieStr).split(/;|&/)) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    out.push({ name, value, domain: domain || undefined, path: '/' });
  }
  return out;
}

// 等待人工交互（验证码/登录）后继续；超时则挂起返回 taskId。
function waitForInteraction(taskId, platform, url, timeoutMs = TASK_TTL_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      PENDING_TASKS.delete(taskId);
      resolve({ ok: false, requireInteraction: true, expired: true, taskId, platform, error: 'interaction-timeout' });
    }, timeoutMs);
    PENDING_TASKS.set(taskId, {
      resolve: (result) => { clearTimeout(timer); PENDING_TASKS.delete(taskId); resolve(result); },
      status: 'pending',
      platform,
      url,
      createdAt: Date.now(),
    });
  });
}

// 人工回填后调用：继续/完成被挂起的任务
export function resolveInteraction(taskId, payload = {}) {
  const t = PENDING_TASKS.get(taskId);
  if (!t) return { ok: false, error: 'task-not-found-or-expired' };
  t.status = 'resolved';
  t.payload = payload;
  t.resolve({ ok: true, resumed: true, taskId, payload });
  return { ok: true, taskId };
}

export function getPendingTasks() {
  return [...PENDING_TASKS.entries()].map(([id, t]) => ({
    taskId: id, platform: t.platform, url: t.url, status: t.status, createdAt: t.createdAt,
  }));
}

// 检测当前页面是否处于验证码/登录墙（通用启发式）
async function detectBlock(page) {
  const signals = [];
  try {
    const title = (await page.title().catch(() => '')) || '';
    const bodyText = (await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '')) || '';
    const lower = (title + ' ' + bodyText).toLowerCase();
    if (/(请登录|登录后|login|sign in|扫码登录|账号登录|未登录)/.test(lower)) signals.push('login-wall');
    if (/(验证码|滑块|拖动|拼图|captcha|verify|安全验证|人机)/.test(lower)) signals.push('captcha');
    if (/(网络异常|访问过于频繁|请求频率|风控|访问受限)/.test(lower)) signals.push('rate-limit');
  } catch {}
  return signals;
}

// 在已注入登录态的 page 上下文里，拦截网盘私有 API 响应，提取真实下载直链。
// 返回 [{ name, url, source }]
async function extractViaApiIntercept(page, opts) {
  const collected = [];
  const seen = new Set();
  const pushUnique = (name, url, source) => {
    if (!url || !/^https?:/i.test(url)) return;
    // 过滤明显非文件链接
    if (/\.(html?|js|css|json|png|gif|ico|woff2?|map)(\?|$)/i.test(url.split('?')[0]) && !/\.(zip|rar|7z|tar|gz|tgz|iso|dmg|mp4|mkv|mov|avi|webm|part|001|exe|apk|pdf|docx?|xlsx?|pptx?|jpg|jpeg|png)\b/i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    collected.push({ name: (name || url.split('/').pop().split('?')[0] || 'netdisk-file').slice(0, 200), url, source });
  };

  const handler = (response) => {
    const u = response.url();
    // 只关心网盘 API / CDN 直链
    if (!/api-|download|cdn|pan\.|drive|file|media|xlcdn|tc\.xunlei/i.test(u)) return;
    const ct = (response.headers()['content-type'] || '').toLowerCase();
    if (ct.includes('application/json') || ct.includes('text/json')) {
      response.text().then((txt) => {
        try {
          const obj = JSON.parse(txt);
          deepScan(obj, pushUnique);
        } catch {}
      }).catch(() => {});
    }
  };
  page.on('response', handler);

  // 触发页面加载 / 展开文件列表：重新 goto 并等待
  // （调用方已 goto 过，这里等待一段时间让 API 自然发起）
  await page.waitForTimeout(opts && opts.waitMs ? opts.waitMs : 6000).catch(() => {});
  page.off('response', handler);
  return collected;
}

// 递归扫描任意 JSON 对象，提取 download_url / url / 直链字段
function deepScan(node, push) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const it of node) deepScan(it, push); return; }
  for (const k of Object.keys(node)) {
    const v = node[k];
    const lk = k.toLowerCase();
    if (typeof v === 'string') {
      if (/download_url|downloadurl|thunder_url|real_url|durl|media_url|file_url|cdn.*url|play_url/i.test(lk) && /^https?:/i.test(v)) {
        push(node.name || node.file_name || node.filename, v, 'api');
      } else if (lk === 'url' || lk === 'link' || lk === 'href') {
        if (/cdn|download|\.zip|\.rar|\.7z|\.mp4|\.mkv|\.iso|\.mp3|\.exe|\.pdf|\.apk/i.test(v) && /^https?:/i.test(v)) {
          push(node.name || node.fileName, v, 'api');
        } else if (/^thunder:\/\//i.test(v)) {
          // 迅雷专用链接：解码 base64 得到真实 url
          try { const dec = Buffer.from(v.replace(/^thunder:\/\//i, ''), 'base64').toString('utf8'); push(node.name, dec.replace(/^AA|ZZ$/g, ''), 'thunder'); } catch {}
        }
      }
    } else if (v && typeof v === 'object') {
      deepScan(v, push);
    }
  }
}

// 增强版 DOM 扫描：覆盖更多网盘列表选择器与内联脚本
async function extractViaDom(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const push = (name, url) => {
      if (!url || !/^https?:/i.test(url)) return;
      if (seen.has(url)) return;
      seen.add(url);
      out.push({ name: (name || url.split('/').pop().split('?')[0] || 'netdisk-file').slice(0, 200), url, source: 'dom' });
    };
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.href;
      if (/download|file=|pan\.|cdn\.|drive|medias?=|thunder/i.test(href) || /\.(zip|rar|7z|tar|gz|tgz|iso|dmg|mp4|mkv|mov|avi|webm|part|001|exe|apk|pdf|docx?|xlsx?|pptx?)\b/i.test(href)) {
        push((a.textContent || a.download || '').trim(), href);
      }
    });
    // 内联脚本里的直链
    const scripts = [...document.querySelectorAll('script')].map((s) => s.textContent || '').join('\n');
    const urls = scripts.match(/https?:\/\/[^"'\s]+\.(zip|rar|7z|tar|gz|tgz|iso|dmg|mp4|mkv|mov|avi|webm|part|001|exe|apk|pdf|docx?|xlsx?|pptx?)\b[^"'\s]*/gi) || [];
    urls.forEach((u) => push(u.split('/').pop().slice(0, 200), u));
    // 还有 download_url / thunder 链接
    const thunder = scripts.match(/thunder:\/\/[A-Za-z0-9+/=]+/gi) || [];
    thunder.forEach((t) => {
      try { const dec = atob(t.replace(/^thunder:\/\//i, '')); push('thunder', dec.replace(/^AA|ZZ$/g, '')); } catch {}
    });
    return out;
  });
}

// 通用：建立带登录态的浏览器上下文（注入 cookies + localStorage）
async function buildAuthedContext(browser, url, opts) {
  const host = (() => { try { return new URL(url).hostname; } catch { return 'xunlei.com'; } })();
  const domain = host.replace(/^www\./, '');
  const ctx = await browser.newContext({ userAgent: UA, acceptDownloads: false });
  // 注入 cookies
  if (opts.cookies) {
    for (const c of parseCookieString(opts.cookies, domain)) {
      try { await ctx.addCookies([c]); } catch {}
    }
  }
  // 注入 localStorage（迅雷 device-id / client-id 等）
  if (opts.localStorageStr) {
    try {
      const pairs = parseCookieString(opts.localStorageStr, domain);
      const page = await ctx.newPage();
      for (const p of pairs) {
        try { await page.evaluate((k, v) => { try { localStorage.setItem(k, v); } catch {} }, p.name, p.value); } catch {}
      }
      await page.close().catch(() => {});
    } catch {}
  }
  return ctx;
}

// ---------- 平台专用解析 ----------

// 夸克网盘（分享页 + 个人盘）
async function scrapeQuark(browser, url, opts) {
  const domain = 'quark.cn';
  const ctx = await buildAuthedContext(browser, url, { ...opts, cookies: opts.cookies });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  const block = await detectBlock(page);
  if (block.length && !opts.cookies) {
    await ctx.close();
    const taskId = taskKey();
    return { ok: false, platform: 'quark', requireLogin: true, requireInteraction: true, taskId, signals: block, url };
  }
  const apiLinks = await extractViaApiIntercept(page, { waitMs: 7000 });
  const domLinks = await extractViaDom(page);
  await ctx.close();
  const files = mergeLinks(apiLinks, domLinks);
  return { ok: true, platform: 'quark', files, needLogin: block.length > 0 };
}

// 百度网盘（分享页 + 个人盘）
async function scrapeBaidu(browser, url, opts) {
  const ctx = await buildAuthedContext(browser, url, { ...opts, cookies: opts.cookies });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  const block = await detectBlock(page);
  if (block.length && !opts.cookies) {
    await ctx.close();
    const taskId = taskKey();
    return { ok: false, platform: 'baidu', requireLogin: true, requireInteraction: true, taskId, signals: block, url };
  }
  const apiLinks = await extractViaApiIntercept(page, { waitMs: 7000 });
  const domLinks = await extractViaDom(page);
  await ctx.close();
  const files = mergeLinks(apiLinks, domLinks);
  return { ok: true, platform: 'baidu', files, needLogin: block.length > 0 };
}

// 迅雷云盘（分享页 + 个人盘 ?path=）
async function scrapeXunlei(browser, url, opts) {
  const ctx = await buildAuthedContext(browser, url, opts);
  const page = await ctx.newPage();
  // 迅雷个人盘需要 device-id / client-id；除 cookies 外，优先用传入的 deviceId/clientId 写入 localStorage
  if (opts.deviceId || opts.clientId) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      if (opts.deviceId) await page.evaluate((v) => { try { localStorage.setItem('deviceid', v); localStorage.setItem('xunlei_device_id', v); } catch {} }, opts.deviceId).catch(() => {});
      if (opts.clientId) await page.evaluate((v) => { try { localStorage.setItem('xunlei_client_id', v); localStorage.setItem('client_id', v); } catch {} }, opts.clientId).catch(() => {});
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    } catch {}
  } else {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }
  const block = await detectBlock(page);
  if (block.length && !opts.cookies) {
    await ctx.close();
    const taskId = taskKey();
    return { ok: false, platform: 'xunlei', requireLogin: true, requireInteraction: true, taskId, signals: block, url };
  }
  // 个人盘：若 URL 带 path=，尝试用网盘私有 API 递归列出文件夹内的文件直链
  const isMyDrive = /\?.*\bpath=/.test(url);
  let apiFiles = [];
  if (isMyDrive) {
    apiFiles = await extractXunleiMyDrive(page, opts);
  }
  const apiLinks = await extractViaApiIntercept(page, { waitMs: 7000 });
  const domLinks = await extractViaDom(page);
  await ctx.close();
  const files = mergeLinks(apiFiles, apiLinks, domLinks);
  return { ok: true, platform: 'xunlei', files, isMyDrive, needLogin: block.length > 0 };
}

// 迅雷个人盘：在已注入登录态的 page 上下文里直接调私有 API 列出文件并取 download_url。
// 自动带同源 Cookie，无需手动拼 header。device-id 已在 localStorage 注入。
async function extractXunleiMyDrive(page, opts) {
  return page.evaluate(async (opts) => {
    const out = [];
    const seen = new Set();
    const push = (name, url) => { if (url && /^https?:/i.test(url) && !seen.has(url)) { seen.add(url); out.push({ name: (name || '').slice(0, 200), url, source: 'xunlei-api' }); } };

    const API = 'https://api-pan.xunlei.com/drive/v1';
    const headers = { 'Content-Type': 'application/json' };
    // 提取 space：从 cookie 或 page 全局
    const getSpace = () => {
      try {
        const m = (document.cookie.match(/space=([^;]+)/) || [])[1];
        if (m) return decodeURIComponent(m);
      } catch {}
      return 'space';
    };

    async function listFiles(parentId, space) {
      const url = `${API}/files?parent_folder_id=${encodeURIComponent(parentId)}&space=${encodeURIComponent(space)}&with_audit=true&limit=100&offset=0`;
      const r = await fetch(url, { headers, credentials: 'include' });
      if (!r.ok) return [];
      const j = await r.json();
      return (j && j.data && j.data.children) || [];
    }

    async function getDownloadUrl(fileId, space) {
      const url = `${API}/files/download_url?space=${encodeURIComponent(space)}`;
      const r = await fetch(url, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ file_id: fileId, space }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return (j && j.download_url) || (j && j.data && j.data.download_url) || null;
    }

    const space = getSpace();
    // 从当前 URL 的 path= 推断起始文件夹；若无则列根目录
    const params = new URLSearchParams(location.search);
    const pathParam = params.get('path') || '/';
    // 尝试拿到根目录文件列表（个人盘根 folder_id 通常为 "" 或 "0"）
    try {
      const root = await listFiles('', space);
      for (const f of root) {
        const name = f.name || f.file_name;
        if (f.kind === 'folder' || f.folder_type || f.category === 'folder') {
          const children = await listFiles(f.id || f.file_id, space);
          for (const c of children) {
            const cn = c.name || c.file_name;
            const durl = await getDownloadUrl(c.id || c.file_id, space);
            push(cn, durl);
          }
        } else {
          const durl = await getDownloadUrl(f.id || f.file_id, space);
          push(name, durl);
        }
      }
    } catch (e) { /* 接口不可用则回退到纯拦截 */ }
    return out;
  }, opts).catch(() => []);
}

// 电驴 / 磁力：直接把 ed2k/thunder/magnet 链接交给 Aria2（无需浏览器）
async function scrapeEd2k(url) {
  const links = [];
  if (url.startsWith('ed2k://')) links.push({ name: url.split('|')[2] || 'ed2k-file', url, source: 'native' });
  else if (url.startsWith('thunder://')) {
    try { const dec = Buffer.from(url.replace(/^thunder:\/\//i, ''), 'base64').toString('utf8'); links.push({ name: 'thunder-link', url: dec.replace(/^AA|ZZ$/g, ''), source: 'native' }); } catch { links.push({ name: 'thunder-link', url, source: 'native' }); }
  } else if (url.startsWith('magnet:')) {
    const dn = (url.match(/dn=([^&]+)/) || [])[1];
    links.push({ name: decodeURIComponent(dn || 'magnet-file'), url, source: 'native' });
  }
  return { ok: true, platform: 'ed2k', files: links };
}

// 合并去重（api 优先于 dom）
function mergeLinks(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const f of (list || [])) {
      if (!f || !f.url) continue;
      const key = f.url;
      if (!map.has(key)) map.set(key, f);
    }
  }
  return [...map.values()];
}

// ---------- 主入口 ----------

export async function scrapeNetdisk({ url, cookies = '', localStorageStr = '', deviceId = '', clientId = '', autoDownload = true, downloadDir = '' } = {}) {
  const platform = detectPlatform(url);
  if (platform === 'ed2k' || platform === 'magnet') {
    const r = await scrapeEd2k(url);
    if (autoDownload && r.files.length) {
      for (const f of r.files) {
        await aria2Manager.aria2AddUri([f.url], { dir: downloadDir || undefined, out: f.name || undefined }).catch(() => {});
      }
      r.downloaded = r.files.map((f) => f.url);
    }
    return r;
  }

  if (platform === 'unknown') {
    return { ok: false, error: 'unsupported-netdisk', platform: 'unknown' };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  } catch (e) {
    return { ok: false, error: 'playwright-launch-failed', detail: String(e && e.message || e) };
  }

  const opts = { cookies, localStorageStr, deviceId, clientId };
  let result;
  try {
    if (platform === 'quark') result = await scrapeQuark(browser, url, opts);
    else if (platform === 'baidu') result = await scrapeBaidu(browser, url, opts);
    else if (platform === 'xunlei') result = await scrapeXunlei(browser, url, opts);
  } catch (e) {
    result = { ok: false, platform, error: 'scrape-exception', detail: String(e && e.message || e) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  // 需要人工交互（登录/验证码）：挂起任务，等待前端回填
  if (result && result.requireInteraction && result.taskId) {
    const resumed = await waitForInteraction(result.taskId, platform, url);
    if (resumed && resumed.resumed) {
      const newCookies = (resumed.payload && resumed.payload.cookies) || cookies;
      const newLs = (resumed.payload && resumed.payload.localStorageStr) || localStorageStr;
      return scrapeNetdisk({ url, cookies: newCookies, localStorageStr: newLs, autoDownload, downloadDir });
    }
    return result; // 超时未回填
  }

  if (result && result.ok && result.files && result.files.length) {
    const dl = [];
    for (const f of result.files) {
      if (!f.url || !/^https?:|^ed2k:|^magnet:|^thunder:/.test(f.url)) continue;
      // 放宽白名单：只过滤明显非文件链接（html 页面），其余一律放行
      if (/\.(html?|js|css|json|map)(\?|$)/i.test(f.url.split('?')[0]) && !/\.(zip|rar|7z|tar|gz|tgz|iso|dmg|mp4|mkv|mov|avi|webm|part|001|exe|apk|pdf|docx?|xlsx?|pptx?|jpg|jpeg|png)\b/i.test(f.url)) continue;
      const headers = [];
      if (/xunlei|xlcdn|tc\.xunlei/i.test(f.url)) headers.push('Referer: https://pan.xunlei.com/');
      const addOpts = { dir: downloadDir || undefined, out: f.name || undefined };
      if (headers.length) addOpts.header = headers;
      await aria2Manager.aria2AddUri([f.url], addOpts).catch(() => {});
      dl.push(f.url);
    }
    result.downloaded = dl;
    if (!dl.length) result.ok = false, result.error = 'no-valid-file-links';
  } else if (result && result.ok && (!result.files || !result.files.length)) {
    result.ok = false;
    result.error = 'no-files-found';
    result.needLogin = result.needLogin;
  }
  return result;
}
