// 本地托管运行时：路径解析 + 版本回滚（P3-9）+ 旧版本/临时产物清理（P3-3）
// 独立轻量模块，避免测试时拉起整个 hmdao-api.mjs 重型服务模块。
// 重依赖（清单持久化、探测缓存清理）通过 configureRuntimeRollback 注入，默认 no-op。
import path from 'node:path';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';

let CONFIG = {
  managedRuntimeDir: '',
  installableRuntimeKeys: new Set(),
  // async (runtimeKey, entry) => void
  persistEntry: null,
  // () => void
  clearCache: null,
};

export function configureRuntimeRollback(opts = {}) {
  if (opts.managedRuntimeDir != null) CONFIG.managedRuntimeDir = String(opts.managedRuntimeDir || '');
  if (opts.installableRuntimeKeys != null) {
    CONFIG.installableRuntimeKeys = new Set(Array.isArray(opts.installableRuntimeKeys) ? opts.installableRuntimeKeys : []);
  }
  if (opts.persistEntry != null) CONFIG.persistEntry = opts.persistEntry;
  if (opts.clearCache != null) CONFIG.clearCache = opts.clearCache;
}

export function buildManagedRuntimePaths(runtimeKey, customRootDir = '') {
  const rootDir = customRootDir ? path.resolve(customRootDir) : path.join(CONFIG.managedRuntimeDir, runtimeKey);
  return {
    rootDir,
    currentDir: path.join(rootDir, 'current'),
    stagingDir: path.join(rootDir, 'staging'),
    downloadDir: path.join(CONFIG.managedRuntimeDir, 'downloads', runtimeKey),
  };
}

// P3-2：仅保留最新 1 个 .bak 回滚点（或 keepDir 指定的那一个）。
export function pruneOldBakBackups(resolvedTargetDir, keepDir = '') {
  const parent = path.dirname(resolvedTargetDir);
  if (!fs.existsSync(parent)) return 0;
  const resolvedKeep = keepDir ? path.resolve(keepDir) : '';
  const prefix = `${path.basename(resolvedTargetDir)}.bak-`;
  const bakDirs = fs.readdirSync(parent)
    .filter((d) => d.startsWith(prefix) && fs.statSync(path.join(parent, d)).isDirectory())
    .sort();
  for (let i = 0; i < bakDirs.length; i += 1) {
    const isLast = i === bakDirs.length - 1;
    if (resolvedKeep) {
      if (path.resolve(parent, bakDirs[i]) === resolvedKeep) continue;
    } else if (isLast) {
      continue; // 默认保留最新 1 个
    }
    try { fs.rmSync(path.join(parent, bakDirs[i]), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return bakDirs.length;
}

export function listManagedLocalPostBackups(runtimeKey, { customRootDir } = {}) {
  if (!CONFIG.installableRuntimeKeys.has(runtimeKey)) {
    throw new Error(`unsupported-runtime:${runtimeKey}`);
  }
  const layout = buildManagedRuntimePaths(runtimeKey, customRootDir || '');
  const parent = path.dirname(layout.currentDir);
  if (!fs.existsSync(parent)) return [];
  const prefix = `${path.basename(layout.currentDir)}.bak-`;
  const walkSize = (dir) => {
    let total = 0;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += walkSize(full);
        else if (entry.isFile()) { try { total += fs.statSync(full).size; } catch { /* ignore */ } }
      }
    } catch { /* ignore */ }
    return total;
  };
  return fs.readdirSync(parent)
    .filter((d) => d.startsWith(prefix))
    .sort()
    .map((dir) => {
      const full = path.join(parent, dir);
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(full, '.hmdao-runtime-meta.json'), 'utf8'));
      } catch { /* no meta sidecar */ }
      return {
        id: dir.slice(prefix.length),
        dir: full,
        version: meta?.installedVersion || null,
        runtimeName: meta?.runtimeName || null,
        sourceLabel: meta?.sourceLabel || null,
        createdAt: meta?.installedAt || null,
        sizeBytes: walkSize(full),
      };
    });
}

export async function rollbackManagedLocalPostRuntime(runtimeKey, { backupId, customRootDir } = {}) {
  if (!CONFIG.installableRuntimeKeys.has(runtimeKey)) {
    throw new Error(`unsupported-runtime:${runtimeKey}`);
  }
  const layout = buildManagedRuntimePaths(runtimeKey, customRootDir || '');
  const parent = path.dirname(layout.currentDir);
  const prefix = `${path.basename(layout.currentDir)}.bak-`;
  let rawEntries = [];
  try { rawEntries = fs.readdirSync(parent); } catch { rawEntries = []; }
  const backups = rawEntries
    .filter((d) => d.startsWith(prefix))
    .sort();
  if (backups.length === 0) {
    const err = new Error('no-backup-available-for-rollback');
    err.code = 'NO_BACKUP_AVAILABLE_FOR_ROLLBACK';
    throw err;
  }
  let target = backups[backups.length - 1];
  if (backupId != null) {
    const hit = backups.find((d) => d === `${prefix}${backupId}` || d.slice(prefix.length === 0 ? 0 : prefix.length) === String(backupId));
    if (!hit) {
      const err = new Error(`backup-not-found:${backupId}`);
      err.code = 'BACKUP_NOT_FOUND';
      throw err;
    }
    target = hit;
  }
  const targetDir = path.join(parent, target);
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(targetDir, '.hmdao-runtime-meta.json'), 'utf8'));
  } catch { /* best-effort */ }

  // 原子交换：先保存当前版本为新备份点，再把回滚目标提升为 current。
  const tmpBak = `${layout.currentDir}.bak-${Date.now()}`;
  const hadCurrent = fs.existsSync(layout.currentDir);
  if (hadCurrent) await fsp.rename(layout.currentDir, tmpBak);
  await fsp.rename(targetDir, layout.currentDir);
  // 保持「仅留 1 个备份」不变量（最新的是刚被替换下来的当前版本）。
  pruneOldBakBackups(layout.currentDir);

  if (meta && typeof CONFIG.persistEntry === 'function') {
    await CONFIG.persistEntry(runtimeKey, {
      runtimeKey,
      runtimeName: meta.runtimeName || runtimeKey,
      sourceLabel: meta.sourceLabel || '',
      version: meta.installedVersion || '',
      executablePath: path.resolve(layout.currentDir, path.basename(meta.executablePath || layout.currentDir)),
      configPath: meta.configPath || '',
      configVersion: meta.configVersion || '',
      installedAt: new Date().toISOString(),
      releaseUrl: meta.releaseUrl || '',
      downloadUrl: meta.downloadUrl || '',
      rootDir: meta.rootDir || layout.rootDir,
    });
  }
  if (typeof CONFIG.clearCache === 'function') CONFIG.clearCache();
  return {
    ok: true,
    runtimeKey,
    rolledBackTo: String(backupId != null ? backupId : target.slice(prefix.length)),
    version: meta?.installedVersion || null,
  };
}

export function cleanupManagedLocalPostRuntimeTemp(runtimeKey, { removeBackups = false, customRootDir } = {}) {
  if (!CONFIG.installableRuntimeKeys.has(runtimeKey)) {
    throw new Error(`unsupported-runtime:${runtimeKey}`);
  }
  const layout = buildManagedRuntimePaths(runtimeKey, customRootDir || '');
  const removed = [];
  if (fs.existsSync(layout.stagingDir)) {
    fs.rmSync(layout.stagingDir, { recursive: true, force: true });
    removed.push(layout.stagingDir);
  }
  if (fs.existsSync(layout.downloadDir)) {
    fs.rmSync(layout.downloadDir, { recursive: true, force: true });
    removed.push(layout.downloadDir);
  }
  let backupsRemoved = 0;
  if (removeBackups) {
    const parent = path.dirname(layout.currentDir);
    const prefix = `${path.basename(layout.currentDir)}.bak-`;
    for (const d of fs.readdirSync(parent).filter((x) => x.startsWith(prefix))) {
      fs.rmSync(path.join(parent, d), { recursive: true, force: true });
      removed.push(path.join(parent, d));
      backupsRemoved += 1;
    }
  }
  return { ok: true, runtimeKey, removed, backupsRemoved };
}
