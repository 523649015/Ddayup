// 网盘深度解析（Playwright 托管）路由
// POST /api/netdisk/scrape  { url, cookies?, autoDownload?, downloadDir? }
//   -> 模拟浏览器访问网盘页，提取真实下载直链，可选直接触发 Aria2 下载
// GET  /api/netdisk/scrape/pending  -> 列出等待人工交互(验证码/登录)的挂起任务
// POST /api/netdisk/scrape/resolve  { taskId, cookies? } -> 回填后继续解析

import { scrapeNetdisk, resolveInteraction, getPendingTasks } from '../lib/netdisk-scraper.mjs';

export function registerNetdiskScrapeRoutes(router, deps) {
  const { send, readJson } = deps;
  if (!send || !readJson) throw new Error('registerNetdiskScrapeRoutes: missing send/readJson deps');

  router.register('POST', '/api/netdisk/scrape', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const url = (body && body.url) || '';
    if (!url) return send(res, 400, { ok: false, error: 'missing-url' });
    try {
      const result = await scrapeNetdisk({
        url,
        cookies: body.cookies || '',
        localStorageStr: body.localStorageStr || '',
        deviceId: body.deviceId || '',
        clientId: body.clientId || '',
        autoDownload: body.autoDownload !== false,
        downloadDir: body.downloadDir || '',
      });
      return send(res, 200, { ok: result.ok, ...result, url });
    } catch (e) {
      return send(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  router.register('GET', '/api/netdisk/scrape/pending', (req, res) => {
    return send(res, 200, { ok: true, pending: getPendingTasks() });
  });

  router.register('POST', '/api/netdisk/scrape/resolve', async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const { taskId, cookies } = body || {};
    if (!taskId) return send(res, 400, { ok: false, error: 'missing-taskId' });
    const r = resolveInteraction(taskId, { cookies: cookies || '' });
    return send(res, 200, r);
  });
}
