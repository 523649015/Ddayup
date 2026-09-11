// 会话存储模块（从 app/server/hmdao-api.mjs 抽离，行为零变更 + P3 持久化增强）。
//
// sessions / accessSessions 是登录态的模块级可变 Map。经由顶部 import 在主文件与各
// 路由组（auth/cobuild 等）之间共享。ES 模块对其采用 live binding：本模块导出 const Map，
// 主文件与各路由组对同一个 Map 实例做 .set/.delete/.get 变更，引用始终一致。
//
// P3-安全：会话持久化。原实现仅内存 Map，进程重启即全员登出、且无法多实例共享。
// 现增加轻量文件持久化（落 DATA_DIR/sessions.json，原子写 + 启动恢复），单实例下
// 重启不丢登录态，亦不影响现有 token 校验逻辑。多实例水平扩展时建议改用 Redis。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 数据目录：复用 server-paths 的 DATA_DIR；此处独立计算以避免循环依赖。
function resolveDataDir() {
  if (process.env.HMDAO_DATA_DIR) return path.resolve(process.env.HMDAO_DATA_DIR);
  const cwd = process.cwd();
  const here = path.resolve(cwd, '.hmdao-data');
  const sibling = path.resolve(cwd, 'app', '.hmdao-data');
  try {
    if (fs.existsSync(sibling) && !fs.existsSync(here)) return sibling;
  } catch { /* noop */ }
  return here;
}
const DATA_DIR = resolveDataDir();
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// 刷新令牌 -> { userId, expiresAt }（7 天）
export const sessions = new Map();
// 访问令牌 -> { userId, expiresAt }（2 小时）
export const accessSessions = new Map();

// ---- 持久化：防抖写 + 启动恢复 ----
let saveTimer = null;
function schedulePersist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const snapshot = {
        sessions: Array.from(sessions.entries()),
        accessSessions: Array.from(accessSessions.entries()),
      };
      const tmp = `${SESSIONS_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
      fs.renameSync(tmp, SESSIONS_FILE);
    } catch (e) {
      console.error('[session-store] persist failed:', e?.message);
    }
  }, 500);
}

export function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const snap = JSON.parse(raw);
    const now = Date.now();
    for (const [k, v] of snap.sessions || []) {
      if (v && v.expiresAt > now) sessions.set(k, v);
    }
    for (const [k, v] of snap.accessSessions || []) {
      if (v && v.expiresAt > now) accessSessions.set(k, v);
    }
  } catch (e) {
    console.error('[session-store] load failed:', e?.message);
  }
}

export function createSession(user) {
  const accessToken = crypto.randomBytes(24).toString('hex');
  const refreshToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + 2 * 60 * 60 * 1000;
  sessions.set(refreshToken, { userId: user.id, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  accessSessions.set(accessToken, { userId: user.id, expiresAt });
  schedulePersist();
  return { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt };
}

export function deleteSessionsForUser(userId) {
  for (const [refreshToken, session] of sessions.entries()) {
    if (session?.userId === userId) {
      sessions.delete(refreshToken);
    }
  }
  schedulePersist();
}

