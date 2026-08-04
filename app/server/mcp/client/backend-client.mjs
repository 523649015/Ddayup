// 后端 HTTP 客户端（单一职责：封装对 hmdao-api 的调用）。
// 所有需要平台能力的 MCP 工具都通过它访问；后端不可达时返回结构化错误而非抛出异常。

export class BackendClient {
  constructor({ baseUrl, timeoutMs = 15000 } = {}) {
    this.baseUrl = (baseUrl || process.env.HMDAO_API_BASE_URL || 'http://127.0.0.1:8792').replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  async _request(method, pathname, { body, query } = {}) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const opts = { method, headers: { Accept: 'application/json', Connection: 'close' }, signal: controller.signal };
      if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(url, opts);
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }
      return { ok: res.ok, status: res.status, data: json };
    } catch (err) {
      return { ok: false, status: 0, data: null, error: String((err && err.message) || err) };
    } finally {
      clearTimeout(timer);
    }
  }

  getHealth() {
    return this._request('GET', '/api/health');
  }

  getPlatform() {
    return this._request('GET', '/api/health/platform');
  }

  listAssets() {
    return this._request('GET', '/api/assets/library');
  }

  getAsset(assetId) {
    return this._request('GET', `/api/assets/content/${encodeURIComponent(String(assetId))}`);
  }

  importAsset({ sourceUrl, type, name, pageUrl } = {}) {
    return this._request('POST', '/api/assets/import', {
      body: { sourceUrl, type, name, pageUrl },
    });
  }

  deleteAsset(assetIds = []) {
    return this._request('POST', '/api/assets/delete', {
      body: { assetIds: Array.isArray(assetIds) ? assetIds : [assetIds] },
    });
  }
}
