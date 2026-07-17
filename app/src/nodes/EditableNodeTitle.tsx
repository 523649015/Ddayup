import { type ComponentType, type KeyboardEvent, useEffect, useState } from 'react';
import type { LucideProps } from 'lucide-react';
import { sanitizeDccVisibleText } from '@/services/dcc/runtimeState';
import { useCanvasStore } from '@/store/useCanvasStore';

const BROKEN_NODE_LABEL_RE = /\uFFFD|\?{2,}|ï¿½|[闂闁婵濠缂鐘鍙]|鎻掍欢|鏋勫浘|涓讳綋|鎹曡幏/;
const BROKEN_NODE_LABEL_HINTS = new Set(['闂', '闁', '婵', '濠', '缂', '鐘', '鍙', '鎻', '掍', '欢', '鏋', '勫', '浘', '涓', '讳', '綋', '鎹', '曡', '幏']);

function isBrokenNodeLabel(value: string) {
  if (!value) return false;
  if (BROKEN_NODE_LABEL_RE.test(value)) return true;
  const suspiciousCount = [...value].reduce((count, char) => count + (BROKEN_NODE_LABEL_HINTS.has(char) ? 1 : 0), 0);
  return value.length <= 32 && suspiciousCount >= 2;
}

function sanitizeNodeTitle(label: unknown, fallback: string) {
  const rawLabel = String(label || '').trim();
  if (!rawLabel) return fallback;
  const visible = sanitizeDccVisibleText(rawLabel, fallback).trim();
  if (visible && visible !== fallback) return visible;
  return isBrokenNodeLabel(rawLabel) ? fallback : rawLabel;
}

export function EditableNodeTitle({
  nodeId,
  icon: Icon,
  label,
  fallback,
  className = '',
}: {
  nodeId: string;
  icon: ComponentType<LucideProps>;
  label?: unknown;
  fallback: string;
  className?: string;
}) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const currentLabel = sanitizeNodeTitle(label, fallback);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentLabel);

  useEffect(() => {
    if (!editing) setDraft(currentLabel);
  }, [currentLabel, editing]);

  function commit() {
    const next = sanitizeNodeTitle(draft, fallback);
    updateNodeData(nodeId, { label: next });
    setDraft(next);
    setEditing(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.key === 'Enter') commit();
    if (event.key === 'Escape') {
      setDraft(currentLabel);
      setEditing(false);
    }
  }

  return (
    <div className={`flex items-center gap-1.5 text-[13px] text-[#a3a3a3] ${className}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {editing ? (
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          onClick={(event) => event.stopPropagation()}
          autoFocus
          className="nodrag w-[150px] rounded border border-[#555] bg-[#1f1f1f] px-1.5 py-0.5 text-xs text-[#e8e8e8] outline-none focus:border-[#9a9a9a]"
          aria-label="重命名节点标题"
        />
      ) : (
        <button
          type="button"
          onDoubleClick={(event) => {
            event.stopPropagation();
            setDraft(currentLabel);
            setEditing(true);
          }}
          onClick={(event) => event.stopPropagation()}
          title="双击重命名"
          className="nodrag max-w-[180px] truncate rounded px-0.5 text-left hover:bg-[#2d2d2d] hover:text-[#e8e8e8]"
        >
          {currentLabel}
        </button>
      )}
    </div>
  );
}
