const STORAGE_KEY_PREFIX = 'hmdao_enc_k_';
const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const PBKDF2_ITERATIONS = 100_000;
const SALT_PREFIX = 'hmdao_salt_v2_';

export interface EncryptedPayload {
  iv: string;
  ciphertext: string;
  version: number;
}

export class SecureKeyStore {
  private cryptoKey: CryptoKey | null = null;
  private initialized = false;
  private sessionSecret: string | null = null;

  async init(sessionSecret: string): Promise<void> {
    this.sessionSecret = sessionSecret;

    if (!this.isCryptoAvailable()) {
      this.cryptoKey = null;
      this.initialized = true;
      return;
    }

    this.cryptoKey = await this.deriveKey(sessionSecret);
    this.initialized = true;
  }

  isReady(): boolean {
    return this.initialized;
  }

  async store(provider: string, apiKey: string): Promise<void> {
    this.ensureInitialized();

    if (!this.cryptoKey) {
      sessionStorage.setItem(`${STORAGE_KEY_PREFIX}${provider}`, apiKey);
      return;
    }

    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: ALGORITHM, iv },
      this.cryptoKey,
      encoder.encode(apiKey),
    );

    const payload: EncryptedPayload = {
      iv: this.arrayBufferToBase64(iv.buffer),
      ciphertext: this.arrayBufferToBase64(ciphertext),
      version: 2,
    };

    localStorage.setItem(`${STORAGE_KEY_PREFIX}${provider}`, JSON.stringify(payload));
  }

  async retrieve(provider: string): Promise<string | null> {
    this.ensureInitialized();

    if (!this.cryptoKey) {
      return sessionStorage.getItem(`${STORAGE_KEY_PREFIX}${provider}`);
    }

    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${provider}`);
    if (!raw) return null;

    try {
      const payload = JSON.parse(raw) as EncryptedPayload;
      const iv = this.base64ToArrayBuffer(payload.iv);
      const ciphertext = this.base64ToArrayBuffer(payload.ciphertext);
      const plaintext = await crypto.subtle.decrypt(
        { name: ALGORITHM, iv: new Uint8Array(iv) },
        this.cryptoKey,
        ciphertext,
      );
      return new TextDecoder().decode(plaintext);
    } catch (error) {
      console.error('[SecureKeyStore] Failed to decrypt key, removing corrupted entry.', error);
      this.remove(provider);
      return null;
    }
  }

  remove(provider: string): void {
    localStorage.removeItem(`${STORAGE_KEY_PREFIX}${provider}`);
    sessionStorage.removeItem(`${STORAGE_KEY_PREFIX}${provider}`);
  }

  clearAll(): void {
    const localKeys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(STORAGE_KEY_PREFIX)) localKeys.push(key);
    }
    for (const key of localKeys) localStorage.removeItem(key);

    const sessionKeys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(STORAGE_KEY_PREFIX)) sessionKeys.push(key);
    }
    for (const key of sessionKeys) sessionStorage.removeItem(key);
  }

  listProviders(): string[] {
    const providers = new Set<string>();
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(STORAGE_KEY_PREFIX)) providers.add(key.slice(STORAGE_KEY_PREFIX.length));
    }
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(STORAGE_KEY_PREFIX)) providers.add(key.slice(STORAGE_KEY_PREFIX.length));
    }
    return Array.from(providers);
  }

  async rotateKey(oldSecret: string, nextSecret: string, providers: string[]): Promise<void> {
    if (!providers.length || oldSecret === nextSecret) {
      await this.init(nextSecret);
      return;
    }

    await this.init(oldSecret);
    const entries = await Promise.all(
      providers.map(async (provider) => ({ provider, apiKey: await this.retrieve(provider) })),
    );

    await this.init(nextSecret);
    for (const entry of entries) {
      if (entry.apiKey) await this.store(entry.provider, entry.apiKey);
    }
  }

  destroy(): void {
    this.cryptoKey = null;
    this.sessionSecret = null;
    this.initialized = false;
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.sessionSecret) {
      throw new Error('[SecureKeyStore] Store has not been initialized.');
    }
  }

  private async deriveKey(sessionSecret: string): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const salt = encoder.encode(`${SALT_PREFIX}${sessionSecret.slice(0, 16)}`);
    const baseKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(sessionSecret),
      'PBKDF2',
      false,
      ['deriveKey'],
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      baseKey,
      { name: ALGORITHM, length: KEY_LENGTH },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  private isCryptoAvailable(): boolean {
    return (
      typeof crypto !== 'undefined' &&
      typeof crypto.subtle !== 'undefined' &&
      typeof crypto.getRandomValues === 'function'
    );
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let index = 0; index < bytes.byteLength; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }
}

export const secureKeyStore = new SecureKeyStore();
