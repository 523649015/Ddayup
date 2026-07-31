// ===== 素材类型注册中心 =====
// 集中定义素材 type 的【规范字符串集合】与【三类映射】（扩展名 / 中文标签 / 下载目录）。
// 目的：消除散落在多处、含义相同的魔法字符串歧义，统一为单一事实来源。
// 依赖：无（纯数据 + 纯函数），必须在 sidepanel.js / bulk-actions.js / audio-playback.js 之前加载。
// 约定：各文件仍可用字符串字面量（'video'/'audio'/...）做比较，但【映射取值】一律走本文件的全局函数/对象。

// 规范 type 集合（唯一事实来源）。新增类型只在此登记一次。
const ASSET_TYPES = Object.freeze({
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  MODEL: 'model',
  ARCHIVE: 'archive',
  NETDISK: 'netdisk',
});

// type → 默认扩展名（deriveFilename 用作兜底后缀）
function extForType(type) {
  return { image: 'png', video: 'mp4', audio: 'mp3', model: 'glb', archive: 'zip' }[type] || 'bin';
}

// type → 中文标签（UI 展示）
function typeLabel(t) {
  return { image: '图片', video: '视频', audio: '音频', model: '3D 模型', archive: '归档', netdisk: '网盘' }[t] || t;
}

// type → 下载子目录名（Ddayup/<dir>/...）
const typeDirs = Object.freeze({
  image: 'images',
  video: 'videos',
  audio: 'audio',
  model: 'models',
  archive: 'archives',
  netdisk: 'netdisk',
});

// 校验 type 是否属于规范集合（单一事实来源在此，避免各文件重复魔法字符串判断）
function validAssetType(t) {
  if (!t || typeof t !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(ASSET_TYPES, t.toUpperCase()) && ASSET_TYPES[t.toUpperCase()] === t;
}
// 归一代管：小写/拼写近似统一回规范值；无法识别返回 null（调用方决定丢弃或保留原值）
function normalizeAssetType(t) {
  if (validAssetType(t)) return t;
  const lower = String(t || '').toLowerCase();
  const alias = {
    img: 'image', pic: 'image', picture: 'image', photo: 'image',
    vid: 'video', movie: 'video', clip: 'video',
    aud: 'audio', sound: 'audio', mp3: 'audio',
    mod: 'model', mesh: 'model', glb: 'model',
    zip: 'archive', rar: 'archive', '3d': 'model',
    disk: 'netdisk', pan: 'netdisk', baidu: 'netdisk',
  }[lower];
  if (alias) return alias;
  return null;
}
