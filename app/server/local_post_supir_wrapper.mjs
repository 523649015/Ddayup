import { readJsonStdin, runHmdaoPostRuntime } from './local_post_wrapper_runtime.mjs';

const request = await readJsonStdin();
const result = await runHmdaoPostRuntime({
  backendName: 'supir',
  backendLabel: 'SUPIR',
  runtimePath: process.env.HMDAO_POST_SUPIR_PATH,
  request,
});
process.stdout.write(JSON.stringify(result));
