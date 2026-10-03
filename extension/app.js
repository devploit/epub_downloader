import { BrowserSource } from "./browser.js";
import { collectBook, filename, siteUrl } from "./core.js";
import { createEpub } from "./zip.js";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(element => [element.id, element]));
let controller;
let pendingResume;
let sourceTab;
let sourceUrl;
let blobUrl;
let suggestedName;
let downloadId;
let saving = false;

const initial = new URL(location.href).searchParams.get("source");
if (initial) {
  try { elements["book-url"].value = siteUrl(initial).href; } catch { /* Leave unrelated active tabs out of the input. */ }
}

function progress(message, completed, total) {
  elements.status.textContent = message;
  elements.phase.textContent = "Downloading";
  elements.count.textContent = total ? `${completed} / ${total} files` : "";
  if (total) {
    elements.progress.max = total;
    elements.progress.value = completed;
  } else elements.progress.removeAttribute("value");
}

async function pause(tabId, url, message) {
  controller.signal.throwIfAborted();
  sourceTab = tabId;
  sourceUrl = siteUrl(url).href;
  elements.phase.textContent = "Waiting for you";
  elements.status.textContent = `${message}\n${url}`;
  elements.verification.hidden = false;
  elements["open-source"].focus();
  try {
    await new Promise((resolve, reject) => {
      const signal = controller.signal;
      const abort = () => { pendingResume = null; reject(signal.reason); };
      pendingResume = () => { signal.removeEventListener("abort", abort); pendingResume = null; resolve(); };
      signal.addEventListener("abort", abort, { once: true });
    });
  } finally {
    elements.verification.hidden = true;
  }
}

elements["open-source"].addEventListener("click", async () => {
  try {
    const tab = await chrome.tabs.update(sourceTab, { active: true, url: sourceUrl });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (error) { showError(error); }
});
elements.resume.addEventListener("click", () => { pendingResume?.(); elements.cancel.focus(); });
elements.cancel.addEventListener("click", () => controller?.abort(new DOMException("Download cancelled.", "AbortError")));

function showError(error) {
  elements.error.textContent = error.message;
  elements.error.hidden = false;
}

async function save() {
  if (saving || !blobUrl) return;
  saving = true;
  elements.save.disabled = true;
  elements.start.disabled = true;
  elements.error.hidden = true;
  try {
    downloadId = await chrome.downloads.download({ url: blobUrl, filename: suggestedName, saveAs: true });
    elements.phase.textContent = "Saving";
    elements.status.textContent = "Waiting for the browser to finish saving…";
    // Query too: a tiny local download can finish before download() resolves.
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item) finishSave(item.state, item.error);
  } catch (error) {
    saving = false;
    elements.phase.textContent = "Ready to save";
    elements.status.textContent = "The EPUB is ready. Choose Save EPUB to try again.";
    showError(error);
    elements.save.disabled = false;
    elements.start.disabled = false;
  }
}

function finishSave(state, error) {
  if (state !== "complete" && state !== "interrupted") return;
  saving = false;
  elements.save.disabled = false;
  elements.start.disabled = false;
  if (state === "complete") {
    elements.phase.textContent = "Saved";
    elements.status.textContent = `${suggestedName} is ready to read offline.`;
    elements["show-file"].hidden = false;
    elements["show-file"].focus();
  } else {
    elements.phase.textContent = "Ready to save";
    showError(new Error(`Saving was interrupted (${error || "unknown reason"}). Choose Save EPUB to try again.`));
  }
}

chrome.downloads.onChanged.addListener(delta => {
  if (delta.id === downloadId && delta.state) finishSave(delta.state.current, delta.error?.current);
});
elements.save.addEventListener("click", save);
elements["show-file"].addEventListener("click", () => chrome.downloads.show(downloadId));

elements["download-form"].addEventListener("submit", async event => {
  event.preventDefault();
  if (controller || saving) return;
  elements["status-panel"].hidden = false;
  elements.error.hidden = true;
  try { siteUrl(elements["book-url"].value.trim()); } catch (error) { showError(error); return; }
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = null;
  downloadId = undefined;
  elements.save.hidden = true;
  elements["show-file"].hidden = true;
  elements.start.disabled = true;
  elements["book-url"].disabled = true;
  elements.cancel.hidden = false;
  controller = new AbortController();
  try {
    const source = new BrowserSource(controller.signal, progress, pause);
    const root = await source.resolve(elements["book-url"].value.trim());
    const book = await collectBook(root, source.fetch.bind(source), progress, controller.signal);
    controller.signal.throwIfAborted();
    progress("Packaging the complete EPUB…");
    blobUrl = URL.createObjectURL(createEpub(book.entries));
    suggestedName = filename(book.title);
    elements.phase.textContent = "Ready to save";
    elements.progress.max = 1;
    elements.progress.value = 1;
    elements.count.textContent = `${book.entries.size} files`;
    elements.status.textContent = "All EPUB resources downloaded. Choose where to save the book.";
    elements.save.hidden = false;
    await save();
  } catch (error) {
    elements.phase.textContent = error.name === "AbortError" ? "Cancelled" : "Download stopped";
    elements.status.textContent = "No incomplete EPUB was saved.";
    if (error.name !== "AbortError") showError(error);
  } finally {
    controller = null;
    elements.cancel.hidden = true;
    elements.start.disabled = saving;
    elements["book-url"].disabled = false;
    if (!blobUrl) elements.start.focus();
  }
});

window.addEventListener("beforeunload", event => {
  if (controller || saving) { event.preventDefault(); event.returnValue = ""; }
});
