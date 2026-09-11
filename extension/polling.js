// ===== 扩展轮询 / 去抖重扫层（由 background.js 经 importScripts 引入）=====
// 负责：网络捕获后的去抖重扫（scheduleRescan）、视频站主动轮询（startPolling/stopPolling）。
// 这些函数只依赖 background 运行时已存在的 scanTab（background.js 内定义，importScripts 在
// background 主逻辑之前加载，运行时调用顺序保证可见），以及全局 timer Map。
// 沿用 mv3-state.js 惯例：以全局函数/常量形式挂载到 SW 全局作用域。

// 去抖重扫：用户点播放后网络层抓到音视频，自动刷新侧栏一次（避免「必须手动重新扫描才能看到音频」）
const RESCAN_TIMERS = {};
function scheduleRescan(tabId) {
  if (RESCAN_TIMERS[tabId]) return;
  RESCAN_TIMERS[tabId] = setTimeout(() => {
    delete RESCAN_TIMERS[tabId];
    // 网络捕获重扫走轻量轮询（不重复跑 WBI 等重网络解析），加速感知
    scanTab(tabId, { deep: false }).catch(() => {});
  }, 800);
}

// ===== A) 主动轮询：首扫之后对视频站每 3.5s 自动重扫一次（限时 90s 或侧栏关闭）=====
// 根治「等一分钟才识别」：播放器常在页面加载后、自动播放策略放行后才请求流媒体，
// 纯被动架构要等用户手动重扫；轮询让「播放器一旦请求流」几秒内即进面板。
const POLL_TIMERS = {};
const VIDEO_HOST_RE = /youtube|bilibili|douyin|tiktok|bytedance|weixin|qq\.com|xinpianchang|youku|iqiyi|mgtv|sohu|cctv|migu/i;
function isVideoHost(url) {
  try { return VIDEO_HOST_RE.test(new URL(url || '').hostname); } catch (_) { return false; }
}
function stopPolling(tabId) {
  if (POLL_TIMERS[tabId]) { clearInterval(POLL_TIMERS[tabId]); delete POLL_TIMERS[tabId]; }
}
function startPolling(tabId) {
  stopPolling(tabId);
  chrome.tabs.get(tabId).then((t) => {
    // ★放开到所有 http(s) 页面：3D 模型站点「下载按钮 → API 返回签名直链」发生在扫描之后，
    // 只对视频站轮询会漏掉 modelHits 补扫（3D 文件识别不出的第三根因）。视频站 3.5s，普通站 5s。
    if (!t || !/^https?:/i.test(t.url || '')) return;
    // ★2026-09-06：豆包（doubao.com）不启动自动轮询。
    //   豆包是超重 SPA（DOM 巨大 + 持续 SSE 更新），每 12s 一次全量页面扫描会带来可感知的卡顿，
    //   而它的朗读音频只在用户点「朗读」后产生 —— 用户点侧栏「扫描」即可，无需后台反复扫。
    //   这是纯性能取舍：不影响采集能力，只去掉无谓的周期性开销。
    if (/doubao\.com/i.test(t.url || '')) return;
    // ★2026-08-30 修复（"侧栏卡片闪烁"根因）：3.5s 一次太频繁 → B站 SPA 持续推内容
    //   → 扫描器不断捕获新元素 → 侧栏持续新增卡片 → 视觉闪烁。改为 10s/8s（视频/普通站）。
    //   SPA 跳集/加载完成仍可及时感知（用户感知延迟从 3.5s → 10s，可接受）。
    const interval = isVideoHost(t.url) ? 10000 : 12000;
    POLL_TIMERS[tabId] = setInterval(() => {
      // ★2026-09-09（源页零开销硬约束）：后台 / 非激活标签跳过本轮扫描——用户看不到的页面
      //   不必周期性地注入脚本与遍历 DOM。切回前台后下一轮（≤12s，且有 scheduleRescan 即时补位）恢复，
      //   采集能力不打折，只去掉无谓的周期性打扰。
      chrome.tabs.get(tabId).then((tt) => {
        if (!tt || tt.active === false) return;
        scanTab(tabId, { deep: false }).catch(() => {}); // 轻量轮询：只读被动捕获 + DOM
      }).catch(() => {});
    }, interval);
  }).catch(() => {});
}
