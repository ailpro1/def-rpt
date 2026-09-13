// End-to-end over the real Worker code: synthetic Telegram updates in, manifest
// and photo bytes out. Run with `node worker/test/run.js` — no wrangler, no
// network, no account.

import worker from '../src/index.js';
import { handleUpdate } from '../src/bot.js';
import * as batch from '../src/batch.js';
import {
  FakeKV, fakeTelegram, makeEnv, ctx, cmd, photo, document_, check, report,
} from './harness.js';

const tgStub = fakeTelegram();
globalThis.fetch = tgStub.fetchImpl;

const kv = new FakeKV();
const env = makeEnv(kv);
const feed = (update) => handleUpdate(env, update, ctx);

/* ---------- a day on site ---------- */

await feed(cmd('/help'));
check('help replies', tgStub.texts().some((t) => t.includes('/sec KITCHEN')));

await feed(photo());
check('photo before /project is ignored', kv.map.size === 0, `${kv.map.size} keys written`);

await feed(cmd('/project 23 JALAN KERUING'));
await feed(cmd('/sec CAR PORCH'));
await feed(photo({ caption: 'OVERVIEW' }));
await feed(photo());
await feed(cmd('/sec KITCHEN'));
await feed(photo({ caption: 'UNFILLED GROUT' }));
await feed(photo());
await feed(photo());

const code = await kv.get('chat:-100123');
check('batch code issued', /^[A-Z0-9]{8}$/.test(code || ''), String(code));

let meta = await batch.getMeta(env, code);
let photos = await batch.listPhotos(env, code);
check('all photos filed', photos.length === 5, `${photos.length}`);
check('sections split correctly',
  photos.filter((p) => p.section === 'CAR PORCH').length === 2
  && photos.filter((p) => p.section === 'KITCHEN').length === 3);
check('typed caption kept', photos[0].caption === 'OVERVIEW');
check('largest variant chosen', photos[0].w === 1280, `${photos[0].w}`);
check('send time used as capture time',
  photos[0].takenAt === 1789000000000 && photos[0].takenSource === 'telegram');

/* ---------- order does not depend on arrival order ---------- */

await feed(photo({ id: 9002, group: 'g1', caption: 'ALBUM' }));
await feed(photo({ id: 9001, group: 'g1' }));
photos = await batch.listPhotos(env, code);
const tail = photos.slice(-2).map((p) => p.id);
check('album sorted by message id', tail[0] === 9001 && tail[1] === 9002, tail.join(','));

/* ---------- /list and /undo ---------- */

const before = tgStub.sent.length;
await feed(cmd('/list'));
const listReply = tgStub.texts().at(-1);
check('/list counts by section', listReply.includes('CAR PORCH — 2') && listReply.includes('KITCHEN — 5'),
  listReply.replace(/\n/g, ' | '));

await feed(cmd('/undo'));
photos = await batch.listPhotos(env, code);
check('/undo removes the last photo', photos.length === 6, `${photos.length}`);
check('/undo drops the newest, not the oldest', !photos.some((p) => p.id === 9002));

/* ---------- a document keeps its own marker ---------- */

await feed(document_({ caption: 'CRACK OBSERVED ON WALL' }));
photos = await batch.listPhotos(env, code);
// Found by its marker, not its position: the album above was sent with ids far
// ahead of the running counter, so "last filed" is not "last in order".
const doc = photos.find((p) => p.caption === 'CRACK OBSERVED ON WALL');
check('document filed as an original', doc && doc.takenSource === 'file',
  doc ? doc.takenSource : 'not filed');

/* ---------- /done ---------- */

await feed(cmd('/done'));
meta = await batch.getMeta(env, code);
check('batch closed', meta.status === 'closed');
check('chat freed for the next batch', (await kv.get('chat:-100123')) === null);
const doneReply = tgStub.texts().at(-1);
check('code given to the user', doneReply.includes(code), doneReply.replace(/\n/g, ' | '));
check('manifest file posted', tgStub.sent.some((s) => s.method === 'sendDocument'));

/* ---------- the HTTP side the app talks to ---------- */

const req = (path, init) => worker.fetch(new Request('https://w.example' + path, init), env, ctx);

check('health', (await req('/health')).status === 200);

const unauth = await req('/tg/webhook', { method: 'POST', body: '{}' });
check('webhook rejects a missing secret', unauth.status === 401);

const manifestRes = await req(`/api/batch/${code}`);
const manifest = await manifestRes.json();
check('manifest served', manifestRes.status === 200);
check('manifest names the project', manifest.project.name === '23 JALAN KERUING');
check('manifest carries both sections', manifest.sections.length === 2,
  manifest.sections.map((s) => s.title).join(','));
check('manifest photo count matches', manifest.total === 7, `${manifest.total}`);
check('manifest numbers run across the batch',
  manifest.sections.flatMap((s) => s.photos).map((p) => p.n).join(',') === '1,2,3,4,5,6,7');
check('manifest is small', JSON.stringify(manifest).length < 4096,
  `${JSON.stringify(manifest).length} bytes`);
check('manifest carries no image bytes', !/[A-Za-z0-9+/]{200,}/.test(JSON.stringify(manifest)));

const firstId = manifest.sections[0].photos[0].id;
const photoRes = await req(`/api/photo/${code}/${firstId}`);
check('photo streams', photoRes.status === 200 && photoRes.headers.get('content-type') === 'image/jpeg');
check('photo has CORS for the Pages origin',
  photoRes.headers.get('access-control-allow-origin') === '*');

check('unknown code is a 404', (await req('/api/batch/ZZZZZZZZ')).status === 404);

const claimRes = await req(`/api/batch/${code}/claim`, { method: 'POST' });
check('claim succeeds', claimRes.status === 200);
check('claim empties the batch', (await batch.listPhotos(env, code)).length === 0);
check('claimed code stops resolving', (await req(`/api/batch/${code}`)).status === 404);

/* ---------- a stranger ---------- */

await feed(cmd('/project SOMEONE ELSE', 999));
check('other chats are ignored', ![...kv.map.keys()].some((k) => k.startsWith('chat:999')));

/* ---------- cost shape ---------- */

check('one KV write per photo, not per update',
  kv.writes < 40, `${kv.writes} writes for 8 photos and 9 commands`);

report('worker');
console.log(`   KV: ${kv.writes} writes, ${kv.reads} reads`);
