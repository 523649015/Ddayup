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
    // 信息流批量采集（独立于 REFRESH_FROM_PAGE，避免与单视频源页解析串扰）
    // body: { mode: 'collection' | 'currentPage' | 'custom', awemeIds?: string[], tabId? }
    // 处理前注入 window.__hmdao_batchMode=true 到源页，强制 tryDouyinWeixin 走 aweme_list 多视频分支；
    // 处理完清除该信号，恢复单视频默认行为。
    BATCH_COLLECT: 'HMDAO_BATCH_COLLECT',

    // --- 网盘 / 预设 ---
    NETDISK_RESOLVE: 'HMDAO_NETDISK_RESOLVE',
    // 在已打开的网盘页中递归解析文件树（自动填码 + 展开子目录 + 捕获每个文件的下载直链）
    // 返回结构化 { tree: [{name, size, isDir, url?, children?}], names: [...] }
    NETDISK_TREE: 'HMDAO_NETDISK_TREE',
    // 在网盘页内自动勾选指定文件并触发下载按钮，通过浏览器下载事件捕获真实直链
    // body: { url, name?, fileId? }  返回 { ok, url?, name? }
    NETDISK_DOWNLOAD: 'HMDAO_NETDISK_DOWNLOAD',
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
    INSTALL_YOUKU_REFERER: 'HMDAO_INSTALL_YOUKU_REFERER', // 优酷 CDN 一次性注入 Referer，供 hls.js 拉 m3u8/.ts

    // --- B站多分辨率枚举（纯前端 WBI，不依赖后端 yt-dlp）---
    // 在源页 MAIN 世界用 WBI 签名调 /x/player/playurl?fnval=16（DASH），
    // 一次返回 dash.video[]（含所有分辨率轨）+ support_formats（清晰度名称），
    // 让侧栏下载面板能列出 4K/1080P/720P/480P… 供用户自选，无需后端。
    // body: { tabId }   返回 { ok, formats: [{quality,label,width,height,url,codecs,isDash}], audioUrl, title }
    BILI_LIST_QUALITIES: 'HMDAO_BILI_LIST_QUALITIES',
    // ★2026-08-31：DASH 音视频【后台线程合并】（大视频也要合并成含音画单文件）。
    //   侧栏主线程做 mp4box 解封装会冻结 UI，故放到 Service Worker 线程执行：
    //     in : { videoUrl, audioUrl, referer, filename }
    //     out: 先发若干 HMDAO_MERGE_CHUNK（每块 ≤50MB，不触及 ~64MB 消息上限），最后发 HMDAO_MERGE_DONE
    MERGE_DASH: 'HMDAO_MERGE_DASH',
    MERGE_CHUNK: 'HMDAO_MERGE_CHUNK',
    MERGE_DONE: 'HMDAO_MERGE_DONE',
    MERGE_PROGRESS: 'HMDAO_MERGE_PROGRESS',

    // --- 智能机器人 ---
    AI_CHAT: 'HMDAO_AI_CHAT',
    AI_CHAT_REPLY: 'HMDAO_AI_CHAT_REPLY',
    AI_BOT_RETURN: 'HMDAO_AI_BOT_RETURN',
    AI_BOT_STATUS: 'HMDAO_AI_BOT_STATUS',
    AI_BOT_TOGGLE_PAGE: 'HMDAO_AI_BOT_TOGGLE_PAGE',
    AI_BOT_REMOVE: 'HMDAO_AI_BOT_REMOVE',
    AGENT_UPLOAD: 'HMDAO_AGENT_UPLOAD',
    RUN_AGENT_WORKFLOW: 'HMDAO_RUN_AGENT_WORKFLOW',

    // --- 截图识文（可插拔特性，features/screenshot-ocr*）---
    // sidepanel → background：请求截当前视口(png 高保真) / 长截图
    //   payload: { tabId?, format? }
    // background → sidepanel：sendResponse({ ok, dataUrl, restricted, isLong, width, height })
    SCREENSHOT_CAPTURE: 'HMDAO_SCREENSHOT_CAPTURE',
    SCREENSHOT_CAPTURE_LONG: 'HMDAO_SCREENSHOT_CAPTURE_LONG',
    // 注入页 → sidepanel：用户取消框选
    SCREENSHOT_CANCEL: 'HMDAO_SCREENSHOT_CANCEL',
    // robot-overlay（网页浮标 content script）→ sidepanel：触发截图
    //   payload: { mode: 'region' | 'long' }
    SCREENSHOT_OPEN: 'HMDAO_SCREENSHOT_OPEN',
    // 注入页 → sidepanel：用户框选完区域后回传矩形
    //   payload: { x, y, w, h, dpr, scrollX, scrollY, vw, vh }
    SCREENSHOT_REGION_READY: 'HMDAO_SCREENSHOT_REGION_READY',
    // sidepanel → background：把截图发后端做 OCR / 翻译（不传画布）
    //   payload: { image: dataURL, task: 'ocr' | 'translate', lang?, deviceId?, token? }
    // background → sidepanel：sendResponse({ ok, text, error, licenseRequired })
    SCREENSHOT_OCR: 'HMDAO_SCREENSHOT_OCR',
    // sidepanel → robot-overlay：OCR / 翻译结果回传（robot 不在页时回退侧栏面板）
    //   payload: { text, error, licenseRequired }
    SCREENSHOT_OCR_RESULT: 'HMDAO_SCREENSHOT_OCR_RESULT',
    // sidepanel → robot-overlay：截图结果回传（渲染到网页机器人浮标，跟随锚点）
    //   payload: { dataUrl, isLong, width, height }
    SCREENSHOT_RESULT: 'HMDAO_SCREENSHOT_RESULT',
    // sidepanel → robot-overlay：错误 / 提示（复制成功或失败也复用此通道）
    //   payload: { error }
    SCREENSHOT_ERROR: 'HMDAO_SCREENSHOT_ERROR',
    // robot-overlay → sidepanel：复制截图（由 sidepanel 在 active tab MAIN 世界执行，最可靠）
    //   payload: { dataUrl }
    SCREENSHOT_COPY: 'HMDAO_SCREENSHOT_COPY',
    // robot-overlay → sidepanel：保存截图到本地（由 sidepanel 调 chrome.downloads.download）
    //   payload: { dataUrl }
    SCREENSHOT_SAVE: 'HMDAO_SCREENSHOT_SAVE',

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
