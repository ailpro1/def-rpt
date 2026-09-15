// The captioning pass, against a stubbed Gemini. Checks what it sends as much
// as what it stores — the prompt is the product here.
//
//   node worker/test/caption.test.js
import { captionPending } from '../src/caption.js';
import { handleUpdate } from '../src/bot.js';
import * as batch from '../src/batch.js';
import { FakeKV, fakeTelegram, makeEnv, ctx, cmd, photo, check, report } from './harness.js';

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
const env = makeEnv(kv, { GEMINI_KEY: 'test-key', CAPTION_PX: '768' });
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

const run1 = await captionPending(env, 6);
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
const run2 = await captionPending(env, 6);
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
const limited = await captionPending(env, 2);
check('a rate limit tries the next model up',
  gemini.calls.map((c) => c.model).join(',') === 'gemini-2.5-flash-lite,gemini-2.5-flash',
  gemini.calls.map((c) => c.model).join(','));
check('the photo is not left to jam the queue', limited.failed === 1, JSON.stringify(limited));
check('a cooldown is remembered', !!(await kv.get('ai:cooldown')));

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
await captionPending(env, 1);
check('a pushed library is used instead',
  /A CAPTION ONLY THE OFFICE HAS/.test(gemini.calls[0].body.contents[0].parts[1].text),
  gemini.calls[0].body.contents[0].parts[1].text);

report('captioning');
