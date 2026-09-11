// 端到端验证：最小核心工作流（SD1.5 + 内置 VAE，零插件）真实生成一张图。
// 正确轮询端点：/tasks/{prompt_id}（submit 返回的 promptId）。
import { writeFileSync } from 'node:fs';
const OUT = 'f:/Work/HMDAODAO/tmp_small_run.json';
const BASE = 'http://127.0.0.1:3000/api/comfyui';
const CKPT = 'v1-5-pruned-emaonly.ckpt';

const graph = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a cute cat, masterpiece', clip: ['1', 1] } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, lowres', clip: ['1', 1] } },
  '4': {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['5', 0],
      seed: (Date.now() % 1000000) + 1, steps: 8, cfg: 7.0, sampler_name: 'euler', scheduler: 'normal', denoise: 1.0,
    },
  },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 384, height: 384, batch_size: 1 } },
  '6': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['1', 2] } },
  '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'hmdao_small_' + Date.now() } },
};

const log = {};
async function postJSON(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function getJSON(url) {
  const r = await fetch(url);
  return { status: r.status, json: await r.json().catch(() => null) };
}

log.validate = (await postJSON(`${BASE}/validate`, { prompt: graph })).json;

const sub = await postJSON(`${BASE}/prompt`, { prompt: graph, client_id: 'hmdao_small_test' });
log.submit = { status: sub.status, promptId: sub.json?.promptId };
const promptId = sub.json?.promptId;

let task = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const res = await getJSON(`${BASE}/tasks/${promptId}`);
  const j = res.json;
  log.lastPoll = { status: res.status, statusField: j?.status, progress: j?.progress?.percent };
  if (j && (j.status === 'done' || j.status === 'error')) { task = j; break; }
}
log.task = task;

if (task && task.status === 'done' && Array.isArray(task.outputs) && task.outputs.length) {
  const out0 = task.outputs[0];
  log.firstImage = { type: out0.type, url: out0.url, node: out0.node, metadata: out0.metadata };
  const imgUrl = out0.url;
  try {
    const ir = await fetch(imgUrl);
    const buf = await ir.arrayBuffer();
    log.firstImageBytes = ir.ok ? buf.byteLength : 'fetch-failed:' + ir.status;
    if (ir.ok) {
      writeFileSync('f:/Work/HMDAODAO/tmp_generated_cat.png', Buffer.from(buf));
      log.savedPng = 'f:/Work/HMDAODAO/tmp_generated_cat.png';
    }
  } catch (e) {
    log.firstImageBytes = 'err:' + String(e.message || e);
  }
}

writeFileSync(OUT, JSON.stringify(log, null, 2));
console.log('written', OUT);
