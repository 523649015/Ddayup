export interface LocalAudioGenerationPayload {
  mode: 'bgm' | 'sfx' | 'voiceover';
  prompt: string;
  duration: number;
  intensity?: number;
  voicePreset?: string;
  speechRate?: number;
  language?: 'zh' | 'en';
  backend?: 'fallback-local' | 'audioldm2' | 'voxcpm';
}

export interface LocalAudioGenerationResult {
  blob?: Blob;
  url: string;
  assetId?: string;
  mimeType?: string;
  format: string;
  duration: number;
  size: number;
  sampleRate: number;
  channels: number;
  engine: string;
  mode: 'bgm' | 'sfx' | 'voiceover';
  voiceName?: string;
  requestedBackend: string;
  backend: string;
  backendLabel: string;
  backendAvailable: boolean;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function generateAudioLocally(
  payload: LocalAudioGenerationPayload,
): Promise<{ success: true; data: LocalAudioGenerationResult } | { success: false; error: string }> {
  try {
    const response = await fetch('/api/local-audio/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !result?.success) {
      return {
        success: false,
        error: String((result?.error as { message?: string } | undefined)?.message || `local-audio-generate-failed:${response.status}`),
      };
    }

    const mimeType = String(result.mimeType || 'audio/wav');
    const outputUrl = String(result.outputUrl || '').trim();
    const outputAssetId = String(result.outputAssetId || '').trim();
    const outputBase64 = String(result.outputBase64 || '');
    const blob = outputBase64 ? new Blob([base64ToBytes(outputBase64)], { type: mimeType }) : undefined;
    return {
      success: true,
      data: {
        blob,
        url: outputUrl || (blob ? URL.createObjectURL(blob) : ''),
        assetId: outputAssetId || undefined,
        mimeType,
        format: String(result.format || 'wav'),
        duration: Math.max(0, Number(result.duration || 0)),
        size: Number(result.size || blob?.size || 0),
        sampleRate: Math.max(0, Number(result.sampleRate || 0)) || 44100,
        channels: Math.max(0, Number(result.channels || 0)) || 2,
        engine: String(result.engine || 'local-audio'),
        mode: String(result.mode || payload.mode) as 'bgm' | 'sfx' | 'voiceover',
        voiceName: String(result.voiceName || ''),
        requestedBackend: String(result.requestedBackend || payload.backend || 'fallback-local'),
        backend: String(result.backend || 'fallback-local'),
        backendLabel: String(result.backendLabel || '本地预览链'),
        backendAvailable: Boolean(result.backendAvailable ?? true),
        fallbackUsed: Boolean(result.fallbackUsed),
        fallbackReason: String(result.fallbackReason || ''),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'local-audio-generate-failed',
    };
  }
}

export interface RemoteAudioGenerationPayload extends Omit<LocalAudioGenerationPayload, 'backend'> {
  model: string;
  provider?: string;
  upstreamModel?: string;
  instructions?: string;
}

export async function generateAudioRemotely(
  payload: RemoteAudioGenerationPayload,
): Promise<{ success: true; data: LocalAudioGenerationResult } | { success: false; error: string }> {
  try {
    const response = await fetch('/api/audio/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !result?.success) {
      return {
        success: false,
        error: String(result?.error || `remote-audio-generate-failed:${response.status}`),
      };
    }

    const mimeType = String(result.mimeType || 'audio/wav');
    const outputUrl = String(result.outputUrl || '').trim();
    const outputAssetId = String(result.outputAssetId || '').trim();
    const outputBase64 = String(result.outputBase64 || '');
    const blob = outputBase64 ? new Blob([base64ToBytes(outputBase64)], { type: mimeType }) : undefined;
    return {
      success: true,
      data: {
        blob,
        url: outputUrl || (blob ? URL.createObjectURL(blob) : ''),
        assetId: outputAssetId || undefined,
        mimeType,
        format: String(result.format || 'wav'),
        duration: Math.max(0, Number(result.duration || 0)),
        size: Number(result.size || blob?.size || 0),
        sampleRate: Math.max(0, Number(result.sampleRate || 0)) || 44100,
        channels: Math.max(0, Number(result.channels || 0)) || 2,
        engine: String(result.engine || payload.model),
        mode: String(result.mode || payload.mode) as 'bgm' | 'sfx' | 'voiceover',
        voiceName: String(result.voiceName || ''),
        requestedBackend: String(result.requestedBackend || payload.model),
        backend: String(result.backend || payload.model),
        backendLabel: String(result.backendLabel || payload.model),
        backendAvailable: Boolean(result.backendAvailable ?? true),
        fallbackUsed: Boolean(result.fallbackUsed),
        fallbackReason: String(result.fallbackReason || ''),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'remote-audio-generate-failed',
    };
  }
}

/**
 * 音频运行期「免费额度模型优先 → 不行则按优先级切换付费 API 模型」封装。
 * 优先使用回退链首条（免费）模型，失败则依次切换下一条（付费）模型。
 * 若未提供回退链，直接走普通 generateAudioRemotely（不破坏既有行为）。
 */
export async function generateAudioWithFallback(
  basePayload: RemoteAudioGenerationPayload,
  chain?: Array<{ provider: string; model: string; isFree: boolean }>,
): Promise<{ success: true; data: LocalAudioGenerationResult } | { success: false; error: string }> {
  if (!chain || chain.length === 0) {
    return generateAudioRemotely(basePayload);
  }
  let lastError = '';
  for (const c of chain) {
    if (!c.provider || !c.model) continue;
    try {
      const res = await generateAudioRemotely({
        ...basePayload,
        model: c.model,
        provider: c.provider,
      });
      if (res.success) {
        return {
          success: true,
          data: {
            ...res.data,
            engine: c.model,
            backend: c.model,
            requestedBackend: c.model,
            fallbackUsed: res.data.fallbackUsed,
            fallbackReason: res.data.fallbackReason,
          },
        };
      }
      lastError = res.error;
    } catch (e) {
      lastError = e instanceof Error ? e.message : 'audio-model-throw';
    }
  }
  return { success: false, error: lastError || '音频模型回退全部失败' };
}
