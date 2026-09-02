// Ddayup 扩展选项页逻辑：读写云端 API 地址与运维 Key（storage key 与 config.js / sidepanel.js 一致）。
import { getApiBase, setApiBase, defaultApiBase, getApiKey, setApiKey } from './config.js';

const input = document.getElementById('apiBase');
const keyInput = document.getElementById('apiKey');
const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');

function showStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind || ''}`;
}

async function init() {
  const current = await getApiBase();
  input.value = current === defaultApiBase() ? '' : current;
  keyInput.value = (await getApiKey()) || '';
  showStatus('当前地址：' + current, '');
}

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
