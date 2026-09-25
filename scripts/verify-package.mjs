import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const staging = join(root, "build", "addon");
const packageJSON = await readJSON(join(root, "package.json"));
const packageLock = await readJSON(join(root, "package-lock.json"));
const sourceManifest = await readJSON(join(root, "addon", "manifest.json"));
const updateManifest = await readJSON(join(root, "updates.json"));
const manifest = await readJSON(join(staging, "manifest.json"));
const zotero = manifest.applications?.zotero;

const versions = [
  packageJSON.version,
  packageLock.version,
  packageLock.packages?.[""]?.version,
  sourceManifest.version,
  manifest.version
];
if (versions.some(version => version !== packageJSON.version)) {
  throw new Error(`Version metadata differs: ${versions.join(", ")}`);
}
if (packageJSON.name !== "zotero-tag-editor"
  || packageJSON.private !== true
  || packageJSON.license !== "MIT") {
  throw new Error("Unexpected package identity");
}
if (manifest.name !== "Zotero Tag Editor") throw new Error("Unexpected plugin name");
if (manifest.icons?.['48'] !== 'content/tag.svg' || manifest.icons?.['96'] !== 'content/tag.svg') {
  throw new Error('Plugin manager icon must reference the packaged tag SVG');
}
if (zotero?.id !== "zotero-tag-editor@lllateron") throw new Error("Unexpected plugin ID");
if (zotero.strict_min_version !== "10.0.3" || zotero.strict_max_version !== "10.*") {
  throw new Error("Unexpected Zotero compatibility range");
}
if (!zotero.update_url || !zotero.update_url.startsWith('https://')) {
  throw new Error('Zotero requires applications.zotero.update_url, using HTTPS for update security');
}
if (zotero.update_url === 'https://updates.invalid/zotero-tag-editor/updates.json') {
  if (updateManifest.addons?.[zotero.id]?.updates?.length !== 0) {
    throw new Error("An unconfigured plugin cannot advertise published updates");
  }
}
else if (!/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/updates\.json$/.test(zotero.update_url)) {
  throw new Error("Unexpected plugin update URL");
}
if (!Array.isArray(updateManifest.addons?.[zotero.id]?.updates)) {
  throw new Error("Missing public update manifest for the plugin ID");
}

for (const required of [
  "bootstrap.js",
  "LICENSE",
  "chrome.manifest",
  "content/editor.css",
  "content/editor.js",
  "content/editor.xhtml",
  "content/tag.svg",
  "content/zotero.js",
  "manifest.json",
  "prefs.js"
]) {
  await access(join(staging, required));
}

const stagedFiles = await walk(staging);
if (stagedFiles.some(path => path.endsWith(".map"))) {
  throw new Error("Source maps must not be included in the release package");
}
const zoteroBundle = await readFile(join(staging, "content", "zotero.js"), "utf8");
if (!zoteroBundle.includes("ZoteroTagEditor")) {
  throw new Error("Zotero runtime bundle does not expose ZoteroTagEditor");
}
const bootstrap = await readFile(join(staging, "bootstrap.js"), "utf8");
if (!bootstrap.includes("content/zotero.js") || !bootstrap.includes("ZoteroTagEditor")) {
  throw new Error("Bootstrap does not load the packaged ZoteroTagEditor runtime");
}
const editorMarkup = await readFile(join(staging, "content", "editor.xhtml"), "utf8");
if (!editorMarkup.includes("chrome://zotero-tag-editor/content/editor.js")
  || !editorMarkup.includes("chrome://zotero-tag-editor/content/editor.css")) {
  throw new Error("Editor markup does not load the packaged script and stylesheet");
}
const chromeManifest = await readFile(join(staging, "chrome.manifest"), "utf8");
if (!/^content\s+zotero-tag-editor\s+content\/$/m.test(chromeManifest)) {
  throw new Error("Chrome manifest does not register the editor content package");
}

const fileName = `zotero-tag-editor-${packageJSON.version}.xpi`;
const xpi = await readFile(join(root, "dist", fileName));
const checksum = await readFile(join(root, "dist", "SHA256SUMS"), "utf8");
const digest = createHash("sha256").update(xpi).digest("hex");
if (checksum !== `${digest}  ${fileName}\n`) throw new Error("SHA256SUMS does not match the XPI");

const archivedFiles = listZipEntries(xpi);
if (new Set(archivedFiles).size !== archivedFiles.length) throw new Error("XPI contains duplicate entries");
const forbiddenPrefixes = [
  ".github/",
  "docs/",
  "node_modules/",
  "prototype/",
  "references/",
  "scripts/",
  "src/",
  "tests/",
  "work/"
];
if (archivedFiles.some(name => forbiddenPrefixes.some(prefix => name.startsWith(prefix)))) {
  throw new Error("XPI contains a repository-only directory");
}
const expectedFiles = stagedFiles
  .map(path => relative(staging, path).replaceAll("\\", "/"))
  .sort(comparePaths);
if (JSON.stringify([...archivedFiles].sort(comparePaths)) !== JSON.stringify(expectedFiles)) {
  throw new Error("XPI entries differ from the staged add-on files");
}
const unpacked = unzipSync(new Uint8Array(xpi));
for (const name of expectedFiles) {
  const staged = await readFile(join(staging, ...name.split("/")));
  if (!Buffer.from(unpacked[name] ?? []).equals(staged)) {
    throw new Error(`Archived bytes differ for ${name}`);
  }
}

const forbiddenContent = [
  new RegExp(`\\b(?:${["gh" + "p_", "gh" + "o_", "gh" + "u_", "gh" + "s_", "gh" + "r_"].join("|")}|${"github" + "_pat_"})[A-Za-z0-9_]{20,}\\b`),
  /secretKey\s*[=:]\s*["'][a-f0-9]{20,}/i,
  new RegExp("BEGIN " + "(?:RSA |EC |OPENSSH )?" + "PRIVATE KEY"),
  /(?:[A-Za-z]:\\Users\\[^\s"'<>]+|\/Users\/[^/\s"'<>]+|\/home\/[^/\s"'<>]+)/
];
for (const path of stagedFiles) {
  const buffer = await readFile(path);
  if (buffer.includes(0)) continue;
  const content = buffer.toString("utf8");
  if (forbiddenContent.some(pattern => pattern.test(content))) {
    throw new Error(`Possible secret or machine-specific path in ${relative(staging, path)}`);
  }
}

console.log(`Verified Zotero Tag Editor ${manifest.version}`);

function listZipEntries(archive) {
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0 || endOffset + 22 !== archive.length) throw new Error("Invalid XPI end record");
  const count = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize !== endOffset) throw new Error("Invalid XPI central directory");

  const names = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid XPI entry header");
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name.startsWith("/") || name.includes("../") || name.includes("\\")) {
      throw new Error(`Unsafe XPI entry: ${name}`);
    }
    names.push(name);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== endOffset) throw new Error("Unexpected data after XPI central directory");
  return names;
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
