import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const appUrl = process.env.HMDAO_APP_URL || 'http://127.0.0.1:3000/';
const chromePath = process.env.HMDAO_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const remoteDebugPort = Number(process.env.HMDAO_VERIFY_LAUNCH_PORT || 9231);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message, extra) {
  if (!condition) {
    const details = extra ? `\n${JSON.stringify(extra, null, 2)}` : '';
    throw new Error(`${message}${details}`);
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.nextId = 0;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const payload = JSON.parse(String(event.data || '{}'));
      if (!payload.id) return;
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      if (payload.error) {
        pending.reject(new Error(payload.error.message || 'cdp-error'));
      } else {
        pending.resolve(payload.result);
      }
    });
  }

  async ready() {
    await this.openPromise;
  }

  async send(method, params = {}) {
    await this.ready();
    const id = ++this.nextId;
    const payload = { id, method, params };
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

async function connectToPageWs() {
  const version = await fetch(`http://127.0.0.1:${remoteDebugPort}/json/version`).then((res) => res.json());
  const browserWs = String(version.webSocketDebuggerUrl || '');
  assert(browserWs, 'Missing browser websocket URL from Chrome remote debugging.');

  const browserCdp = new CdpClient(browserWs);
  await browserCdp.ready();
  const { targetId } = await browserCdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId, flatten: true });

  const page = {
    async send(method, params = {}) {
      return await browserCdp.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id: Date.now() + Math.random(), method, params }),
      });
    },
  };

  const pageWsVersion = await fetch(`http://127.0.0.1:${remoteDebugPort}/json/list`).then((res) => res.json());
  const pageTarget = pageWsVersion.find((item) => item.id === targetId);
  assert(pageTarget?.webSocketDebuggerUrl, 'Missing page websocket URL after target creation.');
  await browserCdp.close();
  return new CdpClient(pageTarget.webSocketDebuggerUrl);
}

async function evalJs(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'runtime-evaluate-failed');
  }
  return result.result?.value;
}

async function waitFor(cdp, expression, timeoutMs = 30000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evalJs(cdp, expression);
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for expression: ${expression}`);
}

async function clickSelector(cdp, selector) {
  const ok = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()
  `);
  assert(ok, `Failed to click selector ${selector}`);
}

async function setInputValue(cdp, selector, value) {
  const ok = await evalJs(cdp, `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
      if (setter) {
        setter.call(element, ${JSON.stringify(value)});
      } else {
        element.value = ${JSON.stringify(value)};
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  assert(ok, `Failed to set input value for ${selector}`);
}

async function main() {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddup-launch-auth-'));
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${remoteDebugPort}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], {
    stdio: 'ignore',
    windowsHide: true,
  });

  let cdp = null;
  try {
    await delay(1600);
    cdp = await connectToPageWs();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Input.enable').catch(() => null);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: appUrl });
    await waitFor(cdp, 'document.readyState !== "loading"', 30000);

    const splashState = await waitFor(cdp, `
      (() => {
        const root = document.querySelector('[data-testid="launch-screen"]');
        const copy = document.querySelector('[data-testid="launch-copy"]');
        const countdown = document.querySelector('[data-testid="launch-countdown"]');
        if (!(root instanceof HTMLElement) || !(copy instanceof HTMLElement) || !(countdown instanceof HTMLElement)) return null;
        return {
          copy: String(copy.textContent || '').trim(),
          countdown: String(countdown.textContent || '').trim(),
        };
      })()
    `, 30000);
    assert(String(splashState.copy || '').includes('遇见更多志同道合的人'), 'Launch screen copy was not visible.', splashState);

    await delay(1200);
    const countdownState = await evalJs(cdp, `
      (() => {
        const countdown = document.querySelector('[data-testid="launch-countdown"]');
        return countdown instanceof HTMLElement ? String(countdown.textContent || '').trim() : '';
      })()
    `);
    assert(countdownState && countdownState !== splashState.countdown, 'Launch countdown did not change over time.', { before: splashState.countdown, after: countdownState });

    await clickSelector(cdp, '[data-testid="launch-enter"]');
    await waitFor(cdp, `Boolean(document.querySelector('[data-testid="add-node-image"]'))`, 30000);

    await clickSelector(cdp, '[data-testid="add-node-image"]');
    const imageNodeId = await waitFor(cdp, `
      (() => {
        const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.()?.canvas?.nodes || [];
        const node = [...nodes].reverse().find((item) => item?.type === 'image');
        return node ? String(node.id || '') : '';
      })()
    `, 15000);
    assert(imageNodeId, 'Failed to add image node on canvas.');

    await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(`[data-testid="image-prompt-${String(imageNodeId)}"]`)}))`, 15000);
    await setInputValue(cdp, `[data-testid="image-prompt-${imageNodeId}"]`, '一张具有强烈品牌感的汽车海报');
    await clickSelector(cdp, `[data-testid="image-generate-${imageNodeId}"]`);

    const authModalState = await waitFor(cdp, `
      (() => {
        const modal = document.querySelector('[data-testid="generation-auth-modal"]');
        const loginTab = document.querySelector('[data-testid="generation-auth-tab-login"]');
        const registerTab = document.querySelector('[data-testid="generation-auth-tab-register"]');
        return modal && loginTab && registerTab ? true : false;
      })()
    `, 15000);
    assert(Boolean(authModalState), 'Guest generate did not trigger the auth modal.');

    const uniqueEmail = `verify-launch-${Date.now()}@example.com`;
    const password = 'DdUpVerify123';
    await clickSelector(cdp, '[data-testid="generation-auth-tab-register"]');
    await setInputValue(cdp, '[data-testid="generation-auth-register-email"]', uniqueEmail);
    await setInputValue(cdp, '[data-testid="generation-auth-register-password"]', password);
    await setInputValue(cdp, '[data-testid="generation-auth-register-confirm"]', password);
    await clickSelector(cdp, '[data-testid="generation-auth-register-submit"]');
    await waitFor(cdp, `String(document.body?.textContent || '').includes('账号已创建')`, 20000);

    await setInputValue(cdp, '[data-testid="generation-auth-login-email"]', uniqueEmail);
    await setInputValue(cdp, '[data-testid="generation-auth-login-password"]', password);
    await clickSelector(cdp, '[data-testid="generation-auth-login-submit"]');
    await waitFor(cdp, `!document.querySelector('[data-testid="generation-auth-modal"]')`, 20000);

    await clickSelector(cdp, `[data-testid="image-generate-${imageNodeId}"]`);
    const apiKeyPromptState = await waitFor(cdp, `
      (() => {
        const modal = document.querySelector('[data-testid="generation-auth-modal"]');
        if (!(modal instanceof HTMLElement)) return null;
        const text = String(modal.textContent || '');
        return text.includes('API Key') ? { text: text.slice(0, 500) } : null;
      })()
    `, 15000);
    assert(Boolean(apiKeyPromptState), 'After sign-in, generate flow did not proceed to the API-key guidance stage.', apiKeyPromptState);

    console.log(JSON.stringify({
      ok: true,
      splashCopy: splashState.copy,
      countdownBefore: splashState.countdown,
      countdownAfter: countdownState,
      imageNodeId,
      registeredEmail: uniqueEmail,
      apiKeyPromptDetected: true,
    }, null, 2));
  } finally {
    if (cdp) {
      await cdp.close().catch(() => null);
    }
    if (!chrome.killed) {
      chrome.kill();
    }
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
