// ============================================================================
// Ddayup 扩展 — 消息协议常量单一真相源 (Single Source of Truth)
// ----------------------------------------------------------------------------
// 所有跨 background / sidepanel / detect / inject-main / model-api-capture
// 之间通信的 HMDAO_* 消息 type 都在这里集中定义，禁止在业务代码里硬编码字符串字面量。
//
// 用法：
//   background.js (SW)        -> importScripts('shared/messages.js') 后用 HMDAO_MSG.XXX
//   页面/ISOLATED 经典脚本    -> 暂保持各自引用，统一从本文件取值（见底部注释）
//
// 新增消息时：只需在此对象加一个键，键名即常量名、键值即原字符串。
// 这把「拼写错误只在运行时静默失败」变为「加载即暴露」。
// ============================================================================
(function (root) {
  'use strict';

  const HMDAO_MSG = Object.freeze({
    // --- 扫描 / 采集 ---
    OPEN_SCAN: 'HMDAO_OPEN_SCAN',
    SCAN_REQUEST: 'HMDAO_SCAN_REQUEST',
    SCAN_RESULT: 'HMDAO_SCAN_RESULT',
    CAPTURE_PAGE: 'HMDAO_CAPTURE_PAGE',
    PAGE_MUTATION: 'HMDAO_PAGE_MUTATION',
    CLICK_REVEAL: 'HMDAO_CLICK_REVEAL',
    DEBUG_NETWORK: 'HMDAO_DEBUG_NETWORK',
    REFRESH_FROM_PAGE: 'HMDAO_REFRESH_FROM_PAGE',
    REFRESH_ASSETS: 'HMDAO_REFRESH_ASSETS',
    FIND_SIMILAR: 'HMDAO_FIND_SIMILAR',

    // --- 网盘 / 预设 ---
    NETDISK_RESOLVE: 'HMDAO_NETDISK_RESOLVE',
    OPEN_PRESET: 'HMDAO_OPEN_PRESET',

    // --- 下载 / 导入 ---
    IMPORT_TO_APP: 'HMDAO_IMPORT_TO_APP',
    IMPORT_ASSETS: 'HMDAO_IMPORT_ASSETS',
    PANEL_CLOSED: 'HMDAO_PANEL_CLOSED',

    // --- 媒体拉取 / 播放 ---
    FETCH: 'HMDAO_FETCH',
    FETCH_MEDIA: 'HMDAO_FETCH_MEDIA',
    FETCH_IN_PAGE: 'HMDAO_FETCH_IN_PAGE',
    GET_YT_BYTES: 'HMDAO_GET_YT_BYTES',
    PLAY_AUDIO_IN_PAGE: 'HMDAO_PLAY_AUDIO_IN_PAGE',
    PLAY_PAGE_AUDIO: 'HMDAO_PLAY_PAGE_AUDIO',
    STOP_PAGE_AUDIO: 'HMDAO_STOP_PAGE_AUDIO',
    DOWNLOAD_PAGE_AUDIO: 'HMDAO_DOWNLOAD_PAGE_AUDIO',
    STOP_AUDIO_IN_PAGE: 'HMDAO_STOP_AUDIO_IN_PAGE',
    RESOLVE_FRESH_AUDIO: 'HMDAO_RESOLVE_FRESH_AUDIO',
    INSTALL_REFERER_RULE: 'HMDAO_INSTALL_REFERER_RULE',

    // --- 智能机器人 ---
    AI_CHAT: 'HMDAO_AI_CHAT',
    AI_CHAT_REPLY: 'HMDAO_AI_CHAT_REPLY',
    AI_BOT_RETURN: 'HMDAO_AI_BOT_RETURN',
    AI_BOT_STATUS: 'HMDAO_AI_BOT_STATUS',
    AI_BOT_TOGGLE_PAGE: 'HMDAO_AI_BOT_TOGGLE_PAGE',
    AI_BOT_REMOVE: 'HMDAO_AI_BOT_REMOVE',
    AGENT_UPLOAD: 'HMDAO_AGENT_UPLOAD',
    RUN_AGENT_WORKFLOW: 'HMDAO_RUN_AGENT_WORKFLOW',

    // --- 扩展心跳 / build ---
    EXT_PING: 'HMDAO_EXT_PING',
    EXT_PONG: 'HMDAO_EXT_PONG',
    REPORT_BUILD: 'HMDAO_REPORT_BUILD',
    GET_BUILDS: 'HMDAO_GET_BUILDS',

    // --- 模型 API 捕获 / 魔法 ---
    MODEL_API_CAPTURE: 'HMDAO_MODEL_API_CAPTURE',
    VERIFY_MAGIC: 'HMDAO_VERIFY_MAGIC',

    // --- build 标记键（非消息，但同前缀，一并集中避免散落）---
    BUILDS: 'HMDAO_BUILDS',
    MAIN_BUILD: 'HMDAO_MAIN_BUILD',
  });

  // SW / background：挂到 globalThis（importScripts 后即为 self.HMDAO_MSG）
  root.HMDAO_MSG = HMDAO_MSG;

  // 页面 / 经典脚本将来可统一引用：
  //   const MSG = (typeof self !== 'undefined' && self.HMDAO_MSG) || HMDAO_MSG_FALLBACK;
  // 当前各页面脚本仍保留字面量，待后续统一迁移至此常量。
})(typeof self !== 'undefined' ? self : this);
