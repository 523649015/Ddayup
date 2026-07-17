import type { ImageGenerationTool } from '@/config/imageToolPresets';

export interface ToolCapabilityPanelProps {
  tool: ImageGenerationTool;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  sourceImageUrl?: string;
  nodeLabel?: string;
  onApply?: (payload: Record<string, unknown>) => Promise<void>;
  onClose?: () => void;
}
