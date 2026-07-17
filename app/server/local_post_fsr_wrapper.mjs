import { readJsonStdin, runHmdaoPostRuntime } from './local_post_wrapper_runtime.mjs';

const request = await readJsonStdin();
const result = await runHmdaoPostRuntime({
  backendName: 'fsr',
  backendLabel: 'FSR',
  runtimePath: process.env.HMDAO_POST_FSR_PATH,
  request,
});
process.stdout.write(JSON.stringify(result));
