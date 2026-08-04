/**
 * 多角度轨道球纯数学工具（无 React / 无 Canvas / 无 store 依赖，便于单测）
 */

/** 归一化屏幕坐标（单位圆内 [-1,1]，y 向下为正）→ yaw/pitch（正交球面投影，前半球） */
export function normToAngle(nx: number, ny: number): { yaw: number; pitch: number } {
  const clampedNy = Math.max(-1, Math.min(1, ny));
  const pitch = -Math.asin(clampedNy) * (180 / Math.PI); // 顶部 ny=-1 → +90°
  const cosPitch = Math.cos(pitch * (Math.PI / 180));
  const sinYaw = Math.max(-1, Math.min(1, nx / Math.max(1e-4, cosPitch)));
  const yawRaw = Math.asin(sinYaw) * (180 / Math.PI); // [-90, 90]
  const yaw = ((yawRaw % 360) + 360) % 360;
  return { yaw: +yaw.toFixed(1), pitch: +pitch.toFixed(1) };
}
