/**
 * DASH 视频轨 + 音频轨 合并为单文件 MP4（Web Worker 版）
 * ---------------------------------------------------------------------------
 * 目的：把「CPU 密集的 mp4box 解封装 + mp4-muxer 重封装」搬到 Worker 线程，
 *       主线程（侧栏 UI / 源页面）零阻塞 —— 同时满足两个要求：
 *         ① 真合并成一个含音画的文件
 *         ② 不卡顿 / 不冻结 / 不影响源页面视频播放（严格遵守边界要求）
 *
 * 关键实现点：
 *   · Worker 内直接用 fetch 拉字节【不经 chrome.runtime.sendMessage】
 *     → 彻底避开 ~64MB 消息上限，任意大小都能拉（8MB/块，CDN 支持 Range）。
 *   · Referer 由 dNR 规则在网络层注入（installRefererRuleForDomain），
 *     对 Worker 的 fetch 同样生效 —— 故此处无需、也无法手动设置 Referer 头。
 *   · 合并结果以 Transferable(ArrayBuffer) 回传主线程，零拷贝。
 *
 * 消息协议（★2026-08-31 改版：Worker 不再自己 fetch）：
 *   原因：Worker 内的 fetch 是【普通网页 fetch】，受 CORS 限制；
 *        B站 CDN 不返回 Access-Control-Allow-Origin → Worker fetch 被浏览器拦截 → 合并失败。
 *        （而 background SW 的 fetch 有 host_permissions:<all_urls> 授权，不受 CORS 限制。）
 *   故改为：主线程负责【分块拉取】（走 background，8MB/块，不触及 ~64MB 消息上限），
 *          再把两个完整 buffer 以 Transferable 交给 Worker 做纯合并。
 *
 *   in : { type:'merge', videoBuffer, audioBuffer }   (ArrayBuffer, Transferable)
 *   out: { type:'progress', stage } | { type:'done', buffer } | { type:'error', error }
 */
/* global importScripts, MP4Box, Mp4Muxer, EncodedVideoChunk, EncodedAudioChunk */

// importScripts 失败常见原因：vendor 路径错误 / CSP 阻止 / MV3 模块限制。
// 包裹后立刻检测库是否可用 → 不可用时向主线程报具体错误（而不是模糊的"合并库未加载"）。
let _loadErr = null;
try { importScripts('vendor/mp4box.all.min.js'); } catch (e) { _loadErr = 'mp4box importScripts 失败：' + (e && e.message || e); }
try { importScripts('vendor/mp4-muxer.js'); } catch (e) { _loadErr = 'mp4-muxer importScripts 失败：' + (e && e.message || e); }
if (typeof MP4Box === 'undefined') _loadErr = (_loadErr || '') + ' MP4Box 未定义（可能 vendor/mp4box.all.min.js 路径错或 CSP 阻止）';
if (typeof Mp4Muxer === 'undefined') _loadErr = (_loadErr || '') + ' Mp4Muxer 未定义（可能 vendor/mp4-muxer.js 路径错或 CSP 阻止）';

function post(msg, transfer) {
  if (transfer && transfer.length) self.postMessage(msg, transfer);
  else self.postMessage(msg);
}

// ===== mp4box 解封装 =====
function dashDemux(buf) {
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    let trackId = null, trackInfo = null;
    const samples = [];
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
        resolve({ file, id: trackId, info: trackInfo, samples });
      }
    };
    buf.fileStart = 0;
    file.appendBuffer(buf);
    file.flush();
    setTimeout(() => resolve({ file, id: trackId, info: trackInfo, samples }), 1500);
  });
}

// ===== codec private data =====
// ★2026-09-02 修复（Worker 合并产出「不可解码 MP4」的根因）：
//   旧实现只有「mp4box 的 box.write(MP4Box.DataStream)」一条路，且 catch(_){ return null } 把
//   异常吞成 null —— 一旦该路径抛错（某些 mp4box 构建里 MP4Box.DataStream 是 undefined，
//   new 它直接 TypeError），codecPrivate 就是 null → muxer 不写 avcC（SPS/PPS）→
//   ffprobe 报 "No start code is found / non-existing PPS referenced / Invalid data found"。
//   修复要点三条：
//     ① 先检查 MP4Box.DataStream 是否真的可用，不可用时不再硬撞；
//     ② 兜底：直接在原始字节里按 box type 搜索 avcC/hvcC/vpcC/av1C 取 payload（零库依赖）；
//     ③ 两条路都拿不到时【抛错中止】——宁可合并失败，也不能交付一个看似成功、实则不可播的文件。
let _lastCodecPrivateError = '';

// 在原始字节里搜索 ISOBMFF box（形如 avcC / hvcC ...），返回其 payload（去掉 8 字节 box header）
function findBoxPayload(bytesLike, types) {
  try {
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
  } catch (e) {
    _lastCodecPrivateError += ' | 字节级搜索异常: ' + ((e && e.message) || e);
  }
  return null;
}

function getVideoCodecPrivate(file, trackId, rawBytes) {
  let boxName = '';
  try {
    const trak = file.getTrackById(trackId);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C || null;
    if (box) {
      boxName = entry.avcC ? 'avcC' : entry.hvcC ? 'hvcC' : entry.vpcC ? 'vpcC' : 'av1C';
      // ① mp4box 路径（必须先确认 DataStream 真的存在）
      if (typeof MP4Box.DataStream === 'function' && typeof MP4Box.DataStream.BIG_ENDIAN !== 'undefined') {
        const ds = new MP4Box.DataStream(new ArrayBuffer(8192), 0, MP4Box.DataStream.BIG_ENDIAN);
        box.write(ds);
        const out = new Uint8Array(ds.buffer, 0, ds.position);
        if (out.length > 8) return out.subarray(8);
        _lastCodecPrivateError = 'mp4box 路径产出的 ' + boxName + ' 长度异常: ' + out.length;
      } else {
        _lastCodecPrivateError = 'MP4Box.DataStream 不可用，改用字节级搜索';
      }
    } else {
      _lastCodecPrivateError = 'stsd entry 无 avcC/hvcC/vpcC/av1C';
    }
  } catch (e) {
    _lastCodecPrivateError = 'mp4box 路径异常: ' + ((e && e.message) || e);
  }
  // ② 兜底：直接读原始字节
  if (rawBytes) {
    const found = findBoxPayload(rawBytes, ['avcC', 'hvcC', 'vpcC', 'av1C']);
    if (found) return found;
  }
  // ③ 拿不到就中止——缺失 SPS/PPS 的 MP4 一定不可播，不能当成"合并成功"
  throw new Error('无法提取视频解码器配置（' + (boxName || '未知') + '）：'
    + (_lastCodecPrivateError || '未知原因')
    + ' —— 缺失 avcC/SPS-PPS 会产出不可播放的 MP4，故中止合并');
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

// ===== 主流程：纯合并（字节由主线程传入）=====
async function doMerge(videoBuffer, audioBuffer) {
  if (_loadErr) throw new Error(_loadErr);   // 库加载失败 → 直接抛出具体错误（而非模糊"合并库未加载"）
  if (typeof MP4Box === 'undefined' || typeof Mp4Muxer === 'undefined') {
    throw new Error('合并库未加载（mp4box / mp4-muxer）—— vendor 路径或 CSP 异常');
  }
  if (!videoBuffer || !audioBuffer) throw new Error('缺少视频轨或音频轨字节');

  post({ type: 'progress', stage: 'demux', done: 0, total: 0, pct: 0 });
  // 备份一份干净的视频轨原始字节：mp4box 的 appendBuffer 会在传入的 ArrayBuffer 上打
  // fileStart 标记并推进指针，而兜底路径（字节级搜 avcC）需要未被改动过的字节。
  const vRaw = new Uint8Array(videoBuffer.slice(0));
  const vBuf = vRaw.buffer;
  const aBuf = audioBuffer;
  const vDemux = await dashDemux(vBuf);
  const aDemux = await dashDemux(aBuf);
  const vInfo = vDemux.info, aInfo = aDemux.info;
  const vTs = vInfo.timescale || 1, aTs = aInfo.timescale || 1;

  post({ type: 'progress', stage: 'mux', done: 0, total: 0, pct: 0 });
  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: {
      codec: muxerVideoCodec(vInfo.codec),
      width: (vInfo.video && vInfo.video.width) || 1920,
      height: (vInfo.video && vInfo.video.height) || 1080,
    },
    audio: {
      codec: 'aac',
      numberOfChannels: (aInfo.audio && aInfo.audio.channel_count) || 2,
      sampleRate: (aInfo.audio && aInfo.audio.sample_rate) || 48000,
    },
    fastStart: 'in-memory',
  });

  const vCP = getVideoCodecPrivate(vDemux.file, vDemux.id, vRaw);
  const aCP = getAacCodecPrivate((aInfo.audio && aInfo.audio.sample_rate) || 48000, (aInfo.audio && aInfo.audio.channel_count) || 2);

  // ★2026-09-02 修复（决定性根因）：mp4-muxer 读取的是 decoderConfig.**description**
  //   （vendor/mp4-muxer.js 的 avcC/hvcC/esds 构造器都取 track.info.decoderConfig.description），
  //   而旧代码传的是 decoderConfig.**codecPrivate** —— 这个字段不是 WebCodecs 标准字段，
  //   库完全不认识 → description 为 undefined → avcC box 被写成【空内容】
  //   → ffprobe 报 "No start code is found / non-existing PPS" → 产出不可播放的 MP4。
  //   （这也解释了为什么修好提取逻辑后文件大小一字不差：avcC box 一直在，只是内容是空的。）
  for (const s of vDemux.samples) {
    const chunk = new EncodedVideoChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: Math.round((s.cts / vTs) * 1e6),
      duration: Math.max(1, Math.round((s.duration / vTs) * 1e6)),
      data: s.data,
    });
    muxer.addVideoChunk(chunk, { decoderConfig: { codec: vInfo.codec, description: vCP } });
  }
  for (const s of aDemux.samples) {
    const chunk = new EncodedAudioChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: Math.round((s.cts / aTs) * 1e6),
      duration: Math.max(1, Math.round((s.duration / aTs) * 1e6)),
      data: s.data,
    });
    muxer.addAudioChunk(chunk, { decoderConfig: { codec: 'mp4a.40.2', description: aCP } });
  }
  muxer.finalize();
  return muxer.target.buffer;
}

self.onmessage = async (e) => {
  const d = e.data || {};
  try {
    if (d.type !== 'merge') return;
    const buffer = await doMerge(d.videoBuffer, d.audioBuffer);
    // Transferable 零拷贝回传
    post({ type: 'done', buffer }, [buffer]);
  } catch (err) {
    post({ type: 'error', error: String((err && err.message) || err) });
  }
};
