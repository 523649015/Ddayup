// Media URL classification and local-route extraction helpers.
// Single-sourced from hmdao-api.mjs to keep the main file lean and DRY.
import net from 'node:net';
import {
  isManagedPublicRelayAssetUrl,
  parseInlineDataUrl,
} from './parse-utils.mjs';

// True for loopback / private / link-local / ULA hostnames and IPs.
export function isPrivateOrLocalHostname(hostname = '') {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized) return true;
  if (
    normalized === 'localhost'
    || normalized === '0.0.0.0'
    || normalized === '::1'
    || normalized.endsWith('.local')
    || normalized.endsWith('.lan')
    || normalized.endsWith('.internal')
  ) {
    return true;
  }
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    if (normalized.startsWith('10.')) return true;
    if (normalized.startsWith('127.')) return true;
    if (normalized.startsWith('192.168.')) return true;
    if (normalized.startsWith('169.254.')) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return true;
    return false;
  }
  if (ipVersion === 6) {
    if (normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('fe80:')) return true;
    return false;
  }
  return false;
}

// Returns the normalized "/path?search" of a managed local route reference, or
// '' when the value is not a same-origin / relay-hosted asset URL.
export function extractManagedLocalRoutePath(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/api/')) return raw;
  try {
    const url = new URL(raw);
    if (!isPrivateOrLocalHostname(url.hostname) && !isManagedPublicRelayAssetUrl(raw)) return '';
    return `${url.pathname}${url.search}`;
  } catch {
    return '';
  }
}

// True for absolute http(s) URLs whose host is a public (non-private) remote
// host (data:/blob:/file:/hmdao-local: are NOT considered public remote).
export function isPublicRemoteMediaUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^(data:|blob:|file:|hmdao-local:\/\/)/i.test(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return !isPrivateOrLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

// True when the reference points only to local/private storage that must be
// inlined before being sent to a cloud upstream.
export function isLocalOnlyMediaReference(value = '') {
  const source = String(value || '').trim();
  if (!source || parseInlineDataUrl(source)?.buffer?.length) return false;
  if (extractManagedLocalRoutePath(source)) return true;
  if (/^file:\/\//i.test(source)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('\\\\')) return true;
  try {
    const url = new URL(source);
    return isPrivateOrLocalHostname(url.hostname);
  } catch {
    return false;
  }
}
