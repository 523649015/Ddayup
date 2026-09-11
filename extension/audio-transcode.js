// =====================================================================
// 音频格式转码（ogg → mp3），调用后端 ffmpeg：POST /api/media/audio-transcode
// ---------------------------------------------------------------------
// 可插拔设计：
//   · 本文件完全独立，未加载时按钮不出现，不影响任何既有功能；
//   · 只有一处对外入口 transcodeAudioToMp3(a)，预览层按需调用；
//   · 后端不可达 / ffmpeg 缺失 → 明确提示，不抛异常、不重试风暴。
// =====================================================================

function atApiBase() {
  try {
    if (typeof window !== 'undefined' && window.DdayupConfig && typeof window.DdayupConfig.getApiBaseSync === 'function') {
      const v = window.DdayupConfig.getApiBaseSync();
      if (v) return String(v).replace(/\/+$/, '');
    }
  } catch (_) {}
  return 'http://127.0.0.1:3000';
}

// 把音频资产的字节取成 base64：优先侧栏已实体化的 blob，其次走后台取回通道
async function collectAudioBase64(a) {
  // 1) 侧栏内已是 blob（豆包朗读实体化后的卡片）
  if (a && /^blob:/i.test(String(a.url || ''))) {
    try {
      const resp = await fetch(a.url);
      const ab = await resp.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)));
      }
      return btoa(bin);
    } catch (_) {}
  }
  // 2) 豆包 WS 音频：从源页取回
  if (a && a.wsAudio) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'HMDAO_GET_DOUBAO_WS_AUDIO', ts: Number(a.wsTs) || 0 });
      if (res && res.ok && res.b64) return res.b64;
    } catch (_) {}
  }
  // 3) 普通直链音频
  if (a && /^https?:/i.test(String(a.url || ''))) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'HMDAO_FETCH_MEDIA',
        url: a.url,
        referer: (typeof pageReferer === 'function') ? pageReferer(a) : '',
      });
      if (res && res.ok && res.b64) return res.b64;
    } catch (_) {}
  }
  return '';
}

// 主入口：把音频转成 MP3 并下载到本地
async function transcodeAudioToMp3(a) {
  if (!a) return false;
  const btn = document.getElementById('pvToMp3');
  const setBtn = (txt, disabled) => {
    try { if (btn) { btn.textContent = txt; btn.disabled = !!disabled; } } catch (_) {}
  };
  try {
    setBtn('⏳ 转码中…', true);
    const b64 = await collectAudioBase64(a);
    if (!b64) {
      setStatus('⚠ 取不到音频字节，无法转码（请重新扫描或重播一次朗读）', true);
      return false;
    }
    setStatus('⏳ 正在转码为 MP3（后端 ffmpeg）…');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    let resp = null;
    try {
      resp = await fetch(atApiBase() + '/api/media/audio-transcode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ b64, from: 'ogg', to: 'mp3', name: (a.title || '') }),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      setStatus('⚠ 无法连接后端转码服务（127.0.0.1:3000 未启动？）', true);
      return false;
    }
    clearTimeout(timer);
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json || !json.ok || !json.b64) {
      setStatus('⚠ 转码失败：' + ((json && json.error) || ('HTTP ' + resp.status)), true);
      return false;
    }
    const bytes = b64ToBytes(json.b64);
    const mime = json.mime || 'audio/mpeg';
    const ext = json.ext || 'mp3';
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const base = (typeof deriveFilename === 'function') ? deriveFilename(a) : (a.title || 'audio');
    const name = String(base).replace(/\.(ogg|mp3|m4a|bin)$/i, '') + '.' + ext;
    downloadBlobUrl(url, 'Ddayup/audio/' + name, a);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    setStatus('✅ 已转码并下载：' + name);
    return true;
  } catch (e) {
    setStatus('⚠ 转码异常：' + ((e && e.message) || e), true);
    return false;
  } finally {
    setBtn('🎵 转 MP3', false);
  }
}
