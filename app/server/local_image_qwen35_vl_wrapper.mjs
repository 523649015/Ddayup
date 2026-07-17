import { readJsonStdin, runHmdaoImageAnalysisRuntime } from './local_image_wrapper_runtime.mjs';

const request = await readJsonStdin();
const result = await runHmdaoImageAnalysisRuntime({
  backendName: 'qwen35-vl',
  backendLabel: 'Qwen Vision',
  runtimePath: process.env.HMDAO_QWEN35_VL_PATH || process.env.HMDAO_QWEN25_VL_PATH,
  request,
});
process.stdout.write(JSON.stringify(result));
