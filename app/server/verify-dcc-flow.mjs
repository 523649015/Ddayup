import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

const PORT = Number(process.env.HMDAO_VERIFY_DCC_PORT || 8791);

const api = spawn('node', ['server/hmdao-api.mjs'], {
  cwd: process.cwd(),
  stdio: 'ignore',
  env: { ...process.env, HMDAO_API_PORT: String(PORT), HMDAO_DCC_MOCK_ONLY: '1' },
});

function request(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path, method: 'GET' }, (res) => {
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
    req.end();
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

function encodeFrame(payload, { masked = true } = {}) {
  const data = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const header = [];
  header.push(0x81);
  if (data.length < 126) {
    header.push((masked ? 0x80 : 0) | data.length);
  } else {
    header.push((masked ? 0x80 : 0) | 126, (data.length >> 8) & 255, data.length & 255);
  }
  if (!masked) return Buffer.concat([Buffer.from(header), data]);
  const mask = crypto.randomBytes(4);
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([Buffer.from(header), mask, out]);
}

function createParser(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      }
      if (length === 127) throw new Error('Large frames are not expected in DCC verification');
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 1) onMessage(JSON.parse(payload.toString('utf8')));
    }
  };
}

async function connectPath(path) {
  const socket = net.connect({ host: '127.0.0.1', port: PORT });
  const key = crypto.randomBytes(16).toString('base64');
  const messages = [];
  let ready = false;
  let handshake = Buffer.alloc(0);
  const parser = createParser((message) => messages.push(message));

  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      if (ready) {
        parser(chunk);
        return;
      }
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf('\r\n\r\n');
      if (end === -1) return;
      const header = handshake.subarray(0, end).toString('utf8');
      if (!/^HTTP\/1\.1 101/i.test(header)) reject(new Error(header));
      const accept = header.match(/sec-websocket-accept:\s*(.+)/i)?.[1]?.trim();
      if (accept !== wsAcceptKey(key)) reject(new Error('Invalid WebSocket accept key'));
      ready = true;
      const rest = handshake.subarray(end + 4);
      if (rest.length) parser(rest);
      resolve();
    });
  });

  return {
    messages,
    send(payload) {
      socket.write(encodeFrame(payload));
    },
    close() {
      socket.end();
    },
  };
}

async function connect(engine) {
  const path = engine === 'unreal' ? '/ws/dcc/unreal?role=browser' : `/ws/dcc-capture?engine=${engine}`;
  return connectPath(path);
}

function tinyImageUrl(label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#111827"/><text x="40" y="120" fill="#f9fafb" font-family="Arial" font-size="36">${label}</text><text x="40" y="190" fill="#93c5fd" font-family="Arial" font-size="24">HMDao Unreal Direct</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function attachFakeUnrealPlugin() {
  const plugin = await connectPath('/ws/dcc/unreal?role=plugin');
  const handled = new Set();
  let selectedCamera = 'CineCameraActor_01';
  plugin.send({ type: 'hello', engine: 'unreal', plugin: 'HMDao Unreal Capture', pluginVersion: 'verify', protocolVersion: 1, editor: true, previewProvider: 'editor-direct' });
  const timer = setInterval(() => {
    plugin.messages.forEach((message, index) => {
      if (handled.has(index)) return;
      handled.add(index);
      if (message.type === 'query_state') {
        plugin.send({ type: 'state', status: 'connected', selectedCameraName: selectedCamera, previewProvider: 'editor-direct' });
      }
      if (message.type === 'query_cameras') {
        plugin.send({ type: 'camera_list', camera_list: ['CineCameraActor_01', 'CineCameraActor_02', 'Sequencer_Camera'].map((name) => ({ name, label: name, active: name === selectedCamera, engine: 'unreal' })), selected_camera: selectedCamera });
      }
      if (message.type === 'query_timeline') {
        plugin.send({ type: 'animation_range', start_frame: 1, end_frame: 144, current_frame: 1, fps: 30 });
      }
      if (message.type === 'set_camera') {
        selectedCamera = String(message.cameraName || message.camera_name || selectedCamera);
        plugin.send({ type: 'camera_list', camera_list: ['CineCameraActor_01', 'CineCameraActor_02', 'Sequencer_Camera'].map((name) => ({ name, label: name, active: name === selectedCamera, engine: 'unreal' })), selected_camera: selectedCamera });
        plugin.send({ type: 'animation_range', start_frame: 1, end_frame: 144, current_frame: 1, fps: 30 });
      }
      if (message.type === 'start_preview') {
        selectedCamera = String(message.cameraName || message.camera_name || selectedCamera);
        plugin.send({ type: 'preview_frame', url: tinyImageUrl(selectedCamera), width: Number(message.width || 1280), height: Number(message.height || 720), cameraName: selectedCamera, latencyMs: 4 });
      }
      if (message.type === 'capture') {
        plugin.send({ type: 'capture_done', asset: { kind: 'image', url: tinyImageUrl(`capture-${selectedCamera}`), width: Number(message.width || 1920), height: Number(message.height || 1080), cameraName: selectedCamera, sizeBytes: 2048 } });
      }
      if (message.type === 'start_recording') {
        plugin.send({ type: 'recording_started', camera_name: selectedCamera, start_frame: message.startFrame, end_frame: message.endFrame, fps: message.fps, mock: false });
      }
      if (message.type === 'stop_recording') {
        plugin.send({ type: 'recording_done', asset: { kind: 'video', url: tinyImageUrl(`record-${selectedCamera}`), width: 1080, height: 1920, cameraName: selectedCamera, sizeBytes: 4096 } });
      }
    });
  }, 30);
  return {
    close() {
      clearInterval(timer);
      plugin.close();
    },
  };
}

async function waitForMessage(client, predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = client.messages.find(predicate);
    if (found) return found;
    await wait(80);
  }
  throw new Error('Timed out waiting for DCC message');
}

async function verifyEngine(engine) {
  const fakePlugin = engine === 'unreal' ? await attachFakeUnrealPlugin() : null;
  const client = await connect(engine);
  const width = engine === 'unreal' ? 1080 : 1280;
  const height = engine === 'unreal' ? 1920 : 720;
  const targetCamera = engine === 'unreal' ? 'CineCameraActor_02' : '产品特写';

  client.send({ type: 'connect', engine, w: width, h: height });
  const connected = await waitForMessage(client, (msg) => msg.type === 'connected' && msg.engine === engine);
  client.send({ type: 'query_camera' });
  const cameras = await waitForMessage(client, (msg) => msg.type === 'camera_list' && Array.isArray(msg.camera_list));
  client.send({ type: 'set_camera', camera_name: targetCamera });
  await waitForMessage(client, (msg) => msg.type === 'camera_list' && msg.selected_camera === targetCamera);
  client.send({ type: 'start_preview', camera_name: targetCamera, w: width, h: height, fps: 24 });
  const frame = await waitForMessage(client, (msg) => msg.type === 'frame' && msg.camera_name === targetCamera && msg.width === width && msg.height === height);
  client.send({ type: 'capture_by_camera', camera_name: targetCamera, w: width, h: height, quality: 95 });
  const capture = await waitForMessage(client, (msg) => msg.type === 'capture_done' && msg.camera_name === targetCamera && msg.width === width && msg.height === height);
  client.send({ type: 'start_recording', camera_name: targetCamera, start_frame: 12, end_frame: 36, fps: 24, w: width, h: height });
  const recording = await waitForMessage(client, (msg) => msg.type === 'recording_started' && msg.start_frame === 12 && msg.end_frame === 36 && msg.fps === 24);
  await wait(400);
  client.send({ type: 'stop_recording', camera_name: targetCamera });
  await waitForMessage(client, (msg) => (msg.type === 'recording_stopped' || msg.type === 'recording_done') && msg.camera_name === targetCamera);
  client.close();
  fakePlugin?.close();

  return {
    engine,
    connected: engine === 'unreal' ? connected.mode === 'real' : connected.mode === 'mock',
    cameraCount: cameras.camera_list.length,
    selectedCamera: targetCamera,
    previewSynced: frame.camera_name === targetCamera,
    captureSynced: capture.camera_name === targetCamera,
    resolution: `${width}x${height}`,
    recordingFrames: `${recording.start_frame}-${recording.end_frame}`,
  };
}

async function run() {
  await wait(900);
  const health = await request('/api/health');
  const status = await request('/api/dcc/status');
  if (!health.body.success || !status.body.success) throw new Error('DCC gateway is not healthy');

  const blender = await verifyEngine('blender');
  const unreal = await verifyEngine('unreal');
  console.table([blender, unreal]);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  api.kill();
});
