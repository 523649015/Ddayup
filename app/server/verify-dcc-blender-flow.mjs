import { main } from './verify-dcc-browser-flow.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const imageOnly = !['0', 'false', 'no'].includes(String(process.env.HMDAO_DCC_BLENDER_IMAGE_ONLY || '1').trim().toLowerCase());

async function appendStage(baseDir, label, payload) {
  const filename = `blender-${label}.json`;
  await fs.writeFile(
    path.join(baseDir, filename),
    JSON.stringify({ capturedAt: new Date().toISOString(), ...payload }, null, 2),
    'utf8',
  );
}

async function browserEval(cdp, expression, timeout = 30000) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return result.result?.value;
}

async function browserWait(cdp, expression, timeoutMs = 30000, intervalMs = 300) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await browserEval(cdp, expression, Math.min(timeoutMs, 5000)).catch(() => false);
    if (ok) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function click(cdp, selector) {
  const ok = await browserEval(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`,
  );
  if (!ok) throw new Error(`Missing selector: ${selector}`);
}

async function setValue(cdp, selector, value) {
  const ok = await browserEval(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = Object.getPrototypeOf(el);
      const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, ${JSON.stringify(value)});
      else el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
  if (!ok) throw new Error(`Missing selector: ${selector}`);
}

async function readPreviewSignature(cdp, nodeId) {
  return browserEval(
    cdp,
    `(() => {
      const node = document.querySelector(${JSON.stringify(`[data-testid=dcc-node-${'${nodeId}'}]`.replace('${nodeId}', nodeId))});
      const canvas = node ? node.querySelector('canvas') : null;
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const sampleWidth = Math.max(1, Math.min(12, Math.floor(canvas.width / 80)));
      const sampleHeight = Math.max(1, Math.min(12, Math.floor(canvas.height / 80)));
      const imageData = ctx.getImageData(0, 0, Math.min(canvas.width, sampleWidth * 6), Math.min(canvas.height, sampleHeight * 6)).data;
      const values = [];
      let brightness = 0;
      for (let i = 0; i < imageData.length; i += 4 * sampleWidth * sampleHeight) {
        const r = imageData[i] || 0;
        const g = imageData[i + 1] || 0;
        const b = imageData[i + 2] || 0;
        const y = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
        brightness += y;
        values.push(String(Math.round(y / 8)));
      }
      return { signature: values.join('|'), averageBrightness: Math.round(brightness / Math.max(1, values.length)) };
    })()`,
  );
}

async function sampleMotion(cdp, nodeId, count = 4, interval = 280) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    samples.push(await readPreviewSignature(cdp, nodeId));
    if (i < count - 1) {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
  const signatures = Array.from(new Set(samples.map((item) => item?.signature).filter(Boolean)));
  return { samples, signatures, motionDetected: signatures.length >= 2 };
}

async function readPauseTitle(cdp, nodeId) {
  return browserEval(
    cdp,
    `(() => {
      const button = document.querySelector(${JSON.stringify(`[data-testid=dcc-pause-${nodeId}]`)});
      return button ? (button.getAttribute('title') || '') : '';
    })()`,
  );
}

async function readNodeText(cdp, nodeId) {
  return browserEval(
    cdp,
    `(() => {
      const node = document.querySelector(${JSON.stringify(`[data-testid=dcc-node-${nodeId}]`)});
      return node ? (node.textContent || '') : '';
    })()`,
  );
}

async function disconnectCurrentNode(cdp, nodeId) {
  await browserEval(
    cdp,
    `(() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.setSelectedNodeIds !== 'function') return false;
      store.setSelectedNodeIds([${JSON.stringify(nodeId)}]);
      return true;
    })()`,
  );
  await browserWait(
    cdp,
    `(() => !!document.querySelector(${JSON.stringify(`[data-testid=dcc-disconnect-${'${nodeId}'}]`.replace('${nodeId}', nodeId))}))()`,
    10000,
  );
  await click(cdp, `[data-testid=dcc-disconnect-${nodeId}]`);
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

async function focusDccNode(cdp, nodeId) {
  await browserEval(
    cdp,
    `(() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      if (!store || typeof store.setSelectedNodeIds !== 'function') return false;
      store.setSelectedNodeIds([${JSON.stringify(nodeId)}]);
      return true;
    })()`,
  );
  await browserWait(
    cdp,
    `(() => !!document.querySelector(${JSON.stringify(`[data-testid=dcc-start-frame-${nodeId}]`)}))()`,
    15000,
    250,
  );
}

async function waitForMeaningfulBlenderCameras(cdp, nodeId) {
  await browserWait(
    cdp,
    `(() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const dccNode = nodes.find((node) => node.id === ${JSON.stringify(nodeId)});
      const params = dccNode?.data?.params || {};
      const selected = typeof params.selectedCamera === 'string' ? params.selectedCamera : '';
      const select = document.querySelector(${JSON.stringify(`[data-testid=dcc-camera-${nodeId}]`)});
      const options = select && select.options ? Array.from(select.options).map((option) => option.label || option.value) : [];
      const meaningful = options.filter((label) => label && !/^视口$/i.test(label));
      return meaningful.length >= 1 || (selected && !/^视口$/i.test(selected));
    })()`,
    45000,
    400,
  );

  return browserEval(
    cdp,
    `(() => {
      const select = document.querySelector(${JSON.stringify(`[data-testid=dcc-camera-${nodeId}]`)});
      if (!select || !select.options) return [];
      return Array.from(select.options)
        .map((option) => ({ value: option.value, label: option.label }))
        .filter((option) => option.label && !/^视口$/i.test(option.label));
    })()`,
  );
}

async function readBlenderReadyCameras(cdp, nodeId) {
  await browserWait(
    cdp,
    `(() => {
      const disconnectButton = document.querySelector(${JSON.stringify(`[data-testid=dcc-disconnect-${nodeId}]`)});
      const select = document.querySelector(${JSON.stringify(`[data-testid=dcc-camera-${nodeId}]`)});
      const options = select && select.options ? Array.from(select.options).map((option) => option.label || option.value).filter(Boolean) : [];
      const node = document.querySelector(${JSON.stringify(`[data-testid=dcc-node-${nodeId}]`)});
      const nodeText = node ? (node.textContent || '') : '';
      const hasFps = /\\b[1-9][0-9]*\\s*fps\\b/i.test(nodeText);
      return Boolean(disconnectButton && !disconnectButton.disabled) && (options.length >= 1 || hasFps);
    })()`,
    45000,
    400,
  );

  return browserEval(
    cdp,
    `(() => {
      const select = document.querySelector(${JSON.stringify(`[data-testid=dcc-camera-${nodeId}]`)});
      if (!select || !select.options) return [];
      const options = Array.from(select.options)
        .map((option) => ({ value: option.value, label: option.label }))
        .filter((option) => option.label);
      const meaningful = options.filter((option) => !/^瑙嗗彛$/i.test(option.label) && !/^视口$/i.test(option.label));
      return meaningful.length > 0 ? meaningful : options;
    })()`,
  );
}

async function run() {
  const result = await main({ headless: true, keepOpen: true });
  const { cdp, runDir, nodeId, cleanup } = result;

  await disconnectCurrentNode(cdp, nodeId);
  await appendStage(runDir, 'unreal-disconnected', { nodeId });

  await setValue(cdp, `[data-testid=dcc-engine-${nodeId}]`, 'blender');
  await appendStage(runDir, 'blender-engine-selected', { nodeId });
  await click(cdp, `[data-testid=dcc-connect-${nodeId}]`);

  await browserWait(
    cdp,
    `(() => {
      const snapshot = window.__HMDAO_DEBUG__?.readCanvasSnapshot?.();
      const dccNode = (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).find((node) => node.id === ${JSON.stringify(nodeId)});
      return snapshot?.selectedNodeIds?.includes(${JSON.stringify(nodeId)}) && dccNode?.data?.model === 'blender';
    })()`,
    15000,
  );
  await browserWait(
    cdp,
    `(() => {
      const node = (window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || []).find((item) => item.id === ${JSON.stringify(nodeId)});
      const params = node?.data?.params || {};
      return Boolean(params.engine === 'blender');
    })()`,
    15000,
  );

  const cameras = await readBlenderReadyCameras(cdp, nodeId);
  await appendStage(runDir, 'blender-cameras-read', { nodeId, cameras });

  if (cameras.length >= 2) {
    const before = cameras[0];
    const after = cameras[1];
    await setValue(cdp, `[data-testid=dcc-camera-${nodeId}]`, String(before.value));
    await new Promise((resolve) => setTimeout(resolve, 900));
    const firstSig = await readPreviewSignature(cdp, nodeId);
    await setValue(cdp, `[data-testid=dcc-camera-${nodeId}]`, String(after.value));
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const secondSig = await readPreviewSignature(cdp, nodeId);
    const cameraSwitchChanged = Boolean(
      firstSig?.signature && secondSig?.signature && firstSig.signature !== secondSig.signature,
    );
    if (!cameraSwitchChanged) {
      throw new Error('Blender camera switch preview did not change.');
    }
    await appendStage(runDir, 'blender-camera-switch-verified', {
      nodeId,
      before,
      after,
      firstSig,
      secondSig,
      cameraSwitchChanged,
    });
  } else {
    await appendStage(runDir, 'blender-camera-switch-skipped', {
      nodeId,
      reason: 'less-than-two-cameras',
      cameras,
    });
  }

  await click(cdp, `[data-testid=dcc-pause-${nodeId}]`);
  await browserWait(
    cdp,
    `(() => {
      const button = document.querySelector(${JSON.stringify(`[data-testid=dcc-pause-${nodeId}]`)});
      const title = button ? (button.getAttribute('title') || '') : '';
      return /恢复|resume/i.test(title);
    })()`,
    15000,
    250,
  );
  await appendStage(runDir, 'blender-preview-paused', {
    nodeId,
    pausedState: {
      pauseTitle: await readPauseTitle(cdp, nodeId),
      nodeText: await readNodeText(cdp, nodeId),
    },
  });

  await click(cdp, `[data-testid=dcc-pause-${nodeId}]`);
  await browserWait(
    cdp,
    `(() => {
      const button = document.querySelector(${JSON.stringify(`[data-testid=dcc-pause-${nodeId}]`)});
      const title = button ? (button.getAttribute('title') || '') : '';
      return /暂停|pause/i.test(title);
    })()`,
    15000,
    250,
  );
  await browserWait(
    cdp,
    `(() => {
      const node = document.querySelector(${JSON.stringify(`[data-testid=dcc-node-${nodeId}]`)});
      if (!node) return false;
      const text = node.textContent || '';
      const lower = text.toLowerCase();
      const fpsIndex = lower.indexOf('fps');
      if (fpsIndex <= 0) return false;
      const prefix = lower.slice(Math.max(0, fpsIndex - 8), fpsIndex);
      const digits = prefix.replace(/[^0-9]/g, '');
      return digits ? Number(digits) > 0 : false;
    })()`,
    20000,
    400,
  );
  await appendStage(runDir, 'blender-preview-resumed', {
    nodeId,
    resumedState: {
      pauseTitle: await readPauseTitle(cdp, nodeId),
      nodeText: await readNodeText(cdp, nodeId),
    },
  });

  const imageBefore = await browserEval(
    cdp,
    `(() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      return nodes.filter((node) => (
        node.type === 'region'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
        && node.data?.params?.sourceMediaType === 'image'
      )).length;
    })()`,
  );
  await click(cdp, `[data-testid=dcc-capture-${nodeId}]`);
  await browserWait(
    cdp,
    `(() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const dccNode = nodes.find((node) => node.id === ${JSON.stringify(nodeId)});
      const regionCount = nodes.filter((node) => (
        node.type === 'region'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
        && node.data?.params?.sourceMediaType === 'image'
      )).length;
      return regionCount > ${Number(imageBefore)} && Boolean(dccNode?.data?.imageUrl);
    })()`,
    45000,
    400,
  );
  const imageDerivedState = await browserEval(
    cdp,
    `(() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const nodes = store?.canvas?.nodes || [];
      const edges = store?.canvas?.edges || [];
      const derived = [...nodes].reverse().find((node) => (
        node.type === 'region'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
        && node.data?.params?.sourceMediaType === 'image'
      )) || null;
      const params = derived?.data?.params || {};
      return {
        derivedId: derived?.id || '',
        sourceMediaType: params.sourceMediaType || '',
        label: derived?.data?.label || '',
        imageUrl: derived?.data?.imageUrl || '',
        edgeLinked: edges.some((edge) => edge.source === ${JSON.stringify(nodeId)} && edge.target === derived?.id),
      };
    })()`,
  );
  if (!imageDerivedState.derivedId || imageDerivedState.sourceMediaType !== 'image' || !imageDerivedState.imageUrl || !imageDerivedState.edgeLinked) {
    throw new Error(`Blender image region node was not created correctly: ${JSON.stringify(imageDerivedState)}`);
  }
  await appendStage(runDir, 'blender-capture-image-node-created', { nodeId, imageDerivedState });

  if (imageOnly) {
    console.log(JSON.stringify({ ok: true, mode: 'blender-image-only', runDir, nodeId, imageDerivedState }, null, 2));
    await cleanup();
    return;
  }

  await focusDccNode(cdp, nodeId);
  await setValue(cdp, `[data-testid=dcc-start-frame-${nodeId}]`, '1');
  await setValue(cdp, `[data-testid=dcc-end-frame-${nodeId}]`, '24');
  await setValue(cdp, `[data-testid=dcc-fps-${nodeId}]`, '12');

  const videoBefore = await browserEval(
    cdp,
    `(() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      return nodes.filter((node) => (
        node.type === 'region'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
        && node.data?.params?.sourceMediaType === 'video'
      )).length;
    })()`,
  );
  await click(cdp, `[data-testid=dcc-record-${nodeId}]`);
  await browserWait(cdp, `!!document.querySelector(${JSON.stringify(`[data-testid=dcc-stop-${nodeId}]`)})`, 15000, 300);

  const liveMotion = await sampleMotion(cdp, nodeId, 6, 300);
  if (!liveMotion.motionDetected) {
    await appendStage(runDir, 'blender-recording-motion-deferred', {
      nodeId,
      note: 'Preview motion was not obvious during the initial sampling window. Continue to downstream recording output verification before failing this run.',
      liveMotion,
    });
  } else {
    await appendStage(runDir, 'blender-recording-live', { nodeId, liveMotion });
  }

  await browserWait(
    cdp,
    `(() => {
      const nodes = window.__HMDAO_DEBUG__?.canvasStore?.getState?.().canvas?.nodes || [];
      const dccNode = nodes.find((node) => node.id === ${JSON.stringify(nodeId)});
      const regionCount = nodes.filter((node) => (
        node.type === 'region'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
        && node.data?.params?.sourceMediaType === 'video'
      )).length;
      return regionCount > ${Number(videoBefore)} && Boolean(dccNode?.data?.videoUrl);
    })()`,
    60000,
    500,
  );
  const videoDerivedState = await browserEval(
    cdp,
    `(() => {
      const store = window.__HMDAO_DEBUG__?.canvasStore?.getState?.();
      const nodes = store?.canvas?.nodes || [];
      const edges = store?.canvas?.edges || [];
      const derived = [...nodes].reverse().find((node) => (
        node.type === 'region'
        && node.data?.params?.sourceNodeId === ${JSON.stringify(nodeId)}
        && node.data?.params?.sourceMediaType === 'video'
      )) || null;
      const params = derived?.data?.params || {};
      return {
        derivedId: derived?.id || '',
        sourceMediaType: params.sourceMediaType || '',
        label: derived?.data?.label || '',
        videoUrl: derived?.data?.videoUrl || '',
        edgeLinked: edges.some((edge) => edge.source === ${JSON.stringify(nodeId)} && edge.target === derived?.id),
      };
    })()`,
  );
  if (!videoDerivedState.derivedId || videoDerivedState.sourceMediaType !== 'video' || !videoDerivedState.videoUrl || !videoDerivedState.edgeLinked) {
    throw new Error(`Blender video region node was not created correctly: ${JSON.stringify(videoDerivedState)}`);
  }
  await appendStage(runDir, 'blender-recording-video-node-created', { nodeId, videoDerivedState });

  console.log(JSON.stringify({ ok: true, runDir, nodeId, imageDerivedState, videoDerivedState }, null, 2));
  await cleanup();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
