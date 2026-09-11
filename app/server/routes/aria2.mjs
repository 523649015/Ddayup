// Aria2 download-channel routes for the Ddayup browser extension.
// Extension posts a netdisk direct link (or any http URL) here; the backend
// lazily starts aria2c --enable-rpc and forwards the task.

const ARIA2_PREFIX = '/api/aria2/';
const TASK_PREFIX = ARIA2_PREFIX + 'task/';
const VERIFY_PREFIX = ARIA2_PREFIX + 'verify/';

export function registerAria2Routes(router, deps) {
  const { send, readJson, getAria2Status, aria2AddUri, aria2TellStatus, aria2TellActive, aria2Remove, aria2VerifyHash } = deps;

  // Status: installed? running? (used by extension checkAria2()).
  router.register('GET', ARIA2_PREFIX + 'status', (req, res) => {
    send(res, 200, { ok: true, status: getAria2Status() });
  });

  // Add download task(s). body: { uris: string|string[], options?: {} }
  router.register('POST', ARIA2_PREFIX + 'add-uri', async (req, res) => {
    try {
      const body = await readJson(req);
      const uris = Array.isArray(body.uris) ? body.uris : [body.uris];
      if (!uris.length || !uris[0]) {
        return send(res, 400, { ok: false, error: 'missing uris' });
      }
      const gid = await aria2AddUri(uris, body.options || {});
      return send(res, 200, { ok: true, gid });
    } catch (e) {
      const code = e.message === 'aria2-not-installed' ? 412 : 500;
      return send(res, code, { ok: false, error: e.message });
    }
  });

  // Active tasks.
  router.register('GET', ARIA2_PREFIX + 'active', async (req, res) => {
    try {
      const list = await aria2TellActive();
      return send(res, 200, { ok: true, active: list });
    } catch (e) {
      return send(res, 500, { ok: false, error: e.message });
    }
  });

  // Verify a completed download's integrity against an expected hash.
  // GET /api/aria2/verify/:gid?hash=sha1:....
  router.registerPrefix('GET', VERIFY_PREFIX, async (req, res, url) => {
    const gid = decodeURIComponent(url.pathname.slice(VERIFY_PREFIX.length));
    const hash = url.searchParams.get('hash') || '';
    try {
      const result = await aria2VerifyHash(gid, hash);
      return send(res, result.ok ? 200 : 409, { ok: result.ok, ...result });
    } catch (e) {
      return send(res, 500, { ok: false, error: e.message });
    }
  });

  // Task status (GET) / remove (POST) by gid.
  router.registerPrefix(['GET', 'POST'], TASK_PREFIX, async (req, res, url) => {
    const gid = decodeURIComponent(url.pathname.slice(TASK_PREFIX.length));
    if (req.method === 'POST') {
      try {
        const ok = await aria2Remove(gid);
        return send(res, 200, { ok: true, removed: ok });
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message });
      }
    }
    try {
      const st = await aria2TellStatus(gid);
      return send(res, 200, { ok: true, status: st });
    } catch (e) {
      return send(res, 500, { ok: false, error: e.message });
    }
  });
}
