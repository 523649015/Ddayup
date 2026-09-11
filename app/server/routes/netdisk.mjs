// 网盘分享解析接口（Ddayup 扩展「深度解析」后端增强）
// 策略：直接调用网盘官方 Web API 解析出真实文件列表 + 下载直链（免登录），
// 让扩展把 zip/rar 直连下载到本地，而不是让用户去网盘页登录。
// 设计原则：不缓存、不写文件、仅用 Node 内置 fetch + 内置 crypto。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const XL_CLIENT_ID = 'Xqp0kJBXWhwaTpB6';
const XL_DEVICE_ID = '1bf91caf40093318e8040916eb7ad16a';

function parseUrl(rawUrl) {
  try { return new URL(rawUrl); } catch { return null; }
}
function xunleiShareId(u) {
  const m = u.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}
function quarkPwdId(u) {
  const m = u.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}
function extractPwd(url, body) {
  const m = url.match(/[?&]pwd=([\w]+)/);
  return (m && m[1]) || (body && body.pwd) || '';
}

// 取迅雷滑块验证 token（复用 Web 端固定 device_id + 硬编码 captcha_sign）
async function xunleiCaptchaToken() {
  try {
    const r = await fetch('https://xluser-ssl.xunlei.com/v1/shield/captcha/init', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: XL_CLIENT_ID,
        action: 'GET:/drive/v1/share',
        device_id: XL_DEVICE_ID,
        captcha_token: '',
        meta: {
          username: '',
          phone_number: '',
          email: '',
          package_name: 'pan.xunlei.com',
          client_version: '1.92.9',
          captcha_sign: '1.cbc20fd633c54023baab5b816228bf90',
          timestamp: '1757383155459',
          user_id: '',
        },
      }),
    });
    const j = await r.json().catch(() => null);
    if (j && j.captcha_token) return j.captcha_token;
    if (j && j.token) return j.token;
  } catch {}
  return '';
}

function xunleiBaseHeaders() {
  return {
    'User-Agent': UA,
    'accept-language': 'zh,en-GB;q=0.9,en-US;q=0.8,en;q=0.7,zh-CN;q=0.6',
    'authorization': '',
    'content-type': 'application/json',
    'x-client-id': XL_CLIENT_ID,
    'x-device-id': XL_DEVICE_ID,
  };
}

// 迅雷公开分享：列文件 + 取 zip/rar 下载直链（免登录）
async function tryXunlei(shareId, pwd) {
  const token = await xunleiCaptchaToken();
  if (!token) return { requireLogin: true, error: 'xunlei-captcha-token-failed' };
  const headers = xunleiBaseHeaders();
  headers['x-captcha-token'] = token;
  headers['Referer'] = `https://pan.xunlei.com/s/${shareId}?pwd=${pwd}`;

  // 第一步：拿分享文件列表
  const listUrl = `https://api-pan.xunlei.com/drive/v1/share?share_id=${encodeURIComponent(shareId)}&pass_code=${encodeURIComponent(pwd)}&limit=100&page_token=&thumbnail_size=SIZE_SMALL`;
  const lr = await fetch(listUrl, { method: 'GET', headers });
  const text = await lr.text().catch(() => '');
  let lj = null;
  try { lj = JSON.parse(text); } catch {}
  if (!lj || lj.code !== 0 || !lj.files || !lj.files.length) {
    // phase 要求验证（滑块/提取码）→ 诚实返回需登录/密码
    if (lj && lj.phase && lj.phase !== 'share_page') {
      return { requireLogin: true, error: 'xunlei-phase-' + lj.phase };
    }
    return { requireLogin: true, error: 'xunlei-no-files', rawHint: text.slice(0, 200) };
  }

  const shareId2 = lj.share_id || shareId;
  const passCodeToken = lj.pass_code_token || '';
  const files = [];
  for (const f of lj.files) {
    const name = f.name || '';
    const isDir = f.is_folder === 1 || f.isFolder === 1;
    const size = Number(f.size || f.file_size || 0) || 0;
    const ext = (name.split('.').pop() || '').toLowerCase();
    const isArchive = ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'iso', 'dmg', 'z', '001', 'part'].includes(ext);
    const isVideo = (f.file_category || '').toUpperCase() === 'VIDEO';
    const item = { name, size, isDir, isArchive, isVideo, direct: '' };
    // 取下载直链：视频/压缩包/单文件都走 file_info（最稳定）
    if (!isDir && (isArchive || isVideo || true)) {
      const infoUrl = `https://api-pan.xunlei.com/drive/v1/share/file_info?pass_code_token=${encodeURIComponent(passCodeToken)}&space=&file_id=${encodeURIComponent(f.id)}&share_id=${encodeURIComponent(shareId2)}&pass_code=${encodeURIComponent(pwd)}`;
      try {
        const ir = await fetch(infoUrl, { method: 'GET', headers });
        const ij = await ir.json().catch(() => null);
        if (ij && ij.file_info && ij.file_info.medias && ij.file_info.medias.length) {
          const m = ij.file_info.medias.find((x) => x.link && x.link.url) || ij.file_info.medias[0];
          if (m && m.link && m.link.url) item.direct = m.link.url;
        }
      } catch {}
    }
    files.push(item);
  }
  return files;
}

async function tryQuark(pwdId, pwd) {
  // 夸克分享：先取 stoken，再列文件（含 download_url）
  const t = await fetch('https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pwd_id: pwdId, passcode: pwd || '' }),
  });
  const tj = await t.json().catch(() => null);
  if (!tj || tj.status !== 0 || !tj.data || !tj.data.stoken) return null;
  const stoken = tj.data.stoken;
  const lr = await fetch('https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pwd_id: pwdId, stoken, pdir_fid: '0', _page: 1, _size: 100, _sort: 'file_name', _dir: 'ASC' }),
  });
  const lj = await lr.json().catch(() => null);
  if (!lj || lj.status !== 0) return null;
  const list = (lj.data && lj.data.list) || [];
  return list.map((f) => {
    const name = f.file_name || '';
    const size = Number(f.size || 0) || 0;
    const isDir = f.is_dir === 1;
    const ext = (name.split('.').pop() || '').toLowerCase();
    const isArchive = ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'iso', 'dmg', 'z', '001', 'part'].includes(ext);
    const media = (f.list && f.list[0]) || {};
    return { name, size, isDir, isArchive, direct: media.download_url || '' };
  }).filter((x) => x.name);
}

export function registerNetdiskRoutes(router, deps) {
  const { send, readJson } = deps;
  if (!send || !readJson) throw new Error('registerNetdiskRoutes: missing send/readJson deps');

  router.register('POST', '/api/netdisk/resolve', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const url = (body && body.url) || '';
    const u = parseUrl(url);
    if (!u) return send(res, 400, { ok: false, error: 'invalid-url' });
    const pwd = extractPwd(url, body);
    try {
      if (u.hostname.includes('xunlei')) {
        const files = await tryXunlei(xunleiShareId(u), pwd);
        if (Array.isArray(files)) {
          const archives = files.filter((f) => f.isArchive && f.direct);
          return send(res, 200, { ok: true, platform: 'xunlei', files, archives });
        }
        return send(res, 200, { ok: false, platform: 'xunlei', requireLogin: true, error: (files && files.error) || 'xunlei-no-files' });
      }
      if (u.hostname.includes('quark')) {
        const files = await tryQuark(quarkPwdId(u), pwd);
        if (Array.isArray(files)) {
          const archives = files.filter((f) => f.isArchive && f.direct);
          return send(res, 200, { ok: true, platform: 'quark', files, archives });
        }
        return send(res, 200, { ok: false, platform: 'quark', requireLogin: true, error: 'quark-need-valid-share' });
      }
    } catch (e) {
      return send(res, 200, { ok: false, requireLogin: false, error: String((e && e.message) || e) });
    }
    return send(res, 200, { ok: false, error: 'unsupported-netdisk' });
  });
}
