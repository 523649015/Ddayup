import { readJsonStdin, runHmdaoPostRuntime } from './local_post_wrapper_runtime.mjs';

const request = await readJsonStdin();
const result = await runHmdaoPostRuntime({
  backendName: 'realbasicvsr',
  backendLabel: 'RealBasicVSR',
  runtimePath: process.env.HMDAO_POST_REALBASICVSR_PATH,
  request,
});
process.stdout.write(JSON.stringify(result));
