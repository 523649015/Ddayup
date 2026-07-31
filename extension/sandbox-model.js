// ===== Ddayup 3D 沙箱渲染模块 =====
// 运行于 chrome-extension://<id>/sandbox-model.html（沙箱页）：
//   - 不受 extension_pages CSP（script-src 'self' 禁 WASM）限制，可编译并运行 WebAssembly；
//   - 禁用 chrome.* API，仅用 postMessage 与父页面(侧栏)通信；
//   - DRACO 用纯 JS 解码器(draco_decoder.js) → 无需 WASM/Worker；
//   - meshopt 用 WASM 解码器，沙箱 'unsafe-eval' 放行 → 可解码 tripo3d 等 meshopt 压缩 glb；
//   - 不挂 KTX2：避免 Basis 转码器(WASM+Worker)在沙箱内的不确定性；PBR 内嵌 PNG/JPEG 贴图不受影响。
import * as THREE from './vendor/three/build/three.module.min.js';
import { OrbitControls } from './vendor/three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from './vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from './vendor/three/examples/jsm/loaders/DRACOLoader.js';

const EXT_BASE = new URL('.', import.meta.url).href;

let meshoptPromise = null;
function getMeshoptDecoder() {
  if (!meshoptPromise) {
    meshoptPromise = import('./vendor/three/examples/jsm/libs/meshopt_decoder.module.js')
      .then((m) => m.MeshoptDecoder)
      .catch((err) => { console.warn('[sandbox] meshopt 解码器加载失败：', err); return null; });
  }
  return meshoptPromise;
}

let gltfLoaderPromise = null;
async function getGltfLoader() {
  if (!gltfLoaderPromise) {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    // ★纯 JS 解码器：无需 WASM、无需 Worker，沙箱内 100% 可用
    draco.setDecoderConfig({ type: 'js' });
    draco.setDecoderPath(EXT_BASE + 'vendor/three/examples/jsm/libs/draco/');
    loader.setDRACOLoader(draco);
    // meshopt(WASM) 在沙箱 'unsafe-eval' 下可用
    const md = await getMeshoptDecoder();
    if (md) loader.setMeshoptDecoder(md);
    gltfLoaderPromise = Promise.resolve(loader);
  }
  return gltfLoaderPromise;
}

// ---------- 渲染器 / 场景（单例，每次渲染重建场景对象） ----------
let renderer = null;
function ensureRenderer() {
  if (renderer) return renderer;
  const canvas = document.getElementById('cv');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  window.addEventListener('resize', onResize);
  return renderer;
}
function onResize() {
  if (!renderer || !camera) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

let scene = null, camera = null, controls = null, raf = 0;

// 缩略图专用离屏渲染器（与全屏 #cv 渲染器隔离，互不抢占 canvas/RAF）
let thumbRenderer = null;
function ensureThumbRenderer(size) {
  if (!thumbRenderer) {
    const canvas = document.createElement('canvas');
    thumbRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    thumbRenderer.setPixelRatio(1);
  }
  thumbRenderer.setSize(size, size, false);
  return thumbRenderer;
}

// 缩略图场景搭建（与 render() 内联逻辑同构，归一化居中+单位缩放）
function buildThumbScene(object) {
  fixMaterials(object);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14171d);
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(3, 5, 4); scene.add(key);
  const rim = new THREE.DirectionalLight(0x99bbff, 0.9); rim.position.set(-4, 2, -3); scene.add(rim);
  scene.add(object);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  object.position.sub(center);
  const scale = 2 / maxDim;
  object.scale.setScalar(scale);
  object.position.multiplyScalar(scale);
  return scene;
}

function disposeScene() {
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  if (controls) { try { controls.dispose(); } catch (_) {} controls = null; }
  if (scene) {
    scene.traverse((o) => {
      if (o.isMesh) {
        o.geometry && o.geometry.dispose && o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m && m.dispose && m.dispose());
      }
    });
    scene = null;
  }
}

function defaultMaterial(vertexColors = false) {
  return new THREE.MeshStandardMaterial({ color: 0x8899bb, metalness: 0.1, roughness: 0.7, vertexColors, side: THREE.DoubleSide });
}
function fixMaterials(root) {
  root.traverse((o) => {
    if (o.isMesh) {
      if (!o.material) o.material = defaultMaterial();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => { if (m) m.side = THREE.DoubleSide; });
    }
  });
}

function countVertices(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) n += o.geometry.attributes.position.count; });
  return n;
}

async function render(data, ext, token) {
  disposeScene();
  const hint = document.getElementById('hint');
  try {
    if (ext !== 'glb' && ext !== 'gltf') throw new Error('沙箱仅处理 glb/gltf');
    const buf = data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
    const loader = await getGltfLoader();
    const gltf = await new Promise((res, rej) => {
      loader.parse(ext === 'gltf' ? new TextDecoder().decode(buf) : buf, '', res, rej);
    });
    const object = gltf.scene || gltf.scenes[0];
    fixMaterials(object);

    const w = window.innerWidth, h = window.innerHeight;
    ensureRenderer();
    renderer.setSize(w, h, false);
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14171d);
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(3, 5, 4); scene.add(key);
    const rim = new THREE.DirectionalLight(0x99bbff, 0.9); rim.position.set(-4, 2, -3); scene.add(rim);
    scene.add(object);

    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    object.position.sub(center);
    const scale = 2 / maxDim;
    object.scale.setScalar(scale);
    object.position.multiplyScalar(scale);

    camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100);
    camera.position.set(1.8, 1.3, 2.4);
    camera.lookAt(0, 0, 0);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.5;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();
    if (hint) hint.style.display = 'none';
    const vertices = countVertices(object);
    parent.postMessage({ __hmdao: 'rendered', token, vertices, size: data.byteLength }, '*');
  } catch (e) {
    if (hint) { hint.style.display = ''; hint.textContent = '沙箱渲染失败：' + (e && e.message ? e.message : e); }
    parent.postMessage({ __hmdao: 'error', token, message: errStr(e) }, '*');
  }
}

// 缩略图渲染（卡片列表用，独立于全屏预览）：复用共享 GLTFLoader 解析，
// 但用独立离屏 renderer 渲染单帧 → dataURL 回传，不抢占全屏 #cv 画面/RAF。
async function renderThumb(data, ext, size, token) {
  try {
    if (ext !== 'glb' && ext !== 'gltf') throw new Error('缩略图仅支持 glb/gltf');
    const buf = data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
    const loader = await getGltfLoader();
    const gltf = await new Promise((res, rej) => {
      loader.parse(ext === 'gltf' ? new TextDecoder().decode(buf) : buf, '', res, rej);
    });
    const object = gltf.scene || gltf.scenes[0];
    const scene = buildThumbScene(object);
    const renderer = ensureThumbRenderer(size || 128);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    camera.position.set(1.8, 1.3, 2.4);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    // 释放场景 GPU 资源（renderer 复用）
    scene.traverse((o) => {
      if (o.isMesh) {
        o.geometry && o.geometry.dispose && o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m && m.dispose && m.dispose());
      }
    });
    parent.postMessage({ __hmdao: 'thumb-ready', token, url }, '*');
  } catch (e) {
    parent.postMessage({ __hmdao: 'thumb-fail', token, message: errStr(e) }, '*');
  }
}

function errStr(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

// ---------- 与父页面(侧栏)通信 ----------
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || !d.__hmdao) return;
  if (d.__hmdao === 'render') { render(d.data, d.ext, d.token); return; }
  if (d.__hmdao === 'thumb') { renderThumb(d.data, d.ext, d.size, d.token); return; }
  if (d.__hmdao === 'stop') { disposeScene(); const hint = document.getElementById('hint'); if (hint) { hint.style.display = ''; hint.textContent = '模型加载中…'; } }
});

parent.postMessage({ __hmdao: 'sandbox-ready' }, '*');
