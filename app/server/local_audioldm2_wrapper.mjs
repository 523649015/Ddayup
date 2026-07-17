import { readJsonStdin, runHmdaoAudioRuntime } from './local_audio_wrapper_runtime.mjs';

const request = await readJsonStdin();
const result = await runHmdaoAudioRuntime({
  backendName: 'audioldm2',
  backendLabel: 'AudioLDM 2',
  runtimePath: process.env.HMDAO_AUDIOLDM2_PATH || '',
  request,
});

process.stdout.write(JSON.stringify(result));
