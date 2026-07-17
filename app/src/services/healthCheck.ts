import { getStorageQuota } from '@/services/storage';
import { getCircuitStates } from '@/services/serviceErrorBoundary';

export interface HealthCheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  timestamp: number;
}

export interface SystemHealthReport {
  allPassed: boolean;
  results: HealthCheckResult[];
  timestamp: number;
}

function checkWebGL(): HealthCheckResult {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : '未知渲染器';
      return { name: 'WebGL', status: 'pass', message: `WebGL 可用 - ${renderer}`, timestamp: Date.now() };
    }
    return { name: 'WebGL', status: 'fail', message: 'WebGL 不可用，3D 功能将降级。', timestamp: Date.now() };
  } catch {
    return { name: 'WebGL', status: 'fail', message: 'WebGL 检测异常。', timestamp: Date.now() };
  }
}

function checkLocalStorage(): HealthCheckResult {
  try {
    const testKey = '__hmdao_health_check__';
    localStorage.setItem(testKey, '1');
    localStorage.removeItem(testKey);
    return { name: 'localStorage', status: 'pass', message: 'localStorage 读写正常。', timestamp: Date.now() };
  } catch {
    return { name: 'localStorage', status: 'fail', message: 'localStorage 不可用，状态持久化将失效。', timestamp: Date.now() };
  }
}

function checkIndexedDB(): Promise<HealthCheckResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HealthCheckResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const request = indexedDB.open('__hmdao_health_check__', 1);
      request.onsuccess = () => {
        request.result.close();
        indexedDB.deleteDatabase('__hmdao_health_check__');
        finish({ name: 'IndexedDB', status: 'pass', message: 'IndexedDB 可用。', timestamp: Date.now() });
      };
      request.onerror = () => {
        finish({ name: 'IndexedDB', status: 'warn', message: 'IndexedDB 不可用，大文件缓存将受限。', timestamp: Date.now() });
      };
      setTimeout(() => {
        finish({ name: 'IndexedDB', status: 'warn', message: 'IndexedDB 检测超时。', timestamp: Date.now() });
      }, 3000);
    } catch {
      finish({ name: 'IndexedDB', status: 'fail', message: 'IndexedDB 检测异常。', timestamp: Date.now() });
    }
  });
}

function buildApiHealthCandidates(): string[] {
  if (typeof window === 'undefined') return ['/api/health'];
  const current = window.location;
  const host = String(current.hostname || '').trim().toLowerCase();
  const isLocalHost = host === '127.0.0.1' || host === 'localhost';
  // 优先同源 /api/health（经 3000 代理到 8792），避免直连 8792 产生刺眼控制台红错
  const candidates = ['/api/health'];
  if (!isLocalHost) return candidates;

  // 同源失败后才降级探测常见本地端口（仅作为兜底，不主动首打）
  const localOrigins = [
    `${current.protocol}//${current.host}`,
    'http://127.0.0.1:3014',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:8792',
    'http://localhost:3014',
    'http://localhost:3000',
    'http://localhost:8792',
  ];

  const seen = new Set<string>();
  for (const origin of localOrigins) {
    const normalizedOrigin = String(origin || '').trim();
    if (!normalizedOrigin) continue;
    const url = normalizedOrigin.endsWith('/api/health')
      ? normalizedOrigin
      : `${normalizedOrigin.replace(/\/+$/, '')}/api/health`;
    if (seen.has(url) || url === '/api/health') continue;
    seen.add(url);
    candidates.push(url);
  }

  return candidates;
}

async function probeApiHealth(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: url.startsWith('http') ? 'omit' : 'same-origin',
    });

    let payload: Record<string, unknown> | null = null;
    try {
      payload = await response.clone().json();
    } catch {
      payload = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      url,
      payload,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function checkApiEndpoint(): Promise<HealthCheckResult> {
  const candidates = buildApiHealthCandidates();
  const failures: string[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const result = await probeApiHealth(candidate, index === 0 ? 5000 : 2500);
      const modeMessage = String(result.payload?.message || '').trim().toLowerCase();
      const dccGateway = result.payload?.capabilities && typeof result.payload.capabilities === 'object'
        ? Boolean((result.payload.capabilities as { dccGateway?: boolean }).dccGateway)
        : false;

      if (result.ok && modeMessage.includes('dev fallback') && !dccGateway) {
        return {
          name: 'API端点',
          status: 'warn',
          message: `前端 /api/health 可达，但当前返回的是 Vite dev fallback，真实后端还没有就绪 (${candidate})。`,
          timestamp: Date.now(),
        };
      }

      if (result.ok) {
        return {
          name: 'API端点',
          status: 'pass',
          message: candidate === '/api/health'
            ? '后端 API 可达。'
            : `后端 API 可达（通过 ${candidate}）。`,
          timestamp: Date.now(),
        };
      }

      failures.push(`${candidate}:HTTP ${result.status}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${candidate}:${reason}`);
    }
  }

  return {
    name: 'API端点',
    status: 'warn',
    message: failures.length
      ? `后端 API 不可达，请先启动后端：在 app 目录执行 \`npm run api\`（或 \`npm run dev:full\` 一键起全套）。已探测 ${failures.join(' | ')}`
      : '后端 API 不可达（纯前端模式运行中）。请先启动后端：在 app 目录执行 `npm run api`。',
    timestamp: Date.now(),
  };
}

async function checkStorageQuota(): Promise<HealthCheckResult> {
  try {
    const quota = await getStorageQuota();
    if (quota.status === 'critical') {
      return { name: '存储配额', status: 'fail', message: `存储空间严重不足 (${(quota.usageRatio * 100).toFixed(0)}%)`, timestamp: Date.now() };
    }
    if (quota.status === 'warn') {
      return { name: '存储配额', status: 'warn', message: `存储空间偏低 (${(quota.usageRatio * 100).toFixed(0)}%)`, timestamp: Date.now() };
    }
    return {
      name: '存储配额',
      status: 'pass',
      message: `存储空间充足 (${(quota.usage / 1024 / 1024).toFixed(0)}MB / ${(quota.quota / 1024 / 1024).toFixed(0)}MB)`,
      timestamp: Date.now(),
    };
  } catch {
    return { name: '存储配额', status: 'warn', message: '无法获取存储配额信息。', timestamp: Date.now() };
  }
}

function checkCircuitBreakers(): HealthCheckResult {
  try {
    const circuits = getCircuitStates();
    const openCircuits = Array.from(circuits.entries()).filter(([, state]) => state.open);
    if (openCircuits.length > 0) {
      const names = openCircuits.map(([name]) => name).join(', ');
      return { name: '熔断器', status: 'warn', message: `${openCircuits.length} 个服务已熔断: ${names}`, timestamp: Date.now() };
    }
    return { name: '熔断器', status: 'pass', message: `全部 ${circuits.size} 个服务正常。`, timestamp: Date.now() };
  } catch {
    return { name: '熔断器', status: 'pass', message: '熔断器未初始化。', timestamp: Date.now() };
  }
}

async function checkWebSocketConnectivity(): Promise<HealthCheckResult> {
  if (!window.WebSocket) {
    return { name: 'WebSocket', status: 'fail', message: '浏览器不支持 WebSocket。', timestamp: Date.now() };
  }
  return { name: 'WebSocket', status: 'pass', message: 'WebSocket API 可用（连接由 WSManager 管理）。', timestamp: Date.now() };
}

export async function runSystemHealthCheck(): Promise<SystemHealthReport> {
  const results: HealthCheckResult[] = [];

  results.push(checkWebGL());
  results.push(checkLocalStorage());
  results.push(checkCircuitBreakers());

  const [idbResult, apiResult, quotaResult, wsResult] = await Promise.all([
    checkIndexedDB(),
    checkApiEndpoint(),
    checkStorageQuota(),
    checkWebSocketConnectivity(),
  ]);

  results.push(idbResult);
  results.push(apiResult);
  results.push(quotaResult);
  results.push(wsResult);

  const allPassed = results.every((result) => result.status === 'pass');

  console.group('[HMDao] 系统健康检查');
  results.forEach((result) => {
    const icon = result.status === 'pass' ? 'OK' : result.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`${icon} ${result.name}: ${result.message}`);
  });
  console.log(`${allPassed ? 'OK' : 'WARN'} 总体状态: ${allPassed ? '全部通过' : '存在警告或错误'}`);
  console.groupEnd();

  return {
    allPassed,
    results,
    timestamp: Date.now(),
  };
}

export function getDegradationStrategy(results: HealthCheckResult[]): string[] {
  const strategies: string[] = [];

  for (const result of results) {
    if (result.name === 'WebGL' && result.status !== 'pass') {
      strategies.push('3D 渲染功能已禁用，节点将使用 2D 降级视图。');
    }
    if (result.name === 'localStorage' && result.status !== 'pass') {
      strategies.push('画布状态无法持久化，刷新页面将丢失未保存的工作。');
    }
    if (result.name === 'IndexedDB' && result.status !== 'pass') {
      strategies.push('大文件本地缓存不可用，每次加载都需要重新下载资源。');
    }
    if (result.name === 'API端点' && result.status !== 'pass') {
      strategies.push('后端服务不可达，AI 生成与云端存储功能将暂时不可用。');
    }
    if (result.name === '存储配额' && result.status === 'fail') {
      strategies.push('存储空间严重不足，模型缓存和自动保存已暂停。');
    }
    if (result.name === '熔断器' && result.status === 'warn') {
      strategies.push('部分服务已进入熔断保护，相关功能将暂时降级。');
    }
    if (result.name === 'WebSocket' && result.status !== 'pass') {
      strategies.push('实时通信不可用，协作功能和进度推送将降级为轮询。');
    }
  }

  return strategies;
}
