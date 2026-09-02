// 诊断：extension/dash-merge-worker.js 的合并算法为什么产出「ffprobe 解不了」的 MP4。
// 在 Node 里用扩展自带的 vendor 库复现同一套算法（mp4box demux → mp4-muxer remux），
// 逐项打印关键中间量，定位是 codecPrivate / 样本格式 / 时间戳 哪一处出错。
// 不改扩展任何代码，只做只读复现。
//
// 用法：node scripts/diag-dash-merge.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VIDEO = path.join(ROOT, 'tmp', 'dnr-verify-media', 'video.m4s');
const AUDIO = path.join(ROOT, 'tmp', 'dnr-verify-media', 'audio.m4s');
const OUT_DIR = path.join(ROOT, 'tmp', 'dnr-verify-media');
const FFPROBE = process.env.FFPROBE || 'C:\\FFMPEG\\bin\\ffprobe.exe';

// ---- 在沙箱里加载 vendor UMD 库（模拟浏览器全局）----
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  TextDecoder, TextEncoder, Uint8Array, Int8Array, Uint16Array, Uint32Array,
  ArrayBuffer, DataView, Math, JSON, Date, String, Number, Object, Array, Error, Promise,
  performance: { now: () => Date.now() },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.global = sandbox;
vm.createContext(sandbox);
for (const f of ['mp4box.all.min.js', 'mp4-muxer.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'extension', 'vendor', f), 'utf8'), sandbox, { filename: f });
}
const MP4Box = sandbox.MP4Box;
const Mp4Muxer = sandbox.Mp4Muxer;
console.log('库加载:', { MP4Box: typeof MP4Box, Mp4Muxer: typeof Mp4Muxer });

// ---- 与 worker 完全一致的 demux ----
function dashDemux(buf, label) {
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    let trackId = null, trackInfo = null;
    const samples = [];
    const t0 = Date.now();
    file.onError = (e) => reject(new Error('demux 失败: ' + e));
    file.onReady = (info) => {
      const t = (info.videoTracks && info.videoTracks[0]) || (info.audioTracks && info.audioTracks[0]) || null;
      if (!t) { reject(new Error('无音视频轨')); return; }
      trackId = t.id; trackInfo = t;
      file.setExtractionOptions(t.id, null, { nbSamples: 1000000 });
      file.start();
    };
    file.onSamples = (id, user, smps) => {
      for (let i = 0; i < smps.length; i++) samples.push(smps[i]);
      if (trackInfo && samples.length >= (trackInfo.nb_samples || 0)) {
        resolve({ file, id: trackId, info: trackInfo, samples, ms: Date.now() - t0 });
      }
    };
    buf.fileStart = 0;
    file.appendBuffer(buf);
    file.flush();
    // 与 worker 一致的兜底，但记录是否走了兜底（兜底=样本可能不全）
    setTimeout(() => {
      if (trackInfo) resolve({ file, id: trackId, info: trackInfo, samples, ms: Date.now() - t0, hitTimeout: true });
    }, 3000);
  });
}

// ---- codecPrivate 提取：复刻 extension/dash-merge-worker.js 修复后的两条路径 ----
// ① mp4box 的 box.write(MP4Box.DataStream)（本沙箱里 DataStream 为 undefined → 会失败）
// ② 兜底：在原始字节里按 box type 搜索 avcC/hvcC/vpcC/av1C 取 payload
function findBoxPayload(bytesLike, types) {
  const b = (bytesLike instanceof Uint8Array) ? bytesLike : new Uint8Array(bytesLike);
  for (const type of types) {
    const s0 = type.charCodeAt(0), s1 = type.charCodeAt(1), s2 = type.charCodeAt(2), s3 = type.charCodeAt(3);
    for (let i = 0; i + 4 <= b.length; i++) {
      if (b[i] !== s0 || b[i + 1] !== s1 || b[i + 2] !== s2 || b[i + 3] !== s3) continue;
      const boxStart = i - 4;
      if (boxStart < 0) continue;
      const size = ((b[boxStart] << 24) | (b[boxStart + 1] << 16) | (b[boxStart + 2] << 8) | b[boxStart + 3]) >>> 0;
      if (size < 9 || boxStart + size > b.length) continue;
      const payload = b.subarray(boxStart + 8, boxStart + size);
      if (payload.length) return payload;
    }
  }
  return null;
}
let lastCpErr = '';
function getVideoCodecPrivate(file, trackId, rawBytes) {
  let boxName = '';
  try {
    const trak = file.getTrackById(trackId);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C || null;
    if (box) {
      boxName = entry.avcC ? 'avcC' : entry.hvcC ? 'hvcC' : entry.vpcC ? 'vpcC' : 'av1C';
      if (typeof MP4Box.DataStream === 'function' && typeof MP4Box.DataStream.BIG_ENDIAN !== 'undefined') {
        const ds = new MP4Box.DataStream(new ArrayBuffer(8192), 0, MP4Box.DataStream.BIG_ENDIAN);
        box.write(ds);
        const out = new Uint8Array(ds.buffer, 0, ds.position);
        if (out.length > 8) return { data: out.subarray(8), via: 'mp4box' };
        lastCpErr = 'mp4box 路径长度异常 ' + out.length;
      } else {
        lastCpErr = 'MP4Box.DataStream 不可用';
      }
    } else {
      lastCpErr = 'stsd entry 无 avcC/hvcC/vpcC/av1C';
    }
  } catch (e) {
    lastCpErr = 'mp4box 路径异常: ' + ((e && e.message) || e);
  }
  if (rawBytes) {
    const found = findBoxPayload(rawBytes, ['avcC', 'hvcC', 'vpcC', 'av1C']);
    if (found) return { data: found, via: 'bytes-scan' };
  }
  return { data: null, via: 'FAILED', error: lastCpErr };
}
function getAacCodecPrivate(sampleRate, channels) {
  const tbl = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let sfi = tbl.indexOf(sampleRate);
  if (sfi < 0) sfi = (sampleRate > 48000 ? 0 : 4);
  const asc = (2 << 11) | (sfi << 7) | ((channels || 2) << 3);
  return new Uint8Array([(asc >> 8) & 0xff, asc & 0xff]);
}
function muxerVideoCodec(codec) {
  if (codec && /av01|av1/i.test(codec)) return 'av1';
  if (codec && /vp09|vp9/i.test(codec)) return 'vp9';
  if (codec && /hvc|hev/i.test(codec)) return 'hevc';
  return 'avc';
}
const hex = (u8, n = 16) => Buffer.from(u8.slice(0, n)).toString('hex');

function mux(vDemux, aDemux, outFile, rawVideoBytes) {
  const vInfo = vDemux.info;
  const aInfo = aDemux ? aDemux.info : null;
  const vTs = vInfo.timescale || 1;
  const cfg = {
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: {
      codec: muxerVideoCodec(vInfo.codec),
      width: (vInfo.video && vInfo.video.width) || 1920,
      height: (vInfo.video && vInfo.video.height) || 1080,
    },
    fastStart: 'in-memory',
  };
  if (aInfo) {
    cfg.audio = {
      codec: 'aac',
      numberOfChannels: (aInfo.audio && aInfo.audio.channel_count) || 2,
      sampleRate: (aInfo.audio && aInfo.audio.sample_rate) || 48000,
    };
  }
  const muxer = new Mp4Muxer.Muxer(cfg);
  const cp = getVideoCodecPrivate(vDemux.file, vDemux.id, rawVideoBytes);
  const vCP = cp.data;
  if (!vCP) throw new Error('无法提取视频解码器配置：' + (cp.error || '未知'));
  console.log('   avcC 提取路径 =', cp.via, '长度 =', vCP.length, '前 12 字节 =', hex(vCP, 12));
  const aCP = aInfo ? getAacCodecPrivate((aInfo.audio && aInfo.audio.sample_rate) || 48000, (aInfo.audio && aInfo.audio.channel_count) || 2) : null;

  for (const s of vDemux.samples) {
    muxer.addVideoChunkRaw(s.data, s.is_sync ? 'key' : 'delta',
      Math.round((s.cts / vTs) * 1e6), Math.max(1, Math.round((s.duration / vTs) * 1e6)),
      { decoderConfig: { codec: vInfo.codec, description: vCP } }); // ★mp4-muxer 认 description，不认 codecPrivate
  }
  if (aDemux) {
    const aTs = aInfo.timescale || 1;
    for (const s of aDemux.samples) {
      muxer.addAudioChunkRaw(s.data, s.is_sync ? 'key' : 'delta',
        Math.round((s.cts / aTs) * 1e6), Math.max(1, Math.round((s.duration / aTs) * 1e6)),
        { decoderConfig: { codec: 'mp4a.40.2', description: aCP } });
    }
  }
  muxer.finalize();
  const buf = Buffer.from(muxer.target.buffer);
  fs.writeFileSync(outFile, buf);
  return buf.length;
}

function probe(file) {
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim().replace(/\n/g, ' | ') || '(无流)';
  } catch (e) {
    const msg = String((e && e.stderr) || (e && e.message) || e);
    return 'FFPROBE_FAIL: ' + msg.split('\n').filter(Boolean).slice(-3).join(' / ').slice(0, 220);
  }
}

(async () => {
  const vBuf = fs.readFileSync(VIDEO);
  const aBuf = fs.readFileSync(AUDIO);
  const vAb = vBuf.buffer.slice(vBuf.byteOffset, vBuf.byteOffset + vBuf.byteLength);
  const aAb = aBuf.buffer.slice(aBuf.byteOffset, aBuf.byteOffset + aBuf.byteLength);

  // 保留一份未被 mp4box 改动的原始字节，供 avcC 兜底搜索（与 worker 修复后的做法一致）
  const vRaw = new Uint8Array(vAb.slice(0));

  console.log('\n==================== 1) demux 视频轨 ====================');
  const v = await dashDemux(vRaw.buffer, 'video');
  console.log('codec =', v.info.codec, '| timescale =', v.info.timescale, '| nb_samples =', v.info.nb_samples,
    '| 实际收集 =', v.samples.length, '| 耗时 =', v.ms + 'ms', v.hitTimeout ? '| ⚠走了 3s 兜底' : '');
  console.log('video 尺寸 =', v.info.video && v.info.video.width + 'x' + v.info.video.height);
  const s0 = v.samples[0];
  const data0 = s0 && s0.data;
  const u0 = data0 instanceof Uint8Array ? data0 : new Uint8Array(data0);
  console.log('第 1 个 sample: size =', u0.length, '| 前 12 字节 =', hex(u0, 12));
  console.log('样本格式判定:',
    (u0[0] === 0 && u0[1] === 0 && u0[2] === 0 && u0[3] === 1) ? '❌ Annex-B（start code 00 00 00 01）— mp4-muxer 期待 AVCC'
      : (u0[0] === 0 && u0[1] === 0 && u0[2] === 0 && u0[3] === 2) ? '❌ Annex-B（00 00 00 02）'
        : (u0[0] === 0 && u0[1] === 0 && u0[2] === 1) ? '❌ Annex-B（3 字节 start code）'
          : '✅ 疑似 AVCC（length-prefixed）');
  const cpProbe = getVideoCodecPrivate(v.file, v.id, vRaw);
  const vCP = cpProbe.data;
  console.log('avcC(codecPrivate) =', vCP ? hex(vCP, 24) + ' (' + vCP.length + ' 字节) via=' + cpProbe.via : '❌ 提取失败 via=' + cpProbe.via + ' err=' + (cpProbe.error || ''));

  // 精确定位：stsd entry 里到底挂了什么
  try {
    const trak = v.file.getTrackById(v.id);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    console.log('entry 类型 =', entry && entry.constructor && entry.constructor.name);
    console.log('entry keys =', Object.keys(entry).join(','));
    for (const k of ['avcC', 'hvcC', 'vpcC', 'av1C', 'esds', 'sinf', 'pasp']) {
      console.log('   entry.' + k + ' =', entry[k] === undefined ? '(undefined)' : typeof entry[k]);
    }
    // 深度找 avcC：有些 fMP4 结构里 avcC 挂在 entry 的子 box 数组中
    const found = [];
    const walk = (obj, p, d) => {
      if (d > 4 || !obj || typeof obj !== 'object') return;
      for (const k of Object.keys(obj)) {
        if (k === 'avcC' || k === 'hvcC') found.push(p + '.' + k);
        const val = obj[k];
        if (val && typeof val === 'object' && !Array.isArray(val)) walk(val, p + '.' + k, d + 1);
      }
    };
    walk(entry, 'entry', 0);
    console.log('深度扫描到的 avcC/hvcC 路径 =', found.length ? found.join(', ') : '(无)');
    if (found.length) {
      const p0 = found[0].slice(6).split('.');
      let node = entry;
      for (const seg of p0) node = node[seg];
      const ds = new MP4Box.DataStream(new ArrayBuffer(8192), 0, MP4Box.DataStream.BIG_ENDIAN);
      node.write(ds);
      const payload = new Uint8Array(ds.buffer, 8, ds.position - 8);
      console.log('按该路径提取的 avcC payload =', hex(payload, 24), '(' + payload.length + ' 字节)');
    }
  } catch (e) { console.log('entry 结构探查失败:', e && e.message); }

  console.log('\n==================== 2) demux 音频轨 ====================');
  const a = await dashDemux(aAb, 'audio');
  console.log('codec =', a.info.codec, '| timescale =', a.info.timescale, '| nb_samples =', a.info.nb_samples,
    '| 实际收集 =', a.samples.length, '| 耗时 =', a.ms + 'ms', a.hitTimeout ? '| ⚠走了 3s 兜底' : '');
  console.log('audio =', a.info.audio && (a.info.audio.sample_rate + 'Hz / ' + a.info.audio.channel_count + 'ch'));
  const aCP = getAacCodecPrivate((a.info.audio && a.info.audio.sample_rate) || 48000, (a.info.audio && a.info.audio.channel_count) || 2);
  console.log('手工构造的 AudioSpecificConfig =', hex(aCP, 8));

  console.log('\n==================== 3) 只 mux 视频轨（排除音频干扰）====================');
  const f1 = path.join(OUT_DIR, 'merged-video-only.mp4');
  const n1 = mux(v, null, f1, vRaw);
  console.log('输出', f1, n1, '字节 → ffprobe:', probe(f1));

  console.log('\n==================== 4) 视频 + 音频 合并（与 worker 同款）====================');
  const f2 = path.join(OUT_DIR, 'merged-both.mp4');
  const n2 = mux(v, a, f2, vRaw);
  console.log('输出', f2, n2, '字节 → ffprobe:', probe(f2));

  console.log('\n==================== 5) 对照：ffmpeg 直接合并同一对分轨 ====================');
  const f3 = path.join(OUT_DIR, 'merged-by-ffmpeg.mp4');
  try {
    execFileSync((process.env.FFMPEG || 'C:\\FFMPEG\\bin\\ffmpeg.exe'),
      ['-y', '-i', VIDEO, '-i', AUDIO, '-c', 'copy', f3], { stdio: 'ignore' });
    console.log('输出', f3, fs.statSync(f3).size, '字节 → ffprobe:', probe(f3));
  } catch (e) { console.log('ffmpeg 合并失败:', e && e.message); }
})();
