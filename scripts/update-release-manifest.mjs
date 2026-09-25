import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

export const PLUGIN_ID = "zotero-tag-editor@lllateron";
export const PACKAGE_NAME = "zotero-tag-editor";

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function parseUpdateURL(updateURL) {
  const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/main\/updates\.json$/.exec(updateURL ?? "");
  if (!match) {
    throw new Error("Release is blocked until the real GitHub update_url is configured");
  }
  return { owner: match[1], repository: match[2] };
}

export function buildUpdateManifest({ currentManifest, releaseManifest, tag, checksumText }) {
  const version = releaseManifest.version;
  parseVersion(version);
  if (tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match manifest version ${version}`);
  }

  const zotero = releaseManifest.applications?.zotero;
  if (zotero?.id !== PLUGIN_ID) throw new Error("Unexpected plugin ID in release manifest");
  if (typeof zotero.strict_min_version !== "string" || typeof zotero.strict_max_version !== "string") {
    throw new Error("Release manifest is missing its Zotero compatibility range");
  }
  const repository = parseUpdateURL(zotero.update_url);

  const fileName = `${PACKAGE_NAME}-${version}.xpi`;
  const digest = parseChecksum(checksumText, fileName);
  const currentAddon = currentManifest.addons?.[PLUGIN_ID];
  if (!currentAddon || !Array.isArray(currentAddon.updates)) {
    throw new Error("Current update manifest has an unexpected structure");
  }

  const update = {
    version,
    update_link: `https://github.com/${repository.owner}/${repository.repository}/releases/download/${tag}/${fileName}`,
    update_hash: `sha256:${digest}`,
    applications: {
      zotero: {
        strict_min_version: zotero.strict_min_version,
        strict_max_version: zotero.strict_max_version
      }
    }
  };
  return mergeUpdate(currentManifest, update);
}

export function mergeUpdate(currentManifest, update) {
  const currentAddon = currentManifest.addons?.[PLUGIN_ID];
  if (!currentAddon || !Array.isArray(currentAddon.updates)) {
    throw new Error("Current update manifest has an unexpected structure");
  }
  const existing = currentAddon.updates.find(candidate => candidate.version === update.version);
  if (existing) {
    if (!isDeepStrictEqual(existing, update)) {
      throw new Error(`Published update ${update.version} is immutable and differs from the supplied release`);
    }
    return currentManifest;
  }
  const updates = currentAddon.updates
    .concat(update)
    .sort((left, right) => compareVersions(left.version, right.version));

  return {
    ...currentManifest,
    addons: {
      ...currentManifest.addons,
      [PLUGIN_ID]: {
        ...currentAddon,
        updates
      }
    }
  };
}

function parseChecksum(content, expectedFileName) {
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length !== 1) throw new Error("SHA256SUMS must contain exactly one non-empty line");
  const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(lines[0]);
  if (!match || match[2] !== expectedFileName) {
    throw new Error(`SHA256SUMS does not describe ${expectedFileName}`);
  }
  return match[1].toLowerCase();
}

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`Unsupported release version: ${version}`);
  return match.slice(1).map(Number);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifestPath = resolve(options.manifest ?? "updates.json");
  const releaseManifestPath = resolve(options["release-manifest"] ?? "addon/manifest.json");
  const checksumPath = resolve(required(options, "checksum-file"));
  const tag = required(options, "tag");
  const [currentManifest, releaseManifest, checksumText] = await Promise.all([
    readJSON(manifestPath),
    readJSON(releaseManifestPath),
    readFile(checksumPath, "utf8")
  ]);
  const updated = buildUpdateManifest({ currentManifest, releaseManifest, tag, checksumText });
  await writeFile(manifestPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  console.log(`Recorded ${tag} in ${manifestPath}`);
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key ?? "end"}`);
    options[key.slice(2)] = value;
  }
  return options;
}

function required(options, key) {
  if (!options[key]) throw new Error(`Missing --${key}`);
  return options[key];
}

async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
