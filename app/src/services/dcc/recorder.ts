export interface DccRecordingResult {
  url: string;
  blob: Blob;
  mimeType: string;
  durationMs: number;
  sizeBytes: number;
}

function canPlayMimeType(mimeType: string): boolean {
  if (typeof document === 'undefined') return true;
  const video = document.createElement('video');
  const result = video.canPlayType(mimeType);
  return result === 'probably' || result === 'maybe';
}

function pickRecordingMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType) && canPlayMimeType(mimeType)) {
      return mimeType;
    }
  }
  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  return 'video/webm';
}

export class DccRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;

  get isRecording(): boolean {
    return this.recorder?.state === 'recording';
  }

  start(stream: MediaStream): void {
    if (this.isRecording) return;
    const mimeType = pickRecordingMimeType();
    this.stream = stream;
    this.chunks = [];
    this.startedAt = performance.now();
    this.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start(250);
  }

  stop(): Promise<DccRecordingResult> {
    if (!this.recorder || this.recorder.state === 'inactive') {
      return Promise.reject(new Error('DCC recorder is not running.'));
    }
    const recorder = this.recorder;
    return new Promise((resolve, reject) => {
      recorder.onerror = () => reject(new Error('DCC recording failed.'));
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || 'video/webm' });
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
        this.recorder = null;
        if (blob.size <= 0) {
          reject(new Error('DCC recording produced an empty video blob.'));
          return;
        }
        resolve({
          url: URL.createObjectURL(blob),
          blob,
          mimeType: blob.type,
          durationMs: Math.max(0, performance.now() - this.startedAt),
          sizeBytes: blob.size,
        });
      };
      recorder.stop();
    });
  }

  dispose(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}
