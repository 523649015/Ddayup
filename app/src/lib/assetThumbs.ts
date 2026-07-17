export function buildEnvironmentThumbnail(label: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="#0f766e"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><circle cx="248" cy="56" r="30" fill="#fcd34d" opacity="0.8"/><text x="24" y="84" fill="#f8fafc" font-family="Arial, sans-serif" font-size="20" font-weight="700">HDRI</text><text x="24" y="116" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="14">${String(label || 'environment').replace(/[<>&]/g, '')}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
