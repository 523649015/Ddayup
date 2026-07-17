import { useState, useEffect, useRef } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Globe, RotateCcw, ZoomIn, Move } from 'lucide-react';
import { EditableNodeTitle } from './EditableNodeTitle';

export function ThreeDNode(props: NodeProps) {
  const { selected, data } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rotation, setRotation] = useState({ x: 15, y: 45 });
  const [mode, setMode] = useState<'rotate' | 'zoom' | 'pan'>('rotate');
  const isDragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  // Render a simple 3D cube on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const size = 60;
    const cx = w / 2;
    const cy = h / 2;

    // Simple cube vertices
    const vertices = [
      [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    ];

    const radX = (rotation.x * Math.PI) / 180;
    const radY = (rotation.y * Math.PI) / 180;

    // Rotate and project
    const projected = vertices.map(([x, y, z]) => {
      // Rotate around Y
      let nx = x * Math.cos(radY) - z * Math.sin(radY);
      let nz = x * Math.sin(radY) + z * Math.cos(radY);
      let ny = y;
      // Rotate around X
      let ny2 = ny * Math.cos(radX) - nz * Math.sin(radX);
      let nz2 = ny * Math.sin(radX) + nz * Math.cos(radX);
      // Project
      const scale = size / (1 + nz2 * 0.15);
      return [cx + nx * scale, cy + ny2 * scale];
    });

    // Draw edges
    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];

    ctx.strokeStyle = '#00d4aa';
    ctx.lineWidth = 1.5;
    edges.forEach(([a, b]) => {
      ctx.beginPath();
      ctx.moveTo(projected[a][0], projected[a][1]);
      ctx.lineTo(projected[b][0], projected[b][1]);
      ctx.stroke();
    });

    // Draw vertices
    projected.forEach(([x, y]) => {
      ctx.fillStyle = '#00d4aa';
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [rotation]);

  const handleMouseDown = (e: React.MouseEvent) => {
    isDragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };

    if (mode === 'rotate') {
      setRotation((prev) => ({ x: prev.x + dy * 0.5, y: prev.y + dx * 0.5 }));
    }
  };

  const handleMouseUp = () => {
    isDragging.current = false;
  };

  return (
    <div
      className={`rounded-xl transition-all duration-200 relative ${
        selected ? 'ring-2 ring-[#e6edf3]' : 'ring-1 ring-[#2a2a2c]'
      }`}
      style={{ width: 280, background: '#1c1c1e' }}
    >
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
        <EditableNodeTitle nodeId={props.id} icon={Globe} label={data?.label} fallback="3D 世界" />
      </div>

      <div className="px-2 pb-2">
        <div
          className="w-full rounded-lg overflow-hidden bg-[#0d1117] cursor-grab active:cursor-grabbing"
          style={{ aspectRatio: '4/3' }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <canvas
            ref={canvasRef}
            width={260}
            height={180}
            className="w-full h-full"
          />
        </div>

        {/* Controls */}
        <div className="flex items-center justify-center gap-1 mt-1.5">
          <button
            onClick={() => setMode('rotate')}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors ${mode === 'rotate' ? 'bg-[#3a3a3c] text-[#e6edf3]' : 'text-[#8b949e] hover:bg-[#2a2a2c]'}`}
          >
            <RotateCcw className="w-3 h-3" /> 旋转
          </button>
          <button
            onClick={() => setMode('zoom')}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors ${mode === 'zoom' ? 'bg-[#3a3a3c] text-[#e6edf3]' : 'text-[#8b949e] hover:bg-[#2a2a2c]'}`}
          >
            <ZoomIn className="w-3 h-3" /> 缩放
          </button>
          <button
            onClick={() => setMode('pan')}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors ${mode === 'pan' ? 'bg-[#3a3a3c] text-[#e6edf3]' : 'text-[#8b949e] hover:bg-[#2a2a2c]'}`}
          >
            <Move className="w-3 h-3" /> 平移
          </button>
          <span className="text-[#6e7681] text-[10px] ml-1">
            Rotation: {Math.round(rotation.y)}°
          </span>
        </div>

        {selected && (
          <div className="mt-2 px-2 py-1.5 rounded-lg bg-[#161b22] text-[10px] text-[#00d4aa]/70">
            提示：完整3D渲染需要后端 Three.js / WebGL 服务支持
          </div>
        )}
      </div>

      <Handle type="target" position={Position.Left} style={{ width: 18, height: 18, background: '#2a2a2c', border: '1px solid #3a3a3c', borderRadius: '50%', left: -9, top: '50%', marginTop: -9, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 12, color: '#6e7681', fontWeight: 'bold', lineHeight: 1 }}>+</span>
      </Handle>
      <Handle type="source" position={Position.Right} style={{ width: 18, height: 18, background: '#2a2a2c', border: '1px solid #3a3a3c', borderRadius: '50%', right: -9, top: '50%', marginTop: -9, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 12, color: '#6e7681', fontWeight: 'bold', lineHeight: 1 }}>+</span>
      </Handle>
    </div>
  );
}
