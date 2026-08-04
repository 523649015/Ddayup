const t = Date.now();
const url = 'http://127.0.0.1:8792/api/hf-proxy/onnx-community/depth-anything-v3-base/resolve/main/onnx/model.onnx_data';
const r = await fetch(url);
const rd = r.body.getReader();
let n = 0, last = Date.now();
const iv = setInterval(() => {}, 100000);
function pump() {
  return rd.read().then(({ done, value }) => {
    if (done) { clearInterval(iv); console.log('TOTAL', (n / 1048576).toFixed(1) + 'MB', ((Date.now() - t) / 1000).toFixed(1) + 's'); return; }
    n += value.byteLength;
    const now = Date.now();
    if (now - last > 3000) { last = now; console.log('SOFAR', (n / 1048576).toFixed(1) + 'MB', ((n / 1048576) / ((now - t) / 1000)).toFixed(2) + 'MB/s'); }
    return pump();
  });
}
pump().catch((e) => console.log('ERR', e.message));
