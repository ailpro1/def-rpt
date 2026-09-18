// The captioning pass, against a stubbed Gemini. Checks what it sends as much
// as what it stores — the prompt is the product here.
//
//   node worker/test/caption.test.js
import { captionPending } from '../src/caption.js';
import { handleUpdate } from '../src/bot.js';
import * as batch from '../src/batch.js';
import { FakeKV, fakeTelegram, makeEnv, ctx, settle, cmd, photo, check, report } from './harness.js';

const tgStub = fakeTelegram();
const gemini = { calls: [], reply: 'UNFILLED GROUT', fail: null };

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('generativelanguage')) {
    const body = JSON.parse(init.body);
    gemini.calls.push({ model: /models\/([^:]+):/.exec(u)[1], body });
    if (gemini.fail) {
      return new Response(JSON.stringify({ error: { message: gemini.fail.message } }),
        { status: gemini.fail.status });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: gemini.reply }] } }],
    }), { status: 200 });
  }
  return tgStub.fetchImpl(url, init);
};

const kv = new FakeKV();
// The bot here has no Gemini key, so photos arrive uncaptioned and the sweep
// below has something to do. Captioning on arrival is a separate entry point
// and gets its own section at the end of this file, with its own key.
const env = makeEnv(kv, { CAPTION_PX: '768' });
const ai = { ...env, GEMINI_KEY: 'test-key' };
const feed = (u) => handleUpdate(env, u, ctx);

// Give DEFAULT_LIBRARY a value: the sources read it as a global that build.mjs
// injects, so in a source-level test it has to be supplied.
globalThis.DEFAULT_LIBRARY = [
  { group: 'Tiling', items: ['UNFILLED GROUT', 'HOLLOW TILE', 'CHIPPED TILE'] },
  { group: 'Plumbing', items: ['LEAK AT TRAP', 'PONDING OBSERVED'] },
  { group: 'Metalwork', items: ['RUSTED HINGE'] },
  { group: 'General', items: ['POOR FINISHING', 'OVERVIEW'] },
];

/* ---------- a batch to work on ---------- */

await feed(cmd('/project 23 JALAN KERUING'));
await feed(cmd('/sec BATH 1'));
await feed(photo());                                   // no caption: for the AI
await feed(photo({ caption: 'TYPED BY THE SITE TEAM' }));  // already captioned
const code = await kv.get('chat:-100123');

/* ---------- the pass ---------- */

const run1 = await captionPending(ai, 6);
check('one photo captioned', run1.done === 1, JSON.stringify(run1));
check('a typed caption is left alone', gemini.calls.length === 1, `${gemini.calls.length} calls`);

let photos = await batch.listPhotos(env, code);
const written = photos.find((p) => p.aiCaption);
check('caption stored', written && written.aiCaption === 'UNFILLED GROUT',
  written ? written.aiCaption : 'none');
check('the model used is recorded', written && written.aiModel === 'gemini-2.5-flash-lite',
  written ? written.aiModel : 'none');

/* ---------- what actually goes to the model ---------- */

const sent = gemini.calls[0].body;
check('cheapest model first', gemini.calls[0].model === 'gemini-2.5-flash-lite', gemini.calls[0].model);
check('the photo is sent inline', !!sent.contents[0].parts[0].inline_data);
check('the small variant was fetched, not the full size',
  written.aiFileId !== written.fileId, `${written.aiFileId} vs ${written.fileId}`);

const prompt = sent.contents[0].parts[1].text;
check('the room is named', /Room: BATH 1/.test(prompt), prompt.slice(0, 60));
check('the library is offered', /Library: /.test(prompt));
check('plumbing and tiling lead for a bathroom',
  prompt.indexOf('LEAK AT TRAP') < prompt.indexOf('RUSTED HINGE'), prompt);

const system = sent.systemInstruction.parts[0].text;
check('same wording rules as the app', /UPPERCASE, 4-7 words/.test(system));
check('the burnt-in timestamp is ruled out', /Ignore any date or time/.test(system));
check('thinking is off for flash', sent.generationConfig.thinkingConfig.thinkingBudget === 0);
check('the reply is capped short', sent.generationConfig.maxOutputTokens === 32);

/* ---------- second pass does not redo work ---------- */

const before = gemini.calls.length;
const run2 = await captionPending(ai, 6);
check('nothing left to do', run2.done === 0 && gemini.calls.length === before, JSON.stringify(run2));

/* ---------- the manifest reflects it ---------- */

const meta = await batch.getMeta(env, code);
const manifest = batch.manifest(meta, await batch.listPhotos(env, code));
check('no captions pending', manifest.pending === 0, String(manifest.pending));
const caps = manifest.sections.flatMap((s) => s.photos);
check('AI caption is carried', caps.some((c) => c.caption === 'UNFILLED GROUT' && c.captionSource === 'ai'));
check('typed caption is carried and marked',
  caps.some((c) => c.caption === 'TYPED BY THE SITE TEAM' && c.captionSource === 'typed'));

/* ---------- rate limits step down, they do not fail ---------- */

await feed(cmd('/sec KITCHEN'));
await feed(photo());
gemini.calls.length = 0;
gemini.fail = { status: 429, message: 'Quota exceeded' };
const limited = await captionPending(ai, 2);
check('a rate limit tries the next model up',
  gemini.calls.map((c) => c.model).join(',') === 'gemini-2.5-flash-lite,gemini-2.5-flash',
  gemini.calls.map((c) => c.model).join(','));
check('the photo is not left to jam the queue', limited.failed === 1, JSON.stringify(limited));
check('a cooldown is remembered', !!(await kv.get('ai:cooldown')));

// A rate limit is the ordinary outcome of forwarding a couple of hundred photos
// at once, and it clears by itself. Writing the photo off as tried would leave
// most of a big job permanently blank — it has to come back on the next tick.
const stillOpen = (await batch.listSummaries(env, code)).filter((p) => !p.tried);
check('a rate-limited photo stays pending for the next tick',
  stillOpen.length === 1, `${stillOpen.length} pending`);
// Clear it by hand so the cases below start from a drained queue.
if (stillOpen[0]) await batch.dropPhoto(env, code, stillOpen[0].id);

/* ---------- a batch is never blocked by captioning ---------- */

await feed(cmd('/done'));
const closed = await batch.getMeta(env, code);
check('/done still closes with captions incomplete', closed.status === 'closed');

/* ---------- no key: says so, breaks nothing ---------- */

const keyless = await captionPending({ ...env, GEMINI_KEY: '' }, 6);
check('a missing key is reported, not thrown',
  keyless.ok === false && /GEMINI_KEY/.test(keyless.reason), JSON.stringify(keyless));

/* ---------- the office library overrides the built-in ---------- */

gemini.fail = null;
// Both models are still resting after the rate-limit case above — which is the
// cooldown doing its job, and has to be cleared before asking for more work.
await env.BATCHES.delete('ai:cooldown');
await env.BATCHES.put('lib:captions', JSON.stringify(
  [{ group: 'Tiling', items: ['A CAPTION ONLY THE OFFICE HAS'] }]));
await feed(cmd('/project SECOND JOB'));
await feed(cmd('/sec BATH 2'));
await feed(photo());
gemini.calls.length = 0;
await captionPending(ai, 1);
check('a pushed library is used instead',
  /A CAPTION ONLY THE OFFICE HAS/.test(gemini.calls[0].body.contents[0].parts[1].text),
  gemini.calls[0].body.contents[0].parts[1].text);

/* ---------- a model that refuses a system instruction ---------- */
/* The same key the app uses hit this on a real phone: the model is there, the
   key is fine, and it answers 400 "Developer instruction is not enabled". */

await env.BATCHES.delete('ai:cooldown');
gemini.calls.length = 0;
let refusedOnce = false;
const plainStub = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('generativelanguage')) {
    const body = JSON.parse(init.body);
    gemini.calls.push({ model: /models\/([^:]+):/.exec(u)[1], body });
    if (body.systemInstruction) {
      refusedOnce = true;
      return new Response(JSON.stringify({ error: {
        message: 'Developer instruction is not enabled for models/x' } }), { status: 400 });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'CHIPPED TILE' }] } }],
    }), { status: 200 });
  }
  return tgStub.fetchImpl(url, init);
};

await feed(cmd('/sec BATH 3'));
await feed(photo());
const picky = await captionPending(ai, 1);
check('a model refusing the instruction still produces a caption',
  picky.done === 1, JSON.stringify(picky));
check('it was refused once, then retried without it',
  refusedOnce && gemini.calls.some((c) => !c.body.systemInstruction),
  JSON.stringify(gemini.calls.map((c) => Object.keys(c.body))));
const plainBody = gemini.calls.find((c) => !c.body.systemInstruction).body;
const sentText = plainBody.contents[0].parts.map((p) => p.text).filter(Boolean).join('');
check('the rules travel in the prompt instead', /UPPERCASE, 4-7 words/.test(sentText),
  sentText.slice(0, 80));
check('the photo is still attached',
  plainBody.contents[0].parts.some((p) => p.inline_data));
globalThis.fetch = plainStub;

/* ---------- captioning as the photo arrives ---------- */
/* The tick is the safety net, not the main road. An ordinary job is a few dozen
   photos, and those should be written up by the time the last one is forwarded
   — nobody should be sitting watching a clock for a batch of twenty. */

{
  const kv2 = new FakeKV();
  const live = makeEnv(kv2, { GEMINI_KEY: 'test-key', CAPTION_PX: '768' });
  // Deliberately NO ctx. The webhook calls handleUpdate from inside its own
  // ctx.waitUntil, after the response has gone back to Telegram, and a
  // waitUntil called from there can be dropped without a word — which is
  // exactly how this shipped once and captioned nothing at all. Captioning has
  // to be part of the promise handleUpdate returns, so passing no ctx must
  // change nothing.
  const send = (u) => handleUpdate(live, u, undefined);

  gemini.fail = null;
  gemini.reply = 'HOLLOW TILE';
  await send(cmd('/project 9 JALAN MERBAU'));
  await send(cmd('/sec BATH 1'));
  await send(photo());

  const code2 = await kv2.get('chat:-100123');
  const arrived = (await batch.listSummaries(live, code2))[0];
  check('a photo is captioned as it arrives, with no tick',
    arrived && arrived.caption === 'HOLLOW TILE' && arrived.captionSource === 'ai',
    JSON.stringify(arrived));

  // And having done it, the tick finds nothing and drops the batch off the queue.
  const sweep = await captionPending(live, 6);
  check('the tick has nothing left to do after an arrival pass',
    sweep.done === 0, JSON.stringify(sweep));
  check('a fully captioned batch leaves the queue',
    !(await batch.queueList(live)).includes(code2),
    JSON.stringify(await batch.queueList(live)));

  /* A burst: Gemini rate-limits partway through, as it will with 200 photos. */

  await kv2.delete('ai:cooldown');
  gemini.fail = { status: 429, message: 'Quota exceeded' };
  gemini.calls.length = 0;
  await send(cmd('/sec KITCHEN'));
  // One at a time, because that is how they land: Telegram delivers each photo
  // as its own request, seconds apart, so what the first one learns is there for
  // the next.
  for (let i = 0; i < 3; i++) await send(photo());

  const pending = (await batch.listSummaries(live, code2)).filter((p) => !p.tried);
  check('a rate-limited burst is left for the tick, not written off',
    pending.length === 3, `${pending.length} of 3 still pending`);
  check('the burst stops asking once a model is resting, rather than one refusal each',
    gemini.calls.length === 2, `${gemini.calls.length} calls for 3 photos`);
  check('the batch is back on the queue for the tick',
    (await batch.queueList(live)).includes(code2));

  // Cooldown over, Gemini willing: the tick clears the backlog.
  await kv2.delete('ai:cooldown');
  gemini.fail = null;
  const rescue = await captionPending(live, 6);
  check('the tick picks up what the burst could not', rescue.done === 3, JSON.stringify(rescue));

  /* A photo the bot cannot read is a different thing: trying again will never
     help, so it is marked and never looked at again. */

  await send(cmd('/sec YARD'));
  gemini.fail = { status: 403, message: 'API key not valid' };
  await send(photo());
  const dud = (await batch.listSummaries(live, code2)).filter((p) => !p.tried);
  check('a permanent failure is written off, not retried for ever',
    dud.length === 0, `${dud.length} still pending`);
  gemini.fail = null;
}

/* ---------- a run says which list it looked at ---------- */
/* A rescan that finds nothing and a tick that finds nothing used to read
   identically, so there was no way to tell a genuinely empty account from a
   request whose &rescan=1 never arrived. */

{
  const kv4 = new FakeKV();
  const empty = makeEnv(kv4, { GEMINI_KEY: 'test-key' });
  const viaQueue = await captionPending(empty, 6);
  const viaScan = await captionPending(empty, 6, { rescan: true });
  check('a tick says it read the queue',
    viaQueue.scanned === 'the queue' && viaQueue.found === 0, JSON.stringify(viaQueue));
  check('a rescan says it read every batch',
    viaScan.scanned === 'every batch' && viaScan.found === 0, JSON.stringify(viaScan));
  check('the two are told apart', viaQueue.scanned !== viaScan.scanned);
}

/* ---------- no key: the bot still collects ---------- */

{
  const kv3 = new FakeKV();
  const keyless3 = makeEnv(kv3, { CAPTION_PX: '768' });
  const before3 = gemini.calls.length;
  await handleUpdate(keyless3, cmd('/project NO AI HERE'), ctx);
  await handleUpdate(keyless3, cmd('/sec PORCH'), ctx);
  await handleUpdate(keyless3, photo(), ctx);
  await settle();
  const code3 = await kv3.get('chat:-100123');
  check('without a key the photo is still filed',
    (await batch.listSummaries(keyless3, code3)).length === 1);
  check('and nothing is asked of Gemini', gemini.calls.length === before3,
    `${gemini.calls.length - before3} calls`);
}

report('captioning');
