import { useCallback, useMemo, useState } from 'react';

type DraftConfig = Record<string, unknown>;
type DraftState<Tool extends string> = Partial<Record<Tool, DraftConfig | null>>;

type PanelOpenState = boolean | ((open: boolean) => boolean);

type UseFloatingDraftEditorsOptions<
  Tool extends string,
  PanelKind extends string,
  Snapshot extends Record<string, unknown>,
  ActiveTool extends string = Tool,
> = {
  tools: readonly Tool[];
  currentTool: ActiveTool | null;
  setCurrentTool: (tool: ActiveTool | null) => void;
  buildToolConfig: (tool: Tool, seed?: DraftConfig) => DraftConfig;
  persistToolConfig: (tool: Tool, config: DraftConfig) => void;
  panelKindByTool: Record<Tool, PanelKind>;
  setPanelOpen: (kind: PanelKind, next: PanelOpenState) => void;
  isPanelOpen: (kind: PanelKind) => boolean;
  rememberSnapshot: () => void;
  restoreSnapshot: () => Snapshot | null;
  clearSnapshot: () => void;
  getToolFromSnapshot: (snapshot: Snapshot | null) => ActiveTool | null;
  onBeginEdit?: (tool: Tool, config: DraftConfig) => void;
  onCancelEdit?: (tool: Tool) => void;
  onCompleteEdit?: (tool: Tool, config: DraftConfig | null) => void;
};

function createEmptyDraftState<Tool extends string>(tools: readonly Tool[]) {
  const next = {} as DraftState<Tool>;
  for (const tool of tools) {
    next[tool] = null;
  }
  return next;
}

export function useFloatingDraftEditors<
  Tool extends string,
  PanelKind extends string,
  Snapshot extends Record<string, unknown>,
  ActiveTool extends string = Tool,
>(
  options: UseFloatingDraftEditorsOptions<Tool, PanelKind, Snapshot, ActiveTool>,
) {
  const {
    tools,
    currentTool,
    setCurrentTool,
    buildToolConfig,
    persistToolConfig,
    panelKindByTool,
    setPanelOpen,
    isPanelOpen,
    rememberSnapshot,
    restoreSnapshot,
    clearSnapshot,
    getToolFromSnapshot,
    onBeginEdit,
    onCancelEdit,
    onCompleteEdit,
  } = options;

  const [drafts, setDrafts] = useState<DraftState<Tool>>(() => createEmptyDraftState(tools));

  const clearDrafts = useCallback(() => {
    setDrafts(createEmptyDraftState(tools));
  }, [tools]);

  const setExclusiveDraft = useCallback((tool: Tool, config: DraftConfig) => {
    setDrafts(() => {
      const next = createEmptyDraftState(tools);
      next[tool] = config;
      return next;
    });
  }, [tools]);

  const getDraft = useCallback((tool: Tool) => drafts[tool] || null, [drafts]);

  const activeDraftTool = useMemo(
    () => tools.find((tool) => Boolean(drafts[tool])) || null,
    [drafts, tools],
  );

  const hasAnyDraft = Boolean(activeDraftTool);

  const openExclusivePanel = useCallback((tool: Tool) => {
    const targetKind = panelKindByTool[tool];
    const panelKinds = Array.from(new Set(tools.map((entry) => panelKindByTool[entry])));
    for (const kind of panelKinds) {
      setPanelOpen(kind, kind === targetKind);
    }
  }, [panelKindByTool, setPanelOpen, tools]);

  const beginEdit = useCallback((tool: Tool, seed?: DraftConfig) => {
    const nextConfig = buildToolConfig(tool, seed);
    rememberSnapshot();
    setCurrentTool(tool as unknown as ActiveTool);
    setExclusiveDraft(tool, nextConfig);
    openExclusivePanel(tool);
    persistToolConfig(tool, nextConfig);
    onBeginEdit?.(tool, nextConfig);
    return nextConfig;
  }, [buildToolConfig, onBeginEdit, openExclusivePanel, persistToolConfig, rememberSnapshot, setCurrentTool, setExclusiveDraft]);

  const updateDraft = useCallback((tool: Tool, patch: DraftConfig) => {
    const base = getDraft(tool) || buildToolConfig(tool);
    const nextConfig = { ...base, ...patch };
    rememberSnapshot();
    setCurrentTool(tool as unknown as ActiveTool);
    setExclusiveDraft(tool, nextConfig);
    openExclusivePanel(tool);
    persistToolConfig(tool, nextConfig);
    return nextConfig;
  }, [buildToolConfig, getDraft, openExclusivePanel, persistToolConfig, rememberSnapshot, setCurrentTool, setExclusiveDraft]);

  const cancelEdit = useCallback((tool: Tool) => {
    onCancelEdit?.(tool);
    setPanelOpen(panelKindByTool[tool], false);
    clearDrafts();
    const snapshot = restoreSnapshot();
    const previousTool = getToolFromSnapshot(snapshot);
    setCurrentTool(previousTool);
    return previousTool;
  }, [clearDrafts, getToolFromSnapshot, onCancelEdit, panelKindByTool, restoreSnapshot, setCurrentTool, setPanelOpen]);

  const completeEdit = useCallback((tool: Tool, nextTool: ActiveTool | null = tool as unknown as ActiveTool) => {
    const nextConfig = getDraft(tool);
    onCompleteEdit?.(tool, nextConfig);
    setPanelOpen(panelKindByTool[tool], false);
    clearDrafts();
    clearSnapshot();
    setCurrentTool(nextTool);
    return nextConfig;
  }, [clearDrafts, clearSnapshot, getDraft, onCompleteEdit, panelKindByTool, setCurrentTool, setPanelOpen]);

  const syncDismissedEditors = useCallback(() => {
    if (!hasAnyDraft || !activeDraftTool) return null;
    const isAnyEditingPanelOpen = tools.some((tool) => Boolean(drafts[tool]) && isPanelOpen(panelKindByTool[tool]));
    if (isAnyEditingPanelOpen) return null;
    onCancelEdit?.(activeDraftTool);
    clearDrafts();
    const snapshot = restoreSnapshot();
    const previousTool = getToolFromSnapshot(snapshot);
    if (currentTool && activeDraftTool && String(currentTool) === String(activeDraftTool)) {
      setCurrentTool(previousTool);
    }
    return previousTool;
  }, [
    activeDraftTool,
    clearDrafts,
    currentTool,
    drafts,
    getToolFromSnapshot,
    hasAnyDraft,
    isPanelOpen,
    onCancelEdit,
    panelKindByTool,
    restoreSnapshot,
    setCurrentTool,
    tools,
  ]);

  return {
    drafts,
    getDraft,
    activeDraftTool,
    hasAnyDraft,
    beginEdit,
    updateDraft,
    cancelEdit,
    completeEdit,
    clearDrafts,
    syncDismissedEditors,
  };
}
