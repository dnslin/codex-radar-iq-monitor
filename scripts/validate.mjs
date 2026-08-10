import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

assert.equal(manifest.manifest_version, 3, "manifest_version must be 3");
assert.equal(manifest.background?.type, "module", "background must be an ES module");
assert.ok(manifest.background?.service_worker, "background service worker is required");
assert.ok(manifest.action?.default_popup, "action popup is required");
assert.ok(
  manifest.host_permissions?.includes("https://api.codexradar.com/*"),
  "Codex Radar API host permission is required",
);

const referencedFiles = new Set([
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action.default_icon ?? {}),
]);

for (const relativePath of referencedFiles) {
  await access(resolve(root, relativePath));
}

const popupHtml = await readFile(resolve(root, manifest.action.default_popup), "utf8");
const scriptTags = [...popupHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
assert.equal(scriptTags.length, 1, "popup must contain exactly one script tag");
assert.match(scriptTags[0][1], /src=["']popup\.js["']/, "popup script must be local");
assert.equal(scriptTags[0][2].trim(), "", "inline JavaScript is not allowed");
assert.doesNotMatch(popupHtml, /<script[^>]+src=["']https?:/i, "remote scripts are not allowed");

assert.equal(
  packageJson.scripts?.package,
  "node scripts/package.mjs",
  "package script must invoke scripts/package.mjs",
);
await access(resolve(root, "scripts/package.mjs"));

const releaseWorkflow = await readFile(
  resolve(root, ".github/workflows/release.yml"),
  "utf8",
);
assert.match(releaseWorkflow, /tags:\s*\n\s*-\s*["']v\*["']/, "release workflow must listen for version tags");
assert.match(releaseWorkflow, /contents:\s*write/, "release workflow needs contents write permission");
assert.match(releaseWorkflow, /npm run check/, "release workflow must run validation");
assert.match(releaseWorkflow, /npm run package/, "release workflow must build the extension archive");
assert.match(releaseWorkflow, /gh release create/, "release workflow must create a GitHub Release");

console.log(`Manifest validated: ${referencedFiles.size} referenced files found.`);
console.log("Release workflow validated.");
