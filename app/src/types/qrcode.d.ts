// qrcode 浏览器端为 CJS 具名导出（无 default），统一用具名导入
declare module 'qrcode' {
  export interface QRCodeToDataURLOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    type?: 'image/png' | 'image/jpeg' | 'image/webp';
    margin?: number;
    width?: number;
    color?: { dark?: string; light?: string };
  }
  function toDataURL(text: string | URL, opts?: QRCodeToDataURLOptions): Promise<string>;
  function toString(text: string | URL, opts?: QRCodeToDataURLOptions): Promise<string>;
  const _default: { toDataURL: typeof toDataURL; toString: typeof toString };
  export default _default;
}
