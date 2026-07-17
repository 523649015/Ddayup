import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

export const UNREAL_PLUGIN_NAME = 'HMDaoUnrealCapture';
export const UNREAL_PLUGIN_FRIENDLY_NAME = 'HMDao Unreal Capture';
export const BLENDER_PLUGIN_NAME = 'hmdao_blender_capture';
export const BLENDER_PLUGIN_FRIENDLY_NAME = 'HMDao Blender Capture';
export const WINDOWS_POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export function nowIso() {
  return new Date().toISOString();
}

export function slugify(value, fallback = 'item') {
  return String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || fallback;
}

export async function pathExists(targetPath) {
  if (!targetPath) return false;
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function probeTcp(port, host = '127.0.0.1', timeoutMs = 1200) {
  return await new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export function extractFirstMatch(text, regex) {
  const match = String(text || '').match(regex);
  return match?.[1] || '';
}

export function hasNonAsciiText(value) {
  return /[^\u0000-\u007f]/.test(String(value || ''));
}

export function quotePowerShellLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

export function formatPowerShellArgument(value) {
  const text = String(value ?? '');
  return /^-[A-Za-z][A-Za-z0-9-]*$/.test(text) ? text : quotePowerShellLiteral(text);
}

export async function runPowerShellInline(scriptText, options = {}) {
  const utf8Script = [
    'try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
    'try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
    scriptText,
  ].join('; ');
  const windowsHide = options.windowsHide !== undefined ? Boolean(options.windowsHide) : true;
  const timeoutMs = Number(options.timeoutMs || 0);
  return await new Promise((resolve) => {
    const child = spawn(WINDOWS_POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', utf8Script], {
      windowsHide,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish({
          ok: false,
          code: -1,
          stdout,
          stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim(),
        });
      }, timeoutMs)
      : null;
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish({ ok: false, code: -1, stdout, stderr: `${stderr}\n${error.message}`.trim() }));
    child.on('close', (code) => finish({ ok: code === 0, code: Number(code || 0), stdout, stderr }));
  });
}

export async function runPowerShellFile(scriptPath, args = []) {
  return await new Promise((resolve) => {
    const scriptInvocation = [
      `& ${quotePowerShellLiteral(scriptPath)}`,
      ...args.map((arg) => formatPowerShellArgument(arg)),
    ].join(' ');
    const command = [
      'try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
      'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
      'try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
      scriptInvocation,
      'if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }',
    ].join('; ');
    const child = spawn(WINDOWS_POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${error.message}`.trim() }));
    child.on('close', (code) => resolve({ ok: code === 0, code: Number(code || 0), stdout, stderr }));
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

export async function waitForCondition(checker, { timeoutMs = 30000, intervalMs = 1000 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await checker()) return true;
    await sleep(intervalMs);
  }
  return false;
}

export async function launchWindowsProcess(command, args = [], options = {}) {
  const cwd = options.cwd || path.dirname(command);
  const windowsHide = options.windowsHide !== undefined ? Boolean(options.windowsHide) : true;
  const detached = options.detached !== undefined ? Boolean(options.detached) : true;
  const stdio = options.stdio || 'ignore';
  return await new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        cwd,
        detached,
        windowsHide,
        stdio,
      });
      child.once('error', (error) => resolve({
        ok: false,
        pid: 0,
        error: error instanceof Error ? error.message : String(error || 'launch failed'),
      }));
      child.once('spawn', () => {
        if (detached) child.unref();
        resolve({
          ok: true,
          pid: Number(child.pid || 0),
        });
      });
    } catch (error) {
      resolve({
        ok: false,
        pid: 0,
        error: error instanceof Error ? error.message : String(error || 'launch failed'),
      });
    }
  });
}

export async function launchWindowsProcessViaStartProcess(command, args = [], options = {}) {
  const cwd = options.cwd || path.dirname(command);
  const windowsHide = options.windowsHide !== undefined ? Boolean(options.windowsHide) : true;
  const commandName = path.basename(String(command || '')).toLowerCase();
  if (options.allowBackgroundLaunch === false || commandName === 'unrealeditor.exe') {
    return {
      ok: false,
      pid: 0,
      error: 'background launch disabled',
    };
  }
  const windowStyle = windowsHide ? 'Hidden' : 'Normal';
  const argumentList = Array.isArray(args) ? args : [];
  const script = [
    `$filePath = ${quotePowerShellLiteral(command)}`,
    `$workingDirectory = ${quotePowerShellLiteral(cwd)}`,
    `$argumentList = @(${argumentList.map((item) => quotePowerShellLiteral(item)).join(', ')})`,
    `$process = Start-Process -FilePath $filePath -ArgumentList $argumentList -WorkingDirectory $workingDirectory -WindowStyle ${windowStyle} -PassThru`,
    'if (-not $process) { throw "Start-Process did not return a process handle." }',
    '$process.Id',
  ].join('; ');
  const result = await runPowerShellInline(script, {
    windowsHide,
  });
  if (!result.ok) {
    return {
      ok: false,
      pid: 0,
      error: result.stderr || result.stdout || 'launch failed',
    };
  }
  const pid = Number(String(result.stdout || '').trim().split(/\r?\n/g).at(-1) || 0);
  if (!Number.isFinite(pid) || pid <= 0) {
    return {
      ok: false,
      pid: 0,
      error: `Start-Process returned an invalid pid. stdout=${String(result.stdout || '').trim()}`,
    };
  }
  return {
    ok: true,
    pid,
  };
}

export async function isWindowsProcessAlive(pid) {
  const resolvedPid = Number(pid || 0);
  if (!resolvedPid) return false;
  try {
    process.kill(resolvedPid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopWindowsProcessTree(pid) {
  const resolvedPid = Number(pid || 0);
  if (!resolvedPid) return { ok: false, code: -1, stdout: '', stderr: 'invalid pid' };
  return await new Promise((resolve) => {
    const command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const child = spawn(command, ['/PID', String(resolvedPid), '/T', '/F'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${error.message}`.trim() }));
    child.on('close', (code) => resolve({ ok: code === 0, code: Number(code || 0), stdout, stderr }));
  });
}

export async function discoverRunningProcessCommandLines(processNamePattern) {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$pattern = '${String(processNamePattern || '').replace(/'/g, "''")}'`,
    '$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -match $pattern } | Select-Object -ExpandProperty CommandLine',
    '$items | ForEach-Object { $_ }',
  ].join('; ');
  const result = await runPowerShellInline(script, { timeoutMs: 5000 });
  if (!result.ok) return [];
  return result.stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function discoverRunningProcesses(processNamePattern) {
  const cimScript = [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$pattern = '${String(processNamePattern || '').replace(/'/g, "''")}'`,
    '$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -match $pattern } | Select-Object ProcessId, Name, ExecutablePath, CommandLine, CreationDate',
    '$items | ConvertTo-Json -Depth 3 -Compress',
  ].join('; ');
  const cimResult = await runPowerShellInline(cimScript, { timeoutMs: 5000 });
  if (cimResult.ok && String(cimResult.stdout || '').trim()) {
    try {
      const parsed = JSON.parse(cimResult.stdout);
      const values = Array.isArray(parsed) ? parsed : [parsed];
      const processes = values
        .map((item) => ({
          pid: Number(item?.ProcessId || 0),
          processName: String(item?.Name || '').trim(),
          path: String(item?.ExecutablePath || '').trim(),
          commandLine: String(item?.CommandLine || '').trim(),
          startedAt: String(item?.CreationDate || '').trim(),
          mainWindowHandle: 0,
          mainWindowTitle: '',
          responding: null,
          source: 'cim',
        }))
        .filter((item) => item.pid > 0);
      if (processes.length) {
        const [windows, fallbackProcesses] = await Promise.all([
          discoverWindowsForProcessIds(processes.map((item) => item.pid)),
          discoverRunningProcessesViaGetProcess(processNamePattern),
        ]);
        const windowsByPid = new Map(windows.map((item) => [Number(item?.pid || 0), item]));
        const fallbackByPid = new Map(fallbackProcesses.map((item) => [Number(item?.pid || 0), item]));
        return processes.map((item) => {
          const windowInfo = windowsByPid.get(item.pid);
          const fallbackInfo = fallbackByPid.get(item.pid);
          if (!windowInfo && !fallbackInfo) return item;
          return {
            ...item,
            path: item.path || fallbackInfo?.path || '',
            mainWindowHandle: Number(windowInfo?.mainWindowHandle || fallbackInfo?.mainWindowHandle || 0),
            mainWindowTitle: String(windowInfo?.mainWindowTitle || fallbackInfo?.mainWindowTitle || '').trim(),
            responding: typeof windowInfo?.responding === 'boolean'
              ? windowInfo.responding
              : (typeof fallbackInfo?.responding === 'boolean' ? fallbackInfo.responding : item.responding),
            source: windowInfo
              ? 'cim+window-probe'
              : fallbackInfo
                ? 'cim+get-process'
                : item.source,
          };
        });
      }
    } catch {
      
    }
  }

  return await discoverRunningProcessesViaGetProcess(processNamePattern);
}

async function discoverRunningProcessesViaGetProcess(processNamePattern) {
  const fallbackScript = [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$pattern = '${String(processNamePattern || '').replace(/'/g, "''")}'`,
    '$items = Get-Process | Where-Object { $_.ProcessName -match $pattern } | Select-Object Id, ProcessName, Path, StartTime, MainWindowHandle, MainWindowTitle, Responding',
    '$items | ConvertTo-Json -Depth 3 -Compress',
  ].join('; ');
  const fallbackResult = await runPowerShellInline(fallbackScript, { timeoutMs: 5000 });
  if (!fallbackResult.ok || !String(fallbackResult.stdout || '').trim()) return [];
  try {
    const parsed = JSON.parse(fallbackResult.stdout);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values
      .map((item) => ({
        pid: Number(item?.Id || 0),
        processName: String(item?.ProcessName || '').trim(),
        path: String(item?.Path || '').trim(),
        commandLine: '',
        startedAt: String(item?.StartTime || '').trim(),
        mainWindowHandle: Number(item?.MainWindowHandle || 0),
        mainWindowTitle: String(item?.MainWindowTitle || '').trim(),
        responding: typeof item?.Responding === 'boolean' ? item.Responding : null,
        source: 'get-process',
      }))
      .filter((item) => item.pid > 0);
  } catch {
    return [];
  }
}

export async function discoverWindowsForProcessIds(processIds = []) {
  const ids = Array.isArray(processIds)
    ? processIds.map((value) => Number(value || 0)).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  if (!ids.length) return [];

  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$source = @"',
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'namespace HMDaoWindowProbe {',
    '  public static class Probe {',
    '    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
    '    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);',
    '    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
    '    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);',
    '    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);',
    '    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);',
    '  }',
    '}',
    '"@',
    'try { Add-Type -TypeDefinition $source -ErrorAction Stop | Out-Null } catch {}',
    `$targetIds = @(${ids.join(', ')})`,
    '$results = New-Object System.Collections.Generic.List[object]',
    '[HMDaoWindowProbe.Probe]::EnumWindows({',
    '  param($hWnd, $lParam)',
    '  [uint32]$windowPid = 0',
    '  [void][HMDaoWindowProbe.Probe]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)',
    '  if ($targetIds -notcontains [int]$windowPid) { return $true }',
    '  $titleBuilder = New-Object System.Text.StringBuilder 512',
    '  [void][HMDaoWindowProbe.Probe]::GetWindowText($hWnd, $titleBuilder, $titleBuilder.Capacity)',
    '  $classBuilder = New-Object System.Text.StringBuilder 256',
    '  [void][HMDaoWindowProbe.Probe]::GetClassName($hWnd, $classBuilder, $classBuilder.Capacity)',
    '  $results.Add([pscustomobject]@{',
    '    processId = [int]$windowPid',
    '    mainWindowHandle = [int64]$hWnd',
    '    visible = [bool][HMDaoWindowProbe.Probe]::IsWindowVisible($hWnd)',
    '    className = $classBuilder.ToString()',
    '    title = $titleBuilder.ToString()',
    '  }) | Out-Null',
    '  return $true',
    '}, [IntPtr]::Zero) | Out-Null',
    '$results | ConvertTo-Json -Depth 4 -Compress',
  ].join('\n');

  const result = await runPowerShellInline(script, { timeoutMs: 5000 });
  if (!result.ok || !String(result.stdout || '').trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.map((item) => ({
      pid: Number(item?.processId || 0),
      mainWindowHandle: Number(item?.mainWindowHandle || 0),
      visible: Boolean(item?.visible),
      className: String(item?.className || '').trim(),
      mainWindowTitle: String(item?.title || '').trim(),
      responding: null,
    }));
  } catch {
    return [];
  }
}

export function parseWindowsJsonDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const direct = Date.parse(raw);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const match = raw.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//i);
  if (!match) return 0;
  return Number(match[1] || 0) || 0;
}

export function extractExecutableFromCommandLine(commandLine) {
  const raw = String(commandLine || '').trim();
  if (!raw) return '';
  const quoted = extractFirstMatch(raw, /^"([A-Za-z]:\\[^"]+?\.exe)"/i);
  if (quoted) return quoted;
  return extractFirstMatch(raw, /^([A-Za-z]:\\[^\s]+?\.exe)/i);
}

export async function discoverRunningProcessExecutables(processNamePattern) {
  const commandLines = await discoverRunningProcessCommandLines(processNamePattern);
  return resolveUniqueItems(
    commandLines
      .map((line) => extractExecutableFromCommandLine(line))
      .filter(Boolean),
    (item) => path.normalize(item).toLowerCase(),
  );
}

export function resolveUniqueItems(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key || map.has(key)) continue;
    map.set(key, item);
  }
  return Array.from(map.values());
}

export function compareVersionLabel(left, right) {
  const l = extractFirstMatch(left, /(\d+(?:\.\d+)+)/);
  const r = extractFirstMatch(right, /(\d+(?:\.\d+)+)/);
  if (!l && !r) return String(right || '').localeCompare(String(left || ''));
  if (!l) return 1;
  if (!r) return -1;
  const lv = l.split('.').map((part) => Number(part));
  const rv = r.split('.').map((part) => Number(part));
  const max = Math.max(lv.length, rv.length);
  for (let index = 0; index < max; index += 1) {
    const diff = (rv[index] || 0) - (lv[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function listDirectories(rootPath, matcher = () => true) {
  if (!await pathExists(rootPath)) return [];
  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && matcher(entry.name))
    .map((entry) => path.join(rootPath, entry.name));
}

export async function listFiles(rootPath, matcher = () => true) {
  if (!await pathExists(rootPath)) return [];
  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && matcher(entry.name))
    .map((entry) => path.join(rootPath, entry.name));
}

export async function readBuildVersion(engineRoot) {
  const buildVersionPath = path.join(engineRoot, 'Engine', 'Build', 'Build.version');
  const payload = await readJsonFile(buildVersionPath, null);
  if (!payload) return '';
  const major = Number(payload.MajorVersion || 0);
  const minor = Number(payload.MinorVersion || 0);
  return major > 0 ? `UE ${major}.${minor}` : '';
}

export async function discoverUnrealEngineInstalls() {
  const candidates = [];
  const runningExecutables = await discoverRunningProcessExecutables('^UnrealEditor');
  for (const executablePath of runningExecutables) {
    const engineRoot = path.resolve(executablePath, '..', '..', '..');
    if (!await pathExists(path.join(engineRoot, 'Engine', 'Build', 'Build.version'))) continue;
    candidates.push({
      engineRoot,
      source: 'process',
      label: path.basename(engineRoot) || 'Unreal Engine',
    });
  }

  const launcherInstalled = await readJsonFile('C:\\ProgramData\\Epic\\UnrealEngineLauncher\\LauncherInstalled.dat', null);
  const installations = Array.isArray(launcherInstalled?.InstallationList) ? launcherInstalled.InstallationList : [];
  for (const item of installations) {
    const installLocation = String(item?.InstallLocation || '').trim();
    if (!installLocation) continue;
    candidates.push({
      engineRoot: installLocation,
      source: 'launcher',
      label: String(item?.AppName || path.basename(installLocation) || 'Unreal Engine'),
    });
  }

  const roots = ['C:\\Program Files\\Epic Games', 'D:\\Epic Games', 'E:\\Epic Games', 'F:\\Epic Games'];
  for (const root of roots) {
    const dirs = await listDirectories(root, (name) => /^UE[_-]?\d+(\.\d+)?$/i.test(name));
    for (const dir of dirs) {
      candidates.push({
        engineRoot: dir,
        source: 'filesystem',
        label: path.basename(dir),
      });
    }
  }

  const unique = resolveUniqueItems(candidates, (item) => path.normalize(item.engineRoot).toLowerCase());
  const detailed = [];
  for (const item of unique) {
    const version = await readBuildVersion(item.engineRoot);
    detailed.push({
      engineRoot: item.engineRoot,
      source: item.source,
      label: version || item.label,
      version: version || item.label,
      buildBatExists: await pathExists(path.join(item.engineRoot, 'Engine', 'Build', 'BatchFiles', 'Build.bat')),
    });
  }
  return detailed.sort((left, right) => compareVersionLabel(left.version, right.version));
}

export async function discoverRunningUnrealProjects() {
  const processes = await discoverRunningProcesses('^UnrealEditor');
  const items = [];
  for (const processInfo of processes) {
    const line = processInfo.commandLine;
    const quoted = extractFirstMatch(line, /"([A-Za-z]:[\\/][^"]+?\.uproject)"/i);
    const unquoted = extractFirstMatch(line, /([A-Za-z]:[\\/][^\s]+?\.uproject)/i);
    const projectPath = (quoted || unquoted).replace(/\//g, '\\');
    if (!projectPath) continue;
    items.push({
      pid: processInfo.pid,
      path: projectPath,
      running: true,
      source: 'process',
      startedAt: processInfo.startedAt || '',
      commandLine: processInfo.commandLine || '',
    });
  }
  return resolveUniqueItems(items, (item) => path.normalize(item.path).toLowerCase());
}

async function discoverRecentUnrealProjects() {
  const localAppDataRoot = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const unrealConfigRoot = path.join(localAppDataRoot, 'UnrealEngine');
  const versionDirs = await listDirectories(unrealConfigRoot, (name) => /^\d+(\.\d+)?$/i.test(name));
  const items = [];
  const settingsFiles = versionDirs.length
    ? versionDirs.map((versionDir) => ({
      editorVersion: path.basename(versionDir),
      settingsPath: path.join(versionDir, 'Saved', 'Config', 'WindowsEditor', 'EditorSettings.ini'),
    }))
    : [{
      editorVersion: 'unknown',
      settingsPath: path.join(unrealConfigRoot, '5.7', 'Saved', 'Config', 'WindowsEditor', 'EditorSettings.ini'),
    }];

  for (const { editorVersion, settingsPath } of settingsFiles) {
    const text = await fs.readFile(settingsPath, 'utf8').catch(() => '');
    if (!text) continue;
    const regex = /RecentlyOpenedProjectFiles=\(ProjectName="([^"]+?\.uproject)"(?:,LastOpenTime=([^)]+))?\)/g;
    for (const match of text.matchAll(regex)) {
      const rawPath = String(match?.[1] || '').trim();
      if (!rawPath) continue;
      const normalizedPath = rawPath.replace(/\//g, '\\');
      items.push({
        path: normalizedPath,
        running: false,
        source: 'recent',
        recentOpenTime: String(match?.[2] || '').trim(),
        editorVersion,
      });
    }
  }

  return resolveUniqueItems(items, (item) => path.normalize(item.path).toLowerCase());
}

export async function discoverUnrealProjects() {
  const items = [
    ...await discoverRunningUnrealProjects(),
    ...await discoverRecentUnrealProjects(),
  ];
  const commonRoots = [
    path.join(os.homedir(), 'Documents', 'Unreal Projects'),
    path.join(os.homedir(), 'Documents'),
  ];
  for (const root of commonRoots) {
    const files = await listFiles(root, (name) => name.toLowerCase().endsWith('.uproject'));
    for (const filePath of files) items.push({ path: filePath, running: false, source: 'filesystem' });
    const dirs = await listDirectories(root);
    for (const dir of dirs) {
      const nested = await listFiles(dir, (name) => name.toLowerCase().endsWith('.uproject'));
      for (const filePath of nested) items.push({ path: filePath, running: false, source: 'filesystem' });
    }
  }

  const unique = resolveUniqueItems(items, (item) => path.normalize(item.path).toLowerCase());
  const enriched = [];
  for (const item of unique) {
    const stat = await fs.stat(item.path).catch(() => null);
    if (!stat?.isFile()) continue;
    const projectJson = await readJsonFile(item.path, {});
    enriched.push({
      pid: Number(item.pid || 0) || undefined,
      path: item.path,
      name: path.basename(item.path, path.extname(item.path)),
      folder: path.dirname(item.path),
      running: Boolean(item.running),
      source: item.source,
      modifiedAt: stat?.mtimeMs || 0,
      engineAssociation: String(projectJson?.EngineAssociation || '').trim(),
      recentOpenTime: item.recentOpenTime || '',
      startedAt: item.startedAt || '',
      startedAtMs: parseWindowsJsonDate(item.startedAt),
      commandLine: String(item.commandLine || '').trim(),
    });
  }
  return enriched.sort((left, right) => {
    if (left.running !== right.running) return left.running ? -1 : 1;
    if (left.source === 'recent' && right.source !== 'recent') return -1;
    if (right.source === 'recent' && left.source !== 'recent') return 1;
    return (right.modifiedAt || 0) - (left.modifiedAt || 0);
  });
}

export async function discoverBlenderVersions() {
  const blenderRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Blender Foundation', 'Blender');
  const versions = await listDirectories(blenderRoot, (name) => /^\d+(\.\d+)?$/i.test(name));
  const runningLines = await discoverRunningProcessCommandLines('^blender(\\.exe)?$');
  const runningText = runningLines.join('\n');
  const items = [];
  for (const versionPath of versions) {
    const version = path.basename(versionPath);
    const addonPath = path.join(versionPath, 'scripts', 'addons', BLENDER_PLUGIN_NAME);
    items.push({
      version,
      versionPath,
      addonPath,
      installed: await pathExists(addonPath),
      running: runningText.includes(versionPath) || runningText.includes(`Blender\\${version}`),
    });
  }
  return items.sort((left, right) => compareVersionLabel(left.version, right.version));
}

export async function discoverBlenderInstallations() {
  const runningExecutables = await discoverRunningProcessExecutables('^blender(\\.exe)?$');
  const registryScript = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$items = @()',
    '$uninstallRoots = @(',
    '  "Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",',
    '  "Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",',
    '  "Registry::HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"',
    ')',
    'foreach ($root in $uninstallRoots) {',
    '  Get-ItemProperty $root | Where-Object { $_.DisplayName -match "Blender" } | ForEach-Object {',
    '    $exe = ""',
    '    if ($_.DisplayIcon) {',
    '      $exe = [string]$_.DisplayIcon -replace ",\\d+$",""',
    '    }',
    '    if (-not $exe -and $_.InstallLocation) {',
    '      $candidate = Join-Path ([string]$_.InstallLocation) "blender.exe"',
    '      if (Test-Path $candidate) { $exe = $candidate }',
    '    }',
    '    if ($exe) {',
    '      $items += [pscustomobject]@{',
    '        label = [string]$_.DisplayName',
    '        version = [string]$_.DisplayVersion',
    '        executablePath = $exe',
    '        installRoot = Split-Path -Parent $exe',
    '        source = "registry-uninstall"',
    '      }',
    '    }',
    '  }',
    '}',
    '$appRoots = @(',
    '  "Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\blender.exe",',
    '  "Registry::HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\blender.exe"',
    ')',
    'foreach ($root in $appRoots) {',
    '  if (Test-Path $root) {',
    '    $item = Get-ItemProperty $root',
    '    $exe = [string]$item."(default)"',
    '    if ($exe) {',
    '      $items += [pscustomobject]@{',
    '        label = "Blender",',
    '        version = "",',
    '        executablePath = $exe,',
    '        installRoot = Split-Path -Parent $exe,',
    '        source = "registry-app-path"',
    '      }',
    '    }',
    '  }',
    '}',
    '$items | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ');
  const registryResult = await runPowerShellInline(registryScript);
  const registryItems = [];
  if (registryResult.ok && String(registryResult.stdout || '').trim()) {
    const parsed = JSON.parse(registryResult.stdout);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of values) {
      const executablePath = String(item?.executablePath || '').trim();
      if (!executablePath) continue;
      registryItems.push({
        label: String(item?.label || 'Blender').trim() || 'Blender',
        version: String(item?.version || '').trim(),
        executablePath,
        installRoot: String(item?.installRoot || path.dirname(executablePath)).trim(),
        source: String(item?.source || 'registry').trim() || 'registry',
      });
    }
  }
  const runningItems = runningExecutables.map((executablePath) => ({
    label: path.basename(path.dirname(executablePath)) || 'Blender',
    version: extractFirstMatch(executablePath, /(\d+(?:\.\d+)+)/),
    executablePath,
    installRoot: path.dirname(executablePath),
    source: 'process',
  }));
  const filesystemRoots = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Blender Foundation'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Blender Foundation'),
    'C:\\软件',
    'D:\\Blender Foundation',
    'E:\\Blender Foundation',
    'F:\\Blender Foundation',
    'D:\\软件',
    'E:\\软件',
    'F:\\软件',
    'D:\\Applications',
    'E:\\Applications',
    'F:\\Applications',
  ];
  const filesystemItems = [];
  for (const root of filesystemRoots) {
    const dirs = await listDirectories(root).catch(() => []);
    for (const dir of dirs) {
      const executablePath = path.join(dir, 'blender.exe');
      if (!await pathExists(executablePath)) continue;
      filesystemItems.push({
        label: path.basename(dir) || 'Blender',
        version: extractFirstMatch(dir, /(\d+(?:\.\d+)+)/),
        executablePath,
        installRoot: dir,
        source: 'filesystem',
      });
    }
  }
  const unique = resolveUniqueItems(
    [...runningItems, ...registryItems, ...filesystemItems],
    (item) => path.normalize(item.executablePath).toLowerCase(),
  );
  return unique.sort((left, right) => compareVersionLabel(left.version || left.label, right.version || right.label));
}

export function normalizeLineBreaks(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

export function summarizeCommandResult(result, fallback) {
  const stdout = normalizeLineBreaks(result?.stdout || '');
  const stderr = normalizeLineBreaks(result?.stderr || '');
  const lines = [stdout, stderr].filter(Boolean).join('\n');
  return lines || fallback;
}

export async function copyIfExists(sourcePath, destinationPath) {
  if (!await pathExists(sourcePath)) return false;
  await ensureDir(path.dirname(destinationPath));
  await fs.cp(sourcePath, destinationPath, { recursive: true, force: true });
  return true;
}

export async function removeIfExists(targetPath) {
  if (!await pathExists(targetPath)) return false;
  await fs.rm(targetPath, { recursive: true, force: true });
  return true;
}

export async function createBackupRecord(backupRoot, payload) {
  await ensureDir(backupRoot);
  const stamp = `${Date.now()}-${slugify(payload.engine)}-${slugify(payload.action)}`;
  const folder = path.join(backupRoot, stamp);
  const restoreRoot = path.join(folder, 'restore');
  await ensureDir(restoreRoot);
  const manifest = {
    id: stamp,
    createdAt: nowIso(),
    ...payload,
  };
  await writeJsonFile(path.join(folder, 'manifest.json'), manifest);
  return { folder, restoreRoot, manifest };
}

export async function listBackups(backupRoot, engine) {
  const engineRoot = path.join(backupRoot, engine);
  if (!await pathExists(engineRoot)) return [];
  const dirs = await listDirectories(engineRoot);
  const items = [];
  for (const dir of dirs) {
    const manifest = await readJsonFile(path.join(dir, 'manifest.json'), null);
    if (!manifest) continue;
    items.push({ ...manifest, folder: dir });
  }
  return items.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

export async function backupUnrealState(backupRoot, action, projectPath, options = {}) {
  const projectDir = path.dirname(projectPath);
  const pluginPath = path.join(projectDir, 'Plugins', UNREAL_PLUGIN_NAME);
  const enginePluginPaths = Array.isArray(options.enginePluginPaths)
    ? options.enginePluginPaths.filter((item, index, items) => item && items.indexOf(item) === index)
    : [];
  const engineEntries = [];
  for (let index = 0; index < enginePluginPaths.length; index += 1) {
    const enginePluginPath = enginePluginPaths[index];
    engineEntries.push({
      type: 'directory',
      sourcePath: enginePluginPath,
      targetPath: enginePluginPath,
      existed: await pathExists(enginePluginPath),
      backupPath: path.join('restore', `engine-plugin-${index}`),
    });
  }
  const backup = await createBackupRecord(path.join(backupRoot, 'unreal'), {
    engine: 'unreal',
    action,
    projectPath,
    restoreEntries: [
      {
        type: 'directory',
        sourcePath: pluginPath,
        targetPath: pluginPath,
        existed: await pathExists(pluginPath),
        backupPath: path.join('restore', 'plugin'),
      },
      {
        type: 'file',
        sourcePath: projectPath,
        targetPath: projectPath,
        existed: await pathExists(projectPath),
        backupPath: path.join('restore', path.basename(projectPath)),
      },
      ...engineEntries,
    ],
  });
  const pluginEntry = backup.manifest.restoreEntries[0];
  const projectEntry = backup.manifest.restoreEntries[1];
  if (pluginEntry.existed) await copyIfExists(pluginPath, path.join(backup.folder, pluginEntry.backupPath));
  if (projectEntry.existed) await copyIfExists(projectPath, path.join(backup.folder, projectEntry.backupPath));
  for (let index = 2; index < backup.manifest.restoreEntries.length; index += 1) {
    const engineEntry = backup.manifest.restoreEntries[index];
    if (engineEntry?.existed) {
      await copyIfExists(engineEntry.sourcePath, path.join(backup.folder, engineEntry.backupPath));
    }
  }
  await writeJsonFile(path.join(backup.folder, 'manifest.json'), backup.manifest);
  return backup.manifest;
}

export async function backupBlenderState(backupRoot, action, versions) {
  const backup = await createBackupRecord(path.join(backupRoot, 'blender'), {
    engine: 'blender',
    action,
    versions: versions.map((item) => ({
      version: item.version,
      addonPath: item.addonPath,
      existed: item.installed,
      backupPath: path.join('restore', slugify(item.version)),
    })),
  });
  for (const version of versions) {
    if (!version.installed) continue;
    await copyIfExists(version.addonPath, path.join(backup.folder, 'restore', slugify(version.version)));
  }
  await writeJsonFile(path.join(backup.folder, 'manifest.json'), backup.manifest);
  return backup.manifest;
}

export async function restoreBackupRecord(backup) {
  if (backup.engine === 'unreal') {
    for (const entry of backup.restoreEntries || []) {
      const backupPath = path.join(backup.folder, entry.backupPath);
      if (entry.existed) {
        await removeIfExists(entry.targetPath);
        await copyIfExists(backupPath, entry.targetPath);
      } else {
        await removeIfExists(entry.targetPath);
      }
    }
    return;
  }

  if (backup.engine === 'blender') {
    for (const version of backup.versions || []) {
      if (version.existed) {
        await removeIfExists(version.addonPath);
        await copyIfExists(path.join(backup.folder, version.backupPath), version.addonPath);
      } else {
        await removeIfExists(version.addonPath);
      }
    }
  }
}

export async function applyProjectPluginStates(projectPath, states = []) {
  const payload = await readJsonFile(projectPath, {});
  const plugins = Array.isArray(payload.Plugins) ? [...payload.Plugins] : [];
  const changedPlugins = [];

  for (const state of states) {
    const pluginName = String(state?.name || '').trim();
    if (!pluginName) continue;
    const enabled = Boolean(state?.enabled);
    const existingIndex = plugins.findIndex((item) => String(item?.Name || '').trim() === pluginName);
    if (enabled) {
      if (existingIndex >= 0) {
        const currentPlugin = plugins[existingIndex];
        if (!currentPlugin?.Enabled) {
          plugins[existingIndex] = { ...currentPlugin, Enabled: true };
          changedPlugins.push(pluginName);
        }
      } else {
        plugins.push({ Name: pluginName, Enabled: true });
        changedPlugins.push(pluginName);
      }
    } else if (existingIndex >= 0) {
      plugins.splice(existingIndex, 1);
      changedPlugins.push(pluginName);
    }
  }

  if (changedPlugins.length > 0) {
    await writeJsonFile(projectPath, { ...payload, Plugins: plugins });
  }

  return {
    changed: changedPlugins.length > 0,
    changedPlugins,
    plugins,
  };
}

export async function updateUnrealProjectPluginState(projectPath, enabled) {
  return await applyProjectPluginStates(projectPath, [{ name: UNREAL_PLUGIN_NAME, enabled }]);
}

export function deriveUnrealStateSummary({ project, pluginInstalled, pluginEnabled, buildArtifactsPresent, directBridgeOnline, cameraCount }) {
  if (!project) return { level: 'warning', summary: 'No Unreal project was detected yet. Open or select a .uproject first.' };
  if (!pluginInstalled) return { level: 'warning', summary: 'An Unreal project was detected, but HMDao Unreal Capture is not installed yet.' };
  if (!pluginEnabled) return { level: 'warning', summary: 'HMDao Unreal Capture files are installed, but the current project has not enabled the plugin yet.' };
  if (!buildArtifactsPresent) return { level: 'warning', summary: 'The plugin is enabled, but Unreal build artifacts for the current project were not detected yet.' };
  if (!directBridgeOnline) return { level: 'warning', summary: 'The plugin is ready, but Unreal has not bridged the editor back to HMDao yet.' };
  if (cameraCount <= 0) return { level: 'warning', summary: 'The plugin is connected, but no camera or viewport source has been enumerated yet.' };
  return { level: 'ready', summary: 'Unreal plugin install, project enablement, and direct bridge are all ready.' };
}

export function deriveUnrealEnvironmentSummary({
  project,
  pluginInstalled,
  pluginEnabled,
  buildArtifactsPresent,
  directBridgeOnline,
  cameraCount,
  officialCaptureReady = false,
  officialMissingCount = 0,
  recommendedIntegrationMode = 'custom-plugin-direct',
}) {
  if (!project) {
    return {
      level: 'warning',
      summary: 'No Unreal project was detected yet. Open or select a .uproject first.',
    };
  }
  if (recommendedIntegrationMode === 'official-sequencer-capture' && officialCaptureReady) {
    return {
      level: 'ready',
      summary: 'Official Unreal capture prerequisites are enabled. If you just changed plugins, restart Unreal once, then use Sequencer or Movie Render Queue for stills or animation output.',
    };
  }
  if (recommendedIntegrationMode === 'official-sequencer-capture' && officialMissingCount > 0) {
    return {
      level: 'warning',
      summary: 'An Unreal project was detected, but the official Sequencer / MRQ capture prerequisites are not fully enabled yet.',
    };
  }
  if (!pluginInstalled) return { level: 'warning', summary: 'HMDao custom Unreal plugin files are not installed yet.' };
  if (!pluginEnabled) return { level: 'warning', summary: 'HMDao custom Unreal plugin files exist, but the current project has not enabled the plugin yet.' };
  if (!buildArtifactsPresent) return { level: 'warning', summary: 'HMDao custom Unreal plugin is enabled, but no plugin build artifacts were detected for the current project yet.' };
  if (!directBridgeOnline) return { level: 'warning', summary: 'HMDao custom Unreal plugin is installed, but Unreal has not bridged the editor back to HMDao yet.' };
  if (cameraCount <= 0) return { level: 'warning', summary: 'HMDao custom Unreal plugin is connected, but no camera or viewport source has been enumerated yet.' };
  return { level: 'ready', summary: 'HMDao custom Unreal plugin, project enablement, and direct bridge are all ready.' };
}

export function deriveBlenderStateSummary({ versions, serviceReachable }) {
  if (!versions.length) return { level: 'warning', summary: 'No local Blender profile directory was detected yet.' };
  if (!versions.some((item) => item.installed)) return { level: 'warning', summary: 'Blender was detected, but HMDao Blender Capture is not installed yet.' };
  if (!serviceReachable) return { level: 'warning', summary: 'The plugin files are installed, but the 8766 capture service is not running yet.' };
  return { level: 'ready', summary: 'Blender plugin is installed and the 8766 capture service is online.' };
}




