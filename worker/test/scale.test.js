// What a big job costs.
//
// A Worker is cut off after a limited number of requests to other services, and
// a KV read is one of those. So the rule is: no hot path may cost more reads
// because the batch is bigger. A 200-photo inspection is an ordinary day.
//
// This test exists because that rule was broken and nobody noticed until a real
// 197-photo job half-imported and then could not be fetched at all: serving one
// photo read every record in the batch, and so did the ack after each photo
// arriving, so the cost per photo grew with every photo already filed.
//
//   node worker/test/scale.test.js
import worker from '../src/index.js';
import { handleUpdate } from '../src/bot.js';
import * as batch from '../src/batch.js';
import { FakeKV, fakeTelegram, makeEnv, ctx, settle, cmd, photo, check, report } from './harness.js';

const tgStub = fakeTelegram();
globalThis.fetch = tgStub.fetchImpl;

const kv = new FakeKV();
const env = makeEnv(kv);
// A thousand keys a page, as the real KV pages.
const realPage = kv.list.bind(kv);
kv.list = (opts = {}) => realPage({ ...opts, limit: opts.limit || 1000 });

const PHOTOS = 200;
// Cloudflare cuts a Worker off at 50 requests to other services on the free
// plan. Everything here is measured against that, with room to spare.
const CEILING = 50;

const count = async (label, fn) => {
  const before = { reads: kv.reads, lists: kv.lists };
  await fn();
  const spent = (kv.reads - before.reads) + (kv.lists - before.lists);
  return { label, spent };
};

/* ---------- build a 200-photo batch, watching the cost of each arrival ---------- */

await handleUpdate(env, cmd('/project 23 JALAN KERUING'), ctx);
await handleUpdate(env, cmd('/sec CAR PORCH'), ctx);

const first = await count('first photo', () => handleUpdate(env, photo(), ctx));
for (let i = 1; i < PHOTOS - 1; i++) await handleUpdate(env, photo(), ctx);
const last = await count('photo 200', () => handleUpdate(env, photo(), ctx));

const code = await kv.get('chat:-100123');
check(`all ${PHOTOS} filed`, (await batch.listSummaries(env, code)).length === PHOTOS,
  String((await batch.listSummaries(env, code)).length));
check('filing the 200th photo costs no more than the first',
  last.spent <= first.spent + 1, `first ${first.spent}, last ${last.spent}`);
check('filing a photo stays under the ceiling', last.spent < CEILING, String(last.spent));

/* ---------- the two calls the app makes ---------- */

const req = (path, init) => worker.fetch(new Request('https://w.example' + path, init), env, ctx);

let manifest;
const mf = await count('manifest', async () => {
  manifest = await (await req(`/api/batch/${code}`)).json();
});
check('the manifest carries every photo', manifest.total === PHOTOS, String(manifest.total));
check('fetching the manifest stays under the ceiling', mf.spent < CEILING, String(mf.spent));

const ids = manifest.sections.flatMap((s) => s.photos).map((p) => p.id);
const one = await count('one photo', () => req(`/api/photo/${code}/${ids[PHOTOS - 1]}`));
check('serving a photo costs a handful of reads, not one per photo in the batch',
  one.spent <= 3, String(one.spent));
check('serving the 200th photo stays under the ceiling', one.spent < CEILING, String(one.spent));

/* ---------- /list and /done ---------- */

const list = await count('/list', () => handleUpdate(env, cmd('/list'), ctx));
check('/list stays under the ceiling', list.spent < CEILING, String(list.spent));

const done = await count('/done', () => handleUpdate(env, cmd('/done'), ctx));
check('/done stays under the ceiling', done.spent < CEILING, String(done.spent));

/* ---------- claiming a finished batch ---------- */

const claim = await count('claim', () => req(`/api/batch/${code}/claim`, { method: 'POST' }));
check('claiming stays under the ceiling', claim.spent < CEILING, String(claim.spent));
check('a claimed code stops working immediately',
  (await req(`/api/batch/${code}`)).status === 404);

/* ---------- captioning as photos arrive ---------- */
/*
 * Captioning now happens inside the request that files the photo, which puts it
 * on the hot path and so under the rule at the top of this file: the sixtieth
 * photo must not cost more than the first. It is written to be constant —
 * cooldown, library, write — and this is what holds it to that.
 */

const { captionPending } = await import('../src/caption.js');

globalThis.DEFAULT_LIBRARY = [{ group: 'Tiling', items: ['HOLLOW TILE', 'UNFILLED GROUT'] }];
const geminiStub = async (url, init) => {
  if (String(url).includes('generativelanguage')) {
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'HOLLOW TILE' }] } }],
    }), { status: 200 });
  }
  return tgStub.fetchImpl(url, init);
};
globalThis.fetch = geminiStub;

const live = makeEnv(kv, { GEMINI_KEY: 'k' });
const arrive = async () => { await handleUpdate(live, photo(), ctx); await settle(); };

await handleUpdate(live, cmd('/project 5 JALAN CEMPAKA'), ctx);
await handleUpdate(live, cmd('/sec BATH 1'), ctx);

const firstArrival = await count('first arrival', arrive);
for (let i = 1; i < 59; i++) await arrive();
const lastArrival = await count('arrival 60', arrive);

const live2 = await kv.get('chat:-100123');
check('every arrival was captioned',
  (await batch.listSummaries(live, live2)).every((p) => p.caption === 'HOLLOW TILE'));
check('captioning the 60th arrival costs no more than the first',
  lastArrival.spent <= firstArrival.spent + 1,
  `first ${firstArrival.spent}, last ${lastArrival.spent}`);
check('filing and captioning one photo stays under the ceiling',
  lastArrival.spent < CEILING, String(lastArrival.spent));

// Filing a photo puts its batch on the queue before anyone knows whether the
// arrival pass will manage it. Nothing was left over here, so the first tick
// should find that out and drop the batch — otherwise every tick after it pays
// to look again, which is exactly the cost the queue exists to avoid.
const swept = await count('sweep after arrivals', () => captionPending(live, 10));
check('a tick after a complete arrival pass captions nothing',
  (await captionPending(live, 10)).done === 0);
check('and takes the finished batch off the queue',
  !(await batch.queueList(live)).length, JSON.stringify(await batch.queueList(live)));
check('the sweep stays under the ceiling', swept.spent < CEILING, String(swept.spent));

/* ---------- what a day of doing nothing costs ---------- */
/*
 * The captioning tick fires unattended, for ever. Cloudflare's free plan allows
 * 1000 key listings a day, and a tick that lists to ask "is there work?" spends
 * one every time — which blocked a real account over a weekend in which nobody
 * touched the bot. An idle tick must not list at all.
 */

const LIST_BUDGET_PER_DAY = 1000;

const idle = { reads: 0, lists: 0 };
{
  const before = { reads: kv.reads, lists: kv.lists };
  const r = await captionPending({ ...env, GEMINI_KEY: 'k' }, 10);
  idle.reads = kv.reads - before.reads;
  idle.lists = kv.lists - before.lists;
  check('an idle tick reports itself idle', r.idle === true, JSON.stringify(r));
}
check('an idle tick lists nothing at all', idle.lists === 0, `${idle.lists} listings`);
check('an idle tick reads once', idle.reads <= 1, `${idle.reads} reads`);

const everyTwoMinutes = (24 * 60) / 2;
check('a day of idle ticks stays inside the free listing allowance',
  idle.lists * everyTwoMinutes < LIST_BUDGET_PER_DAY,
  `${idle.lists * everyTwoMinutes} a day against ${LIST_BUDGET_PER_DAY}`);

report(`scale (${PHOTOS} photos)`);
console.log('   cost in requests: '
  + [first, last, mf, one, list, done, claim, firstArrival, lastArrival, swept]
    .map((c) => `${c.label} ${c.spent}`).join(' · '));
