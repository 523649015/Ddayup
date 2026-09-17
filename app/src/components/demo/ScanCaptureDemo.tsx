import { useEffect, useRef, useState } from 'react';
import MediaThumb from '@/components/demo/MediaThumb';

/**
 * Ddayup 网页素材采集 · 真实流程循环演示（序列帧，零侵入装饰器）
 * - 模拟扩展侧栏 UI：URL 输入 / 参数设置 / 三种扫描模式
 * - 点击「开始扫描」自动循环：滚动预览 → 扫描线掠过 → 缩略图从中心向外扩散填充
 * - 占位素材模拟"网页素材"（视频缩略图 / 商品卡 / Banner / UI 截图等），与扩展真实结果视觉一致
 * - 纯前端模拟，不发任何 API
 */

type Item = { key: number; seed: number; label: string; kind: string; dist?: number };

// 真实感的"网页素材"占位池（与 Ddayup 扩展采集结果风格一致：电商/视频/UI 截图/插画等）
const POOL: Omit<Item, 'key'>[] = [
  { seed: 12, label: '首页 Banner', kind: 'banner' },
  { seed: 200, label: '产品视频 4K', kind: 'video' },
  { seed: 140, label: '商品主图', kind: 'product' },
  { seed: 280, label: '应用截图', kind: 'ui' },
  { seed: 40, label: '配乐 0:42', kind: 'audio' },
  { seed: 330, label: '3D 模型', kind: 'model' },
  { seed: 90, label: '详情页', kind: 'product' },
  { seed: 170, label: '教程录屏', kind: 'video' },
  { seed: 20, label: '海报', kind: 'banner' },
  { seed: 250, label: '音效包', kind: 'audio' },
  { seed: 60, label: '插画封面', kind: 'art' },
  { seed: 310, label: '材质贴图', kind: 'art' },
  { seed: 110, label: '轮播图组', kind: 'ui' },
  { seed: 350, label: '产品视频', kind: 'video' },
  { seed: 30, label: '活动 H5', kind: 'banner' },
  { seed: 220, label: '商品详情', kind: 'product' },
  { seed: 160, label: '广告位', kind: 'banner' },
  { seed: 290, label: 'Logo 套件', kind: 'ui' },
];

// KIND_ICON 已迁到 MediaThumb，这里只保留尺寸/时序常量
const COLS = 6;
const ROWS = 2; // 12 个素材，参考图布局：2 行 6 列
const FILL_STEP = 110; // 每环扩散间隔
const HOLD_MS = 2200; // 填满后停留
const SCAN_MS = 1400; // 扫描线循环一帧

type Phase = 'idle' | 'scanning' | 'filling' | 'holding' | 'clearing';

export default function ScanCaptureDemo() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [items, setItems] = useState<Item[]>([]);
  const [targetUrl, setTargetUrl] = useState('https://example.com/gallery');
  const [scanMode, setScanMode] = useState<'all' | 'selection' | 'list'>('all');
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // 单次扫描流程
  const runOnce = (mode: typeof scanMode) => {
    if (timer.current) clearTimeout(timer.current);
    setPhase('scanning');
    setItems([]);

    // 1. 模拟"点击扫描按钮"→ 滚动预览区（动效：内容快速向下滚动）
    const grid = gridRef.current;
    if (grid) {
      grid.scrollTo({ top: 0 });
      grid.animate(
        [{ transform: 'translateY(0)' }, { transform: 'translateY(-8px)' }, { transform: 'translateY(0)' }],
        { duration: 600, easing: 'ease-in-out' },
      );
    }

    // 2. 扫描线阶段：1.4s
    timer.current = setTimeout(() => {
      setPhase('filling');
      // 3. 生成一批素材（按中心向外扩散）
      const batch: Item[] = [];
      const cx = (COLS - 1) / 2;
      const cy = (ROWS - 1) / 2;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const seed = POOL[Math.floor(Math.random() * POOL.length)];
          const dist = Math.round(Math.hypot(c - cx, r - cy) * 10) / 10;
          batch.push({ ...seed, key: seq.current++, dist: dist as any } as Item);
        }
      }
      batch.sort((a, b) => (a.dist as any) - (b.dist as any));

      // 4. 按环延迟填充
      let i = 0;
      const fillNext = () => {
        if (i >= batch.length) {
          setPhase('holding');
          timer.current = setTimeout(() => {
            // 5. 清空重播
            setPhase('clearing');
            setItems([]);
            timer.current = setTimeout(() => runOnce(scanMode), 500);
          }, HOLD_MS);
          return;
        }
        const cur = batch[i];
        const ring = Math.round((cur.dist as any) * 10) / 10;
        const sameRing = batch.filter((b) => Math.round((b.dist as any) * 10) / 10 === ring);
        const startIdx = batch.findIndex((b) => Math.round((b.dist as any) * 10) / 10 === ring);
        const slice = batch.slice(startIdx, startIdx + sameRing.length);
        setItems((prev) => [...prev, ...slice]);
        i = startIdx + sameRing.length;
        timer.current = setTimeout(fillNext, FILL_STEP);
      };
      fillNext();
    }, SCAN_MS);
  };

  // 自动循环：第一次进入页面就启动（用户也可以点按钮手动触发）
  useEffect(() => {
    const startTimer = setTimeout(() => runOnce(scanMode), 600);
    return () => clearTimeout(startTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusText = {
    idle: '准备就绪',
    scanning: '正在扫描目标网站素材…',
    filling: '捕获缩略图（按中心向外扩散）',
    holding: '扫描完成',
    clearing: '归档并准备下次扫描',
  }[phase];

  return (
    <div className="w-full rounded-2xl border border-[#21262d] bg-[#0d1117] p-4">
      {/* 标题 + 状态 + 项数徽章 */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-medium text-[#e6edf3]">扫描采集循环演示</h3>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#00d4aa]/10 px-2 py-0.5 text-[10px] font-medium text-[#4bd3b2]">
          <span
            className={`h-1.5 w-1.5 rounded-full bg-[#4bd3b2] ${
              phase === 'scanning' || phase === 'filling' ? 'animate-pulse' : ''
            }`}
          />
          {phase === 'idle' || phase === 'clearing' ? '准备就绪' : statusText}
        </span>
        <span className="ml-auto rounded-md border border-[#00d4aa]/40 bg-[#00d4aa]/10 px-2 py-0.5 text-[10px] font-medium text-[#4bd3b2]">
          {items.length} 项
        </span>
      </div>

      {/* 预览网格 */}
      <div
        ref={gridRef}
        className="relative grid gap-2 overflow-hidden"
        style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` }}
      >
        {/* 扫描线（仅 scanning 阶段显示） */}
        {phase === 'scanning' && (
          <span
            className="pointer-events-none absolute inset-0 z-20"
            style={{
              background:
                'linear-gradient(180deg, transparent, rgba(0,212,170,0.22) 50%, transparent)',
              backgroundSize: '100% 200%',
              animation: 'demoScanVertical 1.1s linear infinite',
            }}
          />
        )}

        {/* 空白占位（filling 阶段尾部） */}
        {Array.from({ length: COLS * ROWS - items.length }).map((_, i) => (
          <div
            key={`empty-${i}`}
            className="flex aspect-square items-center justify-center rounded border border-dashed border-[#21262d] bg-[#161b22]/40"
          >
            {phase === 'scanning' || (phase === 'filling' && i === 0) ? (
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-[#00d4aa] border-t-transparent" />
            ) : null}
          </div>
        ))}

        {items.map((it) => (
          <MediaThumb key={it.key} seed={it.seed} kind={it.kind} label={it.label} />
        ))}
      </div>

      {/* 底部说明 */}
      <div className="mt-3 text-[10px] text-[#6e7681]">纯前端模拟演示，不向服务器发任何请求。</div>
    </div>
  );
}
