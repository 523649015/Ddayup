// Self-contained leaf sub-components extracted from AssetLibrary.tsx.
// Moved verbatim — no behavior change.
import { useCallback, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import { prepareFreeImport } from '@/services/freeImageSearchService';
import { useAssetStore } from '@/store/useAssetStore';
import type { AssetFolder, WebSearchResult } from '@/types/assets';

export function InfoItem({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div data-testid={testId} className="rounded-xl border border-[#262626] bg-[#161b22] px-2.5 py-2">
      <div className="text-[10px] text-[#6e7681]">{label}</div>
      <div className="mt-1 text-xs text-[#e6edf3]">{value}</div>
    </div>
  );
}

export function AnalysisField({ label, value }: { label: string; value?: string }) {
  return (
    <div className="rounded-lg border border-[#262626] bg-[#11161d] px-2 py-1.5">
      <div className="text-[10px] text-[#6e7681]">{label}</div>
      <div className="mt-1 text-[11px] leading-5 text-[#e6edf3]">{value || '未识别'}</div>
    </div>
  );
}

export function ContextAction({
  onClick,
  icon,
  label,
  destructive = false,
}: {
  onClick: () => void;
  icon: ReactNode;
  label: string;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
        destructive ? 'text-[#ff8c8c] hover:bg-[#3d2222]/30' : 'text-[#c9d1d9] hover:bg-[#21262d]'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

export function FolderTreeItem({
  folder,
  folders,
  expandedFolders,
  selectedFolderId,
  folderRenameId,
  folderRenameValue,
  onToggleFolder,
  onSelectFolder,
  onStartRename,
  onFolderRenameValue,
  onSaveRename,
  onContextMenu,
  depth = 0,
}: {
  folder: AssetFolder;
  folders: AssetFolder[];
  expandedFolders: Set<string>;
  selectedFolderId: string | null;
  folderRenameId: string | null;
  folderRenameValue: string;
  onToggleFolder: (folderId: string) => void;
  onSelectFolder: (folderId: string) => void;
  onStartRename: (folder: AssetFolder) => void;
  onFolderRenameValue: (value: string) => void;
  onSaveRename: (folderId: string) => void;
  onContextMenu: (event: React.MouseEvent, folderId: string) => void;
  depth?: number;
}) {
  const { collectFromUrl } = useAssetStore();
  const [dropActive, setDropActive] = useState(false);
  const children = folders.filter((entry) => entry.parentId === folder.id);
  const expanded = expandedFolders.has(folder.id);
  const renaming = folderRenameId === folder.id;

  const handleWebResultDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    setDropActive(false);
    const raw = event.dataTransfer.getData('application/json');
    if (!raw) return;
    try {
      const payload = JSON.parse(raw) as { type?: string; result?: WebSearchResult };
      if (payload.type !== 'web-search-result' || !payload.result?.url) return;
      const result = payload.result;
      const prepared = await prepareFreeImport(result, []);
      await collectFromUrl(result.url, {
        folderId: folder.id,
        type: result.type,
        source: 'web',
        title: result.title,
        tags: prepared.tags,
        smartCategories: prepared.smartCategories,
      });
    } catch {
      /* 忽略非法拖拽数据 */
    }
  }, [collectFromUrl, folder.id]);

  return (
    <div
      onContextMenu={(event) => onContextMenu(event, folder.id)}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('application/json')) {
          event.preventDefault();
          setDropActive(true);
        }
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={handleWebResultDrop}
      className={dropActive ? 'rounded-lg ring-1 ring-[#00d4aa] bg-[#00d4aa]/5' : ''}
    >
      <div
        onClick={() => onSelectFolder(folder.id)}
        onDoubleClick={() => onStartRename(folder)}
        className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition-colors ${
          selectedFolderId === folder.id ? 'bg-[#00d4aa]/10 text-[#00d4aa]' : 'text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]'
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleFolder(folder.id);
            }}
            className="flex h-4 w-4 items-center justify-center"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="block h-4 w-4 shrink-0" />
        )}
        <Folder className="h-3.5 w-3.5 shrink-0" />
        {renaming ? (
          <input
            value={folderRenameValue}
            onChange={(event) => onFolderRenameValue(event.target.value)}
            onBlur={() => onSaveRename(folder.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSaveRename(folder.id);
              if (event.key === 'Escape') onSaveRename(folder.id);
            }}
            autoFocus
            className="min-w-0 flex-1 rounded border border-[#00d4aa] bg-[#0d1117] px-1.5 py-0.5 text-xs text-[#e6edf3] outline-none"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
        )}
      </div>

      {expanded ? children.map((child) => (
        <FolderTreeItem
          key={child.id}
          folder={child}
          folders={folders}
          expandedFolders={expandedFolders}
          selectedFolderId={selectedFolderId}
          folderRenameId={folderRenameId}
          folderRenameValue={folderRenameValue}
          onToggleFolder={onToggleFolder}
          onSelectFolder={onSelectFolder}
          onStartRename={onStartRename}
          onFolderRenameValue={onFolderRenameValue}
          onSaveRename={onSaveRename}
          onContextMenu={onContextMenu}
          depth={depth + 1}
        />
      )) : null}
    </div>
  );
}

