// Unreal 插件适配器的纯工具函数（从 dcc/adapters/unreal-plugin-adapter.mjs 抽离，行为零变更）。
// 这些函数无模块级状态依赖，集中为单一来源，避免适配器体积膨胀，并便于契约测试覆盖。
// 注意：extractAbsLogPath 依赖 extractFirstMatch（已单源化到 str-utils.mjs）。

import { promises as fs } from 'node:fs';

import path from 'node:path';

import { extractFirstMatch } from './str-utils.mjs';

/**
 * 路径归一化 + 转小写，作为插件状态/备份键的稳定标识。
 * @param {string} filePath
 * @returns {string}
 */
export function normalizeKey(filePath) {
  return path.normalize(String(filePath || '')).toLowerCase();
}

/**
 * 生成紧凑时间戳标签（YYYYMMDD-HHMMSS），用于备份/日志目录命名。
 * @param {Date} [date]
 * @returns {string}
 */
export function formatTimestampTag(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * 读取文件修改时间；文件不存在或异常时返回 exists:false 的安全默认值（不抛错）。
 * @param {string} filePath
 * @returns {Promise<{path:string,exists:boolean,mtimeMs:number,iso:string}>}
 */
export async function readFileTimestamp(filePath = '') {
  const normalizedPath = String(filePath || '').trim();
  if (!normalizedPath) {
    return {
      path: '',
      exists: false,
      mtimeMs: 0,
      iso: '',
    };
  }

  try {
    const stat = await fs.stat(normalizedPath);
    return {
      path: normalizedPath,
      exists: true,
      mtimeMs: Number(stat.mtimeMs || 0),
      iso: stat.mtime instanceof Date ? stat.mtime.toISOString() : '',
    };
  } catch {
    return {
      path: normalizedPath,
      exists: false,
      mtimeMs: 0,
      iso: '',
    };
  }
}

/**
 * 从 Unreal 命令行中提取 -AbsLog 绝对路径（统一反斜杠）。
 * @param {string} commandLine
 * @returns {string}
 */
export function extractAbsLogPath(commandLine = '') {
  const line = String(commandLine || '').trim();
  if (!line) return '';

  const quoted = extractFirstMatch(line, /-AbsLog="([^"]+)"/i);
  if (quoted) return quoted.replace(/\//g, '\\');

  const unquoted = extractFirstMatch(line, /-AbsLog=([A-Za-z]:[\\/][^\s]+)/i);
  return unquoted ? unquoted.replace(/\//g, '\\') : '';
}

/**
 * 正则特殊字符转义，用于把用户输入拼进 RegExp。
 * @param {string} value
 * @returns {string}
 */
export function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从末尾向前查找首个匹配行，返回 {index, line}；无匹配返回 null。
 * @param {string[]} lines
 * @param {RegExp} pattern
 * @returns {{index:number,line:string}|null}
 */
export function findLastMatchingLineInfo(lines, pattern) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (pattern.test(lines[index])) {
      return {
        index,
        line: lines[index],
      };
    }
  }
  return null;
}

/**
 * 解析 Unreal 日志行前缀的 UTC 毫秒时间戳；格式不符返回 0。
 * @param {string} line
 * @returns {number}
 */
export function parseUnrealLogTimestampMs(line = '') {
  const match = /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]/.exec(String(line || ''));
  if (!match) return 0;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond),
  );
}

/**
 * 从桥接状态中提取相机数量（兼容 camera_list / cameras 两种字段）。
 * @param {object} bridgeState
 * @returns {number}
 */
export function cameraCountFromBridgeState(bridgeState) {
  const cameraList = Array.isArray(bridgeState?.cameraList?.camera_list)
    ? bridgeState.cameraList.camera_list
    : Array.isArray(bridgeState?.cameraList?.cameras)
      ? bridgeState.cameraList.cameras
      : [];
  return cameraList.length;
}

/**
 * 依据当前启动阶段自适应放宽卡死判定窗口（避免把正常静默误判为卡死）。
 * @param {object} latestSnapshot
 * @param {{stallAfterMs?:number,minWaitBeforeStallMs?:number}} [thresholds]
 * @returns {{stallAfterMs:number,minWaitBeforeStallMs:number}}
 */
export function getAdaptiveStallThresholds(latestSnapshot, {
  stallAfterMs,
  minWaitBeforeStallMs,
} = {}) {
  const phaseKey = String(latestSnapshot?.phaseKey || '').trim().toLowerCase();

  if (phaseKey === 'log-wait' || phaseKey === 'stale-log') {
    return {
      stallAfterMs: Math.min(Number(stallAfterMs || 0) || 60000, 60000),
      minWaitBeforeStallMs: Math.min(Number(minWaitBeforeStallMs || 0) || 90000, 90000),
    };
  }

  // Historical successful Action.uproject runs can stay nearly silent for
  // 16+ minutes after Turnkey completes before AssetRegistry/RemoteControl
  // logs appear, so the generic stall window is too aggressive here.
  if (phaseKey === 'turnkey') {
    return {
      stallAfterMs: Math.max(Number(stallAfterMs || 0), 20 * 60 * 1000),
      minWaitBeforeStallMs: Math.max(Number(minWaitBeforeStallMs || 0), 25 * 60 * 1000),
    };
  }

  if (['slate', 'asset-registry', 'shader-warmup', 'project-plugin', 'plugin-mounted', 'package-streaming', 'editor-tooling'].includes(phaseKey)) {
    return {
      stallAfterMs: Math.max(Number(stallAfterMs || 0), 12 * 60 * 1000),
      minWaitBeforeStallMs: Math.max(Number(minWaitBeforeStallMs || 0), 15 * 60 * 1000),
    };
  }

  return {
    stallAfterMs,
    minWaitBeforeStallMs,
  };
}

/**
 * 从 .uproject 的 Plugins 列表提取已启用插件名集合。
 * @param {object} projectJson
 * @returns {Set<string>}
 */
export function getEnabledProjectPlugins(projectJson) {
  const enabled = new Set();
  const items = Array.isArray(projectJson?.Plugins) ? projectJson.Plugins : [];
  for (const item of items) {
    if (!item?.Enabled) continue;
    const pluginName = String(item?.Name || '').trim();
    if (pluginName) enabled.add(pluginName);
  }
  return enabled;
}

export default {
  normalizeKey,
  formatTimestampTag,
  readFileTimestamp,
  extractAbsLogPath,
  escapeRegExp,
  findLastMatchingLineInfo,
  parseUnrealLogTimestampMs,
  cameraCountFromBridgeState,
  getAdaptiveStallThresholds,
  getEnabledProjectPlugins,
};
