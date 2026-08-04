import { readLocalMediaBlob } from '@/services/localMediaRegistry';
import type { AssetImageAnalysis, AssetItem } from '@/types/assets';
import type { AssetImportResult } from '@/api/assetLibrary';

interface AnalyzeImagePayload {
  item: AssetItem | AssetImportResult;
  engine?: string;
  provider?: string;
  model?: string;
}

interface AnalyzeImageResponse {
  success?: boolean;
  analysis?: AssetImageAnalysis;
  error?: { message?: string };
}

function buildJsonPayload(item: AssetItem, engine?: string, provider?: string, model?: string) {
  return {
    itemId: item.id,
    name: item.name,
    // 修复：优先使用可解析路径 item.url（如 /api/assets/content/<id>），
    // 后端据此取字节；仅当缺失时回退退化的 sourceUrl（纯文件名）。
    sourceUrl: item.url || item.sourceUrl,
    width: item.width,
    height: item.height,
    tags: item.tags,
    smartCategories: item.smartCategories,
    engine,
    provider,
    model,
  };
}

export async function analyzeAssetImage(params: AnalyzeImagePayload): Promise<AssetImageAnalysis> {
  const { item: rawItem, engine = 'auto', provider, model } = params;
  // 防御：兼容传入 importLocalAssetFile 返回的 { item, duplicate } 包装对象
  const item = ('item' in rawItem ? rawItem.item : rawItem) as AssetItem;
  if (item.type !== 'image') {
    throw new Error('only-image-assets-supported');
  }

  const localBlob = readLocalMediaBlob(item.url);
  let response: Response;

  if (localBlob) {
    const form = new FormData();
    form.append('file', localBlob, item.name || 'asset-image');
    form.append('itemId', item.id);
    form.append('name', item.name);
    form.append('width', String(item.width || ''));
    form.append('height', String(item.height || ''));
    form.append('tags', JSON.stringify(item.tags || []));
    form.append('smartCategories', JSON.stringify(item.smartCategories || []));
    form.append('engine', engine);
    if (provider) form.append('provider', provider);
    if (model) form.append('model', model);
    response = await fetch('/api/local-image/analyze', {
      method: 'POST',
      body: form,
    });
  } else {
    response = await fetch('/api/local-image/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildJsonPayload(item, engine, provider, model)),
    });
  }

  const data = await response.json().catch(() => ({})) as AnalyzeImageResponse;
  if (!response.ok || !data.success || !data.analysis) {
    throw new Error(data.error?.message || 'asset-image-analysis-failed');
  }
  return data.analysis;
}
