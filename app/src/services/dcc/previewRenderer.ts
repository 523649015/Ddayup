import type { DccFrame } from './types';

export class DccPreviewRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private frameCanvas: HTMLCanvasElement;
  private frameCtx: CanvasRenderingContext2D;
  private frame: DccFrame | null = null;
  private decodedFrame: DccFrame | null = null;
  private raf = 0;
  private running = false;
  private loadingUrl = '';
  private decodeToken = 0;
  private activeBitmap: ImageBitmap | null = null;
  private decoding = false;
  private queuedFrame: DccFrame | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('DCC preview canvas is unavailable.');
    this.ctx = ctx;
    this.frameCanvas = document.createElement('canvas');
    const frameCtx = this.frameCanvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!frameCtx) throw new Error('DCC preview buffer canvas is unavailable.');
    this.frameCtx = frameCtx;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.raf = requestAnimationFrame(this.draw);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  pause(): void {
    this.stop();
  }

  resume(): void {
    this.start();
  }

  clear(): void {
    this.decodedFrame = null;
    this.queuedFrame = null;
    this.loadingUrl = '';
    this.decodeToken += 1;
    this.decoding = false;
    this.releaseBitmap();
    this.ctx.fillStyle = '#111';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  setFrame(frame: DccFrame): void {
    this.frame = frame;
    if (!frame.url) return;
    if (this.decodedFrame?.url === frame.url) return;
    if (this.loadingUrl === frame.url || this.queuedFrame?.url === frame.url) return;
    if (this.decoding) {
      this.queuedFrame = frame;
      return;
    }
    this.loadingUrl = frame.url;
    this.decoding = true;
    const token = this.decodeToken;
    void this.decodeFrame(frame, token);
  }

  captureStream(fps = 30): MediaStream {
    return this.canvas.captureStream(fps);
  }

  async snapshot(type = 'image/webp', quality = 0.95): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('DCC preview snapshot failed.'));
      }, type, quality);
    });
  }

  private async decodeFrame(frame: DccFrame, token: number): Promise<void> {
    try {
      const blob = frame.url.startsWith('data:')
        ? this.dataUrlToBlob(frame.url)
        : await this.fetchFrameBlob(frame.url);
      const bitmap = await createImageBitmap(blob);
      if (token !== this.decodeToken) {
        bitmap.close();
        return;
      }
      this.releaseBitmap();
      this.activeBitmap = bitmap;
      this.frameCanvas.width = bitmap.width;
      this.frameCanvas.height = bitmap.height;
      this.frameCtx.clearRect(0, 0, this.frameCanvas.width, this.frameCanvas.height);
      this.frameCtx.drawImage(bitmap, 0, 0);
      this.decodedFrame = frame;
    } catch {
      if (token === this.decodeToken) {
        this.decodedFrame = null;
      }
    } finally {
      if (token === this.decodeToken) {
        if (this.loadingUrl === frame.url) {
          this.loadingUrl = '';
        }
        this.decoding = false;
        const nextFrame = this.queuedFrame;
        this.queuedFrame = null;
        if (nextFrame?.url && nextFrame.url !== this.decodedFrame?.url) {
          this.loadingUrl = nextFrame.url;
          this.decoding = true;
          void this.decodeFrame(nextFrame, token);
        }
      }
    }
  }

  private async fetchFrameBlob(url: string): Promise<Blob> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Failed to fetch DCC preview frame.');
    }
    return response.blob();
  }

  private dataUrlToBlob(url: string): Blob {
    const match = url.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/);
    if (!match) {
      throw new Error('Invalid DCC preview data url.');
    }
    const mimeType = match[1] || 'application/octet-stream';
    const isBase64 = Boolean(match[2]);
    const payload = match[3] || '';
    if (isBase64) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new Blob([bytes], { type: mimeType });
    }
    return new Blob([decodeURIComponent(payload)], { type: mimeType });
  }

  private releaseBitmap(): void {
    if (this.activeBitmap) {
      this.activeBitmap.close();
      this.activeBitmap = null;
    }
  }

  private draw = () => {
    if (!this.running) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const imageReady = Boolean(this.decodedFrame) && this.frameCanvas.width > 0 && this.frameCanvas.height > 0;

    if (imageReady) {
      const srcRatio = this.frameCanvas.width / this.frameCanvas.height;
      const dstRatio = width / height;
      let drawWidth = width;
      let drawHeight = height;
      let dx = 0;
      let dy = 0;
      if (srcRatio > dstRatio) {
        drawHeight = Math.round(width / srcRatio);
        dy = Math.round((height - drawHeight) / 2);
      } else {
        drawWidth = Math.round(height * srcRatio);
        dx = Math.round((width - drawWidth) / 2);
      }
      this.ctx.fillStyle = '#050505';
      this.ctx.fillRect(0, 0, width, height);
      this.ctx.drawImage(this.frameCanvas, dx, dy, drawWidth, drawHeight);
    } else {
      this.drawWaitingFrame();
    }

    this.drawHud();
    this.raf = requestAnimationFrame(this.draw);
  };

  private drawWaitingFrame(): void {
    const { width, height } = this.canvas;
    const now = performance.now() / 1000;
    const grad = this.ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, '#111827');
    grad.addColorStop(0.55, '#0f766e');
    grad.addColorStop(1, '#020617');
    this.ctx.fillStyle = grad;
    this.ctx.fillRect(0, 0, width, height);
    this.ctx.fillStyle = `rgba(45, 212, 191, ${0.12 + Math.sin(now * 3) * 0.04})`;
    this.ctx.beginPath();
    this.ctx.arc(width * 0.28 + Math.sin(now) * 40, height * 0.36, 92, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.fillStyle = '#d1fae5';
    this.ctx.font = '600 28px Arial, sans-serif';
    this.ctx.fillText('\u7b49\u5f85 DCC \u6444\u50cf\u673a\u753b\u9762', 42, 72);
    this.ctx.font = '18px Arial, sans-serif';
    this.ctx.fillStyle = '#a7f3d0';
    this.ctx.fillText('\u8bf7\u542f\u52a8 Blender / Unreal \u6355\u6349\uff0c\u7136\u540e\u70b9\u51fb\u8fde\u63a5\u3002', 42, 108);
  }

  private drawHud(): void {
    const cameraName = this.frame?.cameraName || '\u672a\u9009\u62e9\u6444\u50cf\u673a';
    const ts = this.frame ? new Date(this.frame.receivedAt).toLocaleTimeString() : '--:--:--';
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
    this.ctx.fillRect(12, this.canvas.height - 46, 330, 32);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.font = '14px Arial, sans-serif';
    this.ctx.fillText(`${cameraName}  ${ts}`, 24, this.canvas.height - 25);
  }
}
