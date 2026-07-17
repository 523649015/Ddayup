import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useApiKeyStore } from '@/store/useApiKeyStore';

export interface AuthUser {
  id: string;
  email: string;
  createdAt: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const AUTH_STORAGE_KEY = 'hmdao-auth-storage';

interface PersistedAuthSnapshot {
  user: AuthUser | null;
  session: AuthSession | null;
}

interface AuthState {
  user: AuthUser | null;
  session: AuthSession | null;
  hasHydrated: boolean;
  isLoading: boolean;
  setUser: (user: AuthUser | null) => void;
  setSession: (session: AuthSession | null) => void;
  setLoading: (loading: boolean) => void;
  setHasHydrated: (hydrated: boolean) => void;
  syncFromStorage: () => void;
  isAuthenticated: () => boolean;
  isSessionExpired: () => boolean;
  logout: () => void;
}

function isValidAuthUser(value: unknown): value is AuthUser {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as AuthUser).id === 'string'
    && typeof (value as AuthUser).email === 'string'
    && typeof (value as AuthUser).createdAt === 'string',
  );
}

function isValidAuthSession(value: unknown): value is AuthSession {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as AuthSession).accessToken === 'string'
    && typeof (value as AuthSession).refreshToken === 'string'
    && Number.isFinite(Number((value as AuthSession).expiresAt)),
  );
}

function parsePersistedAuthStorage(raw: string | null): PersistedAuthSnapshot | null {
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as { state?: { user?: unknown; session?: unknown } };
    const user = isValidAuthUser(payload?.state?.user) ? payload.state.user : null;
    const session = isValidAuthSession(payload?.state?.session)
      ? { ...payload.state.session, expiresAt: Number(payload.state.session.expiresAt) }
      : null;
    return { user, session };
  } catch {
    return null;
  }
}

function readPersistedAuthSnapshot(): PersistedAuthSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    return parsePersistedAuthStorage(window.localStorage.getItem(AUTH_STORAGE_KEY));
  } catch {
    return null;
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      session: null,
      hasHydrated: false,
      isLoading: false,

      setUser: (user) => set({ user }),
      setSession: (session) => set({ session }),
      setLoading: (isLoading) => set({ isLoading }),
      setHasHydrated: (hasHydrated) => set({ hasHydrated }),
      syncFromStorage: () => {
        const persisted = readPersistedAuthSnapshot();
        const current = get();
        if (!persisted?.user || !persisted?.session) {
          if (current.user || current.session) {
            set({ user: null, session: null });
            useApiKeyStore.getState().clearRuntimeKeys();
          }
          if (!current.hasHydrated) {
            set({ hasHydrated: true });
          }
          return;
        }

        if (Date.now() > persisted.session.expiresAt) {
          set({ user: null, session: null, hasHydrated: true });
          void useApiKeyStore.getState().clearAll();
          useApiKeyStore.getState().clearRuntimeKeys();
          try {
            window.localStorage.removeItem(AUTH_STORAGE_KEY);
          } catch {
            // ignore storage errors
          }
          return;
        }

        const sameUser = current.user?.id === persisted.user.id
          && current.user?.email === persisted.user.email
          && current.user?.createdAt === persisted.user.createdAt;
        const sameSession = current.session?.accessToken === persisted.session.accessToken
          && current.session?.refreshToken === persisted.session.refreshToken
          && current.session?.expiresAt === persisted.session.expiresAt;

        if (!sameUser || !sameSession) {
          set({
            user: persisted.user,
            session: persisted.session,
            hasHydrated: true,
          });
          if (persisted.session.refreshToken && current.session?.refreshToken !== persisted.session.refreshToken) {
            void useApiKeyStore.getState().initSecureStore(persisted.session.refreshToken);
          }
          return;
        }

        if (!current.hasHydrated) {
          set({ hasHydrated: true });
        }
      },

      isAuthenticated: () => {
        const { user, session } = get();
        return Boolean(user && session && Date.now() <= session.expiresAt);
      },

      isSessionExpired: () => {
        const { session } = get();
        return !session || Date.now() > session.expiresAt;
      },

      logout: () => {
        set({ user: null, session: null });
        useApiKeyStore.getState().clearRuntimeKeys();
        if (typeof window !== 'undefined') {
          try {
            window.localStorage.removeItem(AUTH_STORAGE_KEY);
          } catch {
            // ignore storage errors
          }
        }
      },
    }),
    {
      name: AUTH_STORAGE_KEY,
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);

        if (state?.session && Date.now() > state.session.expiresAt) {
          state.setSession(null);
          state.setUser(null);
          void useApiKeyStore.getState().clearAll();
          useApiKeyStore.getState().clearRuntimeKeys();
          return;
        }

        if (state?.session?.refreshToken) {
          void useApiKeyStore.getState().initSecureStore(state.session.refreshToken);
        } else {
          useApiKeyStore.getState().clearRuntimeKeys();
        }
      },
    },
  ),
);

let authStorageSyncInitialized = false;

function initializeAuthStorageSync() {
  if (authStorageSyncInitialized || typeof window === 'undefined') return;
  authStorageSyncInitialized = true;

  const sync = () => {
    useAuthStore.getState().syncFromStorage();
  };

  window.addEventListener('storage', (event) => {
    if (!event.key || event.key === AUTH_STORAGE_KEY) {
      sync();
    }
  });
  window.addEventListener('focus', sync);
  window.addEventListener('pageshow', sync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sync();
    }
  });

  queueMicrotask(sync);
}

initializeAuthStorageSync();
