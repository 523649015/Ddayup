import { PDFDocument } from 'pdf-lib';
import { strToU8, zipSync } from 'fflate';

interface StoryboardPanelItem {
  title: string;
  note: string;
  imageUrl?: string;
}

interface StoryboardExportContext {
  template?: string;
  exportLayout?: string;
  outputResolution?: string;
  exportFormat?: string;
  shotPrompt?: string;
}

interface SplitExportOptions {
  subjectAware: boolean;
  avoidFaces: boolean;
  safeMargin?: number;
  namingPattern?: string;
  sourceImageUrl?: string;
}

async function loadImageElement(url: string) {
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    image.src = url;
  });
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function toBlobBytes(bytes: Uint8Array) {
  return Uint8Array.from(bytes);
}

function safeNumber(value: unknown, fallback: number) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function safeNamingPattern(value: unknown) {
  const pattern = String(value || 'tile-r{row}-c{col}').trim();
  return pattern || 'tile-r{row}-c{col}';
}

function buildTileName(pattern: string, row: number, col: number) {
  return pattern.replaceAll('{row}', String(row)).replaceAll('{col}', String(col));
}

function wrapCanvasText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number) {
  const lines = String(text || '').split(/\n+/);
  let cursorY = y;
  for (const rawLine of lines) {
    let buffer = '';
    for (const char of rawLine) {
      const next = `${buffer}${char}`;
      if (ctx.measureText(next).width > maxWidth && buffer) {
        ctx.fillText(buffer, x, cursorY);
        buffer = char;
        cursorY += lineHeight;
      } else {
        buffer = next;
      }
    }
    if (buffer) {
      ctx.fillText(buffer, x, cursorY);
      cursorY += lineHeight;
    }
    cursorY += 8;
  }
}

async function renderCardImage(title: string, detail: string, footer: string, width = 1280, height = 720) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable.');

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#111827');
  gradient.addColorStop(0.58, '#155e75');
  gradient.addColorStop(1, '#030712');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(56, 56, width - 112, height - 112);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.strokeRect(56, 56, width - 112, height - 112);

  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 54px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillText(title, 92, 136);

  ctx.fillStyle = '#cbd5e1';
  ctx.font = '28px "Microsoft YaHei", "PingFang SC", sans-serif';
  wrapCanvasText(ctx, detail, 92, 210, width - 184, 42);

  ctx.fillStyle = '#a7f3d0';
  ctx.font = '22px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillText(footer, 92, height - 88);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to encode canvas.'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

async function renderImageBackedCard(item: StoryboardPanelItem, footer: string, width = 1280, height = 720) {
  if (!item.imageUrl) return await renderCardImage(item.title, item.note, footer, width, height);

  try {
    const source = await loadImageElement(item.imageUrl);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable.');

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);
    const ratio = Math.max(width / source.naturalWidth, height / source.naturalHeight);
    const drawWidth = source.naturalWidth * ratio;
    const drawHeight = source.naturalHeight * ratio;
    const drawX = (width - drawWidth) / 2;
    const drawY = (height - drawHeight) / 2;
    ctx.drawImage(source, drawX, drawY, drawWidth, drawHeight);

    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(48, height - 212, width - 96, 164);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 42px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText(item.title, 80, height - 150);
    ctx.fillStyle = '#dbeafe';
    ctx.font = '26px "Microsoft YaHei", "PingFang SC", sans-serif';
    wrapCanvasText(ctx, item.note || 'No note', 80, height - 108, width - 160, 34);
    ctx.fillStyle = '#a7f3d0';
    ctx.font = '20px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText(footer, 80, height - 64);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Failed to encode image-backed canvas.'));
          return;
        }
        resolve(blob);
      }, 'image/png');
    });
  } catch {
    return await renderCardImage(item.title, item.note, footer, width, height);
  }
}

export async function exportStoryboardPdf(filename: string, items: StoryboardPanelItem[], context: StoryboardExportContext = {}) {
  const pdf = await PDFDocument.create();
  for (const [index, item] of items.entries()) {
    const page = pdf.addPage([1280, 720]);
    const footer = `${context.template || 'storyboard'} / Panel ${index + 1}`;
    const imageBlob = await renderImageBackedCard(item, footer);
    const imageBytes = new Uint8Array(await imageBlob.arrayBuffer());
    const image = await pdf.embedPng(imageBytes);
    page.drawImage(image, { x: 0, y: 0, width: 1280, height: 720 });
  }
  const pdfBytes = await pdf.save();
  downloadBlob(filename, new Blob([toBlobBytes(pdfBytes)], { type: 'application/pdf' }));
}

export async function exportStoryboardZip(filename: string, items: StoryboardPanelItem[], context: StoryboardExportContext = {}) {
  const entries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify({ exportedAt: new Date().toISOString(), count: items.length, context, items }, null, 2)),
  };

  for (const [index, item] of items.entries()) {
    const blob = await renderImageBackedCard(item, `Panel ${index + 1}`);
    const stem = `panel-${String(index + 1).padStart(2, '0')}`;
    entries[`${stem}.png`] = new Uint8Array(await blob.arrayBuffer());
    entries[`${stem}.txt`] = strToU8(`${item.title}\n\n${item.note}`);
  }

  const zipped = zipSync(entries, { level: 6 });
  downloadBlob(filename, new Blob([toBlobBytes(zipped)], { type: 'application/zip' }));
}

export async function exportSplitZip(filename: string, rows: number, cols: number, options: SplitExportOptions) {
  const safeMargin = Math.max(0, Math.min(0.2, safeNumber(options.safeMargin, 0.04)));
  const namingPattern = safeNamingPattern(options.namingPattern);
  const entries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify({
      exportedAt: new Date().toISOString(),
      rows,
      cols,
      options: { ...options, safeMargin, namingPattern },
    }, null, 2)),
  };

  const source = options.sourceImageUrl ? await loadImageElement(options.sourceImageUrl).catch(() => null) : null;

  if (source) {
    const tileWidth = Math.max(1, Math.floor(source.naturalWidth / cols));
    const tileHeight = Math.max(1, Math.floor(source.naturalHeight / rows));

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const canvas = document.createElement('canvas');
        canvas.width = tileWidth;
        canvas.height = tileHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;

        const insetX = options.subjectAware && options.avoidFaces && col > 0 && col < cols - 1 ? Math.floor(tileWidth * safeMargin) : 0;
        const insetY = options.subjectAware && options.avoidFaces && row > 0 && row < rows - 1 ? Math.floor(tileHeight * safeMargin) : 0;
        const sx = col * tileWidth + insetX;
        const sy = row * tileHeight + insetY;
        const sw = Math.max(1, tileWidth - insetX * 2);
        const sh = Math.max(1, tileHeight - insetY * 2);
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, tileWidth, tileHeight);

        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((value) => {
            if (!value) {
              reject(new Error('Failed to encode split tile.'));
              return;
            }
            resolve(value);
          }, 'image/png');
        });

        const tileName = buildTileName(namingPattern, row + 1, col + 1);
        entries[`${tileName}.png`] = new Uint8Array(await blob.arrayBuffer());
      }
    }
  } else {
    let index = 1;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const blob = await renderCardImage(
          `Tile ${index}`,
          `row ${row + 1} / col ${col + 1}`,
          options.subjectAware ? 'subject-aware split' : 'uniform split',
          720,
          720,
        );
        const tileName = buildTileName(namingPattern, row + 1, col + 1);
        entries[`${tileName}.png`] = new Uint8Array(await blob.arrayBuffer());
        index += 1;
      }
    }
  }

  const zipped = zipSync(entries, { level: 6 });
  downloadBlob(filename, new Blob([toBlobBytes(zipped)], { type: 'application/zip' }));
}
