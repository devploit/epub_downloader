import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ["scripting", "downloads"]);
assert.deepEqual(manifest.host_permissions, ["https://epub.pub/*", "https://*.epub.pub/*"]);
for (const file of await readdir("extension")) {
  if (file.endsWith(".js")) execFileSync(process.execPath, ["--check", `extension/${file}`]);
}
await readFile(`extension/${manifest.background.service_worker}`);
const html = await readFile("extension/app.html", "utf8");
assert(!/<script[^>]+src=["']https?:/.test(html), "Scripts must be bundled locally.");
console.log("Manifest, permissions and JavaScript syntax checks passed.");
