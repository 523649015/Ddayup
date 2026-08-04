// WebSocket 帧编解码纯工具函数（从主文件 hmdao-api.mjs 剥离，行为零变更）。
// 仅依赖 node:crypto / Buffer / JSON，无模块级状态依赖，可在任意上下文安全复用。
import crypto from 'node:crypto';

export function wsAcceptKey(key) {
  return crypto.createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

export function encodeWsFrame(payload, { masked = false, opcode = 1 } = {}) {
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

export function createFrameParser(onMessage, onClose, onPing) {
  let buffer = Buffer.alloc(0);
  let fragmentedOpcode = 0;
  let fragmentedChunks = [];

  const emitMessage = (opcode, payload) => {
    if (opcode === 0x1 || opcode === 0x2) onMessage(payload.toString('utf8'));
  };

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = Boolean(first & 0x80);
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
        const unmasked = Buffer.allocUnsafe(payload.length);
        for (let index = 0; index < payload.length; index += 1) {
          unmasked[index] = payload[index] ^ mask[index % 4];
        }
        payload = unmasked;
      }
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) {
        onClose?.();
        return;
      }
      if (opcode === 0x9) {
        onPing?.(payload);
        continue;
      }
      if (opcode === 0xA) continue;

      if (opcode === 0x0) {
        if (!fragmentedOpcode) continue;
        fragmentedChunks.push(payload);
        if (fin) {
          emitMessage(fragmentedOpcode, Buffer.concat(fragmentedChunks));
          fragmentedOpcode = 0;
          fragmentedChunks = [];
        }
        continue;
      }

      if (!fin) {
        fragmentedOpcode = opcode;
        fragmentedChunks = [payload];
        continue;
      }

      emitMessage(opcode, payload);
    }
  };
}

export function sendWs(socket, payload) {
  if (!socket.destroyed) socket.write(encodeWsFrame(JSON.stringify(payload)));
}
