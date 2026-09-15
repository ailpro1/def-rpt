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

check('health answers', (await req('/health')).status === 200);

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

const badToken = await withEnv({ TG_TOKEN: 'not-a-token' });
check('malformed token is named', badToken.status === 400 && /does not look like a bot token/.test(badToken.body.error),
  JSON.stringify(badToken));

const badSecretChars = await withEnv({ TG_WEBHOOK_SECRET: 'has spaces!' }, '/tg/register?secret=has spaces!');
check('illegal secret characters are named',
  badSecretChars.status === 400 && /letters, numbers/.test(badSecretChars.body.error),
  JSON.stringify(badSecretChars));

// Telegram itself refusing, which is what "server error" used to hide.
const saved = tgStub.fetchImpl;
globalThis.fetch = async (u, init) => {
  if (String(u).includes('/setWebhook')) {
    return new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 });
  }
  return saved(u, init);
};
const refused = await withEnv({});
check('Telegram refusing is passed through',
  refused.status === 502 && /Telegram refused: .*Unauthorized/.test(refused.body.error),
  JSON.stringify(refused));
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

check('claim works', (await req(`/api/batch/${code}/claim`, { method: 'POST' })).status === 200);
check('claimed batch is gone', (await req(`/api/batch/${code}`)).status === 404);

report('bundle (the file you paste)');
