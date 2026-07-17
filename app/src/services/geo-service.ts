/**
 * HMDao 地理位置服务 — 浏览器端检测国内/国际用户
 * 
 * 检测策略（按优先级）：
 * 1. navigator.language — 浏览器语言偏好
 * 2. Intl.DateTimeFormat().resolvedOptions().timeZone — 时区
 * 3. navigator.languages — 多语言列表
 * 
 * 用途：
 * - 自动切换国内/国际 API 端点
 * - 自动选择合规策略
 * - 默认语言设置
 */

export interface GeoInfo {
  region: 'CN' | 'US' | 'OTHER';
  currency: 'CNY' | 'USD';
  timezone: string;
  language: string;
  domestic: boolean;
}

/** 国内时区列表 */
const CN_TIMEZONES = [
  'Asia/Shanghai', 'Asia/Chongqing', 'Asia/Harbin', 'Asia/Urumqi',
  'Asia/Hong_Kong', 'Asia/Macau', 'Asia/Taipei',
];

/** 国内语言代码 */
const CN_LANGUAGES = ['zh', 'zh-CN', 'zh-Hans', 'zh-Hans-CN', 'zh-SG', 'zh-TW', 'zh-HK', 'zh-MO'];

/** 从浏览器检测地理位置 */
export function detectFromBrowser(): GeoInfo {
  const language = navigator.language || 'en-US';
  const languages = navigator.languages || [language];
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // 检测是否为国内用户
  const isCnLanguage = languages.some(l => CN_LANGUAGES.includes(l));
  const isCnTimezone = CN_TIMEZONES.includes(timezone);
  const domestic = isCnLanguage || isCnTimezone;

  if (domestic) {
    return {
      region: 'CN',
      currency: 'CNY',
      timezone,
      language: languages.find(l => CN_LANGUAGES.includes(l)) || 'zh-CN',
      domestic: true,
    };
  }

  // 检测美国
  const isUsLanguage = language.startsWith('en');
  const isUsTimezone = timezone.startsWith('America/') || timezone === 'Pacific/Honolulu';

  if (isUsLanguage || isUsTimezone) {
    return {
      region: 'US',
      currency: 'USD',
      timezone,
      language: 'en-US',
      domestic: false,
    };
  }

  return {
    region: 'OTHER',
    currency: 'USD',
    timezone,
    language,
    domestic: false,
  };
}

/** 获取缓存的 Geo 信息 */
let cachedGeo: GeoInfo | null = null;

export function getGeoInfo(): GeoInfo {
  if (!cachedGeo) {
    cachedGeo = detectFromBrowser();
  }
  return cachedGeo;
}

/** 刷新 Geo 缓存 */
export function refreshGeoInfo(): GeoInfo {
  cachedGeo = detectFromBrowser();
  return cachedGeo;
}

/** 判断是否为国内用户 */
export function isDomesticUser(): boolean {
  return getGeoInfo().domestic;
}

/** 根据区域选择 API 端点 */
export function selectEndpoint(domesticUrl: string, globalUrl: string): string {
  return isDomesticUser() ? domesticUrl : globalUrl;
}
