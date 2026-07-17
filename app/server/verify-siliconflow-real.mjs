import http from 'node:http';
import { spawn } from 'node:child_process';

const apiKey = String(process.env.SILICONFLOW_API_KEY || '').trim();
const port = Number(process.env.HMDAO_VERIFY_API_PORT || 8791);
if (!apiKey) {
  console.error('Missing SILICONFLOW_API_KEY environment variable.');
  process.exit(1);
}

const env = {
  ...process.env,
  HMDAO_REAL_API: '1',
  HMDAO_API_PORT: String(port),
};

const api = spawn('node', ['server/hmdao-api.mjs'], {
  cwd: process.cwd(),
  stdio: 'ignore',
  env,
});

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      },
    }, (res) => {
      let out = '';
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(out || '{}') });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function probeRemoteAsset(url) {
  const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
  const headType = head?.headers.get('content-type') || '';
  const headLength = Number(head?.headers.get('content-length') || 0);
  if (head?.ok && headType.startsWith('image/') && headLength > 0) {
    return {
      check: 'HEAD',
      contentType: headType,
      contentLength: headLength,
    };
  }

  const get = await fetch(url, { method: 'GET' });
  if (!get.ok) {
    throw new Error(`Remote asset fetch failed: HTTP ${get.status}`);
  }
  const buffer = await get.arrayBuffer();
  const contentType = get.headers.get('content-type') || headType || '';
  const contentLength = Number(get.headers.get('content-length') || 0) || buffer.byteLength;
  const sniffedType = sniffImageMime(new Uint8Array(buffer));
  const finalType = contentType.startsWith('image/') ? contentType : sniffedType || contentType;
  if (!finalType || !finalType.startsWith('image/')) {
    throw new Error(`Unexpected remote asset content-type: ${contentType || 'unknown'}`);
  }
  if (!(contentLength > 0)) {
    throw new Error('Remote asset content-length is empty.');
  }
  return {
    check: 'GET',
    contentType: finalType,
    headerContentType: contentType || null,
    contentLength,
  };
}

function sniffImageMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  if (bytes.length >= 6) {
    const gif87a = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && bytes[4] === 0x37 && bytes[5] === 0x61;
    const gif89a = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && bytes[4] === 0x39 && bytes[5] === 0x61;
    if (gif87a || gif89a) return 'image/gif';
  }
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 && bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && bytes[11] === 0x66) {
    return 'image/avif';
  }
  return '';
}

async function run() {
  await new Promise((resolve) => setTimeout(resolve, 1600));

  const validate = await request('POST', '/api/byok/validate', {
    provider: 'siliconflow',
    apiKey,
    mode: 'image',
    model: 'Qwen/Qwen-Image',
  });

  if (!validate.body?.success) {
    throw new Error(`API key activation failed: ${JSON.stringify(validate.body)}`);
  }

  const operations = [
    {
      name: 'panorama',
      body: {
        model: 'Qwen/Qwen-Image',
        prompt: 'HMDao real panorama verification, seamless spherical room extension, studio environment.',
        image_tool: 'panorama',
        tool_operation: 'panorama_720',
        tool_config: { fov: 120, spatialFusion: 0.75, panoramaResolution: '4K', localInpaint: true },
      },
    },
    {
      name: 'multi-angle',
      body: {
        model: 'Qwen/Qwen-Image',
        prompt: 'HMDao real multi-angle verification, keep identity and wardrobe consistent.',
        image_tool: 'multiAngle',
        tool_operation: 'multi_angle_view',
        tool_config: { yaw: 35, pitch: 10, shotScale: 'medium', consistency: 0.85 },
      },
    },
    {
      name: 'lighting',
      body: {
        model: 'Qwen/Qwen-Image',
        prompt: 'HMDao real relighting verification, physically plausible key fill rim light.',
        image_tool: 'lighting',
        tool_operation: 'pbr_relight',
        tool_config: {
          preset: 'rembrandt',
          keyLightAzimuth: 45,
          keyLightElevation: 30,
          keyLightIntensity: 0.8,
          keyLightTemperature: 5200,
          fillLightAzimuth: -35,
          fillLightElevation: 15,
          fillLightIntensity: 0.35,
          fillLightTemperature: 5600,
          rimLightEnabled: true,
          rimLightIntensity: 0.45,
          hdri: false,
        },
      },
    },
    {
      name: 'grid',
      body: {
        model: 'Qwen/Qwen-Image',
        prompt: 'HMDao real storyboard verification, nine panel cinematic continuity.',
        image_tool: 'grid',
        tool_operation: 'storyboard_grid',
        tool_config: { template: 'nine_shot', cells: 9, consistency: 0.9, exportLayout: '3x3' },
      },
    },
    {
      name: 'hd',
      body: {
        model: 'Qwen/Qwen-Image',
        prompt: 'HMDao real HD enhancement verification, premium detail restoration, clean texture.',
        image_tool: 'hd',
        tool_operation: 'hd_toolbox_enhance',
        tool_config: { upscale: '2x', restoration: true, denoise: 0.2, faceRestore: true, preserveTexture: true },
      },
    },
    {
      name: 'split',
      body: {
        model: 'Qwen/Qwen-Image',
        prompt: 'HMDao real grid split verification, centered subject with safe composition margins.',
        image_tool: 'split',
        tool_operation: 'smart_grid_split',
        tool_config: { rows: 3, cols: 3, mode: 'subject_aware', avoidFaces: true, exportZip: true },
      },
    },
    {
      name: 'camera',
      body: {
        model: 'Qwen/Qwen-Image',
        prompt: 'HMDao real cinematic camera verification, premium product still life with filmic depth.',
        image_tool: 'camera',
        tool_operation: 'cinematic_camera_simulation',
        tool_config: {
          cameraBody: 'ARRI Alexa 35',
          lens: 'Cooke S4/i 50mm',
          focalLength: 50,
          aperture: 2.8,
          shutter: '1/48',
          iso: 800,
          focusDistance: 2.5,
          lut: 'ARRI LogC',
        },
      },
    },
  ];

  const results = [];
  for (const operation of operations) {
    const generate = await request('POST', '/api/proxy/siliconflow', {
      endpoint: '/images/generations',
      method: 'POST',
      body: operation.body,
      apiKey,
      timeout: 120000,
    });

    const assetUrl = typeof generate.body?.asset?.url === 'string' ? generate.body.asset.url : '';
    const remoteAsset = assetUrl.startsWith('http://') || assetUrl.startsWith('https://')
      ? await probeRemoteAsset(assetUrl)
      : null;

    results.push({
      operation: operation.name,
      status: generate.status,
      success: generate.body?.success,
      provider: generate.body?.provider,
      mode: generate.body?.mode,
      assetType: generate.body?.asset?.type,
      contentType: generate.body?.asset?.metadata?.contentType || null,
      bytes: generate.body?.asset?.metadata?.bytes || null,
      fallback: Boolean(generate.body?.asset?.metadata?.fallback),
      assetUrlPreview: assetUrl ? assetUrl.slice(0, 120) : '',
      remoteCheck: remoteAsset?.check || null,
      remoteContentType: remoteAsset?.contentType || null,
      remoteHeaderContentType: remoteAsset?.headerContentType || null,
      remoteContentLength: remoteAsset?.contentLength || null,
      error: generate.body?.error || null,
    });

    if (!generate.body?.success) {
      throw new Error(`Image generation failed for ${operation.name}: ${JSON.stringify(generate.body)}`);
    }
    if (generate.body?.asset?.metadata?.fallback) {
      throw new Error(`Operation ${operation.name} returned fallback output instead of real upstream media.`);
    }
    if (!assetUrl.startsWith('http://') && !assetUrl.startsWith('https://')) {
      throw new Error(`Operation ${operation.name} did not return a remote asset URL.`);
    }
    if (!remoteAsset?.contentType?.startsWith('image/')) {
      throw new Error(`Operation ${operation.name} returned unexpected remote content-type.`);
    }
    if (!(Number(remoteAsset?.contentLength || 0) > 0)) {
      throw new Error(`Operation ${operation.name} returned empty remote content-length.`);
    }
  }

  console.log(JSON.stringify({
    validateStatus: validate.status,
    validateSuccess: validate.body?.success,
    results,
  }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  api.kill();
});
