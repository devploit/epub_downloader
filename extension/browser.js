import { archiveRoot, discover, MAX_FILE_BYTES, siteUrl } from "./core.js";

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function delay(ms, signal) {
  return abortable(new Promise(resolve => setTimeout(resolve, ms)), signal);
}

// Executed in the tab's isolated world: browser networking, page origin and
// credentials, without trusting page JavaScript or exposing extension APIs.
async function fetchInTab(url, maxBytes) {
  if (new URL(url).origin !== location.origin) return { error: "The source tab changed origin. Start again." };
  try {
    const response = await fetch(url, {
      credentials: "include", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) return { status: response.status, challenge: response.headers.get("cf-mitigated") === "challenge" };
    if (Number(response.headers.get("content-length")) > maxBytes) return { error: "Resource exceeds the 32 MiB file limit." };
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel();
        return { error: "Resource exceeds the 32 MiB file limit." };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const start = new TextDecoder().decode(bytes.subarray(0, 16384));
    if (response.headers.get("cf-mitigated") === "challenge" ||
        /<title[^>]*>\s*(Just a moment|Attention Required)|id=["']challenge-form|\/cdn-cgi\/challenge-platform\//i.test(start)) {
      return { challenge: true, status: response.status };
    }
    let binary = "";
    for (let index = 0; index < bytes.length; index += 32768) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
    }
    return { data: btoa(binary), type: response.headers.get("content-type") || "" };
  } catch (error) {
    return { error: `Browser request failed: ${error.message}`, retryable: true };
  }
}

function snapshotInTab() {
  return {
    url: location.href,
    html: document.documentElement.outerHTML,
    challenge: /^(Just a moment|Attention Required)/i.test(document.title) ||
      Boolean(document.querySelector("#challenge-form, #challenge-running, iframe[src*='challenges.cloudflare.com']"))
  };
}

export class BrowserSource {
  constructor(signal, progress, pause) {
    this.signal = signal;
    this.progress = progress;
    this.pause = pause;
    this.origins = new Map();
  }

  async ready(tabId) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      this.signal.throwIfAborted();
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return tab;
      await delay(250, this.signal);
    }
    throw new Error("The source tab did not finish loading within 60 seconds. Check it and try again.");
  }

  async tab(url, exact = false) {
    const target = siteUrl(url);
    if (!exact && this.origins.has(target.origin)) {
      const id = this.origins.get(target.origin);
      const current = await chrome.tabs.get(id);
      if (current.url && new URL(current.url).origin === target.origin) return id;
      this.origins.delete(target.origin);
    }
    const tabs = await chrome.tabs.query({ url: `${target.origin}/*` });
    const existing = tabs.find(tab => exact ? tab.url === target.href : tab.url && new URL(tab.url).origin === target.origin);
    const tab = existing || await chrome.tabs.create({ url: exact ? target.href : `${target.origin}/`, active: false });
    await this.ready(tab.id);
    this.origins.set(target.origin, tab.id);
    return tab.id;
  }

  async execute(tabId, func, args = []) {
    this.signal.throwIfAborted();
    const results = await abortable(chrome.scripting.executeScript({ target: { tabId }, func, args }), this.signal);
    if (!results[0]?.result) throw new Error("Could not read the source tab. Keep it open and try again.");
    return results[0].result;
  }

  async resolve(input) {
    let url = siteUrl(input).href;
    const visited = new Set();
    for (let step = 0; step < 6; step++) {
      const root = archiveRoot(url);
      if (root) return root;
      if (visited.has(url)) throw new Error("The reader links form a loop. Paste the Read Online URL directly.");
      visited.add(url);
      this.progress("Opening the book in your browser…");
      const tabId = await this.tab(url, true);
      let discoveryDeadline = Date.now() + 5000;
      while (true) {
        const page = await this.execute(tabId, snapshotInTab);
        siteUrl(page.url);
        if (page.challenge) {
          await this.pause(tabId, page.url, "Complete the verification in the source tab, then resume.");
          await this.ready(tabId);
          discoveryDeadline = Date.now() + 5000;
          continue;
        }
        try {
          url = discover(page.html, page.url);
          break;
        } catch (error) {
          if (Date.now() >= discoveryDeadline) throw error;
          this.progress("Waiting for the reader link to finish loading…");
          await delay(250, this.signal);
        }
      }
    }
    throw new Error("Too many reader redirects. Paste the final Read Online URL directly.");
  }

  async fetch(url, optional = false, expectedType = "") {
    siteUrl(url);
    const tabId = await this.tab(url);
    let attempts = 0;
    while (true) {
      this.signal.throwIfAborted();
      const result = await this.execute(tabId, fetchInTab, [url, MAX_FILE_BYTES]);
      if (result.challenge || result.status === 401 || result.status === 403) {
        await this.pause(tabId, url, "The site requires verification or access. Open the source tab, complete it, then resume.");
        await this.ready(tabId);
        attempts = 0;
        continue;
      }
      if (result.status === 404 && optional) return null;
      if (result.retryable || [429, 500, 502, 503, 504].includes(result.status)) {
        if (++attempts < 3) {
          this.progress(`Retrying a browser request (${attempts}/2)…`);
          await delay(1000 * 2 ** (attempts - 1), this.signal);
          continue;
        }
      }
      if (result.error || result.status) throw new Error(`${result.error || `HTTP ${result.status}`}\n${url}`);
      const bytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
      // Do not package a generic HTML error page in place of an image, OPF or CSS.
      if (/text\/html/i.test(result.type) && !/^(?:application\/xhtml\+xml|text\/html)$/.test(expectedType)) {
        throw new Error(`The server returned HTML instead of an EPUB resource: ${url}`);
      }
      return bytes;
    }
  }
}
