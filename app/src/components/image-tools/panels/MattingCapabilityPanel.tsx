import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckSquare,
  Download,
  Eye,
  EyeOff,
  MousePointerClick,
  RefreshCw,
  ScanSearch,
  Square,
  Video,
  X,
} from 'lucide-react';
import { removeBackground, isMattingReady, getMattingDiagnostic } from '@/services/postFX/matting';
import {
  cropComponentCanvas,
  extractComponentAlpha,
  labelConnectedComponents,
  type ComponentLabel,
} from '@/services/postFX/connectedComponents';
import { canvasToBlob, imageToCanvas, loadImageFromUrl } from '@/services/postFX/util';

interface SubjectInfo {
  id: number;
  name: string;
  component: ComponentLabel;
  selected: boolean;
}

export interface MattingExtractResult {
  id: number;
  name: string;
  blob: Blob;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

interface MattingCapabilityPanelProps {
  sourceImageUrl: string;
  mediaType?: 'image' | 'video';     // 图片→出PNG, 视频→RAFT跟踪
  onClose: () => void;
  onExtract: (results: MattingExtractResult[]) => Promise<void>;
  onTrack?: (subjectIds: number[], sourceUrl: string) => Promise<void>;
}

type Stage = 'loading' | 'inferring' | 'selecting' | 'ready' | 'extracting' | 'error';
type InteractionMode = 'tap' | 'box';

type BoxRect = { x: number; y: number; width: number; height: number };

type DetectionOptions = {
  minArea: number;
  threshold: number;
  padPx: number;
  edgeFeather: number;
  despill: number;
};

const SUBJECT_COLORS = [
  '#4f8cff',
  '#ff7a59',
  '#3dd598',
  '#ffc857',
  '#f06eff',
  '#25c9d0',
  '#ff5c8a',
  '#8f9bff',
];

const DEFAULT_OPTIONS: DetectionOptions = {
  minArea: 768,
  threshold: 0.32,
  padPx: 24,
  edgeFeather: 0.18,
  despill: 0.22,
};

function clampRect(rect: BoxRect, width: number, height: number): BoxRect {
  const x = Math.max(0, Math.min(rect.x, width - 1));
  const y = Math.max(0, Math.min(rect.y, height - 1));
  const right = Math.max(x + 1, Math.min(rect.x + rect.width, width));
  const bottom = Math.max(y + 1, Math.min(rect.y + rect.height, height));
  return { x, y, width: right - x, height: bottom - y };
}

function rectFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): BoxRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function intersectsBox(left: BoxRect, right: BoxRect): boolean {
  return !(
    left.x + left.width < right.x
    || right.x + right.width < left.x
    || left.y + left.height < right.y
    || right.y + right.height < left.y
  );
}

function renderPreview(
  target: HTMLCanvasElement,
  source: HTMLCanvasElement,
  labels: Int32Array,
  subjects: SubjectInfo[],
  showOverlay: boolean,
  draftBox: BoxRect | null,
) {
  target.width = source.width;
  target.height = source.height;
  const ctx = target.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(source, 0, 0);

  if (showOverlay) {
    const img = ctx.getImageData(0, 0, target.width, target.height);
    const selectedIds = new Set(subjects.filter((subject) => subject.selected).map((subject) => subject.id + 1));
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index];
      if (label === 0) continue;
      const color = SUBJECT_COLORS[(label - 1) % SUBJECT_COLORS.length];
      const si = index * 4;
      const alpha = selectedIds.has(label) ? 0.28 : 0.12;
      const tint = Number.parseInt(color.slice(1), 16);
      const r = (tint >> 16) & 255;
      const g = (tint >> 8) & 255;
      const b = tint & 255;
      img.data[si] = Math.round(img.data[si] * (1 - alpha) + r * alpha);
      img.data[si + 1] = Math.round(img.data[si + 1] * (1 - alpha) + g * alpha);
      img.data[si + 2] = Math.round(img.data[si + 2] * (1 - alpha) + b * alpha);
    }
    ctx.putImageData(img, 0, 0);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const subject of subjects) {
    const { bbox } = subject.component;
    const color = SUBJECT_COLORS[subject.id % SUBJECT_COLORS.length];
    ctx.lineWidth = subject.selected ? 2.5 : 1.5;
    ctx.strokeStyle = subject.selected ? color : 'rgba(255,255,255,0.45)';
    ctx.setLineDash(subject.selected ? [] : [5, 4]);
    ctx.strokeRect(bbox.x, bbox.y, bbox.width, bbox.height);
    ctx.setLineDash([]);

    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + Math.min(18, Math.max(14, bbox.height * 0.1));
    ctx.fillStyle = subject.selected ? color : 'rgba(17,18,20,0.82)';
    ctx.beginPath();
    ctx.roundRect(cx - 18, cy - 11, 36, 22, 10);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(String(subject.id + 1), cx, cy + 0.5);
  }

  if (draftBox) {
    ctx.fillStyle = 'rgba(0, 212, 170, 0.12)';
    ctx.strokeStyle = 'rgba(0, 212, 170, 0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.fillRect(draftBox.x, draftBox.y, draftBox.width, draftBox.height);
    ctx.strokeRect(draftBox.x, draftBox.y, draftBox.width, draftBox.height);
    ctx.setLineDash([]);
  }
}

/** 单击聚焦主体时的隔离视图——只显示该主体的抠图效果，背景为棋盘格(透明标示) */
function IsolatedSubjectView({
  sourceCanvas, fullAlpha, labels, subjectId,
}: { sourceCanvas: HTMLCanvasElement; fullAlpha: Float32Array; labels: Int32Array | null; subjectId: number }) {
  const [dataUrl, setDataUrl] = useState('');
  const [meta, setMeta] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!labels) return;
    const srcW = sourceCanvas.width;
    const srcH = sourceCanvas.height;
    // 提取该主体的 alpha 和包围盒
    const compAlpha = extractComponentAlpha(labels, fullAlpha, subjectId, srcW, srcH);

    // 找包围盒
    let minX = srcW, minY = srcH, maxX = 0, maxY = 0;
    for (let i = 0; i < srcW * srcH; i++) {
      if (compAlpha[i] > 0.1) {
        const x = i % srcW, y = Math.floor(i / srcW);
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
    }
    const pad = 20;
    const cx = Math.max(0, minX - pad), cy = Math.max(0, minY - pad);
    const cw = Math.min(srcW - cx, maxX - minX + pad * 2);
    const ch = Math.min(srcH - cy, maxY - minY + pad * 2);

    const cropped = cropComponentCanvas(sourceCanvas, compAlpha, srcW, { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, pad);
    setDataUrl(cropped.toDataURL('image/png'));
    setMeta({ w: cropped.width, h: cropped.height });
  }, [sourceCanvas, fullAlpha, labels, subjectId]);

  if (!dataUrl) return <div className="text-sm text-[#8c98a6] p-8">加载中…</div>;
  return (
    <div className="flex items-center justify-center p-2" style={{
      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Crect width='8' height='8' fill='%23222'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23222'/%3E%3Crect x='8' width='8' height='8' fill='%23333'/%3E%3Crect y='8' width='8' height='8' fill='%23333'/%3E%3C/svg%3E")`,
      backgroundSize: '16px 16px',
      maxHeight: '360px',
    }}>
      <img src={dataUrl} alt="isolated subject" className="max-h-[340px] max-w-full object-contain rounded-xl"
        style={{ imageRendering: 'auto' }} />
    </div>
  );
}

export default function MattingCapabilityPanel({
  sourceImageUrl,
  mediaType = 'image',
  onClose,
  onExtract,
  onTrack,
}: MattingCapabilityPanelProps) {
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelsRef = useRef<Int32Array | null>(null);
  const cachedAlphaRef = useRef<Float32Array | null>(null);
  const cachedSourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);

  const [stage, setStage] = useState<Stage>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [progress, setProgress] = useState(0);
  const [engineLabel, setEngineLabel] = useState('');
  const [engineDetail, setEngineDetail] = useState('');
  const [srcSize, setSrcSize] = useState({ width: 0, height: 0 });
  const [fullAlpha, setFullAlpha] = useState<Float32Array | null>(null);
  const [previewCanvas, setPreviewCanvas] = useState<HTMLCanvasElement | null>(null);
  const [subjects, setSubjects] = useState<SubjectInfo[]>([]);
  const [showOverlay, setShowOverlay] = useState(true);
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('tap');
  const [focusedSubjectId, setFocusedSubjectId] = useState<number | null>(null); // 单击隔离显示
  const [draftBox, setDraftBox] = useState<BoxRect | null>(null);
  const [options, setOptions] = useState<DetectionOptions>(DEFAULT_OPTIONS);

  const selectedCount = useMemo(
    () => subjects.filter((subject) => subject.selected).length,
    [subjects],
  );

  const updateOption = useCallback((key: keyof DetectionOptions, value: number) => {
    setOptions((prev) => ({ ...prev, [key]: value }));
  }, []);

  // ── 首次推理（慢，一次性，缓存 alpha）──
  const runModelInference = useCallback(async () => {
    setStage('inferring');
    setErrorMsg('');
    setProgress(10);
    try {
      const hasCOOP = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true;
      console.info('[matting-panel] crossOriginIsolated:', hasCOOP);
      if (!hasCOOP) {
        setErrorMsg('缺少跨域隔离(COOP/COEP)→BiRefNet不可用。请在浏览器中打开,不要用IDE内嵌预览。');
        setStage('error');
        return;
      }
      const image = await loadImageFromUrl(sourceImageUrl);
      const sourceCanvas = imageToCanvas(image);
      sourceCanvasRef.current = sourceCanvas;
      setSrcSize({ width: sourceCanvas.width, height: sourceCanvas.height });
      setProgress(20);

      const result = await removeBackground(image, {
        modelId: 'birefnet-matting',
        edgeFeather: options.edgeFeather,
        despill: options.despill,
      });
      cachedAlphaRef.current = result.alpha;
      cachedSourceCanvasRef.current = sourceCanvas;
      setFullAlpha(result.alpha);
      setPreviewCanvas(result.canvas);
      setProgress(60);

      const isBiRefNet = isMattingReady();
      setEngineLabel(isBiRefNet ? 'BiRefNet(发丝级)' : '@imgly ISNet(普通)');
      setEngineDetail(getMattingDiagnostic());

      // 跑首次 CCL
      reanalyzeComponents(result.alpha, sourceCanvas);
    } catch (error) {
      setStage('error');
      setErrorMsg(error instanceof Error ? error.message : '智能抠图初始化失败。');
    }
  }, [sourceImageUrl, options.edgeFeather, options.despill]);

  // ── 快速重分析（只跑 CCL，~20ms，阈值/最小面积变化触发）──
  const reanalyzeComponents = useCallback((alpha: Float32Array | null, srcCanvas: HTMLCanvasElement | null) => {
    const a = alpha ?? cachedAlphaRef.current;
    const c = srcCanvas ?? cachedSourceCanvasRef.current;
    if (!a || !c) return;

    setStage('selecting');
    const { labels, components } = labelConnectedComponents(a, c.width, c.height, options.minArea, options.threshold);
    labelsRef.current = labels;

    if (!components.length) {
      // 阈值太高没检到主体→放宽阈值提示而不清空
      setSubjects([]);
      return;
    }

    const largest = Math.max(...components.map((c2) => c2.pixelCount));
    setSubjects(
      components.map((component, index) => ({
        id: component.id,
        name: `主体 ${index + 1}`,
        component,
        selected: component.pixelCount >= largest * 0.2,
      })),
    );
    setProgress(100);
    setStage('ready');
  }, [options.minArea, options.threshold]);

  // ── 首次加载时跑完整推理 ──
  useEffect(() => {
    void runModelInference();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceImageUrl]);

  useEffect(() => {
    const previewCanvas = previewCanvasRef.current;
    const sourceCanvas = sourceCanvasRef.current;
    const labels = labelsRef.current;
    if (!previewCanvas || !sourceCanvas || !labels || !subjects.length) return;
    renderPreview(previewCanvas, sourceCanvas, labels, subjects, showOverlay, draftBox);
  }, [draftBox, showOverlay, subjects]);

  // 阈值/最小面积变化→只重跑 CCL（20ms），不跑模型推理
  useEffect(() => {
    if (!cachedAlphaRef.current || !cachedSourceCanvasRef.current) return;
    reanalyzeComponents(null, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.threshold, options.minArea]);

  const eventToSourcePoint = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(rect.width, 1);
    const scaleY = canvas.height / Math.max(rect.height, 1);
    return {
      x: Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - rect.left) * scaleX))),
      y: Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - rect.top) * scaleY))),
    };
  }, []);

  const toggleSubject = useCallback((subjectId: number) => {
    setSubjects((prev) => prev.map((subject) => (
      subject.id === subjectId
        ? { ...subject, selected: !subject.selected }
        : subject
    )));
  }, []);

  const setSubjectsSelected = useCallback((subjectIds: number[], selected: boolean) => {
    const idSet = new Set(subjectIds);
    setSubjects((prev) => prev.map((subject) => (
      idSet.has(subject.id)
        ? { ...subject, selected }
        : subject
    )));
  }, []);

  const renameSubject = useCallback((subjectId: number, name: string) => {
    setSubjects((prev) => prev.map((subject) => (
      subject.id === subjectId
        ? { ...subject, name }
        : subject
    )));
  }, []);

  const handlePreviewPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (stage !== 'ready' || interactionMode !== 'box') return;
    const point = eventToSourcePoint(event);
    if (!point) return;
    pointerStartRef.current = point;
    setDraftBox({ x: point.x, y: point.y, width: 1, height: 1 });
  }, [eventToSourcePoint, interactionMode, stage]);

  const handlePreviewPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (stage !== 'ready' || interactionMode !== 'box' || !pointerStartRef.current) return;
    const point = eventToSourcePoint(event);
    if (!point) return;
    const next = clampRect(rectFromPoints(pointerStartRef.current, point), srcSize.width, srcSize.height);
    setDraftBox(next);
  }, [eventToSourcePoint, interactionMode, srcSize.height, srcSize.width, stage]);

  const handlePreviewPointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (stage !== 'ready') return;
    const labels = labelsRef.current;
    const point = eventToSourcePoint(event);
    if (!labels || !point) return;

    if (interactionMode === 'tap') {
      const label = labels[point.y * srcSize.width + point.x];
      if (label > 0) {
        toggleSubject(label - 1);
        return;
      }
      const fallback = subjects.find((subject) => {
        const { bbox } = subject.component;
        return point.x >= bbox.x && point.x <= bbox.x + bbox.width && point.y >= bbox.y && point.y <= bbox.y + bbox.height;
      });
      if (fallback) toggleSubject(fallback.id);
      return;
    }

    if (!pointerStartRef.current || !draftBox) return;
    const nextRect = clampRect(draftBox, srcSize.width, srcSize.height);
    const alpha = cachedAlphaRef.current;
    const matched = new Set<number>();
    let hasAlphaInBox = false;
    const boxAlphaThreshold = 0.05; // 框选用极低阈值捕获破损/半透明/毛边像素
    for (let y = nextRect.y; y < nextRect.y + nextRect.height; y += 2) {
      for (let x = nextRect.x; x < nextRect.x + nextRect.width; x += 2) {
        const idx = y * srcSize.width + x;
        const label = labels[idx];
        if (label > 0) matched.add(label - 1);
        else if (alpha && alpha[idx] > boxAlphaThreshold) hasAlphaInBox = true;
      }
    }
    // 框内无标签但有alpha → 补漏新建主体(用极低阈值重新CCL)
    if (!matched.size && hasAlphaInBox && alpha) {
      const { components: nc } = labelConnectedComponents(
        alpha, srcSize.width, srcSize.height,
        Math.max(8, options.minArea / 8), boxAlphaThreshold,
      );
      const boxed = nc.filter(c => intersectsBox(nextRect, c.bbox));
      boxed.forEach(c => matched.add(c.id));
      if (boxed.length) {
        setSubjects(prev => {
          const ids = new Set(prev.map(s => s.id));
          return [...prev, ...boxed.filter(c => !ids.has(c.id)).map((c, i) => ({
            id: c.id, name: `新主体 ${i + 1}`, component: c, selected: true,
          }))];
        });
      }
    }
    if (!matched.size) {
      subjects.forEach((subject) => {
        if (intersectsBox(nextRect, subject.component.bbox)) matched.add(subject.id);
      });
    }
    if (matched.size) {
      setSubjectsSelected([...matched], true);
    }
    pointerStartRef.current = null;
    setDraftBox(null);
  }, [draftBox, eventToSourcePoint, interactionMode, options.minArea, options.threshold, setSubjectsSelected, srcSize.height, srcSize.width, stage, subjects, toggleSubject]);

  const handlePreviewPointerLeave = useCallback(() => {
    if (!pointerStartRef.current) return;
    pointerStartRef.current = null;
    setDraftBox(null);
  }, []);

  const handleTrack = useCallback(async () => {
    const selected = subjects.filter(s => s.selected);
    if (!selected.length) { setErrorMsg('请至少选中一个主体。'); return; }
    if (!onTrack) return;
    setStage('extracting'); setProgress(0); setErrorMsg('');
    try { await onTrack(selected.map(s => s.id), sourceImageUrl); onClose(); }
    catch (err) { setErrorMsg((err as Error)?.message || '视频跟踪失败'); setStage('ready'); }
  }, [subjects, onTrack, sourceImageUrl, onClose]);

  const handleExtract = useCallback(async () => {
    const sourceCanvas = sourceCanvasRef.current;
    const labels = labelsRef.current;
    if (!sourceCanvas || !labels || !fullAlpha) return;

    const selectedSubjects = subjects.filter((subject) => subject.selected);
    if (!selectedSubjects.length) {
      setErrorMsg('请至少选中一个主体再输出 PNG。');
      return;
    }

    setStage('extracting');
    setProgress(0);
    setErrorMsg('');

    try {
      const results: MattingExtractResult[] = [];
      for (let index = 0; index < selectedSubjects.length; index += 1) {
        const subject = selectedSubjects[index];
        const componentAlpha = extractComponentAlpha(labels, fullAlpha, subject.id, srcSize.width, srcSize.height);
        const canvas = cropComponentCanvas(sourceCanvas, componentAlpha, srcSize.width, subject.component.bbox, options.padPx);
        const blob = await canvasToBlob(canvas, 'image/png');
        results.push({
          id: subject.id,
          name: subject.name.trim() || `主体 ${index + 1}`,
          blob,
          canvas,
          width: canvas.width,
          height: canvas.height,
        });
        setProgress(Math.round(((index + 1) / selectedSubjects.length) * 100));
      }

      await onExtract(results);
    } catch (error) {
      setStage('error');
      setErrorMsg(error instanceof Error ? error.message : '批量导出失败。');
      return;
    }

    onClose();
  }, [fullAlpha, onClose, onExtract, options.padPx, srcSize.height, srcSize.width, subjects]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0f1114] text-[#f4f7fb]">
      <div className="border-b border-white/8 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.26em] text-[#7ecfbc]">Smart Cutout</div>
            <h2 className="mt-2 text-xl font-semibold">一键智能抠图</h2>
            <p className="mt-2 max-w-[560px] text-sm leading-6 text-[#a8b3c3]">
              先自动识别画面主体，再直接在画面上点选；漏检时切到框选模式补选，最后批量输出带透明通道的 PNG。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-white/10 bg-white/5 p-2 text-[#c8d0da] transition hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1.35fr)_360px]">
        <div className="min-h-0 border-b border-white/8 lg:border-r lg:border-b-0">
          <div className="flex items-center justify-between gap-3 border-b border-white/8 px-6 py-4">
            <div>
              <div className="text-sm font-medium text-white">
                {stage === 'ready' ? `检测到 ${subjects.length} 个候选主体，已选中 ${selectedCount} 个` : '主体识别预览'}
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs flex-wrap">
                <span className={`text-[10px] rounded px-1.5 py-px ${typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? 'bg-[#00d4aa]/15 text-[#00d4aa]' : 'bg-[#f85149]/15 text-[#f85149]'}`}>
                  COOP{typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? '✓' : '✗'}
                </span>
                {engineLabel ? (
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${
                    engineLabel.includes('BiRefNet') ? 'bg-[#00d4aa]/15 text-[#00d4aa]' : 'bg-[#f59e0b]/15 text-[#f59e0b]'
                  }`}>{engineLabel.includes('BiRefNet') ? '✨' : '⚠️'} {engineLabel}</span>
                ) : null}
              </div>
              {engineLabel && !engineLabel.includes('BiRefNet') ? (
                <div className="mt-1 max-w-full break-words text-[11px] leading-snug text-[#f59e0b]">
                  BiRefNet 未生效（已回退 @imgly）。原因：{engineDetail || '未知（见浏览器控制台 [matting] 日志）'}
                </div>
              ) : null}
              <div className="mt-1 text-xs text-[#7f8b99]">
                {interactionMode === 'tap' ? '点击主体即可切换选中状态。' : '拖出一个框，快速补选遗漏主体。'}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setInteractionMode('tap')}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs ${interactionMode === 'tap' ? 'bg-[#17342e] text-[#d7fff5]' : 'bg-white/5 text-[#cbd5df]'}`}
              >
                <MousePointerClick className="h-3.5 w-3.5" />
                点选主体
              </button>
              <button
                type="button"
                onClick={() => setInteractionMode('box')}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs ${interactionMode === 'box' ? 'bg-[#17342e] text-[#d7fff5]' : 'bg-white/5 text-[#cbd5df]'}`}
              >
                <ScanSearch className="h-3.5 w-3.5" />
                框选补漏
              </button>
              <button
                type="button"
                onClick={() => setShowOverlay((prev) => !prev)}
                className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-xs text-[#cbd5df]"
              >
                {showOverlay ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {showOverlay ? '隐藏蒙层' : '显示蒙层'}
              </button>
              <button
                type="button"
                onClick={() => void runModelInference()}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-[#edf2f8]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                重新识别
              </button>
            </div>
          </div>

          <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-[radial-gradient(circle_at_top,#152028,transparent_58%),linear-gradient(180deg,#0d1013,#08090b)] p-6">
            {(stage === 'loading' || stage === 'inferring') ? (
              <div className="flex flex-col items-center gap-4 text-[#b8c2ce]">
                <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/10 border-t-[#00d4aa]" />
                <div className="text-sm">{stage === 'loading' ? '加载模型…' : stage === 'inferring' ? 'BiRefNet 推理中…' : '拆分独立主体…'}</div>
                {engineLabel ? <div className="text-xs text-[#7f8b99]">{engineLabel}</div> : null}
              </div>
            ) : stage === 'error' ? (
              <div className="max-w-md rounded-2xl border border-[#ff6f6f]/20 bg-[#351716] px-5 py-4 text-sm leading-6 text-[#ffd3d3]">
                {errorMsg}
              </div>
            ) : focusedSubjectId !== null && fullAlpha && sourceCanvasRef.current ? (
              <IsolatedSubjectView
                sourceCanvas={sourceCanvasRef.current}
                fullAlpha={fullAlpha}
                labels={labelsRef.current}
                subjectId={focusedSubjectId}
              />
            ) : (stage === 'ready' || stage === 'selecting') ? (
              <canvas
                ref={previewCanvasRef}
                className="max-h-full w-full max-w-full cursor-crosshair rounded-2xl border border-white/10 bg-[#0b0d10] shadow-[0_18px_60px_rgba(0,0,0,0.35)]"
                style={{ aspectRatio: `${Math.max(srcSize.width, 1)} / ${Math.max(srcSize.height, 1)}`, objectFit: 'contain' }}
                onPointerDown={handlePreviewPointerDown}
                onPointerMove={handlePreviewPointerMove}
                onPointerUp={handlePreviewPointerUp}
                onPointerLeave={handlePreviewPointerLeave}
              />
            ) : null}
          </div>
        </div>

        <div className="flex min-h-0 flex-col bg-[#101318]">
          <div className="border-b border-white/8 px-6 py-4">
            <div className="text-sm font-medium text-white">识别与输出设置</div>
            <div className="mt-1 text-xs leading-5 text-[#8894a3]">
              用阈值和最小面积控制主体拆分，用保边和去溢色优化透明 PNG 的边缘质量。
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="space-y-5">
              <div className="space-y-3 rounded-2xl border border-white/8 bg-white/5 p-4">
                <RangeField label="主体阈值" value={options.threshold} min={0.12} max={0.75} step={0.01} format={(value) => value.toFixed(2)} onChange={(value) => updateOption('threshold', value)} />
                <RangeField label="最小面积" value={options.minArea} min={128} max={8192} step={64} format={(value) => `${Math.round(value)} px`} onChange={(value) => updateOption('minArea', Math.round(value))} />
                <RangeField label="裁切留白" value={options.padPx} min={8} max={96} step={2} format={(value) => `${Math.round(value)} px`} onChange={(value) => updateOption('padPx', Math.round(value))} />
                <RangeField label="边缘保边" value={options.edgeFeather} min={0} max={0.5} step={0.01} format={(value) => value.toFixed(2)} onChange={(value) => updateOption('edgeFeather', value)} />
                <RangeField label="去溢色" value={options.despill} min={0} max={1} step={0.01} format={(value) => value.toFixed(2)} onChange={(value) => updateOption('despill', value)} />
              </div>

              <div className="space-y-3 rounded-2xl border border-white/8 bg-[#0d1117] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-white">主体列表</div>
                    <div className="mt-1 text-xs text-[#8c98a6]">可多选、可改名，导出时会按这里的名称命名结果。</div>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <button type="button" onClick={() => setSubjects((prev) => prev.map((subject) => ({ ...subject, selected: true })))} className="rounded-full bg-white/6 px-3 py-1.5 text-[#dfe7ef]">全选</button>
                    <button type="button" onClick={() => setSubjects((prev) => prev.map((subject) => ({ ...subject, selected: false })))} className="rounded-full bg-white/6 px-3 py-1.5 text-[#dfe7ef]">清空</button>
                  </div>
                </div>
                <div className="space-y-2">
                  {subjects.map((subject) => {
                    const color = SUBJECT_COLORS[subject.id % SUBJECT_COLORS.length];
                    return (
                      <div
                        key={subject.id}
                        className={`cursor-pointer rounded-2xl border p-3 transition ${
                          focusedSubjectId === subject.id
                            ? 'border-[#00d4aa]/60 bg-[#0f2f2a] ring-1 ring-[#00d4aa]/30'
                            : subject.selected
                              ? 'border-[#2b7fff]/40 bg-[#142338]'
                              : 'border-white/8 bg-white/4 hover:border-white/15'
                        }`}
                        onClick={() => setFocusedSubjectId(focusedSubjectId === subject.id ? null : subject.id)}
                      >
                        <div className="flex items-start gap-3">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); toggleSubject(subject.id); }}
                            className="mt-0.5 text-[#dbe6f2]"
                          >
                            {subject.selected ? <CheckSquare className="h-4 w-4 text-[#6fb0ff]" /> : <Square className="h-4 w-4 text-[#6f7d8b]" />}
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
                              <span className="text-sm text-white truncate">{subject.name}</span>
                              {focusedSubjectId === subject.id && (
                                <span className="text-[10px] text-[#00d4aa] font-medium">预览中</span>
                              )}
                            </div>
                            <div className="mt-1 text-xs leading-5 text-[#8c98a6]">
                              {subject.component.pixelCount.toLocaleString()} px · {subject.component.bbox.width} × {subject.component.bbox.height}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="border-t border-white/8 px-6 py-4">
            {stage === 'extracting' ? (
              <div className="mb-4">
                <div className="mb-2 flex items-center justify-between text-xs text-[#96a2af]">
                  <span>正在批量导出透明 PNG</span>
                  <span>{progress}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-white/8">
                  <div className="h-full rounded-full bg-[#00d4aa] transition-all" style={{ width: `${progress}%` }} />
                </div>
              </div>
            ) : null}
            {errorMsg && stage !== 'error' ? (
              <div className="mb-4 rounded-2xl border border-[#ff8b8b]/20 bg-[#3b1c1b] px-3 py-2 text-xs leading-5 text-[#ffd4d4]">{errorMsg}</div>
            ) : null}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-[#d7e0ea] transition hover:bg-white/10"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void (mediaType === 'video' ? handleTrack() : handleExtract())}
                disabled={stage === 'loading' || stage === 'extracting' || selectedCount === 0}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-[#00d4aa] px-4 py-3 text-sm font-semibold text-[#07221c] transition hover:bg-[#16e3bb] disabled:cursor-not-allowed disabled:bg-[#0d6050] disabled:text-[#9fd8cb]"
              >
                {mediaType === 'video' ? <Video className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                {mediaType === 'video'
                  ? `跟踪 ${selectedCount > 0 ? `${selectedCount} 个主体` : ''}`
                  : `批量输出 ${selectedCount > 0 ? `${selectedCount} 个 PNG` : 'PNG'}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-[#9aa6b4]">
        <span>{label}</span>
        <span className="font-medium text-[#eef4fb]">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-2 w-full cursor-ew-resize appearance-none rounded-full bg-[#1f2630] accent-[#00d4aa]"
      />
    </label>
  );
}


