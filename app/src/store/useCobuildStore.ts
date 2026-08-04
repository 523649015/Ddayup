import { create } from 'zustand';
import { useAuthStore } from './useAuthStore';

export type CoBuildType = 'suggestion' | 'donation' | 'both';

export interface CoBuildComment {
  id: string;
  userId: string;
  userEmail: string;
  text: string;
  createdAt: string;
}

export interface CoBuildEntry {
  id: string;
  userId: string;
  userEmail: string;
  message: string;
  tags: string[];
  donation: number;
  type: CoBuildType;
  likes: number;
  likedBy: string[];
  comments: CoBuildComment[];
  createdAt: string;
}

interface SubmitInput {
  message?: string;
  tags?: string[];
  donation?: number;
}

interface CobuildState {
  entries: CoBuildEntry[];
  loading: boolean;
  submitting: boolean;
  error: string;
  load: () => Promise<void>;
  submit: (input: SubmitInput) => Promise<CoBuildEntry | null>;
  toggleLike: (id: string) => Promise<void>;
  addComment: (id: string, text: string) => Promise<void>;
  reset: () => void;
}

function maskEmailForDisplay(email = '') {
  const value = String(email || '').trim();
  const at = value.indexOf('@');
  if (at <= 0) return value || '匿名用户';
  const name = value.slice(0, at);
  const domain = value.slice(at);
  if (name.length <= 1) return `${name}***${domain}`;
  if (name.length <= 3) return `${name[0]}***${domain}`;
  return `${name.slice(0, 2)}***${name.slice(-1)}${domain}`;
}

function authHeaders(): Record<string, string> {
  const token = useAuthStore.getState().session?.accessToken;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

const SEED_ENTRIES: CoBuildEntry[] = [
  {
    id: 'seed-1',
    userId: 'seed-user-1',
    userEmail: 'community***@hmdao.ai',
    message: '希望画布支持多语言字幕一键烧录，导出视频时直接嵌入轨道字幕。',
    tags: ['视频导出', '字幕'],
    donation: 0,
    type: 'suggestion',
    likes: 12,
    likedBy: [],
    comments: [],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
  },
  {
    id: 'seed-2',
    userId: 'seed-user-2',
    userEmail: 'designer***@hmdao.ai',
    message: '建议增加「智能分镜」能力：根据剧本自动拆解镜头并生成草图。',
    tags: ['智能分镜', '剧本'],
    donation: 0,
    type: 'suggestion',
    likes: 9,
    likedBy: [],
    comments: [],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 50).toISOString(),
  },
  {
    id: 'seed-3',
    userId: 'seed-user-3',
    userEmail: 'supporter***@hmdao.ai',
    message: '感谢团队持续打磨产品，这是一点心意，希望越来越好！',
    tags: ['支持'],
    donation: 66,
    type: 'donation',
    likes: 21,
    likedBy: [],
    comments: [],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 8).toISOString(),
  },
];

async function fetchCobuild(): Promise<CoBuildEntry[]> {
  const res = await fetch('/api/cobuild', { method: 'GET', headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error('failed');
  const data = await res.json();
  return Array.isArray(data.entries) ? (data.entries as CoBuildEntry[]) : [];
}

async function postCobuild(body: Record<string, unknown>): Promise<{ entry: CoBuildEntry; gaveDonation: boolean }> {
  const res = await fetch('/api/cobuild', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(data?.error?.message || '提交失败，请稍后重试。');
  }
  return data as { entry: CoBuildEntry; gaveDonation: boolean };
}

export const useCobuildStore = create<CobuildState>()((set, get) => ({
  entries: [],
  loading: false,
  submitting: false,
  error: '',

  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: '' });
    try {
      const entries = await fetchCobuild();
      set({ entries, loading: false });
    } catch {
      // 后端不可达时保留本地种子，保证世界频道与面板有内容展示。
      set((state) => ({ loading: false, entries: state.entries.length ? state.entries : SEED_ENTRIES }));
    }
  },

  submit: async (input) => {
    const message = String(input.message || '').trim();
    const donation = Number(input.donation || 0) || 0;
    if (!message && donation <= 0) {
      set({ error: '请填写反馈留言或选择打赏金额。' });
      return null;
    }
    set({ submitting: true, error: '' });
    try {
      const data = await postCobuild({
        message,
        tags: input.tags || [],
        donation,
      });
      set((state) => ({ entries: [data.entry, ...state.entries], submitting: false }));
      return data.entry;
    } catch (err) {
      set({ submitting: false, error: err instanceof Error ? err.message : '提交失败，请稍后重试。' });
      return null;
    }
  },

  toggleLike: async (id) => {
    const user = useAuthStore.getState().user;
    const userId = user?.id || 'local-user';
    // 乐观更新
    set((state) => ({
      entries: state.entries.map((e) => {
        if (e.id !== id) return e;
        const likedBy = Array.isArray(e.likedBy) ? [...e.likedBy] : [];
        const idx = likedBy.indexOf(userId);
        if (idx >= 0) likedBy.splice(idx, 1);
        else likedBy.push(userId);
        return { ...e, likedBy, likes: likedBy.length };
      }),
    }));
    try {
      await fetch(`/api/cobuild/${id}/like`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
    } catch {
      // 离线时保留乐观结果
    }
  },

  addComment: async (id, text) => {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    const user = useAuthStore.getState().user;
    const userId = user?.id || 'local-user';
    const optimistic: CoBuildComment = {
      id: `local_${Date.now()}`,
      userId,
      userEmail: maskEmailForDisplay(user?.email),
      text: trimmed,
      createdAt: new Date().toISOString(),
    };
    set((state) => ({
      entries: state.entries.map((e) =>
        e.id === id ? { ...e, comments: [...(e.comments || []), optimistic] } : e,
      ),
    }));
    try {
      await fetch(`/api/cobuild/${id}/comment`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ text: trimmed }),
      });
    } catch {
      // 离线时保留乐观结果
    }
  },

  reset: () => set({ entries: [], loading: false, submitting: false, error: '' }),
}));

export function maskCobuildEmail(email?: string) {
  return maskEmailForDisplay(email);
}
