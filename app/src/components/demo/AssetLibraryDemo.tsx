import { useEffect, useRef, useState } from 'react';

/**
 * 素材采集循环演示（序列帧，纯代码驱动，零侵入装饰器）
 * - 打开即自动循环：扫描线掠过网格 → 缩略图从中心向外扩散填充（按距离延迟）→ 停留 → 清空重播
 * - 占位池随机抽取，制造"实时扫描"现场感；不发任何请求
 * - 由素材库 <AssetLibraryDemo /> 渲染（真实网格上方常驻区块）
 */

type Item = { key: number; hue: number; label: string; kind: string; col: number; row: number };

const POOL: Omit<Item, 'key' | 'col' | 'row'>[] = [
  { hue: 12, label: '首页 Banner', kind: 'image' },
  { hue: 200, label: '产品截图', kind: 'image' },
  { hue: 140, label: '视频片段', kind: 'video' },
  { hue: 280, label: '图标组', kind: 'image' },
  { hue: 40, label: '配乐 A', kind: 'audio' },
  { hue: 330, label: '3D 模型', kind: 'model' },
  { hue: 90, label: '详情图', kind: 'image' },
  { hue: 170, label: '教程录屏', kind: 'video' },
  { hue: 20, label: '海报', kind: 'image' },
  { hue: 250, label: '音效包', kind: 'audio' },
  { hue: 60, label: '插画', kind: 'image' },
  { hue: 310, label: '材质贴图', kind: 'image' },
];

const KIND_ICON: Record<string, string> = { image: '🖼', video: '🎬', audio: '🎵', model: '📦' };

const COLS = 6;
const ROWS = 2;
const FILL_STEP = 90; // 每个"环"的扩散间隔
const HOLD_MS = 1800;
const GRID_ID = 'asset-demo-grid';

export default function AssetLibraryDemo() {
  const [items, setItems] = useState<Item[]>([]);
  const [scanning, setScanning] = useState(true);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    // 生成一批从中心向外扩散的占位素材（带 col/row 用于计算距离延迟）
    const spawn = () => {
      if (cancelled) return;
      const batch: Item[] = [];
      const cx = (COLS - 1) / 2;
      const cy = (ROWS - 1) / 2;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const seed = POOL[Math.floor(Math.random() * POOL.length)];
          const dist = Math.round(Math.hypot(c - cx, r - cy) * 10) / 10;
          batch.push({ ...seed, key: seq.current++, col: c, row: r, dist } as Item);
        }
      }
      batch.sort((a, b) => a.dist - b.dist);
      setScanning(true);
      setItems([]);

      // 按距离逐环填充（扩散动效）
      let i = 0;
      const fillNext = () => {
        if (cancelled) return;
        if (i >= batch.length) {
          setScanning(false);
          timer.current = setTimeout(() => {
            // 清空重播
            setItems([]);
            setTimeout(spawn, 400);
          }, HOLD_MS);
          return;
        }
        const cur = batch[i];
        const ring = Math.round(cur.dist * 10) / 10;
        // 同环的一起出现
        const sameRing = batch.filter((b) => Math.round(b.dist * 10) / 10 === ring);
        const startIdx = batch.findIndex((b) => Math.round(b.dist * 10) / 10 === ring);
        const slice = batch.slice(startIdx, startIdx + sameRing.length);
        setItems((prev) => [...prev, ...slice]);
        i = startIdx + sameRing.length;
        timer.current = setTimeout(fillNext, FILL_STEP);
      };
      fillNext();
    };

    spawn();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <div className="w-full">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#00d4aa]">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#00d4aa]" />
          {scanning ? '正在扫描采集…（演示）' : '扫描完成（演示循环）'}
        </span>
        <span className="rounded-full bg-[#00d4aa]/10 px-2 py-0.5 text-xs text-[#00d4aa]">
          {items.length} 项
        </span>
      </div>

      <div
        id={GRID_ID}
        className="relative grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
          overflow: 'hidden',
        }}
      >
        {/* 扫描线：水平掠过 */}
        {scanning && (
          <span
            className="pointer-events-none absolute inset-x-0 top-0 z-20 h-full"
            style={{
              background:
                'linear-gradient(180deg, transparent, rgba(0,212,170,0.18) 50%, transparent)',
              backgroundSize: '100% 200%',
              animation: 'demoScanVertical 1.4s linear infinite',
            }}
          />
        )}

        {items.map((it) => (
          <div
            key={it.key}
            className="group relative aspect-square overflow-hidden rounded-lg border border-[#21262d]"
            style={{
              background: `linear-gradient(135deg, hsl(${it.hue} 70% 55%), hsl(${(it.hue + 40) % 360} 70% 40%))`,
              animation: 'demoPopIn 0.45s cubic-bezier(0.22, 1, 0.36, 1) both',
            }}
          >
            <div className="absolute left-1.5 top-1.5 rounded bg-black/40 px-1 text-[10px] text-white">
              {KIND_ICON[it.kind]} {it.kind}
            </div>
            <div className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-1.5 py-1 text-[10px] text-white">
              {it.label}
            </div>
          </div>
        ))}

        {/* 填充阶段尾部：扫描中占位 */}
        {scanning && items.length < COLS * ROWS && (
          <div className="flex aspect-square items-center justify-center rounded-lg border border-dashed border-[#30363d] bg-[#0d1117]">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#00d4aa] border-t-transparent" />
          </div>
        )}
      </div>

      <p className="mt-2 px-1 text-[10px] text-[#6e7681]">
        纯前端模拟演示，不向服务器发起请求。
      </p>
    </div>
  );
}
