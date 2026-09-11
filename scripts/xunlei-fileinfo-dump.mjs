// 打印指定迅雷分享文件 file_info 的完整 body，确认真实网盘 id 字段名与 download_url 实际语义。
import { chromium } from 'playwright';
import path from 'path';
import { execSync } from 'child_process';

const EXT_DIR = path.resolve('f:/Work/HMDAODAO/extension');
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE_PROFILE_SRC = path.resolve(process.env.LOCALAPPDATA, 'Microsoft/Edge/User Data');
const EXT_COPY = `C:\\tmp\\hmdao-ext-${Date.now()}`;
const EDGE_PROFILE_COPY = 'C:\\tmp\\edge-profile-copy';
const SHARE_URL = 'https://pan.xunlei.com/s/VOj-h8suAkW9oy_-90W8M4r9A1?pwd=qkva&path=%2F%E6%A4%8D%E7%89%A9%E5%A4%A7%E6%88%98%E5%B0%B8%E6%9D%82%E4%BA%A4%E7%89%88';

const TARGET_FID = 'VOj-gdWBPeCnQdqryg0WRKi3A1'; // 植物大战僵尸杂交版v2.5.zip 的分享条目 id

const log = (...a) => console.log(...a);

log('[dump] fresh-copying extension...');
try { execSync(`cmd /c robocopy "${EXT_DIR}" "${EXT_COPY}" /E /IS /IT /NFL /NDL /NJH /NJS`, { stdio: 'ignore' }); } catch (_) {}
try { execSync(`cmd /c robocopy "${EDGE_PROFILE_SRC}" "${EDGE_PROFILE_COPY}" /E /IS /IT /NFL /NDL /NJH /NJS`, { stdio: 'ignore' }); } catch (_) {}

(async () => {
  const context = await chromium.launchPersistentContext(EDGE_PROFILE_COPY, {
    executablePath: EDGE_EXE,
    headless: false,
    args: [`--load-extension=${EXT_COPY}`, `--disable-extensions-except=${EXT_COPY}`, '--no-first-run', '--no-default-browser-check'],
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => log('[pageerror]', e.message));
  await page.goto(SHARE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('goto err', e.message));
  await page.waitForTimeout(10000);

  const result = await page.evaluate(async (TARGET_FID) => {
    const xs = window.__hmdao_captures && window.__hmdao_captures.xunleiShare;
    const shareId = (xs && xs.shareId) || 'VOj-h8suAkW9oy_-90W8M4r9A1';
    const pwd = (xs && xs.pwd) || 'qkva';
    const passToken = (xs && xs.passCodeToken) || '';
    const auth = (xs && (xs.authToken)) || (window.__hmdao_xunlei_state && window.__hmdao_xunlei_state().authToken) || '';
    const bridge = window.__hmdao_xunlei_bridge_fetch;
    if (!bridge) return { error: 'bridge not injected' };
    const headers = {
      'Content-Type': 'application/json',
      'Referer': 'https://pan.xunlei.com/s/' + shareId,
      'x-device-id': '925b7631473a13716b791d7f28289cad',
      'x-client-id': 'Xqp0kJBXWhwaTpB6',
    };
    if (auth) headers['Authorization'] = 'Bearer ' + auth;

    const out = { shareId, pwd, passToken: passToken.slice(0, 8) + '...', auth: auth.slice(0, 10) + '...' };

    // 1) file_info 完整 body（不截断）
    const fiUrl = `https://api-pan.xunlei.com/drive/v1/share/file_info?share_id=${encodeURIComponent(shareId)}&file_id=${encodeURIComponent(TARGET_FID)}&pass_code_token=${encodeURIComponent(passToken)}&pass_code=${encodeURIComponent(pwd)}`;
    const fi = await bridge(fiUrl, headers);
    out.fileInfo = { status: fi && fi.status, bodyFull: (fi && fi.text) || '' };

    // 2) download_url 用分享条目 id（当前代码行为）→ 预期 404
    const dlUrl1 = `https://api-pan.xunlei.com/drive/v1/share/download_url?share_id=${encodeURIComponent(shareId)}&file_id=${encodeURIComponent(TARGET_FID)}&pass_code_token=${encodeURIComponent(passToken)}&pass_code=${encodeURIComponent(pwd)}`;
    const dl1 = await bridge(dlUrl1, headers);
    out.downloadUrl_topFid = { status: dl1 && dl1.status, bodyFull: (dl1 && dl1.text) || '' };

    // 3) 尝试从 file_info 提取所有可能的真实 id 字段，逐一带入 download_url
    let parsed = null;
    try { parsed = JSON.parse(out.fileInfo.bodyFull); } catch (_) {}
    const fiObj = parsed && (parsed.file_info || parsed.data || parsed);
    const candidateIds = [];
    for (const k of Object.keys(fiObj || {})) {
      const v = fiObj[k];
      if (typeof v === 'string' && /^VOj-/.test(v) && v !== TARGET_FID) candidateIds.push({ key: k, val: v });
    }
    out.candidateIds = candidateIds;

    out.downloadUrlByCandidate = [];
    for (const c of candidateIds) {
      const u = `https://api-pan.xunlei.com/drive/v1/share/download_url?share_id=${encodeURIComponent(shareId)}&file_id=${encodeURIComponent(c.val)}&pass_code_token=${encodeURIComponent(passToken)}&pass_code=${encodeURIComponent(pwd)}`;
      const r = await bridge(u, headers);
      let rp = null; try { rp = JSON.parse(r.text); } catch (_) {}
      out.downloadUrlByCandidate.push({ key: c.key, id: c.val.slice(0, 24), status: r.status, body: (r.text || '').slice(0, 400), hasDownloadUrl: !!(rp && (rp.download_url || (rp.data && rp.data.download_url))) });
    }

    return out;
  }, TARGET_FID);

  log('===== RESULT =====');
  log(JSON.stringify(result, null, 2));
  await page.waitForTimeout(3000);
  await context.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
