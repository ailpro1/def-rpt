// A content fingerprint of a built variant, used in its service worker cache name.
//
// The cache name used to be a hand-edited VERSION constant and nothing else.
// Forget to bump it and the key does not change, so a browser keeps the shell it
// already precached and fetches only what is missing — half the old app against
// half the new one. It surfaces as an import of a name that no longer exists,
// which is how the Claude rewrite reached a phone broken: a cached settings.js
// importing DEFAULT_MODEL from an assist.js that had stopped exporting it.
//
// Correctness must not depend on remembering to edit a constant, so the cache
// name carries this as well.
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * Hash every file a variant ships, by path and by content.
 *
 * sw.js is excluded: it is where the fingerprint is written, so including it
 * would chase its own tail and the build would never settle.
 */
export async function fingerprint(dir) {
  const h = createHash('sha256');
  const walk = async (d, prefix) => {
    const entries = (await readdir(d, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (prefix === '' && e.name === 'sw.js') continue;
      const rel = prefix + e.name;
      if (e.isDirectory()) await walk(join(d, e.name), `${rel}/`);
      else { h.update(rel); h.update(await readFile(join(d, e.name))); }
    }
  };
  await walk(dir, '');
  return h.digest('hex').slice(0, 8);
}
