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
