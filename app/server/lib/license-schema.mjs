// 授权数据 schema 版本与迁移（纯函数，可被 vitest 直接单测）
// 设备/许可数据存于 DATA_DIR 下的 extension-licenses.json。
// 旧版本数据可能缺失 trialStart / licensePlan / activatedEmail / schemaVersion 等字段，
// 读取时统一迁移补齐，避免状态推导因字段缺失而静默损坏。

export const LICENSE_SCHEMA_VERSION = 1;

// 迁移单个设备条目（原地修改并返回）。
export function migrateDevice(deviceId, device) {
  const d = device || {};
  d.deviceId = d.deviceId || deviceId;
  if (d.schemaVersion == null) d.schemaVersion = LICENSE_SCHEMA_VERSION;
  if (d.trialStart === undefined) d.trialStart = null;
  if (d.licensePlan === undefined) d.licensePlan = null;
  if (d.licenseKey === undefined) d.licenseKey = null;
  if (d.activatedEmail === undefined) d.activatedEmail = null;
  return d;
}

// 迁移整个 licenses 数据对象（原地修改并返回）。
export function migrateLicenses(data) {
  data = data || {};
  data.schemaVersion = LICENSE_SCHEMA_VERSION;
  data.devices = data.devices || {};
  data.licenseKeys = data.licenseKeys || {};
  for (const id of Object.keys(data.devices)) {
    data.devices[id] = migrateDevice(id, data.devices[id]);
  }
  return data;
}
