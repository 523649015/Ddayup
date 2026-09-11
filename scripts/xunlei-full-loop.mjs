// 端到端验证"needManualClick → 网页端点下载 → 被动捕获 → 自动重试下载"闭环。
// 步骤：1) 模拟首次下载（无被动值）→ 应返回 needManualClick
//       2) 模拟用户在网页端点下载 → 写入 store.fileInfo[fid].direct
//       3) 再次调 resolve_files → 应 ok 且 results[fid].direct 命中被动值
import { chromium } from 'playwright';
import path from 'path';
import { execSync } from 'child_process';

const EXT_DIR = path.resolve('f:/Work/HMDAODAO/extension');
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE_PROFILE_SRC = path.resolve(process.env.LOCALAPPDATA, 'Microsoft/Edge/User Data');
const EXT_COPY = `C:\\tmp\\hmdao-ext-${Date.now()}`;
const EDGE_PROFILE_COPY = 'C:\\tmp\\edge-profile-copy-loop';
const SHARE_URL = 'https://pan.xunlei.com/s/VOj-h8suAkW9oy_-90W8M4r9A1?pwd=qkva&path=%2F%E6%A4%8D%E7%89%A9%E5%A4%A7%E6%88%98%E5%B0%B8%E6%9D%82%E4%BA%A4%E7%89%88';
const TARGET_FID = 'VOj-gdWBPeCnQdqryg0WRKi3A1';

try { execSync(`cmd /c robocopy "${EXT_DIR}" "${EXT_COPY}" /E /IS /IT /NFL /NDL /NJH /NJS`, { stdio: 'ignore' }); } catch (_) {}
try { execSync(`cmd /c robocopy "${EDGE_PROFILE_SRC}" "${EDGE_PROFILE_COPY}" /E /IS /IT /NFL /NDL /NJH /NJS`, { stdio: 'ignore' }); } catch (_) {}

(async () => {
  const context = await chromium.launchPersistentContext(EDGE_PROFILE_COPY, {
    executablePath: EDGE_EXE, headless: false,
    args: [`--load-extension=${EXT_COPY}`, `--disable-extensions-except=${EXT_COPY}`, '--no-first-run', '--no-default-browser-check'],
  });
  const page = await context.newPage();
  await page.goto(SHARE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('goto err', e.message));
  await page.waitForTimeout(8000);

  const r = await page.evaluate(async (TARGET_FID) => {
    const resolveFiles = window.__hmdao_xunlei_resolve_files;
    const bag = window.__hmdao_xunlei_salvage;
    if (!resolveFiles || !bag) return { error: 'not ready' };
    const store = bag();

    // 步骤1：首次解析（无被动值）
    const first = await resolveFiles([TARGET_FID]);
    const firstOk = !!(first && first.ok && first.results && first.results[TARGET_FID] && first.results[TARGET_FID].direct);
    const firstNoDirect = !!(first && first.error === 'no-direct');

    // 步骤2：模拟用户在网页端点下载 → 被动捕获写入 store.fileInfo[fid].direct
    const FAKE = 'https://xlcdn.com/PASSIVE.zip?captured=1';
    store.fileInfo[TARGET_FID] = { direct: FAKE, medias: [], ts: Date.now() };

    // 步骤3：再次解析（应命中被动值）
    const second = await resolveFiles([TARGET_FID]);
    const secondOk = !!(second && second.ok && second.results && second.results[TARGET_FID] && second.results[TARGET_FID].direct === FAKE);

    return { firstOk, firstNoDirect, firstError: first && first.error, secondOk, secondDirect: second && second.results && second.results[TARGET_FID] && second.results[TARGET_FID].direct };
  }, TARGET_FID);

  console.log('===== FULL LOOP VERIFY =====');
  console.log(JSON.stringify(r, null, 2));
  await page.waitForTimeout(2000);
  await context.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
