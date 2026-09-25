import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildUpdateManifest,
  compareVersions,
  mergeUpdate,
  PACKAGE_NAME,
  parseUpdateURL,
  PLUGIN_ID
} from "./update-release-manifest.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [content, packageJSON, releaseManifest] = await Promise.all([
  readFile(join(root, "updates.json"), "utf8"),
  readJSON(join(root, "package.json")),
  readJSON(join(root, "addon", "manifest.json"))
]);
const updateManifest = JSON.parse(content);
const updates = updateManifest.addons?.[PLUGIN_ID]?.updates;
if (!Array.isArray(updates)) throw new Error("Update manifest is missing the Zotero Tag Editor update list");

const zotero = releaseManifest.applications?.zotero;
if (zotero?.id !== PLUGIN_ID) throw new Error("Source manifest has an unexpected plugin ID");
let repository;
if (!zotero.update_url) throw new Error('Zotero requires applications.zotero.update_url even for local candidates');
if (zotero.update_url === 'https://updates.invalid/zotero-tag-editor/updates.json') {
  if (updates.length) throw new Error("Published updates require a configured update_url");
  assert.throws(
    () => buildUpdateManifest({
      currentManifest: updateManifest,
      releaseManifest,
      tag: `v${releaseManifest.version}`,
      checksumText: `${"a".repeat(64)}  ${PACKAGE_NAME}-${releaseManifest.version}.xpi\n`
    }),
    /Release is blocked/
  );
}
else {
  repository = parseUpdateURL(zotero.update_url);
}

const versions = new Set();
for (const [index, update] of updates.entries()) {
  if (versions.has(update.version)) throw new Error(`Duplicate update version: ${update.version}`);
  versions.add(update.version);
  if (index && compareVersions(updates[index - 1].version, update.version) >= 0) {
    throw new Error("Update entries are not in ascending semantic-version order");
  }
  if (compareVersions(update.version, packageJSON.version) > 0) {
    throw new Error(`Update ${update.version} is newer than the maintained source version`);
  }
  if (!repository) throw new Error("Published updates require a configured repository");
  const expectedLink = `https://github.com/${repository.owner}/${repository.repository}/releases/download/v${update.version}/${PACKAGE_NAME}-${update.version}.xpi`;
  if (update.update_link !== expectedLink || !/^sha256:[a-f0-9]{64}$/.test(update.update_hash)) {
    throw new Error(`Invalid download metadata for update ${update.version}`);
  }
  const compatibility = update.applications?.zotero;
  if (typeof compatibility?.strict_min_version !== "string"
    || typeof compatibility.strict_max_version !== "string") {
    throw new Error(`Missing Zotero compatibility metadata for update ${update.version}`);
  }
}

const immutableFixture = {
  version: "0.1.0",
  update_link: "https://example.invalid/zotero-tag-editor-0.1.0.xpi",
  update_hash: `sha256:${"b".repeat(64)}`,
  applications: { zotero: { strict_min_version: "10.0.3", strict_max_version: "10.*" } }
};
const fixtureManifest = {
  addons: { [PLUGIN_ID]: { updates: [immutableFixture] } }
};
assert.equal(mergeUpdate(fixtureManifest, structuredClone(immutableFixture)), fixtureManifest);
assert.throws(
  () => mergeUpdate(fixtureManifest, { ...immutableFixture, update_hash: `sha256:${"c".repeat(64)}` }),
  /immutable/
);

if (repository) {
  const sampleDigest = "a".repeat(64);
  const generated = buildUpdateManifest({
    currentManifest: { addons: { [PLUGIN_ID]: { updates: [] } } },
    releaseManifest,
    tag: `v${releaseManifest.version}`,
    checksumText: `${sampleDigest}  ${PACKAGE_NAME}-${releaseManifest.version}.xpi\n`
  });
  const generatedUpdate = generated.addons[PLUGIN_ID].updates.at(-1);
  if (generatedUpdate.version !== releaseManifest.version
    || generatedUpdate.update_hash !== `sha256:${sampleDigest}`) {
    throw new Error("Update-manifest generator did not record the release candidate correctly");
  }
}

if (content !== `${JSON.stringify(updateManifest, null, 2)}\n`) {
  throw new Error("updates.json does not use the deterministic project format");
}
console.log(`Verified update manifest with ${updates.length} published release(s)`);

async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
