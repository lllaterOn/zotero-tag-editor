import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

for (const name of ["build", "dist", "work"]) {
  const target = resolve(root, name);
  if (dirname(target) !== root || basename(target) !== name) {
    throw new Error(`Refusing to clean unexpected path: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}
