#!/usr/bin/env node
/**
 * 云桥网络 (yunqiaonet.com) 教程/资源爬虫 —— Playwright 版（自动读取登录态 Cookie）
 *
 * 用途：抓取分类列表 → 翻页 → 进详情页(带会员登录态) → 提取百度网盘链接+提取码+解压密码 → 归档 JSON/CSV
 *
 * Cookie 处理（选项 B：代码自动）：
 * - 用 chromium.launchPersistentContext(profileDir) 持久化登录态，首次需手动登录一次，之后全自动。
 * - 运行前脚本会检测是否已登录（检查 Cookie 中 wordpress_logged_in）；未登录则提示用 --login 开可见光浏览器手动登录。
 * - 登录态失效（网盘链接为空）时，重跑 --login 重新登录即可。
 *
 * 仅供个人备份/索引，请勿公开分发（违反站点服务条款）。
 *
 * 用法：
 *   首次登录（开可见光浏览器，登录后 Ctrl+C）：
 *     node scripts/yunqiao-crawler.mjs --login
 *   爬取（headless 全自动）：
 *     node scripts/yunqiao-crawler.mjs --cats https://www.yunqiaonet.com/blender/blender-jc
 *     node scripts/yunqiao-crawler.mjs --cats-file cats.txt --out ./yunqiao-courses.json --delay 800
 *
 * 选项：
 *   --login               开可见光浏览器，让你手动登录一次（并存登录态）
 *   --profile <dir>       持久化登录态目录（默认 ./scripts/tmp/yunqiao-profile）
 *   --cats <url>[,url...] 要爬的分类首页 URL（逗号分隔）
 *   --cats-file <path>    每行一个分类 URL 的文本文件
 *   --out <path>          输出 JSON 路径（默认 ./yunqiao-courses.json）
 *   --csv <path>          额外输出 CSV（可选）
 *   --delay <ms>          每请求间隔，默认 800ms（礼貌爬取）
 *   --max-pages <n>       每分类最多翻几页（调试用，默认 9999）
 *   --skip-detail         只抓列表层，不进详情页（不需要登录态）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://www.yunqiaonet.com';
const DEFAULT_PROFILE = path.resolve(__dirname, 'tmp', 'yunqiao-profile');

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
function getArg(name, def) {
  const i = argv.indexOf(name);
  if (i === -1) return def;
  return argv[i + 1] ?? def;
}
const doLogin = argv.includes('--login');
const profileDir = getArg('--profile', DEFAULT_PROFILE);
const catsRaw = getArg('--cats', '');
const catsFile = getArg('--cats-file', '');
const outJson = getArg('--out', path.resolve(__dirname, 'yunqiao-courses.json'));
const outCsv = getArg('--csv', '');
const delay = parseInt(getArg('--delay', '800'), 10);
const maxPages = parseInt(getArg('--max-pages', '9999'), 10);
const skipDetail = argv.includes('--skip-detail');

let cats = [];
if (catsRaw) cats = catsRaw.split(',').map((s) => s.trim()).filter(Boolean);
if (catsFile) {
  const txt = fs.readFileSync(catsFile, 'utf8');
  cats.push(...txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
}
if (!doLogin && !cats.length) {
  console.error('[用法] 至少需要 --cats <url> 或 --cats-file <file>；或 --login 手动登录');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- HTML 解析（与登录态无关，纯文本正则） ----------
function extractDetailLinks(html, origin = BASE) {
  const out = [];
  const re = /<a\b([^>]*?)\bhref=["']([^"']+)["']([^>]*?)>([\s\S]*?)<\/a>/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(html))) {
    const attrs = m[1] + ' ' + m[3];
    const href = m[2];
    const titleMatch = attrs.match(/\btitle=["']([^"']*)["']/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const idMatch = href.match(/\/([a-z0-9\-]+)\/(\d+)\/?$/i) || href.match(/\/jc\/(\d+)\/?$/i);
    if (!idMatch) continue;
    if (/^page$/i.test(idMatch[1])) continue; // 排除 /page/N 分页
    let abs = href;
    if (href.startsWith('/')) abs = origin + href;
    else if (!/^https?:\/\//i.test(href)) continue;
    if (!abs.startsWith(origin)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
  const text = m[4].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    out.push({ url: abs, title: title || text, id: idMatch[2] });
  }
  return out;
}

function extractPageLinks(html, origin = BASE) {
  const pages = new Set();
  const re1 = /<a\b[^>]*\bhref=["']([^"']*?\/page\/(\d+)[^"']*)["'][^>]*>/gi;
  let m;
  while ((m = re1.exec(html))) {
    let href = m[1];
    if (href.startsWith('/')) href = origin + href;
    else if (!/^https?:\/\//i.test(href)) continue;
    if (href.startsWith(origin)) pages.add(parseInt(m[2], 10));
  }
  const re2 = /<a\b[^>]*\bhref=["']([^"']*?paged=(\d+)[^"']*)["'][^>]*>/gi;
  while ((m = re2.exec(html))) {
    let href = m[1];
    if (href.startsWith('/')) href = origin + href;
    else if (!/^https?:\/\//i.test(href)) continue;
    if (href.startsWith(origin)) pages.add(parseInt(m[2], 10));
  }
  return [...pages].sort((a, b) => a - b);
}

function extractTotalPages(html) {
  const m = html.match(/(\d+)\s*\/\s*(\d+)/);
  if (m && parseInt(m[2], 10) > parseInt(m[1], 10)) return parseInt(m[2], 10);
  return null;
}

// 从详情页(登录态)提取百度网盘链接 / 提取码 / 解压密码
// 关键：云桥的下载按钮是 /goto?down=BASE64，服务器 302 重定向到 pan.baidu.com/s/xxx?pwd=提取码
function extractPanInfo(html, pageHtmlUrl) {
  const info = { panLinks: [], extractCode: '', unzipPassword: '', gotoTokens: [] };
  const panRe = /https?:\/\/(?:[a-z]+\.)?pan\.baidu\.com\/s\/[A-Za-z0-9_\-]+/gi;
  const set = new Set();
  let pm;
  while ((pm = panRe.exec(html))) set.add(pm[0]);
  info.panLinks = [...set];

  // 提取 /goto?down= 跳转 token（详情页按钮）
  const gotoRe = /href=["']([^"']*?\/goto\?down=[A-Za-z0-9_\-]+)["']/gi;
  let gm;
  while ((gm = gotoRe.exec(html))) {
    const u = gm[1].startsWith('http') ? gm[1] : (pageHtmlUrl ? new URL(gm[1], pageHtmlUrl).href : gm[1]);
    info.gotoTokens.push(u);
  }

  const codeRe = /(?:提取码|密码|访问码|提取密码)\s*[:：]?\s*([A-Za-z0-9]{4})/i;
  const cm = html.match(codeRe);
  if (cm) {
    info.extractCode = cm[1];
    info.panPassword = cm[1];
  }
  const unzipRe = /(?:解压密码|解压码)\s*[:：]\s*([A-Za-z0-9_\-]{3,32})/i;
  const um = html.match(unzipRe);
  if (um) info.unzipPassword = um[1];
  return info;
}

async function isLoggedIn(page) {
  try {
    const cookies = await page.context().cookies('https://www.yunqiaonet.com');
    return cookies.some((c) => /wordpress_logged_in/i.test(c.name));
  } catch {
    return false;
  }
}

// ---------- 主流程 ----------
const results = [];
const detailKeySeen = new Set();
let browser;
let page;

async function getPageHtml(url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await sleep(300);
  return await page.content();
}

async function crawlCategory(catUrl) {
  console.log(`\n=== 分类：${catUrl}`);
  const visitedPages = new Set();
  let frontier = [catUrl];
  let crawledCount = 0;

  while (frontier.length) {
    const url = frontier.shift();
    if (visitedPages.has(url)) continue;
    visitedPages.add(url);
    crawledCount++;
    if (crawledCount > maxPages) {
      console.log(`  · 已达 --max-pages ${maxPages} 上限，停止`);
      break;
    }
    console.log(`  · 列表页 ${url}`);
    let html;
    try {
      html = await getPageHtml(url);
    } catch (e) {
      console.error(`    ✗ 列表页失败：${e.message}`);
      break;
    }
    const total = extractTotalPages(html);
    if (total) console.log(`    该分类共 ${total} 页`);

    const links = extractDetailLinks(html);
    console.log(`    找到 ${links.length} 条条目`);
    for (const link of links) {
      const item = {
        id: link.id,
        title: (link.title || '').replace(/\s+/g, ' ').trim(),
        catUrl,
        detailUrl: link.url,
        panLinks: [],
        extractCode: '',
        unzipPassword: '',
        crawledAt: new Date().toISOString(),
      };
      results.push(item);
      if (!skipDetail && !detailKeySeen.has(link.url)) {
        detailKeySeen.add(link.url);
        await crawlDetail(item);
      }
      await sleep(delay);
    }

    const pageNums = extractPageLinks(html);
    for (const pn of pageNums) {
      const next = /\/page\/\d+$/.test(url)
        ? url.replace(/\/page\/\d+$/, `/page/${pn}`)
        : `${url.replace(/\/$/, '')}/page/${pn}`;
      if (!visitedPages.has(next)) frontier.push(next);
    }
    await sleep(delay);
  }
}

async function crawlDetail(item) {
  try {
    const html = await getPageHtml(item.detailUrl);
    const pan = extractPanInfo(html, item.detailUrl);
    item.panLinks = [...pan.panLinks];
    item.extractCode = pan.extractCode;
    item.unzipPassword = pan.unzipPassword || '';
    // 若 HTML 中没有直接的网盘链接，但存在 /goto?down= 跳转，则跟随重定向解析真实地址
    const seen = new Set(item.panLinks);
    if (pan.gotoTokens.length) {
      const cookies = await page.context().cookies('https://www.yunqiaonet.com');
      const ck = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      for (const token of pan.gotoTokens) {
        try {
          // 用浏览器 page.goto 跟随重定向（共享登录态 Cookie），拿到最终网盘 URL
          const resp = await page.goto(token, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => null);
          const finalUrl = (resp && resp.url()) || page.url();
          const ms = finalUrl.match(/\/s\/([A-Za-z0-9_\-]+)/i);
          const link = ms ? `https://pan.baidu.com/s/${ms[1]}` : '';
          let pwd = (finalUrl.match(/[?&]pwd=([A-Za-z0-9]+)/i) || [])[1] || '';
          // 若 URL 无 pwd，尝试从百度页面 DOM 提取"提取码"
          if (link && !pwd) {
            try {
              const code = await page.evaluate(() => {
                const el = document.querySelector('#accessCode, input.access-code, [class*=access]');
                if (el && el.value) return el.value;
                const m = document.body.innerText.match(/提取码[：:]?\s*([A-Za-z0-9]{4})/i);
                return m ? m[1] : '';
              });
              if (code) pwd = code;
            } catch {}
          }
          if (link && !seen.has(link)) {
            seen.add(link);
            item.panLinks.push(link);
            if (pwd) item.extractCode = pwd;
          }
        } catch (  e) {
          console.error(`      ↳ goto 解析失败：${e.message}`);
        }
      }
    }
    item.panLinks = [...seen];
    if (item.panLinks.length) {
      console.log(`    ✓ [${item.id}] ${item.title} → 网盘:${item.panLinks.length} 码:${item.extractCode || '-'}`);
    } else {
      console.log(`    · [${item.id}] ${item.title} → 无网盘链接(可能登录态失效/非网盘资源)`);
    }
  } catch (e) {
    console.error(`    ✗ 详情页失败 [${item.id}]：${e.message}`);
  }
}

async function ensureLogin() {
  fs.mkdirSync(profileDir, { recursive: true });
  browser = await chromium.launchPersistentContext(profileDir, {
    headless: !doLogin,
    args: ['--no-sandbox'],
  });
  page = browser.pages()[0] || (await browser.newPage());
  await page.goto(BASE + '/', { waitUntil: 'networkidle' }).catch(() => {});
  let ok = await isLoggedIn(page);
  if (doLogin) {
    if (ok) {
      console.log('✓ 已检测到登录态，登录态已保存到 profile。您可关闭窗口或 Ctrl+C。');
    } else {
      console.log('请在打开的浏览器窗口中登录云桥网络（永久会员账号）。');
      console.log('登录成功后本脚本会自动检测到并保存登录态，您随后可关闭窗口。');
      console.log('（若弹窗无法登录，确认没被拦截；登录后脚本会打印“检测到登录成功”）');
      for (let i = 0; i < 600; i++) {
        await sleep(1000);
        try {
          if (await isLoggedIn(page)) {
            console.log('✓ 检测到登录成功，登录态已保存到 profile。');
            break;
          }
        } catch {}
      }
    }
    await browser.close();
    return false;
  }
  if (!ok) {
    console.warn('[警告] 未检测到登录态。请先手动登录一次：node scripts/yunqiao-crawler.mjs --login');
  }
  return true;
}

async function main() {
  const cont = await ensureLogin();
  if (!cont) return;

  const t0 = Date.now();
  for (const c of cats) {
    await crawlCategory(c);
  }
  const withPan = results.filter((r) => r.panLinks && r.panLinks.length).length;
  fs.writeFileSync(outJson, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n完成：共 ${results.length} 条，其中含网盘链接 ${withPan} 条`);
  console.log(`输出：${outJson}`);

  if (outCsv) {
    const header = ['id', 'title', 'detailUrl', 'panLink', 'extractCode', 'unzipPassword'];
    const lines = [header.join(',')];
    for (const r of results) {
      const link = (r.panLinks && r.panLinks[0]) || '';
      const row = [r.id, `"${(r.title || '').replace(/"/g, '""')}"`, r.detailUrl, link, r.extractCode, r.unzipPassword];
      lines.push(row.join(','));
    }
    fs.writeFileSync(outCsv, lines.join('\n'), 'utf8');
    console.log(`CSV：${outCsv}`);
  }
  console.log(`耗时：${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await browser.close();
}

main().catch((e) => {
  console.error('FATAL', e);
  if (browser) browser.close().catch(() => {});
  process.exit(1);
});
