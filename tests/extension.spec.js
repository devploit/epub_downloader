import { test as base, expect, chromium } from "@playwright/test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = "https://asset.epub.pub/epub/sample.epub/";
const BOOK = "https://www.epub.pub/book/sample";
const READER = "https://spread.epub.pub/epub/sample";
const container = `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:sample</dc:identifier><dc:title>A Sample Book</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="chapter" href="Text/chapter%201.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="../Styles/main.css" media-type="text/css"/><item id="cover" href="Images/cover.png" media-type="image/png" properties="cover-image"/></manifest><spine><itemref idref="chapter"/></spine></package>`;
const chapter = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter One</title><link rel="stylesheet" type="text/css" href="../../Styles/main.css"/></head><body><h1>A sample chapter</h1><p>A complete, offline book.</p><img src="../Images/cover.png" alt="Cover"/></body></html>`;
const nav = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="Text/chapter%201.xhtml">Chapter One</a></li></ol></nav></body></html>`;
const cover = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const resources = new Map([
  ["META-INF/container.xml", ["application/xml", container]],
  ["OPS/package.opf", ["application/oebps-package+xml", opf]],
  ["OPS/Text/chapter%201.xhtml", ["application/xhtml+xml", chapter]],
  ["OPS/nav.xhtml", ["application/xhtml+xml", nav]],
  ["Styles/main.css", ["text/css", "body { color: #123; }"]],
  ["OPS/Images/cover.png", ["image/png", cover]]
]);

const test = base.extend({
  browserApp: async ({}, use, testInfo) => {
    const profile = await mkdtemp(path.join(tmpdir(), "epub-extension-test-"));
    const extension = path.resolve("extension");
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chromium", headless: true, acceptDownloads: true,
      downloadsPath: testInfo.outputPath("downloads"),
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    const errors = [];
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    let worker = context.serviceWorkers()[0];
    worker ||= await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/app.html`);
    await use({ page, context, errors });
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("browser-state", {
        body: JSON.stringify(await Promise.all(context.pages().map(async tab => ({ url: tab.url(), text: await tab.locator("body").innerText().catch(() => "Unavailable") }))), null, 2),
        contentType: "application/json"
      });
    }
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

async function mockSite(context, overrides = new Map()) {
  const requests = [];
  await context.route(/^https:\/\/(?:[^/]+\.)?epub\.pub\//, async route => {
    const request = route.request();
    const url = request.url();
    requests.push({ url, document: request.frame().url(), navigation: request.isNavigationRequest() });
    if (overrides.has(url)) return route.fulfill(await overrides.get(url)(request));
    if (url === BOOK) return route.fulfill({ contentType: "text/html", body: '<a class="btn-read" data-domain="https://spread.epub.pub" data-readid="sample">Read Online</a>' });
    if (url === READER) return route.fulfill({ contentType: "text/html", body: `<input id="assetUrl" value="${ROOT}OPS/package.opf">` });
    const entry = url.startsWith(ROOT) && resources.get(url.slice(ROOT.length));
    if (entry) return route.fulfill({ contentType: entry[0], body: entry[1] });
    return route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
  });
  // Attach test routing before navigation. Chromium does not expose the first
  // request from chrome.tabs.create to Playwright interception in all versions.
  // These also exercise reuse of tabs with an existing browser session.
  for (const url of [BOOK, READER, new URL(ROOT).origin]) {
    const tab = await context.newPage();
    await tab.goto(url);
  }
  requests.length = 0;
  return requests;
}

async function start(page, url = BOOK) {
  await page.locator("#book-url").fill(url);
  await page.locator("#start").click();
}

test("book page to complete saved EPUB through real extension and same-origin tab requests", async ({ browserApp }, testInfo) => {
  const { page, context, errors } = browserApp;
  const requests = await mockSite(context);
  await start(page);
  await expect(page.locator("#phase")).toHaveText("Saved");
  const download = await page.evaluate(async () => (await chrome.downloads.search({ limit: 1, orderBy: ["-startTime"] }))[0]);
  await expect(page.locator("#status")).toHaveText("A Sample Book.epub is ready to read offline.");
  await copyFile(download.filename, testInfo.outputPath("sample.epub"));
  // Independently check CRCs, stored mimetype, filenames and exact source bytes.
  const report = execFileSync("python3", ["-c", "import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({'names':z.namelist(),'first':z.infolist()[0].compress_type,'extra':len(z.infolist()[0].extra),'mime':z.read('mimetype').decode(),'chapter':z.read('OPS/Text/chapter 1.xhtml').decode(),'opf':z.read('OPS/package.opf').decode(),'cover':list(z.read('OPS/Images/cover.png'))}))", download.filename], { encoding: "utf8" });
  const zip = JSON.parse(report);
  expect(zip.names).toEqual(["mimetype", "META-INF/container.xml", "OPS/package.opf", "OPS/Text/chapter 1.xhtml", "OPS/nav.xhtml", "Styles/main.css", "OPS/Images/cover.png"]);
  expect(zip.first).toBe(0);
  expect(zip.extra).toBe(0);
  expect(zip.mime).toBe("application/epub+zip");
  expect(zip.chapter).toBe(chapter);
  expect(zip.opf).toBe(opf);
  expect(zip.cover).toEqual([...cover]);
  expect(requests.filter(request => !request.navigation && request.url.startsWith(ROOT)).every(request => new URL(request.document).origin === new URL(ROOT).origin)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("saved.png"), fullPage: true });
});

test("verification pauses and resumes the failed resource without restarting the book", async ({ browserApp }) => {
  const { page, context } = browserApp;
  let verified = false;
  const blocked = `${ROOT}OPS/Text/chapter%201.xhtml`;
  const requests = await mockSite(context, new Map([[blocked, async () => verified ?
    { contentType: "application/xhtml+xml", body: chapter } :
    { contentType: "text/html", body: '<title>Just a moment...</title><form id="challenge-form"></form>' }
  ]]));
  await start(page);
  await expect(page.locator("#verification")).toBeVisible();
  await expect(page.locator("#phase")).toHaveText("Waiting for you");
  await page.locator("#open-source").click();
  await expect.poll(() => context.pages().some(tab => tab.url() === blocked)).toBe(true);
  verified = true;
  await context.pages().find(tab => tab.url() === blocked).reload();
  await page.locator("#resume").click();
  await expect(page.locator("#phase")).toHaveText("Saved");
  expect(requests.filter(request => request.url === `${ROOT}OPS/package.opf`)).toHaveLength(1);
});

test("a missing resource never produces an incomplete EPUB", async ({ browserApp }) => {
  const { page, context } = browserApp;
  await mockSite(context, new Map([[`${ROOT}OPS/Images/cover.png`, async () => ({ status: 404, body: "Missing" })]]));
  await start(page, READER);
  await expect(page.locator("#error")).toContainText("HTTP 404");
  await expect(page.locator("#status")).toHaveText("No incomplete EPUB was saved.");
  await expect(page.locator("#save")).toBeHidden();
  expect(await page.evaluate(() => chrome.downloads.search({}))).toEqual([]);
});

test("current Next.js book buttons resolve their streamed asset ID", async ({ browserApp }) => {
  const { page, context } = browserApp;
  const assetId = "6808f5c0faf19e058cacba36";
  const payload = '27:["$","$L30",null,{"assetId":"' + assetId + '"}]\n28:["$","$L31",null,{"postId":"6808f5c07667f95f0f0fa7fb"}]\n';
  await mockSite(context, new Map([
    [BOOK, async () => ({ contentType: "text/html", body: `<button type="button" class="btn-read" title="Read Online (Swipe)">Read Online (Swipe)</button><script>self.__next_f=[];self.__next_f.push([1,${JSON.stringify(payload)}])</script>` })],
    [`https://spread.epub.pub/epub/${assetId}`, async () => ({ contentType: "text/html", body: `<script>self.__next_f=[];self.__next_f.push([1,${JSON.stringify(`5:["$","$L10",null,{"url":"${ROOT}OPS/package.opf","assetId":"${assetId}"}]\n`)}])</script>` })]
  ]));
  const reader = await context.newPage();
  await reader.goto(`https://spread.epub.pub/epub/${assetId}`);
  await start(page);
  await expect(page.locator("#phase")).toHaveText("Saved");
  await expect(page.locator("#verification")).toBeHidden();
});

test("missing reader stops with an actionable error instead of a verification loop", async ({ browserApp }) => {
  const { page, context } = browserApp;
  await mockSite(context, new Map([[BOOK, async () => ({ contentType: "text/html", body: "<h1>Book unavailable</h1>" })]]));
  await start(page);
  await expect(page.locator("#phase")).toHaveText("Download stopped", { timeout: 10000 });
  await expect(page.locator("#error")).toContainText("No EPUB reader was found");
  await expect(page.locator("#verification")).toBeHidden();
  await expect(page.locator("#book-url")).toBeEnabled();
});

test("cancel during verification permits a fresh download", async ({ browserApp }) => {
  const { page, context } = browserApp;
  let blocked = true;
  await mockSite(context, new Map([[BOOK, async () => ({ contentType: "text/html", body: blocked ?
    '<title>Just a moment...</title><form id="challenge-form"></form>' :
    `<a href="${READER}">Read Online</a>` })]]));
  await start(page);
  await expect(page.locator("#verification")).toBeVisible();
  await page.locator("#cancel").click();
  await expect(page.locator("#phase")).toHaveText("Cancelled");
  await expect(page.locator("#verification")).toBeHidden();
  blocked = false;
  await start(page, `${ROOT}OPS/package.opf`);
  await expect(page.locator("#phase")).toHaveText("Saved");
});

test("transient server errors are retried before saving", async ({ browserApp }) => {
  const { page, context } = browserApp;
  let attempts = 0;
  await mockSite(context, new Map([[`${ROOT}Styles/main.css`, async () => ++attempts < 3 ?
    { status: 503, body: "Unavailable" } : { contentType: "text/css", body: "body { color: #123; }" }
  ]]));
  await start(page, ROOT);
  await expect(page.locator("#phase")).toHaveText("Saved", { timeout: 15000 });
  expect(attempts).toBe(3);
});

test("parses reader variants and rejects unsafe resources, malformed XML and broken spines", async ({ browserApp }) => {
  const result = await browserApp.page.evaluate(async ({ root, opf, container }) => {
    const core = await import("./core.js");
    const bytes = value => new TextEncoder().encode(value);
    const fails = fn => { try { fn(); return false; } catch { return true; } };
    return {
      script: core.discover(`<script>const book = "https:\\/\\/asset.epub.pub\\/epub\\/sample.epub\\/OPS\\/package.opf";</script>`, "https://spread.epub.pub/epub/sample"),
      input: core.discover(`<input name="assetUrl" value="${root}OPS/package.opf">`, "https://spread.epub.pub/epub/sample"),
      traversal: fails(() => core.resource(root, "../../outside")),
      encodedTraversal: fails(() => core.resource(root, "%2e%2e%2fsecret")),
      external: fails(() => core.resource(root, "https://example.com/file")),
      fakeHost: fails(() => core.siteUrl("https://epub.pub.evil.test/book")),
      unsafeScheme: fails(() => core.siteUrl("http://epub.pub/book")),
      credentials: fails(() => core.siteUrl("https://name:password@epub.pub/book")),
      malformed: fails(() => core.packagePaths(bytes("<container>"))),
      readingOrder: fails(() => core.packageInfo(bytes(opf.replace('idref="chapter"', 'idref="missing"')), root, `${root}OPS/package.opf`)),
      remote: fails(() => core.packageInfo(bytes(opf.replace('id="chapter"', 'id="chapter" properties="remote-resources"')), root, `${root}OPS/package.opf`)),
      paths: core.packagePaths(bytes(container)),
      relative: core.resource(root, "../Styles/main.css", `${root}OPS/package.opf`).path,
      name: core.filename("../A: Book?")
    };
  }, { root: ROOT, opf, container });
  expect(result).toEqual({ script: `${ROOT}OPS/package.opf`, input: `${ROOT}OPS/package.opf`, traversal: true, encodedTraversal: true, external: true, fakeHost: true, unsafeScheme: true, credentials: true, malformed: true, readingOrder: true, remote: true, paths: ["OPS/package.opf"], relative: "Styles/main.css", name: "_A_ Book_.epub" });
});

test("generic HTML errors are not packaged as assets", async ({ browserApp }) => {
  const { page, context } = browserApp;
  await mockSite(context, new Map([[`${ROOT}OPS/Images/cover.png`, async () => ({ contentType: "text/html", body: "<h1>Something went wrong</h1>" })]]));
  await start(page, ROOT);
  await expect(page.locator("#error")).toContainText("HTML instead of an EPUB resource");
  await expect(page.locator("#save")).toBeHidden();
});

test("empty chapter responses stop the download", async ({ browserApp }) => {
  const { page, context } = browserApp;
  await mockSite(context, new Map([[`${ROOT}OPS/Text/chapter%201.xhtml`, async () => ({ contentType: "application/xhtml+xml", body: "" })]]));
  await start(page, ROOT);
  await expect(page.locator("#error")).toContainText("Empty EPUB resource");
  await expect(page.locator("#save")).toBeHidden();
});

test("font obfuscation metadata is preserved and other encryption fails explicitly", async ({ browserApp }) => {
  const result = await browserApp.page.evaluate(async ({ root, container, opf, chapter, nav }) => {
    const { collectBook } = await import("./core.js");
    const bytes = value => new TextEncoder().encode(value);
    let algorithm = "http://www.idpf.org/2008/embedding";
    const fetchFile = async (url, optional) => {
      const name = url.slice(root.length);
      if (name === "META-INF/encryption.xml") return bytes(`<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="${algorithm}"/></EncryptedData></encryption>`);
      if (optional) return null;
      return bytes({ "META-INF/container.xml": container, "OPS/package.opf": opf, "OPS/Text/chapter%201.xhtml": chapter, "OPS/nav.xhtml": nav, "Styles/main.css": "", "OPS/Images/cover.png": "image" }[name]);
    };
    const book = await collectBook(root, fetchFile, () => {}, new AbortController().signal);
    algorithm = "http://www.w3.org/2001/04/xmlenc#aes256-cbc";
    let error;
    try { await collectBook(root, fetchFile, () => {}, new AbortController().signal); } catch (failure) { error = failure.message; }
    return { preserved: book.entries.has("META-INF/encryption.xml"), error };
  }, { root: ROOT, container, opf, chapter, nav });
  expect(result.preserved).toBe(true);
  expect(result.error).toContain("unsupported encryption");
});

test("cancelled save can be retried without downloading the book again", async ({ browserApp }) => {
  const { page, context } = browserApp;
  const requests = await mockSite(context);
  await page.evaluate(() => {
    const original = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = async options => {
      chrome.downloads.download = original;
      throw new Error("User cancelled the save dialog.");
    };
  });
  await start(page);
  await expect(page.locator("#phase")).toHaveText("Ready to save");
  await expect(page.locator("#error")).toContainText("User cancelled");
  const count = requests.length;
  await page.locator("#save").click();
  await expect(page.locator("#phase")).toHaveText("Saved");
  expect(requests).toHaveLength(count);
});

test("keyboard flow and compact viewport have visible controls without overflow", async ({ browserApp }, testInfo) => {
  const { page, errors } = browserApp;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Tab");
  await expect(page.locator("#book-url")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#start")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("compact.png"), fullPage: true });
  expect(errors).toEqual([]);
});
