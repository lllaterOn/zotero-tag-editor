import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { PACKAGE_NAME, parseUpdateURL, PLUGIN_ID } from "./update-release-manifest.mjs";

export async function verifyReleaseAsset({ xpiPath, checksumPath, tag, sourceManifestPath, outputPath }) {
  const version = parseTag(tag);
  const expectedFileName = `${PACKAGE_NAME}-${version}.xpi`;
  if (basename(xpiPath) !== expectedFileName) {
    throw new Error(`Release asset must be named ${expectedFileName}`);
  }

  const [xpi, checksumText, sourceManifest] = await Promise.all([
    readFile(xpiPath),
    readFile(checksumPath, "utf8"),
    readJSON(sourceManifestPath)
  ]);
  const digest = createHash("sha256").update(xpi).digest("hex");
  if (checksumText !== `${digest}  ${expectedFileName}\n`) {
    throw new Error("Published SHA256SUMS does not match the XPI asset");
  }

  const manifestBytes = readZipEntry(xpi, "manifest.json");
  const packagedManifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  if (packagedManifest.version !== version) {
    throw new Error(`Packaged manifest version ${packagedManifest.version} does not match ${tag}`);
  }
  const zotero = packagedManifest.applications?.zotero;
  if (zotero?.id !== PLUGIN_ID) throw new Error("Packaged manifest has an unexpected plugin identity");
  parseUpdateURL(zotero.update_url);
  if (!isDeepStrictEqual(packagedManifest, sourceManifest)) {
    throw new Error("Packaged manifest differs from the manifest at the release tag");
  }

  await writeFile(outputPath, `${JSON.stringify(packagedManifest, null, 2)}\n`, "utf8");
}

function readZipEntry(archive, expectedName) {
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0 || endOffset + 22 !== archive.length) throw new Error("Invalid XPI end record");
  const count = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize !== endOffset) throw new Error("Invalid XPI central directory");

  let offset = centralOffset;
  let found;
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid XPI entry header");
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === expectedName) {
      if (found) throw new Error(`Duplicate ${expectedName} in XPI`);
      if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid XPI local entry header");
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > archive.length) throw new Error(`Truncated ${expectedName} entry`);
      const compressed = archive.subarray(dataStart, dataEnd);
      found = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : undefined;
      if (!found) throw new Error(`Unsupported ZIP compression method ${method}`);
      if (found.length !== uncompressedSize) throw new Error(`Invalid ${expectedName} size`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== endOffset) throw new Error("Unexpected data after XPI central directory");
  if (!found) throw new Error(`Missing ${expectedName} in XPI`);
  return found;
}

function parseTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!match) throw new Error(`Unsupported release tag: ${tag}`);
  return match.slice(1).join(".");
}

async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await verifyReleaseAsset({
    xpiPath: resolve(required(options, "xpi")),
    checksumPath: resolve(required(options, "checksum-file")),
    tag: required(options, "tag"),
    sourceManifestPath: resolve(required(options, "source-manifest")),
    outputPath: resolve(required(options, "output"))
  });
  console.log(`Verified published release asset ${options.tag}`);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
