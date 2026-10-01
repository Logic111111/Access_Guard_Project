import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("manifest is MV3 and every declared local entry point exists", async () => {
  const manifest = JSON.parse(await readFile(resolve(extensionRoot, "manifest.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(resolve(extensionRoot, "package.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.background.type, "module");
  assert.ok(manifest.permissions.includes("declarativeNetRequest"));
  assert.ok(manifest.permissions.includes("tabs"));
  assert.ok(manifest.host_permissions.includes("https://*/*"));
  assert.equal(manifest.incognito, "not_allowed");

  const declaredFiles = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.storage.managed_schema,
    ...manifest.content_scripts.flatMap((script) => script.js || []),
    "blocked.html",
    "blocked.js",
    "popup.js",
    "ui.css",
  ];

  await Promise.all(declaredFiles.map((file) => access(resolve(extensionRoot, file))));
});

test("manifest intentionally omits icons so unpacked loading has no missing assets", async () => {
  const manifest = JSON.parse(await readFile(resolve(extensionRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.icons, undefined);
  assert.equal(manifest.action.default_icon, undefined);
});
