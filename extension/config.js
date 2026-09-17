// Ddayup 网页素材采集扩展 · 配置层（ESM 薄代理）
// 真实实现见 config-runtime.js（window.DdayupConfig，挂全局，供非 module 脚本复用）。
// 本文件仅保留 ESM 导出，供 options.js / nativeClient.js 使用，避免多份实现漂移。
export const FREE_MODE = (typeof window !== 'undefined' && window.DdayupConfig)
  ? window.DdayupConfig.FREE_MODE
  : true;

// 已适配采集策略的平台列表（对应上架计划 P1 2.1）。
export const SUPPORTED_PLATFORMS = [
  { id: 'bilibili', label: 'B站', hosts: ['*.bilibili.com'], coverSource: 'page-global(__INITIAL_STATE__.videoData.pic)' },
  { id: 'youtube', label: 'YouTube', hosts: ['*.youtube.com', '*.youtu.be'], coverSource: 'page-global(ytInitialPlayerResponse.videoDetails.thumbnail)' },
  { id: 'douyin', label: '抖音', hosts: ['*.douyin.com'], coverSource: 'render-data(RENDER_DATA aweme.cover, 经 relay 带 Referer 拉取)' },
  { id: 'weixin-channels', label: '视频号', hosts: ['*.weixin.qq.com', '*.channels.weixin.qq.com'], coverSource: 'render-data(RENDER_DATA, 需登录态)' },
  { id: 'xinpianchang', label: '新片场', hosts: ['*.xinpianchang.com'], coverSource: 'render-data/og:image' },
  { id: 'aigei', label: '爱给', hosts: ['*.aigei.com'], coverSource: 'audio-playback(音频无封面, 用波形图标)' },
  { id: 'gfxcamp', label: 'gfxcamp', hosts: ['*.gfxcamp.com'], coverSource: 'netdisk(百度网盘分享, 无直链封面)' },
  { id: 'yunqiaonet', label: '云桥网', hosts: ['*.yunqiaonet.com'], coverSource: 'netdisk(需登录购买后注入)' },
];

// ESM 代理：运行时委托 window.DdayupConfig（由 config-runtime.js 注入）。
// 若全局尚未就绪（极早加载），回退默认本机地址，保证不崩。
export async function getApiBase() {
  if (typeof window !== 'undefined' && window.DdayupConfig) return window.DdayupConfig.getApiBase();
  return 'https://mingmingchuangyi.cn';
}
export async function setApiBase(base) {
  if (typeof window !== 'undefined' && window.DdayupConfig) return window.DdayupConfig.setApiBase(base);
  return false;
}
export function defaultApiBase() {
  if (typeof window !== 'undefined' && window.DdayupConfig) return window.DdayupConfig.defaultApiBase();
  return 'https://mingmingchuangyi.cn';
}
export async function getApiKey() {
  if (typeof window !== 'undefined' && window.DdayupConfig) return window.DdayupConfig.getApiKey();
  return '';
}
export async function setApiKey(key) {
  if (typeof window !== 'undefined' && window.DdayupConfig) return window.DdayupConfig.setApiKey(key);
  return false;
}

// 原生主机名称（方案 A）。与 native-host 注册表/manifest 中声明的 name 必须一致。
export const NATIVE_HOST_NAME = 'com.ddayup.host';
