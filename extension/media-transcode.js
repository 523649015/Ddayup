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
function getVideoCodecPrivate(file, trackId) {
  try {
    const trak = file.getTrackById(trackId);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C || null;
    if (!box) return null;
    const ds = new MP4Box.DataStream(new ArrayBuffer(8192), 0, MP4Box.DataStream.BIG_ENDIAN);
    box.write(ds);
    const out = new Uint8Array(ds.buffer, 0, ds.position);
    return out.subarray(8); // 去掉 8 字节 box 头，只留 avcC/hvcC 配置 payload
  } catch (_) { return null; }
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
  if (codec && /hvc|hev/i.test(codec)) return 'hevc';
  return 'avc';
}

// 合并 DASH 分离的视频轨 + 音频轨为单文件 MP4（mp4box 解封装 + mp4-muxer 重封装）
async function mergeDashToMp4(videoUrl, audioUrl) {
  if (typeof MP4Box === 'undefined' || typeof Mp4Muxer === 'undefined') throw new Error('合并库未加载');
  const referer = 'https://www.bilibili.com/';
  const [vResp, aResp] = await Promise.all([
    fetchViaBackground(videoUrl, { referer }),
    fetchViaBackground(audioUrl, { referer }),
  ]);
  if (!vResp || !vResp.ok || !vResp.arrayBuffer) throw new Error('视频轨获取失败');
  if (!aResp || !aResp.ok || !aResp.arrayBuffer) throw new Error('音频轨获取失败');

  const vDemux = await dashDemux(vResp.arrayBuffer);
  const aDemux = await dashDemux(aResp.arrayBuffer);
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

  const vCP = getVideoCodecPrivate(vDemux.file, vDemux.id);
  const aCP = getAacCodecPrivate((aInfo.audio && aInfo.audio.sample_rate) || 48000, (aInfo.audio && aInfo.audio.channel_count) || 2);

  for (const s of vDemux.samples) {
    const chunk = new EncodedVideoChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: Math.round((s.cts / vTs) * 1e6),
      duration: Math.max(1, Math.round((s.duration / vTs) * 1e6)),
      data: s.data,
    });
    muxer.addVideoChunk(chunk, { decoderConfig: { codec: vInfo.codec, codecPrivate: vCP } });
  }
  for (const s of aDemux.samples) {
    const chunk = new EncodedAudioChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: Math.round((s.cts / aTs) * 1e6),
      duration: Math.max(1, Math.round((s.duration / aTs) * 1e6)),
      data: s.data,
    });
    muxer.addAudioChunk(chunk, { decoderConfig: { codec: 'mp4a.40.2', codecPrivate: aCP } });
  }
  muxer.finalize();
  const { buffer } = muxer.target;
  return new Blob([buffer], { type: 'video/mp4' });
}
