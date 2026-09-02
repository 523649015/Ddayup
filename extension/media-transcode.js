// ===== DASH / YouTube 字节转码算法簇（纯算法，不触 DOM/UI 状态）=====
// 依赖全局 vendor 库 MP4Box（vendor/mp4box.all.min.js）、Mp4Muxer（vendor/mp4-muxer.js）
// 与 fetchViaBackground（sidepanel.js 注入的全局函数）。
// 本文件由 sidepanel.html 在 vendor 库之后、sidepanel.js 之前加载，
// 各函数进入脚本级全局作用域，供 sidepanel.js 的预览/下载逻辑按 typeof 延迟调用。
// 抽离自 sidepanel.js（原 L1857-1962），作为 C1 拆分的第一阶段：算法与 UI 解耦。

// 用 mp4box 解封装 ISOBMFF（DASH 片段 / YouTube UMP 字节）为样本数组
function dashDemux(buf) {
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    let trackId = null, trackInfo = null, samples = [];
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

// 从 mp4box track 提取视频 codec private data（avcC/hvcC/vpcC/av1C 的 payload）
// ★2026-09-02 修复（与 dash-merge-worker.js 同源的两个叠加根因）：
//   根因① 旧实现只有「mp4box 的 box.write(MP4Box.DataStream)」一条路，某些 mp4box 构建里
//          MP4Box.DataStream 是 undefined → TypeError → 被 catch(_){return null} 吞成 null；
//   根因② 调用方把结果塞进 decoderConfig.**codecPrivate**，而 mp4-muxer 只认
//          decoderConfig.**description**（见 vendor/mp4-muxer.js 的 avcC/hvcC/esds 构造器）
//          → avcC box 被写成空内容 → ffprobe "No start code is found / Invalid data found"。
//   本函数修复①：mp4box 路径先检查 DataStream 可用性，失败则走零库依赖的字节级兜底；
//   两条路都拿不到时【抛错中止】——宁可合并失败，也不交付看似成功、实则不可播的文件。
//   rawBytes：轨道原始字节（未被 mp4box 改写过），供兜底搜索使用。
let _lastVideoCpError = '';
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
        const payload = b.subarray(boxStart + 8, boxStart + size); // 去掉 8 字节 box 头
        if (payload.length) return payload;
      }
    }
  } catch (e) {
    _lastVideoCpError += ' | 字节级搜索异常: ' + ((e && e.message) || e);
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
      // ① mp4box 路径（必须先确认 DataStream 真的存在，不再硬撞）
      if (typeof MP4Box.DataStream === 'function' && typeof MP4Box.DataStream.BIG_ENDIAN !== 'undefined') {
        const ds = new MP4Box.DataStream(new ArrayBuffer(8192), 0, MP4Box.DataStream.BIG_ENDIAN);
        box.write(ds);
        const out = new Uint8Array(ds.buffer, 0, ds.position);
        if (out.length > 8) return out.subarray(8);
        _lastVideoCpError = 'mp4box 路径产出的 ' + boxName + ' 长度异常: ' + out.length;
      } else {
        _lastVideoCpError = 'MP4Box.DataStream 不可用，改用字节级搜索';
      }
    } else {
      _lastVideoCpError = 'stsd entry 无 avcC/hvcC/vpcC/av1C';
    }
  } catch (e) {
    _lastVideoCpError = 'mp4box 路径异常: ' + ((e && e.message) || e);
  }
  // ② 兜底：直接在原始字节里搜索
  if (rawBytes) {
    const found = findBoxPayload(rawBytes, ['avcC', 'hvcC', 'vpcC', 'av1C']);
    if (found) return found;
  }
  // ③ 拿不到就中止
  throw new Error('无法提取视频解码器配置（' + (boxName || '未知') + '）：'
    + (_lastVideoCpError || '未知原因')
    + ' —— 缺失 avcC/SPS-PPS 会产出不可播放的 MP4，故中止合并');
}

// 复制一份干净的原始字节（mp4box 的 appendBuffer 会在传入的 ArrayBuffer 上打标记并推进指针，
// 而 avcC 的兜底搜索需要未被改动的字节）。入参可以是 ArrayBuffer 或 Uint8Array。
function cloneTrackBytes(x) {
  try {
    if (x instanceof Uint8Array) { const c = new Uint8Array(x.length); c.set(x); return c; }
    if (x instanceof ArrayBuffer) return new Uint8Array(x.slice(0));
  } catch (_) { /* 忽略 */ }
  return null;
}

// 构造 AAC-LC (audioObjectType=2) 的 codec private（AudioSpecificConfig，2 字节）
function getAacCodecPrivate(sampleRate, channels) {
  const tbl = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let sfi = tbl.indexOf(sampleRate);
  if (sfi < 0) sfi = (sampleRate > 48000 ? 0 : 4);
  const asc = (2 << 11) | (sfi << 7) | ((channels || 2) << 3); // audioObjectType=2 (AAC-LC)
  return new Uint8Array([(asc >> 8) & 0xff, asc & 0xff]);
}

// 映射 mp4box codec 字符串到 mp4-muxer 视频 codec 标识
function muxerVideoCodec(codec) {
  if (codec && /av01|av1/i.test(codec)) return 'av1';
  if (codec && /vp09|vp9/i.test(codec)) return 'vp9';
  if (codec && /hvc|hev/i.test(codec)) return 'hevc';
  return 'avc';
}

// 合并 DASH 分离的视频轨 + 音频轨为单文件 MP4（mp4box 解封装 + mp4-muxer 重封装）
// referer：视频来源站的 Referer（防盗链）。默认 bilibili（B站DASH CDN 必需），
// 调用方可按平台传入（如抖音 www.douyin.com），做到「多站互不干扰」。
async function probeSize(url, referer) {
  try {
    return await fetchViaBackground(url, { referer, method: 'HEAD' });
  } catch (_) { return { ok: false }; }
}

// ★2026-08-30：分块拉取（Range: bytes=start-end），突破 chrome.runtime.sendMessage ~64MB 上限。
//   大文件（B站 4K/1080P+ DASH 轨常达数百 MB~数 GB）无法一次性回传，
//   故按 DASH_CHUNK（8MB）分块请求后本地拼接为完整 Uint8Array。CDN 普遍支持 Range。
const DASH_CHUNK = 8 * 1024 * 1024; // 8MB
async function fetchTrackChunked(url, referer, onProgress) {
  // 先 HEAD 拿总大小
  let total = 0;
  try {
    const h = await fetchViaBackground(url, { referer, method: 'HEAD' });
    total = (h && h.contentLength) || 0;
  } catch (_) {}
  // 小文件或拿不到大小 → 一次性拉取（不超限）
  if (!total || total <= DASH_CHUNK) {
    const r = await fetchViaBackground(url, { referer });
    if (!r || !r.ok || !r.arrayBuffer) throw new Error('拉取失败：' + ((r && (r.error || r.status)) || 'unknown'));
    return new Uint8Array(r.arrayBuffer);
  }
  // 分块拉取
  const chunks = [];
  let offset = 0;
  let guard = 0;
  while (offset < total && guard < 2000) {   // guard 防死循环
    guard++;
    const end = Math.min(offset + DASH_CHUNK - 1, total - 1);
    const r = await fetchViaBackground(url, {
      referer,
      headers: { Range: `bytes=${offset}-${end}` },
    });
    if (!r || !r.ok || !r.arrayBuffer) {
      throw new Error(`分块拉取失败 @${offset}-${end}：` + ((r && (r.error || r.status)) || 'unknown'));
    }
    chunks.push(new Uint8Array(r.arrayBuffer));
    offset = end + 1;
    if (typeof onProgress === 'function') onProgress(offset, total);
  }
  // 拼接
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

// ===== 主线程纯合并（接受已拉取的 buffer，不发起 fetch）=====
// 与 mergeDashToMp4 共享 dashDemux/getVideoCodecPrivate/getAacCodecPrivate/muxerVideoCodec。
// 边界合规：仅小文件调用（≤100MB 视频轨），大文件走分轨直连——主线程不长时间冻结。
async function mergeDashBuffers(videoBuffer, audioBuffer) {
  if (typeof MP4Box === 'undefined' || typeof Mp4Muxer === 'undefined') {
    throw new Error('合并库未加载（mp4box / mp4-muxer）');
  }
  // 备份原始字节供 avcC 兜底搜索（mp4box 会改写传入的 ArrayBuffer）
  const vRaw = cloneTrackBytes(videoBuffer);
  const vDemux = await dashDemux(vRaw ? vRaw.buffer : videoBuffer);
  const aDemux = await dashDemux(audioBuffer);
  const vInfo = vDemux.info, aInfo = aDemux.info;
  const vTs = vInfo.timescale || 1, aTs = aInfo.timescale || 1;
  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: muxerVideoCodec(vInfo.codec), width: (vInfo.video && vInfo.video.width) || 1920, height: (vInfo.video && vInfo.video.height) || 1080 },
    audio: { codec: 'aac', numberOfChannels: (aInfo.audio && aInfo.audio.channel_count) || 2, sampleRate: (aInfo.audio && aInfo.audio.sample_rate) || 48000 },
    fastStart: 'in-memory',
  });
  const vCP = getVideoCodecPrivate(vDemux.file, vDemux.id, vRaw);
  const aCP = getAacCodecPrivate((aInfo.audio && aInfo.audio.sample_rate) || 48000, (aInfo.audio && aInfo.audio.channel_count) || 2);
  // ★mp4-muxer 只认 decoderConfig.description（codecPrivate 不是 WebCodecs 字段，会被忽略）
  for (const s of vDemux.samples) {
    muxer.addVideoChunk(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round((s.cts / vTs) * 1e6), duration: Math.max(1, Math.round((s.duration / vTs) * 1e6)), data: s.data }), { decoderConfig: { codec: vInfo.codec, description: vCP } });
  }
  for (const s of aDemux.samples) {
    muxer.addAudioChunk(new EncodedAudioChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round((s.cts / aTs) * 1e6), duration: Math.max(1, Math.round((s.duration / aTs) * 1e6)), data: s.data }), { decoderConfig: { codec: 'mp4a.40.2', description: aCP } });
  }
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

async function mergeDashToMp4(videoUrl, audioUrl, referer) {
  if (typeof MP4Box === 'undefined' || typeof Mp4Muxer === 'undefined') throw new Error('合并库未加载');
  if (!referer) referer = 'https://www.bilibili.com/';
  // 预探测大小（HEAD → contentLength）用于进度提示。
  // ★2026-08-30：不再设 300MB 硬上限——改用【分块拉取 fetchTrackChunked】，
  //   任意大小都能拉（8MB/块，不触及 sendMessage ~64MB 上限），故只需提示大小、不再拒绝。
  let vs = 0, as = 0;
  try {
    const [vH, aH] = await Promise.all([probeSize(videoUrl, referer), probeSize(audioUrl, referer)]);
    vs = (vH && vH.contentLength) || 0;
    as = (aH && aH.contentLength) || 0;
    if (vs > 0 && typeof setStatus === 'function') {
      setStatus('⏳ 视频轨 ' + Math.round(vs / 1048576) + 'MB + 音频轨 ' + Math.round(as / 1048576) + 'MB，开始分块拉取并合并…');
    }
  } catch (_) {}
  // 分块拉取（突破 64MB 消息限制）
  let lastPct = -1;
  const onProg = (done, total) => {
    if (typeof setStatus !== 'function') return;
    const pct = Math.floor((done / total) * 100);
    if (pct !== lastPct && pct % 10 === 0) {   // 每 10% 提示一次，避免刷屏
      lastPct = pct;
      setStatus(`⏳ 拉取视频轨… ${pct}%（${Math.round(done / 1048576)}/${Math.round(total / 1048576)}MB）`);
    }
  };
  const vBytes = await fetchTrackChunked(videoUrl, referer, onProg);
  if (typeof setStatus === 'function') setStatus('⏳ 视频轨已就绪，正在拉取音频轨…');
  const aBytes = await fetchTrackChunked(audioUrl, referer, null);

  // dashDemux 期望 ArrayBuffer；用 buffer 视图（保证 byteOffset/byteLength 正确）
  const vBuf = vBytes.buffer.slice(vBytes.byteOffset, vBytes.byteOffset + vBytes.byteLength);
  const aBuf = aBytes.buffer.slice(aBytes.byteOffset, aBytes.byteOffset + aBytes.byteLength);
  // 备份原始字节供 avcC 兜底搜索（mp4box 会改写传入的 ArrayBuffer）
  const vRaw = new Uint8Array(vBuf.slice(0));
  const vDemux = await dashDemux(vRaw.buffer);
  const aDemux = await dashDemux(aBuf);
  const vInfo = vDemux.info, aInfo = aDemux.info;
  const vTs = vInfo.timescale || 1, aTs = aInfo.timescale || 1;

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
  const { buffer } = muxer.target;
  return new Blob([buffer], { type: 'video/mp4' });
}
