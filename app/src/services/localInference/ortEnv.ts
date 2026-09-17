/**
 * onnxruntime-web 运行时封装（浏览器端本地推理）
 *
 * - wasm 文件同源托管在 /ort-wasm-v1/（已由构建脚本从 node_modules 复制，旧 /ort-wasm/ 已弃用），
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
  // 同源 wasm（public/ort-wasm-v1）。版本号 v1 用于绕过浏览器对旧 /ort-wasm/ 路径的
  // immutable 毒缓存（曾缓存到错误 MIME 的 404/index.html），新路径强制重新拉取。
  ort.env.wasm.wasmPaths = '/ort-wasm-v1/';
  const isolated =
    typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  // 关键修复：ORT-web 在 COOP✓(shared) 模式下使用的是「预分配固定内存」，运行时并不会
  // 动态 grow —— 若 initial 太小，大模型推理一旦超过该 committed 上限就直接抛
  // std::bad_alloc(ERROR_CODE 6)，即使机器仍有空闲内存也无济于事。
  // BiRefNet(fp16 ~490MB) 在 WebGL 主后端下大部分权重/激活驻留显存，但仍有少量算子回退到
  // CPU/WASM 执行，需要足够大的 wasm 堆兜底。故在 shared 模式下一次性预分配 4GB（32 位
  // WASM 寻址上限 65536×64KB），并按 4GB→2GB→1GB 逐级降级，避免预留过大导致 ORT 初始化直接抛错。
  // 注意：onnxruntime-web 为单例，本全局 wasmMemory 同时作用于 BiRefNet 与 @imgly 的内部会话；
  // 只要 BiRefNet 能在 4GB 内跑通就不会走到 @imgly，自然规避资源争用。
  // onnxruntime-web 的 .d.ts 未声明 wasmMemory（运行时有效，用于预分配 WASM 堆兜底）
  (ort.env.wasm as { wasmMemory?: WebAssembly.Memory }).wasmMemory = createWasmMemory(isolated);

function createWasmMemory(isolated: boolean): WebAssembly.Memory {
  // 候选 initial（单位：64KB 页）。4GB 为 32 位 WASM 寻址上限，优先一次性给够；
  // 若本机空闲内存不足导致创建失败，逐级降到 2GB / 1GB / 默认 256MB，保证 ORT 至少能初始化。
  const candidates = isolated
    ? [65536, 32768, 16384, 4096]
    : [65536, 32768, 16384, 4096];
  let lastErr: unknown;
  for (const initial of candidates) {
    try {
      return new WebAssembly.Memory({ initial, maximum: 65536, shared: isolated });
    } catch (e) {
      lastErr = e;
      console.warn(`[ortEnv] 预分配 ${initial * 64}KB 共享内存失败，尝试更小档：`, (e as Error)?.message);
    }
  }
  console.error('[ortEnv] 所有共享内存档位均失败，退回默认 256MB（大模型将 bad_alloc）：', lastErr);
  return new WebAssembly.Memory({ initial: 4096, maximum: 65536, shared: isolated });
}
  // COOP✓（crossOriginIsolated=true）时启用多线程 WASM，显著加速 CPU 回退推理；
  // 否则退回单线程以保证在普通静态托管下也能运行。
  ort.env.wasm.numThreads = isolated
    ? Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8))
    : 1;
  ort.env.wasm.simd = true;
  // 关闭 ORT 可能尝试的模型代理拉取（proxy 字段在多数版本存在，少数版本无；用 try 包住避免运行时报错）
  try {
    (ort.env.wasm as { proxy?: boolean }).proxy = false;
  } catch {
    /* noop */
  }
}

export type OrtSession = Awaited<ReturnType<OrtModule['InferenceSession']['create']>>;
export type OrtTensor = InstanceType<OrtModule['Tensor']>;

/**
 * 外部权重条目：对应拆分式 ONNX 模型（如 Depth Anything V3 的 model.onnx_data）的
 * 外部数据文件。onnxruntime-web 1.27 的 InferenceSession.create 的 externalData 选项
 * 期望一个「对象数组」[{ path, data }]，而不是 Map（Map 迭代产出 [key,value] 数组，
 * 取到 .path 为 undefined → mountExternalData 报 "startsWith" 错误）。
 */
export interface ExternalDataEntry {
  /** 外部数据文件名，需与 onnx 内 external_data 引用的 name 完全一致（如 'model.onnx_data'） */
  path: string;
  /** 权重二进制 */
  data: Uint8Array | ArrayBuffer;
}

/**
 * 从缓存的 onnx ArrayBuffer 创建推理会话。
 * @param externalData 外部权重（如 Depth Anything V3 的 model.onnx_data）。
 *                     支持两种传入形式：
 *                       - ExternalDataEntry[]：直接透传给 ORT（`[{ path, data }]`）
 *                       - Map<string, Uint8Array>：兼容旧调用方，内部归一化为数组
 *                     注意：onnxruntime-web 的字段名是 externalData（不是 fileCache），
 *                     传错字段名会让 ORT 退回不可用的 MountedFiles 机制而报错。
 */
/**
 * 执行后端候选列表（按优先级）。
 *
 * 关键结论（2026-07-18 真机验证）：
 *   - WebGPU EP 在 onnxruntime-web 中对 BiRefNet / Depth V3 这类「大 Concat/Split + 深嵌套」
 *     的模型会生成超出 WebGPU 单阶段 storage buffer 上限的着色器 → 禁用 webgpu。
 *   - 改走更成熟的 **WebGL EP**：WebGL 不依赖 SharedArrayBuffer / 跨域隔离（COOP/COEP），
 *     也不受那些 WebGPU 资源上限约束；权重与激活驻留显存，同样绕开 wasm 4GB 线性堆 OOM。
 *   - **关键**：纯 WASM 回退对 >500MB 模型必 OOM（单一 4GB 堆无法同时容纳 970MB 权重 + 激活）。
 *     因此在 skipWasmOnly 模式下只保留 [webgl, wasm]，不做纯 wasm 兜底。
 *   - WebGL 不支持的算子由 ORT 在节点级自动回退到 wasm（仍可运行，仅局部变慢）。
 */
export function buildEpCandidates(skipWasmOnly = false): string[][] {
  const candidates: string[][] = [['webgl', 'wasm']];
  if (!skipWasmOnly) {
    candidates.push(['wasm']);
  }
  return candidates;
}

/**
 * 图优化级别候选（按优先级）。
 * 'all' 在绝大多数模型上最优；个别导出模型（如某些 Depth V3 变体）在 'all' 下因
 * 常量折叠/布局优化触发不兼容时，回退到 'basic' 仍可成功创建会话（仅推理略慢）。
 */
const OPT_LEVEL_CANDIDATES: Array<'all' | 'basic'> = ['all', 'basic'];

export async function createOrtSession(
  buffer: ArrayBuffer,
  externalData?: ExternalDataEntry[] | Map<string, Uint8Array>,
  opts?: { skipWasmOnly?: boolean; executionProviders?: string[] },
): Promise<OrtSession> {
  const skipWasmOnly = opts?.skipWasmOnly ?? false;
  const epOverride = opts?.executionProviders;
  const ort = await getOrt();
  configureOrt(ort);
  const externalArr: ExternalDataEntry[] | undefined =
    externalData && (Array.isArray(externalData) ? externalData.length : externalData.size)
      ? (Array.isArray(externalData)
          ? externalData
          : [...externalData.entries()].map(([path, data]) => ({ path, data })))
      : undefined;

  const epLists =
    epOverride && epOverride.length
      ? [epOverride]
      : buildEpCandidates(skipWasmOnly);

  let lastErr: unknown;
  for (const graphOptimizationLevel of OPT_LEVEL_CANDIDATES) {
    const baseOpts: Record<string, unknown> = { graphOptimizationLevel };
    if (externalArr) baseOpts.externalData = externalArr;
    for (const executionProviders of epLists) {
      try {
        const opts = { ...baseOpts, executionProviders };
        const session = await ort.InferenceSession.create(
          buffer,
          opts as Parameters<typeof ort.InferenceSession.create>[1],
        );
        if (executionProviders.length > 1 || executionProviders[0] !== 'wasm') {
          console.info(`[ortEnv] ORT 会话已用执行后端：${executionProviders.join('+')}（opt=${graphOptimizationLevel}）`);
        }
        return session;
      } catch (err) {
        lastErr = err;
        console.warn(
          `[ortEnv] 执行后端 ${executionProviders.join('+')}（opt=${graphOptimizationLevel}）创建会话失败，尝试下一个：`,
          (err as Error)?.message,
        );
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('ort-session-create-failed');
}

/** 诊断：当前 WASM 线性堆已提交字节数（-1 表示尚未初始化）。用于判断 bad_alloc 是「堆上限」还是「真实内存不足」。 */
export async function getWasmHeapBytes(): Promise<number> {
  try {
    const ort = await getOrt();
    const mem = (ort.env.wasm as { wasmMemory?: WebAssembly.Memory }).wasmMemory;
    return mem?.buffer?.byteLength ?? -1;
  } catch {
    return -1;
  }
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
