# EPUB Downloader by devploit

Save complete EPUB books from epub.pub using your browser session.
No server, account, Node.js, Python, or build step is needed to use this extension.

## Install

Use Chrome 120+, or a recent Chromium-based Edge or Brave. Firefox and Safari are
not supported. Chrome/Chromium is verified; Edge and Brave are not separately tested.

1. Extract `epub-downloader-extension.zip`.
2. Open `chrome://extensions`, `edge://extensions`, or `brave://extensions`.
3. Enable **Developer mode** and select **Load unpacked**.
4. Choose the extracted folder containing `manifest.json`.
5. Pin **EPUB Downloader by devploit** from the extensions menu.

If installing from the source repository, select its `extension` directory instead.
Keep this directory on your computer: the browser loads the extension from it.

## Download a book

1. Click the extension icon to open the downloader.
2. Paste an epub.pub book page, a Read Online URL on `spread.epub.pub` or
   `continuous.epub.pub`, or an expanded `.epub` archive URL on `asset.epub.pub`.
   An `.opf` URL inside that archive also works.
3. Select **Download EPUB**. Keep the downloader and source tabs open.
4. If verification is requested, select **Open source tab**, complete the site's
   verification, return to the downloader, and select **Resume download**.
5. Choose where to save the EPUB. **Saved** confirms the browser finished saving it.

**Cancel** stops the current task. **Save EPUB** retries a cancelled save without
fetching the book again. Source tabs remain open afterward.

## Troubleshooting

- **No EPUB reader was found:** open Read Online on the site and paste that URL
  into the downloader. This is different from a verification challenge.
- **Verification or access required:** open the source tab and check access.
  Browser sessions do not guarantee access through Cloudflare, and challenges
  are not solved automatically.
- **Missing resource or HTTP error:** check the source tab and retry. The extension
  stops rather than offering a partial EPUB.
- **Source tab closed:** start again and keep the source tabs open.
- **Updating the extension:** replace its files, reload it in the browser's
  extension manager, and reopen the downloader.

## Privacy and permissions

All files are fetched through epub.pub tabs and assembled locally. The extension
has no analytics, remote scripts, external backend, or account system. It does
not export cookies; requests use the existing browser session.

- `scripting`: read source pages and fetch book resources inside their tabs.
- `downloads`: save the EPUB and confirm completion.
- Host access: HTTPS epub.pub and its subdomains only.

## Limits

- Includes all resources declared in the EPUB manifest, preserving their bytes,
  metadata and reading order. Undeclared dependencies cannot be reliably recovered.
- Requires an expanded EPUB archive. Plain chapter pages and arbitrary standalone
  EPUB/ZIP downloads are unsupported.
- External resources and remote-resource declarations are rejected.
- Font-obfuscation metadata is preserved; other encryption is unsupported.
- Maximum 32 MiB per resource, 256 MiB per book, and 10,000 entries.
- Progress is held in memory. Closing or reloading the downloader discards it.
- ZIP STORE preserves uncompressed entries; output may be larger than the original.

Maintained by devploit. Distributed under the MIT license included in `LICENSE`.
