// ===== Ddayup 3D 模型预览模块（ES module，本地 vendoring Three.js，符合 MV3 CSP script-src 'self'）=====
// 暴露 window.__hmdaoModel3D 给经典脚本 sidepanel.js 调用：
//   canRender(ext)            → 该扩展名是否可浏览器渲染
//   preview(container, bytes, ext, opts) → 在容器内渲染可交互 3D 视图（OrbitControls 旋转/缩放）
//   thumbnail(bytes, ext, size) → 离屏渲染一张缩略图 dataURL
//   listZipEntries(bytes)     → 列出 zip 内文件名（fflate，复用 FBXLoader 依赖）
//   disposeViewer()           → 关闭预览时释放 WebGL 资源
//
// 可渲染格式：glb/gltf(GLTFLoader)、obj、stl、ply、fbx(fflate)、dae(ColladaLoader)、3ds(TDSLoader)
// 不可渲染（专有闭源格式，无浏览器解析器）：c4d/blend/max/ma/mb/skp/lwo/abc/smd 等 → 由调用方显示信息卡

import * as THREE from './vendor/three/build/three.module.min.js';
import { OrbitControls } from './vendor/three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from './vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from './vendor/three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from './vendor/three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from './vendor/three/examples/jsm/loaders/PLYLoader.js';
import { FBXLoader } from './vendor/three/examples/jsm/loaders/FBXLoader.js';
import { ColladaLoader } from './vendor/three/examples/jsm/loaders/ColladaLoader.js';
import { TDSLoader } from './vendor/three/examples/jsm/loaders/TDSLoader.js';
import { DRACOLoader } from './vendor/three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from './vendor/three/examples/jsm/loaders/KTX2Loader.js';
import { unzipSync } from './vendor/three/examples/jsm/libs/fflate.module.js';

// 扩展根目录（model-preview.js 位于扩展根，decoder 二进制放在 vendor/three/... 下）
const THREE_BASE = new URL('.', import.meta.url).href;

// ★根因修复（关键）：Chrome/Edge 扩展页（侧栏/弹窗）的 CSP 被【强制锁死】为 script-src 'self'，
// 不允许 wasm-eval / unsafe-eval —— 扩展【永远无法】在扩展页内编译 WebAssembly。
// 即便用惰性动态 import()，动态模块求值阶段就 WebAssembly.instantiate → 仍被 CSP 拒绝，
// 浏览器会持续报 "Refused to compile or instantiate WebAssembly module"。
// 因此扩展页（本文件，运行于 sidepanel）【绝不】尝试加载 meshopt 的 WASM 解码器，
// 否则每次渲染/缩略图都会触发 CSP 报错。meshopt 解码只在【沙箱页 sandbox-model.js】里做
// （沙箱 CSP 放开 unsafe-eval/wasm-eval，manifest 已声明 sandbox.pages），glb/gltf 的正式预览也全走沙箱。
// 扩展页仅渲染无需 WASM 的格式（obj/stl/ply/fbx/dae/3ds），这些不需要 meshopt，能力无损。
function getMeshoptDecoder() {
  // 扩展页内不可用 WASM，直接返回 null，避免触犯 CSP。
  // 若需解码 meshopt 压缩的 glb，请走 sandbox-model 通道（previewModelViaSandbox）。
  return Promise.resolve(null);
}

// 真实 glb 普遍 DRACO 压缩、部分 KTX2 纹理、meshopt → 必须挂解码器，否则解析直接抛异常
async function makeGltfLoader(renderer) {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(THREE_BASE + 'vendor/three/examples/jsm/libs/draco/');
  loader.setDRACOLoader(draco);
  const ktx2 = new KTX2Loader();
  ktx2.setTranscoderPath(THREE_BASE + 'vendor/three/examples/jsm/libs/basis/');
  if (renderer) ktx2.detectSupport(renderer); // 必须在 parse 前对 renderer 检测支持
  loader.setKTX2Loader(ktx2);
  const md = await getMeshoptDecoder();
  if (md) loader.setMeshoptDecoder(md);
  return loader;
}

const RENDERABLE = new Set(['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx', 'dae', '3ds']);

// ---------- 解析：bytes + ext → THREE.Object3D ----------
async function parseToObject(bytes, ext, gltfLoader) {
  const buf = bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  ext = String(ext || '').toLowerCase();
  if (ext === 'glb' || ext === 'gltf') {
    const loader = gltfLoader || new GLTFLoader();
    const gltf = await new Promise((res, rej) => loader.parse(ext === 'gltf' ? new TextDecoder().decode(buf) : buf, '', res, rej));
    return gltf.scene || gltf.scenes[0];
  }
  if (ext === 'obj') {
    return new OBJLoader().parse(new TextDecoder().decode(buf));
  }
  if (ext === 'stl') {
    const geo = new STLLoader().parse(buf);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, defaultMaterial());
  }
  if (ext === 'ply') {
    const geo = new PLYLoader().parse(buf);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const hasColor = !!geo.attributes.color;
    return new THREE.Mesh(geo, defaultMaterial(hasColor));
  }
  if (ext === 'fbx') {
    return new FBXLoader().parse(buf, '');
  }
  if (ext === 'dae') {
    const collada = new ColladaLoader().parse(new TextDecoder().decode(buf), '');
    return collada.scene;
  }
  if (ext === '3ds') {
    return new TDSLoader().parse(buf, '');
  }
  throw new Error('浏览器无法渲染 .' + ext + ' 格式');
}

function defaultMaterial(vertexColors = false) {
  return new THREE.MeshStandardMaterial({ color: 0x8899bb, metalness: 0.1, roughness: 0.7, vertexColors, side: THREE.DoubleSide });
}

// 无材质/加载失败纹理的 mesh 兜底成可见材质，避免全黑
function fixMaterials(root) {
  root.traverse((o) => {
    if (o.isMesh) {
      if (!o.material) o.material = defaultMaterial();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => { if (m) m.side = THREE.DoubleSide; });
    }
  });
}

// ---------- 场景搭建（复用） ----------
function buildScene(object) {
  fixMaterials(object);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14171d);
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(3, 5, 4); scene.add(key);
  const rim = new THREE.DirectionalLight(0x99bbff, 0.9); rim.position.set(-4, 2, -3); scene.add(rim);
  scene.add(object);

  // 归一化：把模型居中并缩放到单位尺度，任何单位建模都能看清
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

function makeCamera(aspect) {
  const cam = new THREE.PerspectiveCamera(45, aspect, 0.01, 100);
  cam.position.set(1.8, 1.3, 2.4);
  cam.lookAt(0, 0, 0);
  return cam;
}

// ---------- 交互预览 ----------
let viewer = null; // { renderer, controls, raf, container }

function disposeViewer() {
  if (!viewer) return;
  try {
    cancelAnimationFrame(viewer.raf);
    viewer.controls.dispose();
    viewer.renderer.dispose();
    viewer.renderer.forceContextLoss && viewer.renderer.forceContextLoss();
    viewer.renderer.domElement.remove();
    // 释放 GLTF 解码头（DRACO/KTX2 各起 Web Worker，不释放会泄漏）
    if (viewer.loader) {
      try { viewer.loader.dracoLoader && viewer.loader.dracoLoader.dispose(); } catch (_) {}
      try { viewer.loader.ktx2Loader && viewer.loader.ktx2Loader.dispose(); } catch (_) {}
      try { viewer.loader.dispose && viewer.loader.dispose(); } catch (_) {}
    }
  } catch (_) {}
  viewer = null;
}

async function preview(container, bytes, ext) {
  disposeViewer();
  const w = container.clientWidth || 320;
  const h = container.clientHeight || 260;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
  container.appendChild(renderer.domElement);
  // ★renderer 必须先于 parse 创建：KTX2 解码器需 detectSupport(renderer)
  const loader = await makeGltfLoader(renderer);
  const object = await parseToObject(bytes, ext, loader);
  const scene = buildScene(object);
  const camera = makeCamera(w / h);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.5;

  let raf = 0;
  const tick = () => {
    raf = viewer ? (viewer.raf = requestAnimationFrame(tick)) : 0;
    controls.update();
    renderer.render(scene, camera);
  };
  viewer = { renderer, controls, raf, container, loader };
  tick();
  return { vertices: countVertices(object) };
}

function countVertices(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) n += o.geometry.attributes.position.count; });
  return n;
}

// ---------- 离屏缩略图 ----------
let thumbRenderer = null;
function getThumbRenderer(size) {
  if (!thumbRenderer) {
    const canvas = document.createElement('canvas');
    thumbRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    thumbRenderer.setPixelRatio(1);
  }
  thumbRenderer.setSize(size, size);
  return thumbRenderer;
}

async function thumbnail(bytes, ext, size = 128) {
  ext = String(ext || '').toLowerCase();
  // ★DRACO/meshopt 压缩的 glb/gltf 需 WASM 解码，扩展页 CSP 禁 WASM → 走沙箱才安全。
  // 扩展页缩略图对 glb/gltf 直接降级（返回 null），避免触发 CSP 报错；
  // 正式预览走 sandbox-model 通道（已含 DRACO/meshopt WASM 解码）。
  if (ext === 'glb' || ext === 'gltf') return null;
  const renderer = getThumbRenderer(size);
  const loader = await makeGltfLoader(renderer); // KTX2 需 detectSupport(renderer)
  const object = await parseToObject(bytes, ext, loader);
  const scene = buildScene(object);
  const camera = makeCamera(1);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  try { loader.dracoLoader && loader.dracoLoader.dispose(); } catch (_) {}
  try { loader.ktx2Loader && loader.ktx2Loader.dispose(); } catch (_) {}
  try { loader.dispose && loader.dispose(); } catch (_) {}
  // 释放本次场景 GPU 资源（renderer 复用）
  scene.traverse((o) => {
    if (o.isMesh) {
      o.geometry && o.geometry.dispose && o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => m && m.dispose && m.dispose());
    }
  });
  return url;
}

// ---------- zip 归档内容列出（复用 fflate） ----------
function listZipEntries(bytes) {
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return Object.keys(unzipSync(u8));
  } catch (e) {
    return null; // 非 zip（rar/7z 不支持）或损坏
  }
}

window.__hmdaoModel3D = {
  canRender: (ext) => RENDERABLE.has(String(ext || '').toLowerCase()),
  RENDERABLE: [...RENDERABLE],
  preview,
  thumbnail,
  listZipEntries,
  disposeViewer,
};
window.dispatchEvent(new CustomEvent('hmdao:model3d-ready'));
