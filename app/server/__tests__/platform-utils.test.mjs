/**
 * 跨平台运行时「候选可执行名 / 示例安装路径 / 资产名」单测。
 *
 * 覆盖 2026-09-16 的两处修复：
 *   A. platformExecutableCandidates 补平台后缀（Linux=yt-dlp_linux / macOS=yt-dlp_macos）——
 *      这是「云端一键安装 yt-dlp 必然失败」的根因：安装侧 findFileRecursively 是文件名精确匹配，
 *      旧候选 [yt-dlp, yt-dlp.exe] 匹配不到带后缀的产物，安装直接抛错、探测恒 configured:false。
 *   E. commonInstallPaths / exampleRuntimePath 不再硬编码 .exe，按平台生成。
 *
 * 全部为注入式纯函数断言（显式传 platform/arch），无需真的切换操作系统。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildPlatformInfo,
  platformExecutableCandidates,
  resolveYtDlpAssetNames,
} from '../platform-utils.mjs';
import { buildRuntimeCommonInstallPaths } from '../lib/local-post-constants.mjs';
import { findInSystemPath } from '../lib/local-post-processing.mjs';

const PLATFORMS = [
  ['win32', 'x64'],
  ['darwin', 'arm64'],
  ['linux', 'x64'],
];

describe('A. platformExecutableCandidates 平台后缀候选', () => {
  it('linux：包含裸名与 yt-dlp_linux（修复前两者都缺，导致探测/安装恒不命中）', () => {
    const candidates = platformExecutableCandidates('yt-dlp', 'linux');
    expect(candidates).toContain('yt-dlp');
    expect(candidates).toContain('yt-dlp_linux');
  });

  it('darwin：包含 yt-dlp_macos', () => {
    expect(platformExecutableCandidates('yt-dlp', 'darwin')).toContain('yt-dlp_macos');
  });

  it('win32：首选 yt-dlp.exe，且不引入 _linux/_macos 噪声', () => {
    const candidates = platformExecutableCandidates('yt-dlp', 'win32');
    expect(candidates[0]).toBe('yt-dlp.exe');
    expect(candidates).not.toContain('yt-dlp_linux');
    expect(candidates).not.toContain('yt-dlp_macos');
  });

  it('纯增量：其它运行时的既有候选一个都不少（无回归）', () => {
    for (const [base, platform] of [
      ['gmic', 'linux'],
      ['aria2c', 'linux'],
      ['ffmpeg', 'linux'],
      ['oiiotool', 'win32'],
      ['ocioconvert', 'darwin'],
    ]) {
      const candidates = platformExecutableCandidates(base, platform);
      expect(candidates).toContain(base);
      expect(candidates).toContain(`${base}.exe`);
    }
  });

  it('候选去重且顺序稳定（findFileRecursively 按数组序命中）', () => {
    const first = platformExecutableCandidates('yt-dlp', 'linux');
    const second = platformExecutableCandidates('yt-dlp', 'linux');
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });

  it('输入已带 .exe 时先规范化（不会拼出 yt-dlp.exe_linux 这类垃圾名）', () => {
    const candidates = platformExecutableCandidates('yt-dlp.exe', 'linux');
    expect(candidates).toContain('yt-dlp_linux');
    expect(candidates.some((name) => name.includes('.exe_'))).toBe(false);
  });

  it('空/非法输入返回空数组（调用方无需额外判空）', () => {
    expect(platformExecutableCandidates('', 'linux')).toEqual([]);
    expect(platformExecutableCandidates(null, 'linux')).toEqual([]);
  });

  it('闭环一致性：onedir 解压产物名必须在候选内（安装与探测同源）', () => {
    // 模拟三个平台 onedir 压缩包解压后的真实可执行文件名
    const onedirOutputs = {
      win32: 'yt-dlp.exe',
      darwin: 'yt-dlp_macos',
      linux: 'yt-dlp_linux',
    };
    for (const [platform, producedName] of Object.entries(onedirOutputs)) {
      expect(platformExecutableCandidates('yt-dlp', platform)).toContain(producedName);
    }
  });
});

describe('A. yt-dlp 安装资产名与 PATH 扫描目录', () => {
  it('三个平台各自选择对应资产', () => {
    expect(resolveYtDlpAssetNames(buildPlatformInfo('win32', 'x64')).assetName).toBe('yt-dlp_win.zip');
    expect(resolveYtDlpAssetNames(buildPlatformInfo('darwin', 'arm64')).assetName).toBe('yt-dlp_macos.zip');
    expect(resolveYtDlpAssetNames(buildPlatformInfo('linux', 'x64')).assetName).toBe('yt-dlp_linux.zip');
  });

  it('类 Unix 平台提供额外的常见 bin 目录（供 PATH 扫描）', () => {
    expect(buildPlatformInfo('linux', 'x64').extraBinDirs).toContain('/usr/local/bin');
    expect(buildPlatformInfo('darwin', 'arm64').extraBinDirs).toContain('/usr/local/bin');
    expect(buildPlatformInfo('win32', 'x64').extraBinDirs).toEqual([]);
  });

  it('每个平台都返回可用的可执行后缀（用于示例路径与候选拼接）', () => {
    expect(buildPlatformInfo('win32', 'x64').exeSuffix).toBe('.exe');
    expect(buildPlatformInfo('linux', 'x64').exeSuffix).toBe('');
    expect(buildPlatformInfo('darwin', 'arm64').exeSuffix).toBe('');
  });
});

describe('E. 运行时示例安装路径按平台生成', () => {
  it('Linux：yt-dlp 不再带 .exe', () => {
    const paths = buildRuntimeCommonInstallPaths('ytdlp', buildPlatformInfo('linux', 'x64'));
    expect(paths).toHaveLength(1);
    expect(path.basename(paths[0])).toBe('yt-dlp');
    expect(paths[0]).not.toMatch(/\.exe$/i);
    expect(paths[0]).toContain('local-post-runtimes');
  });

  it('macOS：yt-dlp 同样不带 .exe', () => {
    const paths = buildRuntimeCommonInstallPaths('ytdlp', buildPlatformInfo('darwin', 'arm64'));
    expect(path.basename(paths[0])).toBe('yt-dlp');
  });

  it('Windows：仍展示 yt-dlp.exe（既有行为不变）', () => {
    const paths = buildRuntimeCommonInstallPaths('ytdlp', buildPlatformInfo('win32', 'x64'));
    expect(path.basename(paths[0])).toBe('yt-dlp.exe');
  });

  it('aria2 在 Linux 展示 aria2c（此前错误展示 aria2c.exe）', () => {
    expect(path.basename(buildRuntimeCommonInstallPaths('aria2', buildPlatformInfo('linux', 'x64'))[0])).toBe('aria2c');
    expect(path.basename(buildRuntimeCommonInstallPaths('aria2', buildPlatformInfo('win32', 'x64'))[0])).toBe('aria2c.exe');
  });

  it('ffmpeg 保留 current/bin 层级，且文件名按平台', () => {
    const linuxPaths = buildRuntimeCommonInstallPaths('ffmpeg', buildPlatformInfo('linux', 'x64'));
    expect(path.basename(linuxPaths[0])).toBe('ffmpeg');
    expect(linuxPaths[0]).toContain(path.join('current', 'bin'));
    expect(path.basename(buildRuntimeCommonInstallPaths('ffmpeg', buildPlatformInfo('win32', 'x64'))[0])).toBe('ffmpeg.exe');
  });

  it('未登记运行时返回空数组（不产生误导路径）', () => {
    for (const [platform, arch] of PLATFORMS) {
      expect(buildRuntimeCommonInstallPaths('never-registered', buildPlatformInfo(platform, arch))).toEqual([]);
    }
  });
});

describe('F. 系统 PATH 回退（apt / brew 安装的运行时也能被识别）', () => {
  let tmpDir;
  const savedPath = process.env.PATH;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddayup-path-'));
    // 模拟 apt install ffmpeg / aria2 后的 /usr/bin 产物
    await fs.writeFile(path.join(tmpDir, 'ffmpeg'), '#!/bin/sh\n');
    await fs.writeFile(path.join(tmpDir, 'aria2c'), '#!/bin/sh\n');
    process.env.PATH = tmpDir;
  });

  afterAll(async () => {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('正常：能在 PATH 中找到 ffmpeg / aria2c', () => {
    expect(findInSystemPath('ffmpeg')).toBe(path.join(tmpDir, 'ffmpeg'));
    expect(findInSystemPath('aria2c')).toBe(path.join(tmpDir, 'aria2c'));
  });

  it('边界：未安装时返回空串（不抛错、不误报）', () => {
    expect(findInSystemPath('definitely-not-installed-xyz')).toBe('');
  });

  it('异常：空/非法输入返回空串而非抛错', () => {
    expect(findInSystemPath('')).toBe('');
    expect(findInSystemPath(null)).toBe('');
  });
});
