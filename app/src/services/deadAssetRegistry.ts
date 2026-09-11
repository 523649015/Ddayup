/**
 * 失效素材登记表。
 *
 * 背景：画布节点引用的素材被删除后，/api/assets/content/<id> 会返回 404。
 * 由于节点数据持久化在 localStorage，每次加载画布都会重新发起这个注定失败的请求，
 * 控制台持续刷 404。仅靠 onError 做渲染降级无法阻止请求本身。
 *
 * 方案：把已确认 404 的素材 ID 记入 localStorage，渲染前先查表，
 * 命中则直接显示占位、不再请求。首次仍会有一次 404（用于确认失效），之后彻底消除。
 */

const STORAGE_KEY = 'hmdao-dead-assets';
const MAX_ENTRIES = 500;

let cache: Set<string> | null = null;

function load(): Set<string> {
  if (cache) return cache;
  const set = new Set<string>();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string' && item) set.add(item);
        }
      }
    }
  } catch {
    /* 存储不可用时退化为内存态，不影响功能 */
  }
  cache = set;
  return set;
}

function persist(): void {
  try {
    const all = Array.from(load());
    // 只保留最近的若干条，避免登记表无限增长
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all.slice(-MAX_ENTRIES)));
  } catch {
    /* ignore */
  }
}

/** 从素材 URL 中提取素材 ID（形如 /api/assets/content/<id>） */
export function extractAssetId(url: string): string {
  const matched = /\/api\/assets\/content\/([^/?#]+)/.exec(String(url || ''));
  if (!matched) return '';
  try {
    return decodeURIComponent(matched[1]);
  } catch {
    return matched[1];
  }
}

/** 该素材是否已被确认失效（后端 404） */
export function isDeadAssetUrl(url: string): boolean {
  const id = extractAssetId(url);
  return Boolean(id) && load().has(id);
}

/** 标记素材失效（在图片/视频加载失败时调用） */
export function markAssetDead(url: string): void {
  const id = extractAssetId(url);
  if (!id) return;
  const set = load();
  if (set.has(id)) return;
  set.add(id);
  persist();
}

/** 清除记录（例如用户重新上传了同名素材，或手动重置） */
export function clearDeadAssets(): void {
  load().clear();
  persist();
}
