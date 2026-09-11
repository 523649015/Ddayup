# Microsoft Edge Add-ons Listing Copy (English - United States)

## Extension name
Ddayup Web Clipper
> Note: Edge currently shows "Ddayup网页素材采集扩展" from manifest.json. If you want the English name above, update `name` in `extension/manifest.json`, rebuild `dist-store/Ddayup-extension.zip`, and re-upload.

## Description (>= 250 characters)
Ddayup is a browser-side media collector built for designers, creators, and developers. With one click on the side panel, it scans the active webpage and discovers publicly accessible images, videos, audio clips, and 3D model files. Users can preview assets instantly, download individual or batch items to a custom local folder, and import captured links into the local Ddayup asset library. The extension also detects network streams from media sites, injects required Referer headers for protected CDNs, and integrates with a local native host for advanced downloads. All scanning happens only after user action; no personal data is collected or uploaded.

## Search terms (up to 7, 30 chars each, 21 words total)
1. media downloader
2. image downloader
3. video downloader
4. audio downloader
5. 3D model
6. web clipper
7. asset collector

## Image assets to upload
- Extension logo: `dist-store/store-assets/extension-logo.png` (300 × 300 px)
- Small promotional tile: `dist-store/store-assets/small-promo-tile.png` (440 × 280 px)
- Screenshot/s: `dist-store/store-assets/screenshot-1.png` (1280 × 800 px)
- Large promotional tile: `dist-store/store-assets/large-promo-tile.png` (1400 × 560 px)


## Notes for certification (testers only, < 2,000 characters)
```
This extension is a local media collector. After installing, click the Ddayup icon in the browser toolbar to open the side panel. Visit any public webpage (for example Pexels, Unsplash, YouTube, Bilibili, or any page containing <img>, <video>, or <audio> tags) and click "Scan page" in the side panel. The extension will list publicly accessible images, videos, audio files, and 3D model links found on the page or captured from network requests. Click any item to preview; click Save to download it to the default Downloads folder.

No user accounts or third-party service logins are required for basic scanning. For sites that require authentication (for example paid stock sites), the user must already be logged in in the browser; the extension does not provide or store credentials.

A local native host (ddayup-host) is available separately for advanced downloads from YouTube/Bilibili. It is optional and not required for the core extension to pass certification. The native host installer and instructions are provided on the extension's homepage after publication.

All permissions declared in the manifest are used only for local media discovery and download (tabs, scripting, webRequest, downloads, storage, sidePanel, clipboardWrite, nativeMessaging, cookies, declarativeNetRequest). No user data is uploaded to any server.
```

## YouTube video URL
Leave blank (optional).
