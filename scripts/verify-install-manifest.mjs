import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Zotero 10.0.3's modules/Extension.sys.mjs (1874–1883) explicitly rejects
// extensions without these Zotero-specific fields. HTTPS is additionally
// required by XPIDatabase.sys.mjs::providesUpdatesSecurely.
function assertInstallableManifest(manifest) {
  const zotero = manifest.applications?.zotero;
  for (const key of ['id', 'update_url', 'strict_max_version']) {
    assert(typeof zotero?.[key] === 'string' && zotero[key].length > 0,
      `applications.zotero.${key} not provided`);
  }
  assert.equal(new URL(zotero.update_url).protocol, 'https:', 'Updates must use HTTPS');
}

const manifest = JSON.parse(await readFile(new URL('../addon/manifest.json', import.meta.url), 'utf8'));
assertInstallableManifest(manifest);
for (const key of ['id', 'update_url', 'strict_max_version']) {
  const invalid = structuredClone(manifest);
  delete invalid.applications.zotero[key];
  assert.throws(() => assertInstallableManifest(invalid), new RegExp(key));
}
const insecure = structuredClone(manifest);
insecure.applications.zotero.update_url = 'http://updates.invalid/updates.json';
assert.throws(() => assertInstallableManifest(insecure), /HTTPS/);
console.log('Verified native Zotero required fields and missing-field regression cases');
