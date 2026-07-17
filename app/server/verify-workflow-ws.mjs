import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';

const api = spawn('node', ['server/hmdao-api.mjs'], {
  cwd: process.cwd(),
  stdio: 'ignore',
});

function encodeWsFrame(payload, { masked = true, opcode = 1 } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const header = [];
  header.push(0x80 | opcode);
  if (data.length < 126) {
    header.push((masked ? 0x80 : 0) | data.length);
  } else if (data.length < 65536) {
    header.push((masked ? 0x80 : 0) | 126, (data.length >> 8) & 255, data.length & 255);
  } else {
    header.push((masked ? 0x80 : 0) | 127, 0, 0, 0, 0, (data.length / 2 ** 24) & 255, (data.length / 2 ** 16) & 255, (data.length / 2 ** 8) & 255, data.length & 255);
  }
  if (!masked) return Buffer.concat([Buffer.from(header), data]);
  const mask = crypto.randomBytes(4);
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([Buffer.from(header), mask, out]);
}

function createFrameParser(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const high = buffer.readUInt32BE(2);
        const low = buffer.readUInt32BE(6);
        length = high * 2 ** 32 + low;
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) return;
      if (opcode === 0x1 || opcode === 0x2) onMessage(payload.toString('utf8'));
    }
  };
}

function connectWorkflowSocket() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: 8792 });
    const key = crypto.randomBytes(16).toString('base64');
    let handshake = Buffer.alloc(0);
    socket.once('connect', () => {
      socket.write([
        'GET /ws/workflow HTTP/1.1',
        'Host: 127.0.0.1:8792',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      handshake = Buffer.concat([handshake, chunk]);
      const headerEnd = handshake.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = handshake.subarray(0, headerEnd).toString('utf8');
      if (!/^HTTP\/1\.1 101/i.test(header)) {
        reject(new Error(`handshake failed: ${header}`));
        socket.destroy();
        return;
      }
      const rest = handshake.subarray(headerEnd + 4);
      socket.removeAllListeners('data');
      resolve({ socket, rest });
    });
    socket.once('error', reject);
  });
}

async function run() {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const { socket, rest } = await connectWorkflowSocket();
  const events = [];
  const parser = createFrameParser((text) => {
    try {
      events.push(JSON.parse(text));
    } catch {
      events.push({ raw: text });
    }
  });
  socket.on('data', parser);
  if (rest?.length) parser(rest);

  const requestId = `ws-test-${Date.now()}`;
  const workflow = {
    name: 'terminal-websocket-test',
    nodes: [
      {
        node_id: 'node-image-1',
        nodeType: 'image',
        provider: 'siliconflow',
        model: 'lib-image',
        prompt: '终端 WebSocket 图片验证',
        endpoint: '/images/generations',
        body: {
          model: 'lib-image',
          prompt: '终端 WebSocket 图片验证',
          width: 1024,
          height: 1024,
        },
        apiKey: 'image-key-123456',
        timeout: 20000,
      },
    ],
  };

  socket.write(encodeWsFrame(JSON.stringify({
    msg_id: requestId,
    msg_type: 'workflow:create',
    payload: { workflow },
    ts: Date.now(),
  })));

  const started = Date.now();
  while (Date.now() - started < 30000) {
    const completed = events.find((item) => item.msg_type === 'workflow:completed');
    const failed = events.find((item) => item.msg_type === 'workflow:failed' || item.msg_type === 'error');
    if (failed) {
      throw new Error(`workflow failed: ${JSON.stringify(failed)}`);
    }
    if (completed) {
      const nodeResult = completed.payload?.node_results?.[0];
      if (!nodeResult?.asset?.url) {
        throw new Error(`workflow completed without asset: ${JSON.stringify(completed)}`);
      }
      console.log(JSON.stringify({
        ok: true,
        workflowId: completed.payload.workflow_id,
        progress: completed.payload.progress,
        nodeStatus: nodeResult.status,
        assetType: nodeResult.asset.type,
      }, null, 2));
      socket.end();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`workflow timeout; events=${JSON.stringify(events, null, 2)}`);
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    api.kill();
  });
