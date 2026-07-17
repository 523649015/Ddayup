import { readJsonStdin, runHmdaoPostRuntime } from './local_post_wrapper_runtime.mjs';

const request = await readJsonStdin();
const result = await runHmdaoPostRuntime({
  backendName: 'depth-anything',
  backendLabel: 'Depth Anything',
  runtimePath: process.env.HMDAO_POST_DEPTH_ANYTHING_PATH,
  request,
});
process.stdout.write(JSON.stringify(result));
