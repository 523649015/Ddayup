import { readJsonStdin, runHmdaoAudioRuntime } from './local_audio_wrapper_runtime.mjs';

const request = await readJsonStdin();
const result = await runHmdaoAudioRuntime({
  backendName: 'voxcpm',
  backendLabel: 'VoxCPM',
  runtimePath: process.env.HMDAO_VOXCPM_PATH || '',
  request,
});

process.stdout.write(JSON.stringify(result));
