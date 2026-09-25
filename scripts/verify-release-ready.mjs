import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUpdateURL, PLUGIN_ID } from "./update-release-manifest.mjs";

const options = parseArguments(process.argv.slice(2));
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryName = required(options, "repository");
if (!/^[^/]+\/[^/]+$/.test(repositoryName)) throw new Error("--repository must be owner/repository");

const manifest = JSON.parse(await readFile(join(root, "addon", "manifest.json"), "utf8"));
const zotero = manifest.applications?.zotero;
if (zotero?.id !== PLUGIN_ID) throw new Error("Unexpected plugin ID");
const configured = parseUpdateURL(zotero.update_url);
if (`${configured.owner}/${configured.repository}` !== repositoryName) {
  throw new Error("Configured update_url does not match the GitHub repository running this workflow");
}
if (manifest.homepage_url !== `https://github.com/${repositoryName}`) {
  throw new Error("Configured homepage_url does not match the GitHub repository running this workflow");
}
console.log(`Verified release configuration for ${repositoryName}`);

function parseArguments(argumentsList) {
  const parsed = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key ?? "end"}`);
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

function required(parsed, key) {
  if (!parsed[key]) throw new Error(`Missing --${key}`);
  return parsed[key];
}

if (!process.argv[1] || resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) {
  throw new Error("verify-release-ready.mjs must run as a command");
}
