// 验证"被动捕获优先"闭环：模拟用户在网页端点击下载后 store.fileInfo[fid].direct 已被写入，
// resolveXunleiDirect 应直接命中被动值（via=passive-capture），不再发 download_url 请求。
import { chromium } from 'playwright';
import path from 'path';
import { execSync } from 'child_process';

const EXT_DIR = path.resolve('f:/Work/HMDAODAO/extension');
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE_PROFILE_SRC = path.resolve(process.env.LOCALAPPDATA, 'Microsoft/Edge/User Data');
const EXT_COPY = `C:\\tmp\\hmdao-ext-${Date.now()}`;
const EDGE_PROFILE_COPY = 'C:\\tmp\\edge-profile-copy-passive';
const SHARE_URL = 'https://pan.xunlei.com/s/VOj-h8suAkW9oy_-90W8M4r9A1?pwd=qkva&path=%2F%E6%A4%8D%E7%89%A9%E5%A4%A7%E6%88%98%E5%B0%B8%E6%9D%82%E4%BA%A4%E7%89%88';
const TARGET_FID = 'VOj-gdWBPeCnQdqryg0WRKi3A1';

const log = (...a) => console.log(...a);
try { execSync(`cmd /c robocopy "${EXT_DIR}" "${EXT_COPY}" /E /IS /IT /NFL /NDL /NJH /NJS`, { stdio: 'ignore' }); } catch (_) {}
try { execSync(`cmd /c robocopy "${EDGE_PROFILE_SRC}" "${EDGE_PROFILE_COPY}" /E /IS /IT /NFL /NDL /NJH /NJS`, { stdio: 'ignore' }); } catch (_) {}

(async () => {
  const context = await chromium.launchPersistentContext(EDGE_PROFILE_COPY, {
    executablePath: EDGE_EXE, headless: false,
    args: [`--load-extension=${EXT_COPY}`, `--disable-extensions-except=${EXT_COPY}`, '--no-first-run', '--no-default-browser-check'],
  });
  const page = await context.newPage();
  await page.goto(SHARE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('goto err', e.message));
  await page.waitForTimeout(8000);

  const result = await page.evaluate(async (TARGET_FID) => {
    const fn = window.__hmdao_xunlei_resolve_direct;
    const bag = window.__hmdao_xunlei_salvage;
    if (!fn || !bag) return { error: 'resolve_direct or bag not ready', hasResolve: !!fn, hasBag: !!bag };
    const store = bag();
    if (!store) return { error: 'bag() returned null' };

    // 模拟"用户在网页端点击下载"后被动捕获已写入直链
    const FAKE_DIRECT = 'https://xlcdn.com/path/PASSIVE-CAPTURED-ZIP.zip?fake=1';
    store.fileInfo[TARGET_FID] = { direct: FAKE_DIRECT, medias: [], ts: Date.now() };

    // 拦截 download_url 请求，确认 resolveXunleiDirect 不再发（命中被动值后应 break 出循环）
    let downloadUrlHits = 0;
    const XHR = window.XMLHttpRequest;
    const origOpen = XHR.prototype.open;
    XHR.prototype.open = function () {
      const u = arguments[1] || '';
      if (/download_url/.test(u)) downloadUrlHits++;
      return origOpen.apply(this, arguments);
    };
    const origFetch = window.fetch;
    window.fetch = function () {
      const u = (typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url)) || '';
      if (/download_url/.test(u)) downloadUrlHits++;
      return origFetch.apply(this, arguments);
    };

    const res = await fn([TARGET_FID]);
    return {
      out: res.out,
      detailsVia: res.details && res.details[TARGET_FID] && res.details[TARGET_FID].via,
      fileInfoOkCount: res.fileInfoOkCount,
      downloadUrlHits,
      hitPassive: (res.out && res.out[TARGET_FID] === FAKE_DIRECT),
    };
  }, TARGET_FID);

  log('===== PASSIVE-CAPTURE VERIFY =====');
  log(JSON.stringify(result, null, 2));
  await page.waitForTimeout(2000);
  await context.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
