import type { ImageGenerationTool } from '@/config/imageToolPresets';

export interface ToolCapabilityPanelProps {
  tool: ImageGenerationTool;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  sourceImageUrl?: string;
  nodeLabel?: string;
  /** 写回当前节点（破坏式） */
  onApply?: (payload: Record<string, unknown>) => Promise<void>;
  /** 生成新图片节点继承效果（非破坏式，推荐） */
  onCreateAsNewNode?: (payload: Record<string, unknown>) => Promise<void>;
  onClose?: () => void;
}
