/**
 * Ddayup 网页素材采集扩展 · Edge 加载项商店地址
 *
 * ⚠️ 链接稳定性说明（重要）：
 *   该 URL 由扩展的 CRX ID（产品身份）决定，与版本号【无关】。
 *   后续每次用 update-edge-store.ps1 提交新版本，都是发布到同一个产品下，
 *   因此本链接【永久不变】，无需随版本同步修改。
 *   仅当「另建一个全新产品」时 ID 才会不同。
 *
 * 相关标识（分类存档，勿混用）：
 *   - CRX ID（= 商店链接用）      : jpcnchdcjaapokighokneachmbkeafan
 *   - Store ID                     : 0RDCK9QLWJWP
 *   - Product ID（上传 API 用 GUID）: 2f6d8ab3-b73e-4bce-b35a-356cd96cf8af
 */
export const EXTENSION_STORE_URL =
  'https://microsoftedge.microsoft.com/addons/detail/ddayup%E7%BD%91%E9%A1%B5%E7%B4%A0%E6%9D%90%E9%87%87%E9%9B%86%E6%89%A9%E5%B1%95/jpcnchdcjaapokighokneachmbkeafan';

/** 短链形式（省略中文 slug），与上面等价，适合文案排版受限处使用 */
export const EXTENSION_STORE_SHORT_URL =
  'https://microsoftedge.microsoft.com/addons/detail/jpcnchdcjaapokighokneachmbkeafan';

/** 当前仅在 Edge 上架；Chrome 版（Chrome Web Store）尚未上架 */
export const EXTENSION_CHROME_STORE_URL: string | null = null;
