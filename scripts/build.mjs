import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { zipSync } from "fflate";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const buildDirectory = cleanTarget("build");
const staging = join(buildDirectory, "addon");
const dist = cleanTarget("dist");

await Promise.all([
  rm(buildDirectory, { recursive: true, force: true }),
  rm(dist, { recursive: true, force: true })
]);
await mkdir(staging, { recursive: true });
await mkdir(dist, { recursive: true });
await cp(join(root, "addon"), staging, { recursive: true });
await cp(join(root, "LICENSE"), join(staging, "LICENSE"));

await Promise.all([
  build({
    absWorkingDir: root,
    bundle: true,
    charset: "utf8",
    entryPoints: ["src/zotero.ts"],
    format: "iife",
    globalName: "ZoteroTagEditor",
    legalComments: "none",
    outfile: "build/addon/content/zotero.js",
    platform: "browser",
    sourcemap: false,
    target: "firefox115"
  }),
  build({
    absWorkingDir: root,
    bundle: true,
    charset: "utf8",
    entryPoints: ["src/editor.ts"],
    format: "iife",
    legalComments: "none",
    outfile: "build/addon/content/editor.js",
    platform: "browser",
    sourcemap: false,
    target: "firefox115"
  })
]);

const packageJSON = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifestPath = join(staging, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.version = packageJSON.version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

// fflate writes DOS timestamps with local-time accessors, so construct the same
// local wall-clock time on every runner instead of converting a UTC instant.
const fixedTimestamp = new Date(2000, 0, 1, 0, 0, 0);
const archiveInput = {};
const stagedFiles = await filesUnder(staging);
await Promise.all(stagedFiles.map(normalizeTextFile));
for (const path of stagedFiles) {
  const name = relative(staging, path).replaceAll("\\", "/");
  archiveInput[name] = [new Uint8Array(await readFile(path)), {
    attrs: (0o100644 << 16) >>> 0,
    mtime: fixedTimestamp,
    os: 3
  }];
}

async function normalizeTextFile(path) {
  const textExtensions = new Set([".css", ".ftl", ".html", ".js", ".json", ".manifest", ".svg", ".xhtml"]);
  if (!textExtensions.has(extname(path).toLowerCase())) return;
  const content = await readFile(path, "utf8");
  const normalized = content.replace(/\r\n?/g, "\n");
  if (normalized !== content) await writeFile(path, normalized, "utf8");
}

const fileName = `zotero-tag-editor-${packageJSON.version}.xpi`;
const archive = Buffer.from(zipSync(archiveInput, {
  attrs: (0o100644 << 16) >>> 0,
  level: 9,
  mtime: fixedTimestamp,
  os: 3
}));
const xpiPath = join(dist, fileName);
await writeFile(xpiPath, archive);
const digest = createHash("sha256").update(archive).digest("hex");
await writeFile(join(dist, "SHA256SUMS"), `${digest}  ${fileName}\n`, "utf8");

console.log(`Built ${xpiPath}`);
console.log(`SHA-256 ${digest}`);

async function filesUnder(directory) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(compareEntries)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else files.push(path);
  }
  return files;
}

function compareEntries(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function cleanTarget(name) {
  const target = resolve(root, name);
  if (dirname(target) !== root || basename(target) !== name || !["build", "dist"].includes(name)) {
    throw new Error(`Refusing to clean unexpected path: ${target}`);
  }
  return target;
}
