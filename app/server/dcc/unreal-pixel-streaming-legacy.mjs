import path from 'node:path';
import { spawn } from 'node:child_process';

export function createUnrealPixelStreamingLegacyModule({
  repoRoot,
  getControlConfig,
  nativeHttpRequest,
  probeTcp,
  normalizeHttpUrl,
  configuredUnrealCameras,
  defaultPixelUrl,
  defaultRemoteUrl,
  send,
  sendRaw,
}) {
  let unrealPixelStreamingProcess = null;
  let unrealPixelProxyBaseUrl = defaultPixelUrl;

  async function probeHttp(url, timeoutMs = 2500) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, status: 0, error: 'invalid-url', tcpReachable: false };
    }
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    const tcpReachable = await probeTcp(port, Math.min(timeoutMs, 1000));
    if (!tcpReachable) {
      return { ok: false, status: 0, error: 'tcp-connect-failed', tcpReachable: false };
    }
    const result = await nativeHttpRequest(url, { timeoutMs, responseType: 'text' });
    return { ok: Boolean(result.ok), status: result.status || 0, error: result.error || '', tcpReachable: true, code: result.code || '' };
  }

  function buildPixelStreamingFrontendCandidates(rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { mode: 'invalid-url', candidates: [], suggestedUrl: defaultPixelUrl };
    }

    if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
      const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
      const port = parsed.port === '8888' || !parsed.port ? '1025' : parsed.port;
      const suggested = `${protocol}//${parsed.hostname}${port ? `:${port}` : ''}/player.html`;
      return {
        mode: 'websocket-url',
        candidates: [],
        suggestedUrl: suggested,
      };
    }

    const candidates = new Set();
    const pathname = parsed.pathname || '/';
    const pathLower = pathname.toLowerCase();

    candidates.add(parsed.toString().replace(/\/$/, ''));

    if (pathLower === '/' || pathLower === '') {
      candidates.add(new URL('/player.html', parsed).toString());
      candidates.add(new URL('/index.html', parsed).toString());
    } else if (pathLower.endsWith('/player.html')) {
      candidates.add(new URL(pathname.replace(/player\.html$/i, ''), parsed).toString().replace(/\/$/, ''));
      candidates.add(new URL(pathname.replace(/player\.html$/i, 'index.html'), parsed).toString());
    } else if (pathLower.endsWith('/index.html')) {
      candidates.add(new URL(pathname.replace(/index\.html$/i, ''), parsed).toString().replace(/\/$/, ''));
      candidates.add(new URL(pathname.replace(/index\.html$/i, 'player.html'), parsed).toString());
    } else if (!/\.[a-z0-9]+$/i.test(pathname)) {
      const safeBase = pathname.endsWith('/') ? pathname : `${pathname}/`;
      candidates.add(new URL('player.html', new URL(safeBase, parsed)).toString());
      candidates.add(new URL('index.html', new URL(safeBase, parsed)).toString());
    }

    return {
      mode: 'http-url',
      candidates: Array.from(candidates).filter(Boolean),
      suggestedUrl: candidates.has(defaultPixelUrl) ? defaultPixelUrl : Array.from(candidates)[0] || defaultPixelUrl,
    };
  }

  async function probePixelStreamingFrontend(url, timeoutMs = 3500) {
    const planned = buildPixelStreamingFrontendCandidates(url);
    if (planned.mode === 'invalid-url') {
      return {
        ok: false,
        status: 0,
        error: 'Pixel Streaming URL is invalid.',
        hint: `Pixel Streaming endpoint is invalid. Suggested URL: ${planned.suggestedUrl}`,
        resolvedUrl: '',
        suggestedUrl: planned.suggestedUrl,
        checkedUrls: [],
        configMode: planned.mode,
      };
    }

    if (planned.mode === 'websocket-url') {
      return {
        ok: false,
        status: 0,
        error: 'Pixel Streaming requires an HTTP frontend URL instead of a websocket URL.',
        hint: `Pixel Streaming requires an HTTP frontend URL. Suggested URL: ${planned.suggestedUrl}`,
        resolvedUrl: '',
        suggestedUrl: planned.suggestedUrl,
        checkedUrls: [],
        configMode: planned.mode,
      };
    }

    let lastFailure = { status: 0, error: '', checkedUrl: planned.candidates[0] || url };
    for (const candidate of planned.candidates) {
      const result = await probeHttp(candidate, timeoutMs);
      if (result.ok) {
        return {
          ok: true,
          status: result.status || 200,
          error: '',
          hint: '',
          resolvedUrl: candidate,
          suggestedUrl: candidate,
          checkedUrls: planned.candidates,
          configMode: planned.mode,
        };
      }
      lastFailure = {
        status: result.status || 0,
        error: result.error || '',
        checkedUrl: candidate,
      };
    }

    const statusHint = lastFailure.status
      ? `Pixel Streaming endpoint checked ${lastFailure.checkedUrl} returned HTTP ${lastFailure.status}.`
      : lastFailure.error
        ? `Pixel Streaming endpoint checked ${lastFailure.checkedUrl} failed: ${lastFailure.error}.`
        : `Pixel Streaming endpoint checked ${lastFailure.checkedUrl} is unavailable.`;

    return {
      ok: false,
      status: lastFailure.status,
      error: lastFailure.error,
      hint: `${statusHint} Suggested URL: ${planned.suggestedUrl}`,
      resolvedUrl: '',
      suggestedUrl: planned.suggestedUrl,
      checkedUrls: planned.candidates,
      configMode: planned.mode,
    };
  }

  async function probeJson(url, timeoutMs = 2500) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, status: 0, error: 'invalid-url', data: null, tcpReachable: false };
    }
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    const tcpReachable = await probeTcp(port, Math.min(timeoutMs, 1000));
    if (!tcpReachable) {
      return { ok: false, status: 0, error: 'tcp-connect-failed', data: null, tcpReachable: false };
    }
    const result = await nativeHttpRequest(url, { timeoutMs, responseType: 'json', headers: { Accept: 'application/json' } });
    return {
      ok: Boolean(result.ok),
      status: result.status || 0,
      error: result.error || '',
      data: result.data ?? null,
      tcpReachable: true,
      code: result.code || '',
    };
  }

  async function remoteControlInfo(remoteUrl) {
    const result = await probeJson(`${remoteUrl}/remote/info`, 2500);
    if (!result.ok) return { ok: false, status: result.status || 0, error: result.error || '' };
    return { ok: true, data: result.data || {} };
  }

  async function probePixelStreamingRuntime(playerUrl) {
    let parsed;
    try {
      parsed = new URL(playerUrl);
    } catch {
      return {
        restApiReachable: false,
        restApiUrl: '',
        restApiError: 'invalid-url',
        streamerConnected: false,
        streamerCount: 0,
        playerCount: 0,
        streamers: [],
      };
    }

    const restApiUrl = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/api`;
    const [statusResult, streamersResult] = await Promise.all([
      probeJson(`${restApiUrl}/status`, 2500),
      probeJson(`${restApiUrl}/streamers`, 2500),
    ]);

    const streamers = Array.isArray(streamersResult.data) ? streamersResult.data : [];
    const statusData = statusResult.data && typeof statusResult.data === 'object' ? statusResult.data : {};
    const streamerCount = Number(statusData.streamer_count ?? streamers.length ?? 0);
    const playerCount = Number(statusData.player_count ?? 0);
    const restApiReachable = Boolean(statusResult.ok || streamersResult.ok);
    const restApiError = statusResult.error || streamersResult.error || '';

    return {
      restApiReachable,
      restApiUrl,
      restApiError,
      streamerConnected: streamerCount > 0,
      streamerCount: Number.isFinite(streamerCount) ? streamerCount : 0,
      playerCount: Number.isFinite(playerCount) ? playerCount : 0,
      streamers,
    };
  }

  function getPixelStreamingLauncherConfig() {
    const playerPort = Number(process.env.HMDAO_UNREAL_PLAYER_PORT || 1025);
    const streamerPort = Number(process.env.HMDAO_UNREAL_STREAMER_PORT || 8888);
    const sfuPort = Number(process.env.HMDAO_UNREAL_SFU_PORT || 8889);
    const scriptPath = path.join(repoRoot, 'scripts', 'dcc', 'start-unreal-pixel-streaming.ps1');
    const shellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const signalHost = String(process.env.HMDAO_UNREAL_SIGNAL_HOST || '127.0.0.1').trim() || '127.0.0.1';
    const signalProtocol = String(process.env.HMDAO_UNREAL_SIGNAL_PROTOCOL || 'ws').trim().toLowerCase() === 'wss' ? 'wss' : 'ws';
    const signalUrl = `${signalProtocol}://${signalHost}:${streamerPort}`;
    return { playerPort, streamerPort, sfuPort, scriptPath, shellPath, signalUrl };
  }

  async function startUnrealPixelStreamingService() {
    if (unrealPixelStreamingProcess && unrealPixelStreamingProcess.exitCode === null) {
      return { started: false, reason: 'already-running', pid: unrealPixelStreamingProcess.pid || 0 };
    }

    const { playerPort, streamerPort, sfuPort, scriptPath, shellPath, signalUrl } = getPixelStreamingLauncherConfig();
    const child = spawn(shellPath, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-PlayerPort',
      String(playerPort),
      '-StreamerPort',
      String(streamerPort),
      '-SfuPort',
      String(sfuPort),
    ], {
      cwd: repoRoot,
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    });

    unrealPixelStreamingProcess = child;
    child.once('exit', () => {
      if (unrealPixelStreamingProcess === child) unrealPixelStreamingProcess = null;
    });

    const probeUrl = `http://127.0.0.1:${playerPort}/player.html`;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const probe = await probeHttp(probeUrl, 1200);
      if (probe.ok) {
        return { started: true, pid: child.pid || 0, playerPort, streamerPort, sfuPort, signalUrl, ready: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    return { started: true, pid: child.pid || 0, playerPort, streamerPort, sfuPort, signalUrl, ready: false };
  }

  async function proxyPixelStreamingAsset(remoteUrl, req, res, pathname) {
    try {
      const base = new URL(remoteUrl);
      const target = new URL(pathname.replace(/^\/api\/dcc\/unreal\/pixel-proxy/, '') || '/', base);
      if (!/\.[a-z0-9]+$/i.test(target.pathname) && !target.pathname.endsWith('/player.html')) {
        target.pathname = target.pathname.replace(/\/$/, '') || '/';
      }
      const upstream = await fetch(target.toString(), {
        method: 'GET',
        headers: {
          Accept: req.headers.accept || '*/*',
        },
      });
      const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
      let body = Buffer.from(await upstream.arrayBuffer());
      if (/text\/html/i.test(contentType) && target.pathname.endsWith('/player.html')) {
        let html = body.toString('utf8');
        const proxiedPlayerScript = `/api/dcc/unreal/pixel-proxy/player.js?sourceUrl=${encodeURIComponent(base.toString())}`;
        html = html.replace(/<script\s+defer\s+src="player\.js"><\/script>/i, `<script defer src="${proxiedPlayerScript}"></script>`);
        const controlConfig = await getControlConfig().catch(() => null);
        const signalUrl = String(controlConfig?.signalUrl || getPixelStreamingLauncherConfig().signalUrl || 'ws://127.0.0.1:8888').trim();
        const bootstrap = `<script>(function(){var url=new URL(window.location.href);if(!url.searchParams.has('ss')){url.searchParams.set('ss',${JSON.stringify(signalUrl)});window.history.replaceState({},'',url.toString());}})();</script>`;
        html = html.replace('</head>', `${bootstrap}</head>`);
        body = Buffer.from(html, 'utf8');
      }
      const headers = {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      };
      return sendRaw(res, upstream.status, body, headers);
    } catch (error) {
      return send(res, 502, {
        success: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async function handle(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/dcc/unreal/pixel-streaming/start') {
      const result = await startUnrealPixelStreamingService();
      send(res, 200, { success: true, ...result });
      return true;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/dcc/unreal/pixel-proxy')) {
      const source = normalizeHttpUrl(url.searchParams.get('sourceUrl'), unrealPixelProxyBaseUrl || defaultPixelUrl);
      await proxyPixelStreamingAsset(source, req, res, url.pathname);
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/dcc/unreal/status') {
      const pixelUrl = normalizeHttpUrl(url.searchParams.get('pixelUrl'), defaultPixelUrl);
      const remoteUrl = normalizeHttpUrl(url.searchParams.get('remoteUrl'), defaultRemoteUrl);
      const [pixel, remote, controlConfig] = await Promise.all([
        probePixelStreamingFrontend(pixelUrl, 3500),
        remoteControlInfo(remoteUrl),
        getControlConfig(),
      ]);
      const proxySource = pixel.resolvedUrl || pixel.suggestedUrl || pixelUrl;
      const pixelRuntime = await probePixelStreamingRuntime(proxySource);
      unrealPixelProxyBaseUrl = proxySource;
      const proxiedPixelUrl = `/api/dcc/unreal/pixel-proxy/player.html?sourceUrl=${encodeURIComponent(proxySource)}`;
      const cameras = configuredUnrealCameras();
      send(res, 200, {
        success: true,
        service: 'hmdao-unreal-pixel-streaming-adapter',
        integration: 'pixel-streaming',
        pixelStreamingUrl: proxiedPixelUrl,
        pixelConfiguredUrl: pixelUrl,
        pixelResolvedUrl: proxySource,
        remoteControlUrl: remoteUrl,
        pixelReachable: pixel.ok,
        pixelStatus: pixel.status || 0,
        pixelError: pixel.error || '',
        pixelHint: pixel.hint || '',
        pixelSuggestedUrl: pixel.suggestedUrl || pixelUrl,
        pixelCheckedUrls: pixel.checkedUrls || [pixelUrl],
        pixelConfigMode: pixel.configMode || 'http-url',
        pixelRestApiReachable: pixelRuntime.restApiReachable,
        pixelRestApiUrl: pixelRuntime.restApiUrl,
        pixelRestApiError: pixelRuntime.restApiError,
        pixelStreamerConnected: pixelRuntime.streamerConnected,
        pixelStreamerCount: pixelRuntime.streamerCount,
        pixelPlayerCount: pixelRuntime.playerCount,
        pixelStreamers: pixelRuntime.streamers,
        remoteReachable: remote.ok,
        remoteStatus: remote.status || 0,
        remoteError: remote.error || '',
        controlObjectPath: controlConfig.controlObjectPath,
        controlCameraFunction: controlConfig.cameraFunction,
        controlSignalUrl: controlConfig.signalUrl,
        controlConfigured: controlConfig.configured,
        controlConfigSource: controlConfig.source,
        cameras,
        selectedCamera: cameras[0]?.name || 'Pixel Streaming',
        timeline: {
          start_frame: Number(process.env.HMDAO_UNREAL_START_FRAME || 1),
          end_frame: Number(process.env.HMDAO_UNREAL_END_FRAME || 120),
          current_frame: Number(process.env.HMDAO_UNREAL_CURRENT_FRAME || 1),
          fps: Number(process.env.HMDAO_UNREAL_FPS || 30),
        },
        remoteInfo: remote.ok ? remote.data : undefined,
      });
      return true;
    }

    return false;
  }

  return {
    handle,
  };
}
