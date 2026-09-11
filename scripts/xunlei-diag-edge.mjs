// 用本机 Edge + 已登录 Default profile 打开迅雷分享页，自动执行诊断并回传 list/fileInfo 结构。
// 用法：node scripts/xunlei-diag-edge.mjs
import { chromium } from 'playwright';
import path from 'path';

const EXT_DIR = path.resolve('f:/Work/HMDAODAO/extension');
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE_PROFILE_SRC = path.resolve(process.env.LOCALAPPDATA, 'Microsoft/Edge/User Data');
const EXT_COPY = `C:\\tmp\\hmdao-ext-${Date.now()}`; // 每次新路径强制重新加载扩展代码
const EDGE_PROFILE_COPY = 'C:\\tmp\\edge-profile-copy';
const SHARE_URL = 'https://pan.xunlei.com/s/VOj-h8suAkW9oy_-90W8M4r9A1?pwd=qkva&path=%2F%E6%A4%8D%E7%89%A9%E5%A4%A7%E6%88%98%E5%B0%B8%E6%9D%82%E4%BA%A4%E7%89%88';

const log = (...a) => console.log(...a);
import { execSync } from 'child_process';

// 重新复制一份扩展（新路径，强制重新加载代码）+ 清空旧 profile 副本缓存，确保运行的是最新 background.js
log('[edge-diag] fresh-copying extension to', EXT_COPY, '...');
try { execSync(`cmd /c robocopy "${EXT_DIR}" "${EXT_COPY}" /E /IS /IT /NFL /NDL /NJH /NJS`, { stdio: 'ignore' }); } catch (_) {}
log('[edge-diag] fresh-copying Edge profile to', EDGE_PROFILE_COPY, '...');
try { execSync(`cmd /c robocopy "${EDGE_PROFILE_SRC}" "${EDGE_PROFILE_COPY}" /E /IS /IT /NFL /NDL /NJH /NJS`, { stdio: 'ignore' }); } catch (_) {}
log('[edge-diag] copies ready.');

(async () => {
  log('[edge-diag] launching Edge with fresh extension + copied profile...');
  const context = await chromium.launchPersistentContext(EDGE_PROFILE_COPY, {
    executablePath: EDGE_EXE,
    headless: false, // 必须非 headless 才能加载扩展 + 带登录态
    args: [
      `--load-extension=${EXT_COPY}`,
      `--disable-extensions-except=${EXT_COPY}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
    // viewport 可选
  });

  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/\[HMDAO\]|\[DIAG\]|xunlei/i.test(t)) consoleLines.push(`[page:${m.type()}] ${t}`);
  });
  // 也收集 SW 转发的背景日志（MV3 SW console 会转发到页面）
  page.on('console', (m) => {
    const t = m.text();
    if (/xunlei-proxy|seen is not defined|FAILED/i.test(t)) consoleLines.push(`[sw:${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));

  log('[edge-diag] navigating to share URL...');
  try {
    await page.goto(SHARE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    log('[edge-diag] goto error:', e.message);
  }

  // 等待页面捕获（MAIN 世界注入 + API 响应）
  log('[edge-diag] waiting 12s for capture...');
  await page.waitForTimeout(12000);

  // 在页面上下文执行诊断，回传结构化结果
  log('[edge-diag] running __hmdao_xunlei_diagnose in page...');
  let diag = null;
  try {
    diag = await page.evaluate(async () => {
      if (!window.__hmdao_xunlei_diagnose) return { error: 'diagnose fn not injected (extension MAIN world not loaded?)' };
      const d = await window.__hmdao_xunlei_diagnose();
      const xs = window.__hmdao_captures && window.__hmdao_captures.xunleiShare;
      return {
        ...d,
        passCodeToken: (xs && xs.passCodeToken) || '(空)',
        authToken: (xs && (xs.authToken || (window.__hmdao_xunlei_state && window.__hmdao_xunlei_state().authToken))) || '(空)',
        rawList: (xs && xs.list) || [],
        rawFileInfo: (xs && xs.fileInfo) || {},
      };
    });
  } catch (e) {
    diag = { evalError: e.message };
  }

  log('[edge-diag] ===== DIAG RESULT =====');
  log(JSON.stringify(diag, null, 2));

  log('[edge-diag] ===== RELEVANT CONSOLE LINES =====');
  log(consoleLines.slice(-60).join('\n') || '(none)');

  // 等更久，让自动点击文件夹 + SPA 加载完成（scanXunleiDom 自动点击逻辑）
  log('[edge-diag] waiting 15s for auto-folder-expand (DOM click)...');
  await page.waitForTimeout(15000);

  // 重新 probe parent_folder_id（这次可能 200，回传完整结构）
  log('[edge-diag] re-probing parent_folder_id raw response...');
  try {
    const probe2 = await page.evaluate(async () => {
      const sid = window.__hmdao_captures?.xunleiShare?.shareId || 'VOj-h8suAkW9oy_-90W8M4r9A1';
      const pwd = window.__hmdao_captures?.xunleiShare?.pwd || 'qkva';
      const fid = 'VOj-gdTB91WnwpJ1mUgknd7fA1';
      const url = 'https://api-pan.xunlei.com/drive/v1/share?share_id=' + encodeURIComponent(sid) + '&pass_code=' + encodeURIComponent(pwd) + '&parent_folder_id=' + encodeURIComponent(fid) + '&limit=200&page_token=';
      const headers = { 'Content-Type': 'application/json', 'Referer': 'https://pan.xunlei.com/s/' + sid, 'x-device-id': '925b7631473a13716b791d7f28289cad', 'x-client-id': 'Xqp0kJBXWhwaTpB6' };
      const r = await window.__hmdao_xunlei_bridge_fetch(url, headers);
      const t = (r && typeof r.text === 'string') ? r.text : '';
      let parsed = null; try { parsed = JSON.parse(t); } catch (_) {}
      const arr = parsed ? (parsed.list || (parsed.data && parsed.data.list) || parsed.files || []) : [];
      return {
        status: r && r.status, error: r && r.error,
        filesLen: arr.length,
        files: arr.slice(0, 8).map((f) => ({ id: (f.id || '').slice(0, 20), name: f.name, size: f.size, isDir: f.isDir, subFileId: f.subFileId || '' })),
      };
    });
    log('[edge-diag] ===== PARENT_FOLDER PROBE (after expand) =====');
    log(JSON.stringify(probe2, null, 2));
  } catch (e) {
    log('[edge-diag] probe2 error:', e.message);
  }

  // 重新读 store.list，看是否展开了文件夹内的文件
  log('[edge-diag] re-reading store.list after auto-expand...');
  try {
    const afterExpand = await page.evaluate(() => {
      const xs = window.__hmdao_captures && window.__hmdao_captures.xunleiShare;
      const list = (xs && xs.list) || [];
      return {
        listLen: list.length,
        items: list.map((f) => ({ id: (f.id || '').slice(0, 24), name: f.name, size: f.size, isDir: f.isDir })),
        fileInfoKeys: xs ? Object.keys(xs.fileInfo || {}) : [],
        clicked: xs && xs.__xunleiClicked ? Object.keys(xs.__xunleiClicked) : [],
      };
    });
    log('[edge-diag] ===== STORE LIST AFTER AUTO-EXPAND =====');
    log(JSON.stringify(afterExpand, null, 2));
  } catch (e) {
    log('[edge-diag] re-read error:', e.message);
  }

  // 触发后台 HMDAO_NETDISK_RESOLVE，验证 needManualExpand 标志
  log('[edge-diag] triggering HMDAO_NETDISK_RESOLVE...');
  try {
    const resolveRes = await page.evaluate(async () => {
      const url = location.href;
      return await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'HMDAO_NETDISK_RESOLVE', url }, (res) => {
          resolve({ ok: !!(res && res.ok), needManualExpand: !!(res && res.needManualExpand), hint: (res && res.hint) || '', treeLen: res && res.tree ? res.tree.length : 0, tree: (res && res.tree || []).map((t) => ({ name: t.name, isDir: t.isDir })) });
        });
      });
    });
    log('[edge-diag] ===== NETDISK_RESOLVE RESULT =====');
    log(JSON.stringify(resolveRes, null, 2));
  } catch (e) {
    log('[edge-diag] resolve error:', e.message);
  }

  log('[edge-diag] done. keeping browser open 5s for manual inspection...');
  await page.waitForTimeout(5000);
  await context.close();
  process.exit(0);
})().catch((e) => {
  console.error('[edge-diag] FATAL', e);
  process.exit(1);
});
