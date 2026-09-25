import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testsRoot = join(root, "tests");
const outputRoot = join(root, "work", "tests");
const entryPoints = (await filesUnder(testsRoot))
  .filter(path => /\.test\.ts$/.test(path))
  .sort(comparePaths);

if (!entryPoints.length) throw new Error("No TypeScript test files were found");
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await build({
  absWorkingDir: root,
  bundle: true,
  entryNames: "[dir]/[name]",
  entryPoints,
  format: "esm",
  legalComments: "none",
  outbase: testsRoot,
  outdir: outputRoot,
  platform: "node",
  sourcemap: false,
  target: "node22"
});

const compiledTests = entryPoints.map(path => {
  const relativePath = relative(testsRoot, path).replace(/\.ts$/, ".js");
  return join(outputRoot, relativePath);
});
const exitCode = await run(process.execPath, ["--test", ...compiledTests]);
if (exitCode !== 0) process.exitCode = exitCode;

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", code => resolveRun(code ?? 1));
  });
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else files.push(path);
  }
  return files;
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
