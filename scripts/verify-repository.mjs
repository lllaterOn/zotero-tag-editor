import { access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const excludedDirectories = new Set([
  ".cache",
  ".git",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "test-results",
  "work"
]);

for (const required of [
  "AGENTS.md",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "addon/manifest.json",
  "docs/ACCEPTANCE-1.0.0.md",
  "docs/DEVELOPMENT.md",
  "package-lock.json",
  "package.json",
  "src/domain/tags.ts",
  "src/editor.ts",
  "src/zotero.ts",
  "tests/domain.test.ts",
  "updates.json"
]) {
  await access(join(root, required));
}

const secretPatterns = [
  new RegExp(`\\b(?:${["gh" + "p_", "gh" + "o_", "gh" + "u_", "gh" + "s_", "gh" + "r_"].join("|")}|${"github" + "_pat_"})[A-Za-z0-9_]{20,}\\b`),
  /secretKey\s*[=:]\s*["'][a-f0-9]{20,}/i,
  new RegExp("BEGIN " + "(?:RSA |EC |OPENSSH )?" + "PRIVATE KEY"),
  /(?:[A-Za-z]:\\Users\\[^\s"'<>]+|\/Users\/[^/\s"'<>]+|\/home\/[^/\s"'<>]+)/
];

const failures = [];
for (const path of await walk(root)) {
  const metadata = await stat(path);
  if (metadata.size > 2_000_000) {
    failures.push(`${relative(root, path)} exceeds the 2 MB source-file limit`);
    continue;
  }
  const buffer = await readFile(path);
  if (buffer.includes(0)) continue;
  const content = buffer.toString("utf8");
  if (secretPatterns.some(pattern => pattern.test(content))) {
    failures.push(`${relative(root, path)} may contain a credential or machine-specific path`);
  }
}

if (failures.length) throw new Error(failures.join("\n"));
console.log("Verified repository hygiene");

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}
