import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJSON = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const fileName = `zotero-tag-editor-${packageJSON.version}.xpi`;
const xpiPath = join(root, "dist", fileName);
const before = await snapshot(xpiPath);

let after = before;
for (const timezone of ["UTC", "Pacific/Honolulu"]) {
  const exitCode = await run(process.execPath, ["scripts/build.mjs"], timezone);
  if (exitCode !== 0) throw new Error(`Build in ${timezone} exited with code ${exitCode}`);
  after = await snapshot(xpiPath);
  if (before.digest !== after.digest || before.bytes !== after.bytes) {
    throw new Error(`Build changes in ${timezone}: ${before.digest} != ${after.digest}`);
  }
}
const checksum = await readFile(join(root, "dist", "SHA256SUMS"), "utf8");
if (checksum !== `${after.digest}  ${fileName}\n`) {
  throw new Error("The rebuilt SHA256SUMS does not match the deterministic XPI");
}
console.log(`Verified deterministic XPI ${after.digest}`);

async function snapshot(path) {
  const content = await readFile(path);
  return {
    bytes: content.length,
    digest: createHash("sha256").update(content).digest("hex")
  };
}

function run(command, args, timezone) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, TZ: timezone },
      stdio: "inherit"
    });
    child.once("error", rejectRun);
    child.once("exit", code => resolveRun(code ?? 1));
  });
}
