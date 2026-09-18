// Drives worker/dist/worker.js — the exact text that gets pasted into the
// Cloudflare editor — through its fetch() handler only, the way Cloudflare will.
//
// The source tests (run.js) reach inside and call handleUpdate directly. This
// one deliberately cannot: if the flattening broke a cross-module reference, the
// only way to find out is to go in through the front door.
//
//   node worker/test/bundle.test.js
import worker from '../dist/worker.js';
import { FakeKV, fakeTelegram, makeEnv, cmd, photo, check, report } from './harness.js';

const tgStub = fakeTelegram();
globalThis.fetch = tgStub.fetchImpl;

const kv = new FakeKV();
const env = makeEnv(kv);
const ORIGIN = 'https://insta-intake.example.workers.dev';

// The Worker answers Telegram immediately and finishes the work in waitUntil, so
// the test has to wait for that too — Cloudflare does, we must.
const pending = [];
const ctx = { waitUntil: (p) => { pending.push(p); return p; } };
const settle = () => Promise.all(pending.splice(0));

const req = (path, init) => worker.fetch(new Request(ORIGIN + path, init), env, ctx);

/** A Telegram update, delivered exactly as Telegram delivers it. */
const deliver = async (update) => {
  const res = await req('/tg/webhook', {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'shh', 'content-type': 'application/json' },
    body: JSON.stringify(update),
  });
  await settle();
  return res;
};

const health = await req('/health');
check('health answers', health.status === 200);
// Which file is actually deployed has been the hidden cause of more than one
// bug here, so the built file says who it is and /health hands that back.
const healthBody = await health.json();
check('health reports which build is running',
  /^[0-9a-f]{8}$/.test(healthBody.build || ''), JSON.stringify(healthBody));

/* ---------- setup, the way SETUP.md describes it ---------- */

const badSecret = await req('/tg/register?secret=wrong');
check('register rejects a wrong secret', badSecret.status === 401, String(badSecret.status));

const reg = await req('/tg/register?secret=shh');
const regBody = await reg.json();
check('register succeeds', reg.status === 200 && regBody.ok === true, JSON.stringify(regBody));
check('register points Telegram at this Worker',
  regBody.webhook === `${ORIGIN}/tg/webhook`, String(regBody.webhook));
const hookCall = tgStub.sent.find((s) => s.method === 'setWebhook');
check('setWebhook actually called', !!hookCall);
check('setWebhook carries the secret', hookCall && hookCall.body.secret_token === 'shh');

/* Setup goes wrong in a handful of ways. Each one has to name itself, because
   this is the step done by hand and "server error" helps nobody. */

const withEnv = async (patch, path = '/tg/register?secret=shh') => {
  const res = await worker.fetch(new Request(ORIGIN + path), { ...env, ...patch }, ctx);
  return { status: res.status, body: await res.json() };
};

const noToken = await withEnv({ TG_TOKEN: '' });
check('missing token is named', noToken.status === 400 && /TG_TOKEN is not set/.test(noToken.body.error),
  JSON.stringify(noToken));

// A token this Worker considers odd is still sent to Telegram: Telegram decides.
const oddToken = await withEnv({ TG_TOKEN: 'no-colon-here' });
check('an odd-looking token is not blocked locally',
  oddToken.status === 200 || /Telegram refused/.test(oddToken.body.error || ''),
  JSON.stringify(oddToken));

/* When Telegram does refuse, the reply has to be enough to act on without
   anyone pasting a credential into a chat to ask for help. */

const saved = tgStub.fetchImpl;
const refuseWith = (description) => {
  globalThis.fetch = async (u, init) => {
    if (String(u).includes('/setWebhook')) {
      return new Response(JSON.stringify({ ok: false, description }), { status: 400 });
    }
    return saved(u, init);
  };
};

refuseWith('Unauthorized');
const refused = await withEnv({ TG_TOKEN: '  8123456789:AAFtesttesttesttesttesttesttesttest  ' });
check('Telegram refusing is passed through',
  refused.status === 502 && /Telegram refused: .*Unauthorized/.test(refused.body.error),
  JSON.stringify(refused));
check('a right-shaped token gets the re-copy hint',
  /Re-copy it from BotFather/.test(refused.body.hint), String(refused.body.hint));
check('the token is described, not revealed',
  refused.body.check.TG_TOKEN.hasColon === true
  && refused.body.check.TG_TOKEN.digitsBeforeColon === true
  && refused.body.check.TG_TOKEN.charsAfterColon === 35,
  JSON.stringify(refused.body.check));
check('no credential appears anywhere in the reply',
  !JSON.stringify(refused.body).includes('8123456789')
  && !JSON.stringify(refused.body).includes('shh'),
  JSON.stringify(refused.body));

// The real one from setup: right length, right shape, one lookalike character.
refuseWith('Not Found');
const dashed = await withEnv({ TG_TOKEN: '8123456789:AAFtesttesttesttest\u2013testtesttesttes' });
check('a lookalike dash is named, not missed',
  /en dash/.test(dashed.body.hint || ''), String(dashed.body.hint));
check('the odd character is reported by code point',
  (dashed.body.check.TG_TOKEN.nonAsciiCharacters || []).join(',') === 'U+2013',
  JSON.stringify(dashed.body.check.TG_TOKEN));
check('a right-shaped token is not mistaken for a good one',
  dashed.body.check.TG_TOKEN.charsAfterColon === 35 && dashed.body.check.TG_TOKEN.nonAscii === true,
  JSON.stringify(dashed.body.check.TG_TOKEN));

const invisible = await withEnv({ TG_TOKEN: '8123456789:AAFtest\u200Btesttesttesttesttesttesttes' });
check('an invisible character is named too',
  /zero-width/.test(invisible.body.hint || ''), String(invisible.body.hint));

refuseWith('Unauthorized');
const swapped = await withEnv({ TG_TOKEN: 'vN9DCZGs40toh1eyg5VQ' });
check('a value that is not token-shaped gets the swap hint',
  /not the token|swap/.test(swapped.body.hint || ''), String(swapped.body.hint));

refuseWith('Bad Request: secret_token contains unallowed characters');
const badSecret2 = await withEnv({ TG_WEBHOOK_SECRET: 'has spaces!' }, '/tg/register?secret=has spaces!');
check('a rejected secret gets the character hint',
  /letters, numbers, underscore and hyphen/.test(badSecret2.body.hint || ''), String(badSecret2.body.hint));
check('the secret is described, not revealed',
  badSecret2.body.check.TG_WEBHOOK_SECRET.onlyLettersNumbersDashUnderscore === false
  && !JSON.stringify(badSecret2.body).includes('has spaces'),
  JSON.stringify(badSecret2.body.check));

globalThis.fetch = saved;

/* ---------- a whole job, through the webhook ---------- */

check('webhook without the secret header is refused',
  (await req('/tg/webhook', { method: 'POST', body: '{}' })).status === 401);

await deliver(cmd('/project 23 JALAN KERUING'));
await deliver(cmd('/sec CAR PORCH'));
await deliver(photo({ caption: 'OVERVIEW' }));
await deliver(photo());
await deliver(cmd('/sec KITCHEN'));
await deliver(photo({ caption: 'UNFILLED GROUT' }));

const code = await kv.get('chat:-100123');
check('batch opened through the bundle', /^[A-Z0-9]{8}$/.test(code || ''), String(code));

await deliver(cmd('/done'));
const doneReply = tgStub.texts().at(-1);
check('code replied to the user', doneReply.includes(code), doneReply.replace(/\n/g, ' | '));
check('manifest file posted', tgStub.sent.some((s) => s.method === 'sendDocument'));

/* ---------- what the app reads ---------- */

const manifestRes = await req(`/api/batch/${code}`);
const manifest = await manifestRes.json();
check('manifest served', manifestRes.status === 200);
check('manifest names the project', manifest.project.name === '23 JALAN KERUING');
check('manifest has both sections', manifest.sections.map((s) => s.title).join(',') === 'CAR PORCH,KITCHEN',
  manifest.sections.map((s) => s.title).join(','));
check('manifest has every photo', manifest.total === 3, String(manifest.total));
check('captions carried', manifest.sections[0].photos[0].caption === 'OVERVIEW');

const photoRes = await req(`/api/photo/${code}/${manifest.sections[0].photos[0].id}`);
check('photo streams', photoRes.status === 200);
check('photo is an image', photoRes.headers.get('content-type') === 'image/jpeg');

/* ---------- the status route ---------- */
/* Built after a live setup sat with five photos waiting and the captioner
   reporting itself idle, with no way to see which of the two was lying. */

check('status needs the secret', (await req('/api/status?secret=wrong')).status === 401);

const st = await (await req('/api/status?secret=shh')).json();
check('status reports the build', st.build === healthBody.build, JSON.stringify(st.build));
check('status says whether a key is set', st.geminiKeySet === false, JSON.stringify(st.geminiKeySet));
check('status names the missing key as the reason',
  /GEMINI_KEY is not set/.test(st.diagnosis), st.diagnosis);
check('status lists the batch and what it is waiting on',
  st.batches.length === 1 && st.batches[0].code === code && st.batches[0].photos === 3,
  JSON.stringify(st.batches));
check('status carries no secret value',
  !JSON.stringify(st).includes('shh') && !JSON.stringify(st).includes('8123456789'),
  JSON.stringify(st));

// The case that started this: photos waiting, but the queue does not know
// about them, so the tick would never look. It has to say so rather than
// reporting itself idle.
await kv.delete('queue:pending');
const stranded = await (await req('/api/status?secret=shh'))
  .json()
  .then((s) => s);
const withKey = await worker.fetch(new Request(ORIGIN + '/api/status?secret=shh'),
  { ...env, GEMINI_KEY: 'k' }, ctx).then((r) => r.json());
check('a batch waiting off the queue is spotted',
  /not on the queue/.test(withKey.diagnosis), withKey.diagnosis);
check('and the fix is named', /rescan=1/.test(withKey.diagnosis), withKey.diagnosis);
check('the queue is reported as it actually is',
  Array.isArray(stranded.queue) && stranded.queue.length === 0, JSON.stringify(stranded.queue));

// A rescan repairs the queue, so nobody has to run it a second time. It needs
// a key to get as far as looking, which is the same order the real one runs in.
await worker.fetch(new Request(ORIGIN + '/api/caption/run?secret=shh&rescan=1'),
  { ...env, GEMINI_KEY: 'k' }, ctx);
check('a rescan puts the stranded batch back on the queue',
  (await kv.get('queue:pending') || '').includes(code), String(await kv.get('queue:pending')));

check('claim works', (await req(`/api/batch/${code}/claim`, { method: 'POST' })).status === 200);
check('claimed batch is gone', (await req(`/api/batch/${code}`)).status === 404);

report('bundle (the file you paste)');
