const LOCAL_CANVAS_DEMO_MODES = new Set([
  'video-local-edit',
  'media-proxy',
  'canvas-migration',
  'reference-consistency',
  'tagging-contract',
]);

function readWindowLocation() {
  if (typeof window === 'undefined') return null;
  return window.location;
}

export function getActiveHmdaoDemoMode(href?: string): string {
  const location = readWindowLocation();
  const sourceHref = typeof href === 'string' && href.trim()
    ? href
    : location?.href;
  if (!sourceHref) return '';
  try {
    return String(new URL(sourceHref).searchParams.get('hmdao-demo') || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

export function isLocalCanvasDemoHost(hostname?: string): boolean {
  const location = readWindowLocation();
  const sourceHostname = typeof hostname === 'string' && hostname.trim()
    ? hostname
    : String(location?.hostname || '').trim().toLowerCase();
  return Boolean(
    import.meta.env.DEV
    || sourceHostname === '127.0.0.1'
    || sourceHostname === 'localhost'
  );
}

export function allowsLocalCanvasDemoAccess(href?: string, hostname?: string): boolean {
  return isLocalCanvasDemoHost(hostname) && LOCAL_CANVAS_DEMO_MODES.has(getActiveHmdaoDemoMode(href));
}

