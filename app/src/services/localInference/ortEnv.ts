/**
 * onnxruntime-web 运行时封装（浏览器端本地推理）
 *
 * - wasm 文件同源托管在 /ort-wasm/（已由构建脚本从 node_modules 复制），
 *   不依赖外部 CDN，也不受生产环境 COEP 限制。
 * - 使用单线程 WASM（numThreads=1），避免 SharedArrayBuffer / COOP-COEP 依赖，
 *   在普通静态托管下即可运行（代价是推理稍慢，对本地预览可接受）。
 *
 * 通过动态 import 加载 onnxruntime-web，避免它被打进首屏主包。
 */

type OrtModule = typeof import('onnxruntime-web');

let ortModule: OrtModule | null = null;
let configured = false;

async function getOrt(): Promise<OrtModule> {
  if (!ortModule) {
    ortModule = await import('onnxruntime-web');
  }
  return ortModule;
}

function configureOrt(ort: OrtModule): void {
  if (configured) return;
  configured = true;
  // 同源 wasm（public/ort-wasm）
  ort.env.wasm.wasmPaths = '/ort-wasm/';
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  // 关闭 ORT 可能尝试的模型代理拉取
  try {
    // @ts-expect-error 部分版本存在该字段
    ort.env.wasm.proxy = false;
  } catch {
    /* noop */
  }
}

export type OrtSession = InstanceType<OrtModule['InferenceSession']>;
export type OrtTensor = InstanceType<OrtModule['Tensor']>;

/** 从缓存的 onnx ArrayBuffer 创建推理会话 */
export async function createOrtSession(buffer: ArrayBuffer): Promise<OrtSession> {
  const ort = await getOrt();
  configureOrt(ort);
  return ort.InferenceSession.create(buffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
}

/** 创建 ORT 输入张量 */
export async function createTensor(
  type: 'float32',
  data: Float32Array,
  dims: number[],
): Promise<OrtTensor> {
  const ort = await getOrt();
  return new ort.Tensor(type, data, dims);
}
