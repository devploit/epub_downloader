export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_BOOK_BYTES = 256 * 1024 * 1024;
export const MAX_FILES = 10000;

export function siteUrl(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !(url.hostname === "epub.pub" || url.hostname.endsWith(".epub.pub"))) {
    throw new Error("Only HTTPS URLs on epub.pub and its subdomains are supported.");
  }
  url.hash = "";
  return url;
}

export function archiveRoot(value) {
  const url = siteUrl(value);
  const match = url.pathname.match(/^(.+?\.epub)(?:\/|$)/i);
  if (!match) return null;
  url.pathname = `${match[1]}/`;
  url.search = "";
  return url.href;
}

export function discover(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const candidates = [];
  const assetIds = new Set();
  for (const element of doc.querySelectorAll("#assetUrl, [name='assetUrl'], [data-asset-url], iframe[src], a[href]")) {
    const value = element.getAttribute("value") || element.getAttribute("data-asset-url") ||
      element.getAttribute("src") || element.getAttribute("href");
    if (value) candidates.push(value);
  }
  // Read configuration strings without executing scripts from the site.
  for (const script of doc.scripts) {
    const sources = [script.textContent];
    // Current book pages pass the reader's assetId through Next.js Flight data.
    // Decode only JSON string literals, never evaluate the surrounding script.
    for (const match of script.textContent.matchAll(/self\.__next_f\.push\(\s*\[\s*1\s*,\s*("(?:\\.|[^"\\])*")\s*\]\s*\)/g)) {
      try { sources.push(JSON.parse(match[1])); } catch { /* Ignore malformed stream chunks. */ }
    }
    for (const text of sources) {
      const source = text.replace(/\\\//g, "/").replace(/\\u002[fF]/g, "/");
      candidates.push(...(source.match(/https?:\/\/[^\s"'<>`\\]+\.(?:opf|epub)(?:\?[^\s"'<>`\\]*)?/gi) || []));
    }
    for (const source of sources.slice(1)) {
      for (const match of source.matchAll(/"assetId"\s*:\s*"([a-f0-9]{24})"/gi)) assetIds.add(match[1]);
    }
  }
  for (const candidate of candidates) {
    try {
      const url = siteUrl(candidate, pageUrl);
      if (archiveRoot(url.href)) return url.href;
    } catch { /* Unrelated links on the book page are not download candidates. */ }
  }
  for (const element of doc.querySelectorAll("[data-readid][data-domain]")) {
    return siteUrl(`/epub/${encodeURIComponent(element.dataset.readid)}`, siteUrl(element.dataset.domain, pageUrl)).href;
  }
  for (const candidate of candidates) {
    try {
      const url = siteUrl(candidate, pageUrl);
      if (/^\/epub\/[^/]+\/?$/.test(url.pathname)) return url.href;
    } catch { /* Ignore unrelated navigation. */ }
  }
  if (assetIds.size === 1 && [...doc.querySelectorAll("button, a")].some(element => /read\s+online/i.test(element.textContent))) {
    return `https://spread.epub.pub/epub/${[...assetIds][0]}`;
  }
  throw new Error("No EPUB reader was found. Open Read Online on the site, then paste that reader URL.");
}

export function xml(bytes, label) {
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");
  if (doc.querySelector("parsererror")) throw new Error(`Invalid XML in ${label}. The server may have returned a verification page.`);
  return doc;
}

export function resource(root, href, base = root) {
  if (!href || href.includes("\\")) throw new Error(`Invalid resource path: ${href}`);
  const url = siteUrl(href, base);
  const rootUrl = new URL(root);
  if (url.origin !== rootUrl.origin || !url.pathname.startsWith(rootUrl.pathname)) {
    throw new Error(`Resource outside the EPUB archive: ${href}`);
  }
  const path = decodeURIComponent(url.pathname.slice(rootUrl.pathname.length));
  if (!path || path.split("/").some(part => !part || part === "." || part === "..") || /[\\\x00-\x1f\x7f]/.test(path)) {
    throw new Error(`Unsafe archive path: ${href}`);
  }
  return { url: url.href, path };
}

export function packagePaths(bytes) {
  const doc = xml(bytes, "container.xml");
  if (doc.documentElement.localName !== "container") throw new Error("Missing EPUB container.");
  const paths = [...doc.getElementsByTagNameNS("*", "rootfile")].map(node => node.getAttribute("full-path"));
  if (!paths.length || paths.some(path => !path || path.startsWith("/") || path.split("/").includes(".."))) {
    throw new Error("The EPUB container has no valid package paths.");
  }
  // Container full-path is a file path; manifest href is a URL.
  return [...new Set(paths)].map(path => path.split("/").map(encodeURIComponent).join("/"));
}

export function packageInfo(bytes, root, opfUrl) {
  const doc = xml(bytes, "package document");
  if (doc.documentElement.localName !== "package") throw new Error("Missing EPUB package document.");
  const manifest = [...doc.getElementsByTagNameNS("*", "manifest")][0];
  const spine = [...doc.getElementsByTagNameNS("*", "spine")][0];
  if (!manifest || !spine) throw new Error("The EPUB package is missing its manifest or reading order.");
  const items = [...manifest.children].filter(node => node.localName === "item");
  const ids = new Set();
  const files = items.map(item => {
    const id = item.getAttribute("id");
    if (!id || ids.has(id)) throw new Error("The EPUB manifest contains missing or duplicate IDs.");
    ids.add(id);
    if ((item.getAttribute("properties") || "").split(/\s+/).includes("remote-resources")) {
      throw new Error("This EPUB declares remote resources and cannot be saved completely offline.");
    }
    return { ...resource(root, item.getAttribute("href"), opfUrl), type: item.getAttribute("media-type") || "" };
  });
  const order = [...spine.children].filter(node => node.localName === "itemref");
  if (!order.length || order.some(node => !ids.has(node.getAttribute("idref")))) {
    throw new Error("The EPUB reading order refers to missing chapters.");
  }
  return { files, title: doc.getElementsByTagNameNS("*", "title")[0]?.textContent.trim() || "book" };
}

export function filename(title) {
  return (title.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 120) || "book") + ".epub";
}

export async function collectBook(root, fetchFile, progress, signal) {
  const entries = new Map();
  let totalBytes = 0;
  function add(path, bytes) {
    if (entries.has(path)) throw new Error(`Duplicate archive entry: ${path}`);
    totalBytes += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || totalBytes > MAX_BOOK_BYTES || entries.size >= MAX_FILES) {
      throw new Error("This book exceeds the limit of 32 MiB per file, 256 MiB per book, or 10,000 files.");
    }
    entries.set(path, bytes);
  }
  async function get(item, optional = false) {
    signal.throwIfAborted();
    const bytes = await fetchFile(item.url, optional, item.type || "");
    signal.throwIfAborted();
    if (bytes !== null) {
      if (!bytes.length && item.type !== "text/css") throw new Error(`Empty EPUB resource: ${item.path}`);
      if (item.type === "application/xhtml+xml" && xml(bytes, item.path).documentElement.localName !== "html") {
        throw new Error(`Invalid XHTML chapter: ${item.path}`);
      }
      add(item.path, bytes);
    }
    return bytes;
  }
  add("mimetype", new TextEncoder().encode("application/epub+zip"));
  progress("Reading the EPUB container…");
  const container = await get(resource(root, "META-INF/container.xml"));
  const packages = packagePaths(container);
  let title;
  const files = new Map();
  for (const path of packages) {
    const item = resource(root, path);
    const bytes = await get(item);
    const info = packageInfo(bytes, root, item.url);
    title ||= info.title;
    for (const file of info.files) {
      const previous = files.get(file.path);
      if (previous && previous.url !== file.url) throw new Error(`Conflicting resource URLs: ${file.path}`);
      files.set(file.path, file);
    }
  }
  if (files.size + entries.size > MAX_FILES) throw new Error("The EPUB contains too many files.");
  for (const name of ["encryption.xml", "rights.xml", "metadata.xml", "manifest.xml", "signatures.xml"]) {
    progress(`Checking META-INF/${name}…`);
    const bytes = await get(resource(root, `META-INF/${name}`), true);
    if (bytes) {
      const doc = xml(bytes, name);
      if (name === "encryption.xml") {
        for (const method of doc.getElementsByTagNameNS("*", "EncryptionMethod")) {
          if (!["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"].includes(method.getAttribute("Algorithm"))) {
            throw new Error("This EPUB uses unsupported encryption. No file was saved.");
          }
        }
      }
    }
  }
  let completed = 0;
  for (const file of files.values()) {
    progress(`Downloading ${file.path}`, completed, files.size);
    if (!entries.has(file.path)) await get(file);
    progress(`Downloaded ${file.path}`, ++completed, files.size);
  }
  return { entries, title, totalBytes };
}
