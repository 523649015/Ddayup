import { readJsonStdin, runHmdaoImageAnalysisRuntime } from './local_image_wrapper_runtime.mjs';

const request = await readJsonStdin();
const result = await runHmdaoImageAnalysisRuntime({
  backendName: 'florence2',
  backendLabel: 'Florence-2',
  runtimePath: process.env.HMDAO_FLORENCE2_PATH,
  request,
});
process.stdout.write(JSON.stringify(result));
