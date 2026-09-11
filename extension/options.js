// Ddayup 扩展选项页逻辑：读写云端 API 地址与运维 Key（storage key 与 config.js / sidepanel.js 一致）。
import { getApiBase, setApiBase, defaultApiBase, getApiKey, setApiKey } from './config.js';

const input = document.getElementById('apiBase');
const keyInput = document.getElementById('apiKey');
const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const featScreenshotOcr = document.getElementById('featScreenshotOcr');

function showStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind || ''}`;
}

async function init() {
  const current = await getApiBase();
  input.value = current === defaultApiBase() ? '' : current;
  keyInput.value = (await getApiKey()) || '';
  const f = await new Promise((res) => chrome.storage.local.get('hmdao:feature:screenshotOcr', (o) => res(o['hmdao:feature:screenshotOcr'])));
  featScreenshotOcr.checked = (f === undefined ? true : !!f);
  showStatus('当前地址：' + current, '');
}

// 「截图识文」开关：实时写入 storage，侧栏 FeatureManager 读取后热插拔
featScreenshotOcr.addEventListener('change', () => {
  chrome.storage.local.set({ 'hmdao:feature:screenshotOcr': featScreenshotOcr.checked });
  showStatus(featScreenshotOcr.checked ? '已启用「截图识文」。' : '已停用「截图识文」。', 'ok');
});

saveBtn.addEventListener('click', async () => {
  const raw = input.value.trim();
  if (!raw) {
    // 空值视为恢复默认
    await setApiBase(defaultApiBase());
    showStatus('已恢复默认（本机 3000）。', 'ok');
  } else if (!/^https?:\/\/.+/.test(raw)) {
    showStatus('地址格式不正确，须以 http:// 或 https:// 开头。', 'err');
    return;
  } else {
    const ok = await setApiBase(raw);
    if (!ok) { showStatus('保存失败，请重试。', 'err'); return; }
  }
  await setApiKey(keyInput.value.trim());
  showStatus('已保存云端地址与 Key。', 'ok');
});

resetBtn.addEventListener('click', async () => {
  await setApiBase(defaultApiBase());
  await setApiKey('');
  input.value = '';
  keyInput.value = '';
  showStatus('已恢复默认（本机 3000）。', 'ok');
});

init();
