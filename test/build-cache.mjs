// The service worker must never serve half of one build against half of another.
//
// The cache name used to be `instareport-admin-` + a VERSION constant edited by
// hand. Forget the edit and the cache key does not change, so the browser keeps
// the precached shell it already has and fetches only what is missing — a mix of
// old and new modules. It fails as an import of a name that no longer exists,
// which is what reached a phone after the Claude rewrite: a cached settings.js
// importing DEFAULT_MODEL from an assist.js that no longer exported it.
//
// So the cache name now carries a fingerprint of everything the variant ships,
// and this holds it to that. Correctness must not depend on remembering to edit
// a constant.
//
// Run `node tools/build.mjs` first; this checks what that produced.
//
//   node test/build-cache.mjs
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint } from '../tools/fingerprint.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ADMIN = join(ROOT, 'dist', 'admin');

let passed = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const sw = await readFile(join(ADMIN, 'sw.js'), 'utf8');
const cacheLine = /const CACHE = ([^;]+);/.exec(sw);
check('the built worker names a cache', !!cacheLine, sw.slice(0, 200));

const stamp = await fingerprint(ADMIN);
check('the cache name carries the fingerprint of what was built',
  cacheLine && cacheLine[1].includes(`'-${stamp}'`),
  `expected -${stamp} in ${cacheLine && cacheLine[1]}`);

// The fingerprint has to move when a shipped module moves, or it guards nothing.
const tmp = await mkdtemp(join(tmpdir(), 'ir-cache-'));
try {
  await cp(ADMIN, tmp, { recursive: true });
  check('a copy fingerprints the same', (await fingerprint(tmp)) === stamp);

  const target = join(tmp, 'js', 'assist.js');
  await writeFile(target, (await readFile(target, 'utf8')) + '\n// one more line\n');
  check('changing a shipped module changes the fingerprint',
    (await fingerprint(tmp)) !== stamp, 'the cache would not have been invalidated');

  // sw.js is excluded on purpose — it is where the stamp is written. Changing it
  // must not move the fingerprint, or the build could never settle.
  await cp(ADMIN, tmp, { recursive: true });
  const swPath = join(tmp, 'sw.js');
  await writeFile(swPath, (await readFile(swPath, 'utf8')) + '\n// noise\n');
  check('the worker itself is left out of its own fingerprint',
    (await fingerprint(tmp)) === stamp, 'the fingerprint chases its own tail');
} finally {
  await rm(tmp, { recursive: true, force: true });
}

// The one thing a hash cannot tell you: which release this is. That stays a
// human-readable constant, and it should still be in the name.
check('the readable version is still in the cache name',
  cacheLine && cacheLine[1].includes('VERSION'), String(cacheLine && cacheLine[1]));
check('the version is not the dev placeholder',
  /const VERSION = 'v\d+\.\d+\.\d+'/.test(sw), 'sw.js has no release version');

console.log(`\nservice worker cache: ${passed} passed, ${failures.length} failed`);
failures.forEach((f) => console.log('  FAIL ' + f));
if (failures.length) process.exitCode = 1;
