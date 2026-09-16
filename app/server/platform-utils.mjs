// 跨平台运行时安装/检测的纯逻辑工具（可注入 platform/arch 便于单元测试全平台行为）
// 被 hmdao-api.mjs 引用；不含任何副作用（不启动服务、不读写文件）。
import path from 'node:path';
import os from 'node:os';

// P1-1: 统一的运行平台信息（供跨平台目录选择 / 二进制分发 / 依赖检测复用）
// platform/arch 可显式传入以便测试非当前平台的分支。
export function buildPlatformInfo(platform = process.platform, arch = process.arch) {
  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';
  const isLinux = platform === 'linux';
  // macOS Homebrew 前缀：Apple Silicon 为 /opt/homebrew，Intel 为 /usr/local
  const homebrewPrefix = isMac ? (arch === 'arm64' ? '/opt/homebrew' : '/usr/local') : '';
  // 依赖检测时额外扫描的可执行目录候选（PATH + 常见安装前缀）
  const pathEnv = String(process.env.PATH || process.env.Path || '').trim();
  const pathDirs = pathEnv
    ? pathEnv.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean)
    : [];
  const extraBinDirs = [];
  if (isMac) {
    extraBinDirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  } else if (isLinux) {
    extraBinDirs.push('/usr/local/bin', '/usr/bin', '/bin', '/snap/bin');
  }
  return {
    platform,
    arch,
    isWindows,
    isMac,
    isLinux,
    homebrewPrefix,
    release: os.release(),
    homedir: os.homedir(),
    // 可执行文件后缀（Windows 为 .exe，类 Unix 为空）
    exeSuffix: isWindows ? '.exe' : '',
    // 原生目录选择器可用性：Windows(FolderBrowserDialog) / macOS(osascript) 可用
    supportsNativeDirectoryPicker: isWindows || isMac,
    pathDirs,
    extraBinDirs,
  };
}

// P1-3/P1-4: 给出某可执行程序在各平台的候选文件名（用于托管目录递归查找）
export function platformExecutableCandidates(baseName, platform = process.platform) {
  const base = String(baseName || '').trim().replace(/\.exe$/i, '');
  if (!base) return [];
  // 各平台都保留 .exe 候选，兼容用户手动放入的跨平台产物
  if (platform === 'win32') return [`${base}.exe`, base];
  // ★2026-09-16 修复（A：云端/线上「一键安装 yt-dlp」必然失败的真因）：
  //   yt-dlp 的 onedir 产物是【带平台后缀】的二进制（Linux=yt-dlp_linux / macOS=yt-dlp_macos），
  //   而旧候选只有 [base, base.exe] → findFileRecursively 是「文件名精确匹配」→ 恒不命中 →
  //     ① 安装阶段直接抛 'ytdlp-executable-missing-after-prepare'（装不上）；
  //     ② 探测阶段 detectManagedLocalPostYtDlpPath 恒返回空（configured:false → 上层一律 503）。
  //   纯增量：多出的候选只有在同名文件真实存在时才命中，对 gmic / oiiotool / ocioconvert /
  //   aria2c / ffmpeg（这些本身无平台后缀）的既有行为零影响。
  const platformSuffix = platform === 'darwin' ? '_macos' : '_linux';
  return [...new Set([base, `${base}${platformSuffix}`, `${base}.exe`])];
}

// P1-3: 当前平台对应的 yt-dlp GitHub 资产名与落地文件名。
// 统一采用「onedir（目录式）」构建以彻底消除 onefile 单文件 exe 启动时的控制台闪窗
// （PyInstaller onefile 解压阶段不受 Node windowsHide 控制，会弹黑窗口）。
// onedir 资产为压缩包：Windows=yt-dlp_win.zip / macOS=yt-dlp_macos.zip / Linux=yt-dlp_linux.zip，
// 解压后内含 yt-dlp/ 目录（Windows 下为 yt-dlp/yt-dlp.exe），由 findFileRecursively 自动定位。
export function resolveYtDlpAssetNames(info = buildPlatformInfo()) {
  if (info.isWindows) return { assetName: 'yt-dlp_win.zip', fileName: 'yt-dlp_win.zip' };
  if (info.isMac) return { assetName: 'yt-dlp_macos.zip', fileName: 'yt-dlp_macos.zip' };
  return { assetName: 'yt-dlp_linux.zip', fileName: 'yt-dlp_linux.zip' };
}

// P1-3: 按平台 + CPU 架构选择匹配的 PyPI wheel 平台标签正则
export function selectPypiWheelPlatformRegex(info = buildPlatformInfo()) {
  if (info.isWindows) {
    return /win_amd64\.whl$/i;
  }
  if (info.isMac) {
    // macOS：Apple Silicon 优先 arm64，Intel 用 x86_64；universal2 两者通吃
    return info.arch === 'arm64'
      ? /(macosx_.*(arm64|universal2))\.whl$/i
      : /(macosx_.*(x86_64|universal2))\.whl$/i;
  }
  // Linux：manylinux/musllinux，按架构（x86_64 / aarch64）
  return info.arch === 'arm64'
    ? /(many|musl)linux.*(aarch64)\.whl$/i
    : /(many|musl)linux.*(x86_64)\.whl$/i;
}

// P1-6: gmic 托管一键安装的平台支持性。
// gmic.eu 官方仅发布 Windows CLI zip；macOS/Linux 走系统包管理器（本面板会自动识别 PATH/Homebrew 中的 gmic）。
export function gmicManagedInstallSupport(info = buildPlatformInfo()) {
  if (info.isWindows) return { supported: true, hint: '' };
  if (info.isMac) {
    return {
      supported: false,
      hint: 'macOS 请使用 Homebrew 安装：brew install gmic（装好后本面板会自动识别 PATH/Homebrew 中的 gmic，无需其他配置）',
    };
  }
  return {
    supported: false,
    hint: 'Linux 请使用系统包管理器安装，例如：sudo apt install gmic（装好后本面板会自动识别 PATH 中的 gmic）',
  };
}

// P1-6: 自定义安装目录的按平台禁写前缀（防止误写系统目录）
export function forbiddenInstallPrefixes(info = buildPlatformInfo()) {
  if (info.isWindows) {
    return ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'];
  }
  const unixCommon = ['/bin', '/sbin', '/usr', '/etc', '/boot', '/proc', '/dev'];
  if (info.isMac) {
    // /System 与系统级 /Library 需 sudo 且污染系统；用户级 ~/Library 是不同路径不受影响
    return ['/System', '/Library', ...unixCommon];
  }
  return unixCommon;
}

// P1-6: 判断目标目录是否命中禁写前缀（Windows 大小写不敏感，类 Unix 大小写敏感）
export function isForbiddenInstallTarget(resolvedPath, info = buildPlatformInfo(), extraPrefixes = []) {
  const sep = info.isWindows ? '\\' : '/';
  const norm = (p) => (info.isWindows ? String(p || '').toLowerCase() : String(p || ''));
  const target = norm(resolvedPath);
  if (!target) return false;
  const prefixes = [...forbiddenInstallPrefixes(info), ...extraPrefixes].map(norm).filter(Boolean);
  return prefixes.some((p) => target === p || target.startsWith(p.endsWith(sep) ? p : p + sep));
}
