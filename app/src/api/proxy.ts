import { getApiConfig } from '@/config/api-config';

interface ProxyOptions {
  endpoint: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: Record<string, unknown> | string;
  headers?: Record<string, string>;
  timeout?: number;
  apiKey?: string;
  baseUrl?: string;
}

export async function proxyRequest(platformId: string, options: ProxyOptions): Promise<unknown> {
  const { method = 'POST', body, headers = {}, timeout = 60000, apiKey } = options;

  const config = getApiConfig();
  const platform = config.platforms.find((item) => item.id === platformId);
  if (!platform) throw new Error(`未知平台：${platformId}`);

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`/api/proxy/${platformId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        endpoint: options.endpoint,
        method,
        body,
        timeout,
        apiKey,
        baseUrl: options.baseUrl,
      }),
      signal: controller.signal,
    });

    const responseText = await response.text();
    const trimmed = responseText.trim();

    if (trimmed.startsWith('<!') || trimmed.startsWith('<html')) {
      throw new Error('后端服务未启动，请先启动 HMDao API 服务。');
    }

    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(`代理响应不是有效的 JSON（HTTP ${response.status}）。`);
    }

    if (!response.ok || !data.success) {
      const errorMessage = data.error?.message || data.message || `代理请求失败：HTTP ${response.status}。`;
      throw Object.assign(new Error(errorMessage), { status: response.status });
    }

    return data;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error(`请求超时：${timeout}ms。`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function testApiKey(
  platformId: string,
  apiKey: string,
  modelOverride?: string,
): Promise<{ success: boolean; message: string; model?: string }> {
  const config = getApiConfig();
  const platform = config.platforms.find((item) => item.id === platformId);
  if (!platform) return { success: false, message: `未知平台：${platformId}` };

  const testModel = modelOverride || platform.defaultTestModel;

  try {
    // 依据平台能力（modes）选择测试端点；用「端点确实存在」作为守卫，
    // 以精确还原旧的 type 维度路由（llm→chat、video→video、其余→image），
    // 避免 volcengine/fal/replicate 这类有 image 端点但无 video 端点的平台被误路由到 video。
    if (platform.modes.includes('llm') && platform.chatEndpoint) {
      await proxyRequest(platformId, {
        endpoint: platform.chatEndpoint || '/chat/completions',
        method: 'POST',
        body: {
          model: testModel,
          messages: [{ role: 'user', content: platform.testPrompt }],
          max_tokens: 10,
        },
        apiKey,
        timeout: 15000,
      });
    } else if (platform.modes.includes('video') && platform.videoEndpoint) {
      await proxyRequest(platformId, {
        endpoint: platform.videoEndpoint || '/videos/generations',
        method: 'POST',
        body: { model: testModel, prompt: platform.testPrompt, duration: 3, aspect_ratio: '16:9' },
        apiKey,
        timeout: 15000,
      });
    } else {
      await proxyRequest(platformId, {
        endpoint: platform.imageEndpoint || '/images/generations',
        method: 'POST',
        body: { model: testModel, prompt: platform.testPrompt },
        apiKey,
        timeout: 15000,
      });
    }
    return { success: true, message: 'API Key 校验成功。', model: testModel };
  } catch (error: any) {
    return { success: false, message: error.message || '校验失败。' };
  }
}
