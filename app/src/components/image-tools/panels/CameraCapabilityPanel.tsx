import { Camera, Search } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { ToolCapabilityPanelProps } from './capabilityPanelTypes';

type CameraBody = { name: string; brand: string; sensor: string; mount: string };
type Lens = { name: string; family: string; mount: string; focal: string };

const CAMERA_PRESETS = [
  { id: 'product-shot', label: '产品摄影', cameraBody: 'ARRI Alexa 35', lens: 'Cooke S4/i 50mm', focalLength: 50, aperture: 2.8, iso: 800, shutter: '1/48', lut: 'ARRI LogC', focusDistance: 1.8 },
  { id: 'portrait', label: '人物肖像', cameraBody: 'Sony Venice 2', lens: 'Zeiss Supreme 85mm', focalLength: 85, aperture: 2, iso: 640, shutter: '1/96', lut: 'Sony S-Cinetone', focusDistance: 3.2 },
  { id: 'wide-ambient', label: '宽景环境', cameraBody: 'RED V-Raptor XL', lens: 'ARRI Signature Prime 35mm', focalLength: 35, aperture: 4, iso: 500, shutter: '1/48', lut: 'RED IPP2', focusDistance: 4.5 },
  { id: 'handheld-drama', label: '手持剧情', cameraBody: 'ARRI Alexa Mini LF', lens: 'Cooke S4/i 32mm', focalLength: 32, aperture: 2.2, iso: 1000, shutter: '1/48', lut: 'ARRI LogC', focusDistance: 2.4 },
  { id: 'shallow-bokeh', label: '浅景深', cameraBody: 'Sony Venice 2', lens: 'Atlas Orion 40mm', focalLength: 40, aperture: 2.8, iso: 800, shutter: '1/48', lut: 'Sony S-Cinetone', focusDistance: 3 },
  { id: 'telephoto-compress', label: '长焦压缩', cameraBody: 'RED V-Raptor XL', lens: 'Zeiss Supreme 135mm', focalLength: 135, aperture: 2.8, iso: 640, shutter: '1/96', lut: 'RED IPP2', focusDistance: 8.5 },
];

const CAMERA_BODY_LIBRARY: CameraBody[] = [
  { name: 'ARRI Alexa 35', brand: 'ARRI', sensor: 'Super 35', mount: 'LPL' },
  { name: 'ARRI Alexa Mini LF', brand: 'ARRI', sensor: 'Large Format', mount: 'LPL' },
  { name: 'ARRI Alexa 65', brand: 'ARRI', sensor: '65mm', mount: 'XPL' },
  { name: 'Sony Venice 2', brand: 'Sony', sensor: 'Full Frame', mount: 'PL / E' },
  { name: 'Sony FX9', brand: 'Sony', sensor: 'Full Frame', mount: 'E' },
  { name: 'Sony Burano', brand: 'Sony', sensor: 'Full Frame', mount: 'E' },
  { name: 'RED V-Raptor XL', brand: 'RED', sensor: 'VV 8K', mount: 'RF / PL' },
  { name: 'RED Komodo-X', brand: 'RED', sensor: 'Super 35 6K', mount: 'RF' },
  { name: 'Blackmagic URSA Cine 12K', brand: 'Blackmagic', sensor: 'Large Format', mount: 'PL' },
  { name: 'Blackmagic PYXIS 6K', brand: 'Blackmagic', sensor: 'Full Frame', mount: 'L' },
  { name: 'Canon EOS C500 Mark II', brand: 'Canon', sensor: 'Full Frame', mount: 'EF' },
  { name: 'Canon EOS C400', brand: 'Canon', sensor: 'Full Frame', mount: 'RF' },
  { name: 'Panavision DXL2', brand: 'Panavision', sensor: 'Large Format', mount: 'PV' },
  { name: 'Panavision Millennium DXL', brand: 'Panavision', sensor: 'Large Format', mount: 'PV' },
  { name: 'DJI Ronin 4D 6K', brand: 'DJI', sensor: 'Full Frame', mount: 'DL / E / M / L' },
  { name: 'Kinefinity MAVO Edge 8K', brand: 'Kinefinity', sensor: 'Full Frame', mount: 'KineMOUNT / PL' },
  { name: 'Z CAM E2-F6', brand: 'Z CAM', sensor: 'Full Frame', mount: 'EF / PL' },
  { name: 'Phantom Flex4K', brand: 'Vision Research', sensor: 'Super 35', mount: 'PL' },
  { name: 'Leica SL3-S Cine', brand: 'Leica', sensor: 'Full Frame', mount: 'L' },
  { name: 'Nikon Z9 Cinema Rig', brand: 'Nikon', sensor: 'Full Frame', mount: 'Z' },
];

const LENS_LIBRARY: Lens[] = [
  { name: 'Cooke S4/i 25mm', family: 'Cooke S4/i', mount: 'PL', focal: '25mm' },
  { name: 'Cooke S4/i 32mm', family: 'Cooke S4/i', mount: 'PL', focal: '32mm' },
  { name: 'Cooke S4/i 50mm', family: 'Cooke S4/i', mount: 'PL', focal: '50mm' },
  { name: 'Cooke S4/i 75mm', family: 'Cooke S4/i', mount: 'PL', focal: '75mm' },
  { name: 'Cooke Anamorphic/i 40mm', family: 'Cooke Anamorphic/i', mount: 'PL', focal: '40mm' },
  { name: 'Cooke Anamorphic/i 65mm', family: 'Cooke Anamorphic/i', mount: 'PL', focal: '65mm' },
  { name: 'Zeiss Supreme 35mm', family: 'Zeiss Supreme', mount: 'PL', focal: '35mm' },
  { name: 'Zeiss Supreme 50mm', family: 'Zeiss Supreme', mount: 'PL', focal: '50mm' },
  { name: 'Zeiss Supreme 85mm', family: 'Zeiss Supreme', mount: 'PL', focal: '85mm' },
  { name: 'Zeiss Supreme 135mm', family: 'Zeiss Supreme', mount: 'PL', focal: '135mm' },
  { name: 'ARRI Signature Prime 29mm', family: 'ARRI Signature Prime', mount: 'LPL', focal: '29mm' },
  { name: 'ARRI Signature Prime 35mm', family: 'ARRI Signature Prime', mount: 'LPL', focal: '35mm' },
  { name: 'ARRI Signature Prime 47mm', family: 'ARRI Signature Prime', mount: 'LPL', focal: '47mm' },
  { name: 'ARRI Signature Prime 75mm', family: 'ARRI Signature Prime', mount: 'LPL', focal: '75mm' },
  { name: 'Atlas Orion 40mm', family: 'Atlas Orion', mount: 'PL', focal: '40mm' },
  { name: 'Atlas Orion 65mm', family: 'Atlas Orion', mount: 'PL', focal: '65mm' },
  { name: 'Laowa 24mm Probe', family: 'Laowa Probe', mount: 'PL / EF', focal: '24mm' },
  { name: 'Sigma Cine 24mm', family: 'Sigma Cine', mount: 'PL / EF', focal: '24mm' },
  { name: 'Sigma Cine 35mm', family: 'Sigma Cine', mount: 'PL / EF', focal: '35mm' },
  { name: 'Canon Sumire 50mm', family: 'Canon Sumire', mount: 'PL', focal: '50mm' },
  { name: 'Canon Sumire 85mm', family: 'Canon Sumire', mount: 'PL', focal: '85mm' },
  { name: 'Leitz Summilux-C 35mm', family: 'Leitz Summilux-C', mount: 'PL', focal: '35mm' },
  { name: 'Leitz Summilux-C 50mm', family: 'Leitz Summilux-C', mount: 'PL', focal: '50mm' },
  { name: 'Leitz Summilux-C 75mm', family: 'Leitz Summilux-C', mount: 'PL', focal: '75mm' },
  { name: 'Angenieux Optimo 24-290mm', family: 'Angenieux Optimo', mount: 'PL', focal: '24-290mm' },
  { name: 'Fujinon Premista 28-100mm', family: 'Fujinon Premista', mount: 'PL', focal: '28-100mm' },
  { name: 'Fujinon Premista 80-250mm', family: 'Fujinon Premista', mount: 'PL', focal: '80-250mm' },
  { name: 'DZO Vespid 40mm', family: 'DZO Vespid', mount: 'PL / EF', focal: '40mm' },
  { name: 'DZO Vespid 90mm', family: 'DZO Vespid', mount: 'PL / EF', focal: '90mm' },
  { name: 'Tokina Vista 65mm', family: 'Tokina Vista', mount: 'PL', focal: '65mm' },
];

const LUT_OPTIONS = ['ARRI LogC', 'Sony S-Cinetone', 'RED IPP2', 'Kodak 2383', 'Canon C-Log2'];
const SHUTTER_OPTIONS = ['1/24', '1/48', '1/60', '1/96', '1/125'];
const BODY_BRANDS = ['全部品牌', 'ARRI', 'Sony', 'RED', 'Blackmagic', 'Canon', 'Panavision', 'DJI', 'Kinefinity', 'Z CAM'];
const LENS_FAMILIES = ['全部镜头', 'Cooke S4/i', 'Cooke Anamorphic/i', 'Zeiss Supreme', 'ARRI Signature Prime', 'Atlas Orion', 'Laowa Probe', 'Sigma Cine', 'Canon Sumire', 'Leitz Summilux-C', 'Angenieux Optimo', 'Fujinon Premista', 'DZO Vespid', 'Tokina Vista'];

function safeNumber(value: unknown, fallback: number) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function buildTestId(prefix: string, value: string) {
  return `${prefix}-${value.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export default function CameraCapabilityPanel({ value, onChange }: ToolCapabilityPanelProps) {
  const [cameraQuery, setCameraQuery] = useState('');
  const [lensQuery, setLensQuery] = useState('');
  const [brandFilter, setBrandFilter] = useState('全部品牌');
  const [familyFilter, setFamilyFilter] = useState('全部镜头');
  const focalLength = safeNumber(value.focalLength, 50);
  const aperture = safeNumber(value.aperture, 2.8);
  const focusDistance = safeNumber(value.focusDistance, 2.5);
  const iso = safeNumber(value.iso, 800);
  const cameraBody = String(value.cameraBody ?? CAMERA_BODY_LIBRARY[0].name);
  const lens = String(value.lens ?? LENS_LIBRARY[0].name);
  const shutter = String(value.shutter ?? SHUTTER_OPTIONS[1]);
  const lut = String(value.lut ?? LUT_OPTIONS[0]);

  const filteredBodies = useMemo(() => CAMERA_BODY_LIBRARY.filter((item) => {
    const matchesBrand = brandFilter === '全部品牌' || item.brand === brandFilter;
    const matchesQuery = item.name.toLowerCase().includes(cameraQuery.trim().toLowerCase());
    return matchesBrand && matchesQuery;
  }), [cameraQuery, brandFilter]);

  const filteredLenses = useMemo(() => LENS_LIBRARY.filter((item) => {
    const matchesFamily = familyFilter === '全部镜头' || item.family === familyFilter;
    const matchesQuery = item.name.toLowerCase().includes(lensQuery.trim().toLowerCase());
    return matchesFamily && matchesQuery;
  }), [lensQuery, familyFilter]);

  const currentBody = CAMERA_BODY_LIBRARY.find((item) => item.name === cameraBody) || CAMERA_BODY_LIBRARY[0];
  const currentLens = LENS_LIBRARY.find((item) => item.name === lens) || LENS_LIBRARY[0];
  const bodyCount = CAMERA_BODY_LIBRARY.length;
  const lensCount = LENS_LIBRARY.length;

  function merge(next: Record<string, unknown>) {
    onChange({ ...value, ...next });
  }

  return (
    <div className="mb-4 rounded-xl border border-[#353535] bg-[#242424] p-3">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-[#ededed]"><Camera className="h-4 w-4" />摄像机与镜头库</div>

      <div className="mb-3 grid gap-3 md:grid-cols-2">
        <FilterBlock label="机身搜索">
          <div className="grid gap-2">
            <input value={cameraQuery} onChange={(event) => setCameraQuery(event.target.value)} data-testid="camera-search-body" placeholder="搜索机身型号" className="nodrag nopan nowheel rounded-lg border border-[#303030] bg-[#111] px-3 py-2 text-sm text-[#e8e8e8] outline-none" />
            <select value={brandFilter} onChange={(event) => setBrandFilter(event.target.value)} className="nodrag nopan nowheel rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-[#e6edf3] outline-none">
              {BODY_BRANDS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
        </FilterBlock>
        <FilterBlock label="镜头搜索">
          <div className="grid gap-2">
            <input value={lensQuery} onChange={(event) => setLensQuery(event.target.value)} data-testid="camera-search-lens" placeholder="搜索镜头型号" className="nodrag nopan nowheel rounded-lg border border-[#303030] bg-[#111] px-3 py-2 text-sm text-[#e8e8e8] outline-none" />
            <select value={familyFilter} onChange={(event) => setFamilyFilter(event.target.value)} className="nodrag nopan nowheel rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-[#e6edf3] outline-none">
              {LENS_FAMILIES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
        </FilterBlock>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
        {filteredBodies.map((body) => (
          <button key={body.name} type="button" data-testid={buildTestId('camera-body', body.name)} onClick={() => merge({ cameraBody: body.name })} className={`rounded-lg border px-3 py-2 text-left ${cameraBody === body.name ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}>
            <div className="font-medium">{body.name}</div>
            <div className="mt-1 text-[11px] opacity-70">{body.brand} / {body.sensor} / {body.mount}</div>
          </button>
        ))}
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
        {filteredLenses.map((item) => (
          <button key={item.name} type="button" data-testid={buildTestId('camera-lens', item.name)} onClick={() => merge({ lens: item.name })} className={`rounded-lg border px-3 py-2 text-left ${lens === item.name ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}>
            <span className="flex items-center gap-2"><Search className="h-3.5 w-3.5" />{item.name}</span>
            <div className="mt-1 text-[11px] opacity-70">{item.family} / {item.mount}</div>
          </button>
        ))}
      </div>

      <div className="mb-3 rounded-lg border border-[#404040] bg-[#1c1c1c] p-3 text-xs text-[#b4b4b4]">
        <div className="mb-2 text-sm font-medium text-[#ededed]">当前组合</div>
        <div className="grid gap-2 md:grid-cols-4">
          <Badge label="机身" value={currentBody.name} />
          <Badge label="传感器" value={currentBody.sensor} />
          <Badge label="焦段" value={currentLens.focal} />
          <Badge label="卡口" value={currentLens.mount} />
        </div>
      </div>

      <div className="mb-3 flex items-center justify-between rounded-lg border border-[#404040] bg-[#161616] px-3 py-2 text-xs text-[#b4b4b4]">
        <span>镜头库摘要</span>
        <span data-testid="camera-library-summary">机身 {bodyCount} / 镜头 {lensCount} / 预设 {CAMERA_PRESETS.length}</span>
      </div>

      <div className="grid grid-cols-1 gap-2 text-xs">
        {CAMERA_PRESETS.map((preset) => {
          const selected = String(value.lens) === preset.lens && Number(value.focalLength || 0) === preset.focalLength;
          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => merge(preset)}
              data-testid={`camera-preset-${preset.id}`}
              className={`rounded-lg border px-3 py-2 text-left ${selected ? 'border-[#7b7b7b] bg-[#363636] text-white' : 'border-[#404040] text-[#cbcbcb]'}`}
            >
              <div className="font-medium">{preset.label}</div>
              <div className="mt-1 text-[11px] opacity-80">{preset.cameraBody} / {preset.lens}</div>
              <div className="mt-1 text-[11px] opacity-70">{preset.focalLength}mm / f/{preset.aperture} / ISO {preset.iso}</div>
            </button>
          );
        })}
      </div>

      <div className="mt-4 rounded-lg border border-[#404040] bg-[#1c1c1c] p-3">
        <RangeRow label="焦距" value={`${focalLength}mm`}>
          <input type="range" min={12} max={200} step={1} value={focalLength} onChange={(event) => merge({ focalLength: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="camera-focal-slider" />
        </RangeRow>
        <RangeRow label="光圈" value={`f/${aperture.toFixed(1)}`}>
          <input type="range" min={0.7} max={22} step={0.1} value={aperture} onChange={(event) => merge({ aperture: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="camera-aperture-slider" />
        </RangeRow>
        <RangeRow label="对焦距离" value={`${focusDistance.toFixed(1)}m`}>
          <input type="range" min={0.1} max={20} step={0.1} value={focusDistance} onChange={(event) => merge({ focusDistance: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="camera-focus-slider" />
        </RangeRow>
        <RangeRow label="ISO" value={String(iso)}>
          <input type="range" min={50} max={25600} step={50} value={iso} onChange={(event) => merge({ iso: Number(event.target.value) })} className="nodrag nopan nowheel w-full" data-testid="camera-iso-slider" />
        </RangeRow>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-2 text-xs text-[#b4b4b4]">
            <span>快门</span>
            <select value={shutter} onChange={(event) => merge({ shutter: event.target.value })} className="nodrag nopan nowheel w-full rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[#e6edf3] outline-none" data-testid="camera-shutter-select">
              {SHUTTER_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label className="space-y-2 text-xs text-[#b4b4b4]">
            <span>LUT</span>
            <select value={lut} onChange={(event) => merge({ lut: event.target.value })} className="nodrag nopan nowheel w-full rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[#e6edf3] outline-none" data-testid="camera-lut-select">
              {LUT_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}

function RangeRow({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-2 flex items-center justify-between text-xs text-[#b4b4b4]">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      {children}
    </div>
  );
}

function FilterBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-[#404040] bg-[#1c1c1c] p-3">
      <div className="mb-2 text-xs text-[#b4b4b4]">{label}</div>
      {children}
    </div>
  );
}

function Badge({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#353535] bg-[#131313] px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-[#7d8590]">{label}</div>
      <div className="mt-1 text-xs text-[#ededed]">{value}</div>
    </div>
  );
}

