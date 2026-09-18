// Captions photos with Gemini, so a batch arrives already written up and the
// office only reviews.
//
// This is the browser assistant's logic (js/ai.js) with the browser taken out:
// same system prompt, same model ladder, same library hinting. Two deliberate
// differences, both forced by where it runs:
//
//   1. One photo per request, not eight. The app batches to save tokens, but a
//      Worker pays for base64 in CPU time and the free plan's budget is per
//      invocation. One small photo is comfortably inside it whatever the exact
//      limit turns out to be; eight would be a gamble.
//   2. No canvas to downscale with. Telegram already ships several sizes of
//      every photo, so the bot records the one nearest a Gemini tile when the
//      photo arrives and that is what gets sent.
//
// Nothing here is on the critical path. Captioning happens twice over:
//
//   * as each photo arrives, so a small job is written up by the time the last
//     photo is forwarded and there is nothing to wait for;
//   * from a cron tick, which sweeps up what the arrival pass could not do —
//     Gemini's free tier allows about fifteen requests a minute, so a couple of
//     hundred photos forwarded in one go will always spill over.
//
// A photo that fails simply arrives blank.

import * as tg from './telegram.js';
import * as batch from './batch.js';

const HOST = 'https://generativelanguage.googleapis.com/v1beta/models';
const WANTED = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const COOLDOWN_MS = 90_000;
const HINTS = 24;                 // library entries shown to the model
const COOLDOWN_KEY = 'ai:cooldown';
const MODELS_KEY = 'ai:models';
const MODELS_TTL = 21_600;        // 6 hours; a key's model list barely moves
const LADDER_MAX = 3;             // models tried per photo, before the budget bites

const SYSTEM =
  'Caption photos for a building defect report. Reply with the caption only. '
  + 'UPPERCASE, 4-7 words, plain QA/QC wording a contractor can action. '
  + 'Reuse a caption from the library when one fits. '
  + 'No defect visible: describe the item factually. Technical terms stay in English. '
  // These photos are stamped by the site team's camera app. The date is not the
  // defect and must never become the caption.
  + 'Ignore any date or time printed on the photo.';

const clean = (t) => String(t || '').replace(/^["'\s]+|["'.\s]+$/g, '').toUpperCase().slice(0, 90);

/* ------------------------- the library ------------------------- */

/**
 * The office's caption library if it has been pushed, otherwise the one built
 * into this file from js/captions.js. Either way the model is hinted with the
 * same wording the report will print.
 */
async function library(env) {
  const raw = await env.BATCHES.get('lib:captions');
  if (raw) {
    try {
      const lib = JSON.parse(raw);
      if (Array.isArray(lib) && lib.length) return lib;
    } catch { /* fall through to the built-in */ }
  }
  return DEFAULT_LIBRARY;
}

// Which caption groups suit which room. Ported from affinity() in
// js/captions.js — the app ranks by usage as well, which a Worker has no sight
// of, so this is the part that carries over.
const AFFINITY = {
  BATH: ['Plumbing', 'Tiling', 'Door & Window'],
  KITCHEN: ['Plumbing', 'Tiling', 'Electrical'],
  YARD: ['Plumbing', 'Metalwork'],
  'CAR PORCH': ['Metalwork', 'General'],
  EXTERNAL: ['Wall & Ceiling', 'Metalwork', 'Roofing'],
  STAIR: ['Tiling', 'Wall & Ceiling'],
  BEDROOM: ['Wall & Ceiling', 'Door & Window', 'Electrical'],
  LIVING: ['Tiling', 'Electrical', 'Door & Window'],
  DINING: ['Tiling', 'Electrical'],
  ROOF: ['Roofing', 'Wall & Ceiling'],
  CEILING: ['Roofing', 'Wall & Ceiling'],
  DB: ['Electrical'],
};

/** The captions worth the tokens for this room, most likely first. Named as in
 * js/ai.js, where the same job is done against the app's own library. */
function libraryHint(lib, sectionTitle) {
  const sec = String(sectionTitle || '').toUpperCase();
  const suited = new Set();
  for (const key of Object.keys(AFFINITY)) {
    if (sec.includes(key)) AFFINITY[key].forEach((g) => suited.add(g));
  }
  const flat = lib.flatMap((g) => g.items.map((t) => ({ group: g.group, text: t })));
  const ranked = [
    ...flat.filter((c) => suited.has(c.group)),
    ...flat.filter((c) => !suited.has(c.group)),
  ];
  return ranked.slice(0, HINTS).map((c) => c.text.replace(/\n/g, ' / ')).join(' | ');
}

/* ------------------------- which models this key has ------------------------- */

/*
 * Two model names were hardcoded here, and a real key could not see either of
 * them. Both were marked as resting on the first try and nothing was ever
 * captioned — with no error to look at, because a resting model is not a
 * failure. The app already learned this lesson and asks Google what the key
 * actually has; this is the same thing, ported, with the answer cached in KV so
 * a tick every two minutes does not ask afresh every time.
 */

const USABLE = (m) => !/embedding|aqa|imagen|image-generation|tts|native-audio|live/.test(m);

/** Every model this key can call generateContent on. */
export async function listModels(env, { refresh = false } = {}) {
  if (!refresh) {
    const raw = await env.BATCHES.get(MODELS_KEY);
    if (raw) {
      try {
        const cached = JSON.parse(raw);
        if (Array.isArray(cached) && cached.length) return cached;
      } catch { /* fall through and ask again */ }
    }
  }

  const found = [];
  let url = `${HOST}?pageSize=200`;
  for (let page = 0; page < 4 && url; page++) {
    const res = await fetch(url, { headers: { 'x-goog-api-key': env.GEMINI_KEY } });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error?.message || ''; } catch { /* non-JSON */ }
      throw new Error(`Google refused the model list (${res.status}). ${detail}`.trim());
    }
    const data = await res.json();
    for (const m of data.models || []) {
      if ((m.supportedGenerationMethods || []).includes('generateContent')) {
        found.push(String(m.name || '').replace(/^models\//, ''));
      }
    }
    url = data.nextPageToken
      ? `${HOST}?pageSize=200&pageToken=${encodeURIComponent(data.nextPageToken)}` : null;
  }
  found.sort();
  if (found.length) {
    await env.BATCHES.put(MODELS_KEY, JSON.stringify(found), { expirationTtl: MODELS_TTL });
  }
  return found;
}

/**
 * The closest model this key really has to the one we wanted.
 *
 * The rule that matters, same as in the app: when the key's list is known,
 * never hand back a name that is not on it. Returning the name we wished for is
 * how this failed — a 404 quoting a model nobody chose.
 */
export function resolve(wanted, available) {
  const list = (available || []).filter(USABLE);
  if (!list.length) return wanted;
  if (list.includes(wanted)) return wanted;

  const family = /lite/.test(wanted) ? 'lite' : /pro/.test(wanted) ? 'pro' : 'flash';
  const pick = (test) => list.find(test);
  const chosen = family === 'lite'
    ? pick((m) => /flash/.test(m) && /lite/.test(m)) || pick((m) => /flash/.test(m))
    : family === 'pro'
      ? pick((m) => /pro/.test(m) && !/vision/.test(m)) || pick((m) => /flash/.test(m))
      : pick((m) => /flash/.test(m) && !/lite/.test(m)) || pick((m) => /flash/.test(m));

  return chosen || pick((m) => /gemini/.test(m)) || list[0];
}

/** What to try, in order, for this key. Cheapest first, then whatever else it has. */
export async function ladderFor(env) {
  let available = [];
  let error = '';
  try {
    available = await listModels(env);
  } catch (err) {
    // No list is not fatal: the names we know are still worth a try, and a key
    // that cannot list may still generate.
    error = err.message;
  }
  if (!available.length) return { ladder: WANTED.slice(), available, error };

  const ladder = [];
  for (const wanted of WANTED) {
    const got = resolve(wanted, available);
    if (got && !ladder.includes(got)) ladder.push(got);
  }
  // A key whose models are all named something unfamiliar still has models.
  for (const m of available.filter(USABLE)) {
    if (ladder.length >= LADDER_MAX) break;
    if (!ladder.includes(m)) ladder.push(m);
  }
  return { ladder: ladder.slice(0, LADDER_MAX), available, error };
}

/* ------------------------- talking to Gemini ------------------------- */

/** Chunked, because a byte-at-a-time loop over a photo is the expensive way. */
function base64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Models rate-limited recently, so a tick does not walk into the same wall. */
async function cooling(env) {
  const raw = await env.BATCHES.get(COOLDOWN_KEY);
  const map = raw ? JSON.parse(raw) : {};
  const now = Date.now();
  return {
    ready: (m) => (map[m] || 0) < now,
    rest: async (m) => {
      map[m] = now + COOLDOWN_MS;
      await env.BATCHES.put(COOLDOWN_KEY, JSON.stringify(map), { expirationTtl: 600 });
    },
  };
}

/**
 * One caption from one model.
 *
 * `plain` drops the two optional pieces some models refuse outright — the
 * system instruction, which Google also calls the developer instruction, and
 * the thinking budget. The rules are not lost: they go at the front of the
 * prompt, which every model reads.
 */
async function ask(env, model, imageB64, prompt, plain = false) {
  const parts = [{ inline_data: { mime_type: 'image/jpeg', data: imageB64 } }];
  if (plain) parts.push({ text: `${SYSTEM}\n\n${prompt}` });
  else parts.push({ text: prompt });

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 32,
      // Flash reasons before answering out of the same budget, which can leave
      // a short caption with nothing left to say.
      ...(!plain && /flash/i.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
    ...(plain ? {} : { systemInstruction: { parts: [{ text: SYSTEM }] } }),
  };

  const res = await fetch(`${HOST}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* non-JSON */ }
    const err = new Error(`${res.status} ${detail}`.trim());
    err.status = res.status;
    // A rate limit or a model this key cannot see: step down the ladder.
    err.step = res.status === 429 || res.status === 404;
    // The model is fine but will not take part of the request: same model,
    // simpler request.
    err.plain = res.status === 400 && !plain
      && /instruction|thinking|not enabled|not supported|unsupported/i.test(detail);
    throw err;
  }

  const data = await res.json();
  const reply = data.candidates?.[0]?.content?.parts || [];
  return clean(reply.map((p) => p.text).filter(Boolean).join(''));
}

/* ------------------------- the pass ------------------------- */

/**
 * Caption up to `max` photos that have none. Returns what it did, which is what
 * the cron log and the manual trigger report.
 */
export async function captionPending(env, max = 6, { rescan = false } = {}) {
  if (!env.GEMINI_KEY) return { ok: false, reason: 'GEMINI_KEY is not set', done: 0 };

  // One read, and usually the end of it. This runs every couple of minutes
  // forever, so an idle tick has to cost as close to nothing as possible — in
  // particular it must not list keys, which is the scarcest free allowance.
  const codes = rescan ? await openCodes(env) : await batch.queueList(env);
  // Say which list this looked at and what was on it. Without that, a rescan
  // that found nothing and a tick that found nothing read identically, and
  // there was no way to tell a repaired queue from a request whose &rescan=1
  // never arrived.
  const looked = { scanned: rescan ? 'every batch' : 'the queue', found: codes.length };
  if (!codes.length) {
    return { ok: true, ...looked, done: 0, failed: 0, remaining: 0, idle: true, errors: [] };
  }

  const lib = await library(env);
  const cool = await cooling(env);
  const { ladder, error: ladderError } = await ladderFor(env);
  const out = { ok: true, ...looked, models: ladder, done: 0, failed: 0, remaining: 0, errors: [] };
  if (ladderError) out.errors.push(ladderError);

  for (const code of codes) {
    // Summaries first, so finding the handful still to do costs one request
    // rather than one per photo. Only the ones actually being captioned are
    // then read in full.
    const waiting = (await batch.listSummaries(env, code)).filter((p) => !p.tried);
    if (!waiting.length) {
      // Nothing left here: take it off the queue so later ticks cost one read.
      await batch.queueRemove(env, code);
      continue;
    }
    // A rescan is what you run when the queue has lost something — photos filed
    // before the queue existed, or a write that did not land. Put it back, so
    // the fix is permanent and nobody has to run this twice.
    if (rescan) await batch.queueAdd(env, code);

    for (const s of waiting) {
      if (out.done + out.failed >= max) { out.remaining++; continue; }
      try {
        const photo = await batch.getPhoto(env, code, s.id);
        if (!photo) continue;
        await captionOne(env, code, photo, lib, cool, ladder);
        out.done++;
      } catch (err) {
        out.failed++;
        if (out.errors.length < 3) out.errors.push(err.message);
        // Mark it tried so one unreadable photo cannot block the queue forever
        // — but not when the only thing wrong was a rate limit, which is the
        // ordinary outcome of forwarding two hundred photos at once and clears
        // by itself. That one is left pending for the next tick.
        if (!err.retry) await batch.updatePhoto(env, code, s.id, { aiCaption: '' });
      }
    }
  }
  return out;
}

async function captionOne(env, code, photo, lib, cool, ladder) {
  // The variant nearest a Gemini tile, chosen when the photo arrived. Older
  // batches only have the full-size one.
  const file = await tg.openFile(env, photo.aiFileId || photo.fileId);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const prompt = `Room: ${photo.section || 'unspecified'}\nLibrary: ${libraryHint(lib, photo.section)}`;
  const img = base64(bytes);

  let last = null;
  for (const model of ladder) {
    if (!cool.ready(model)) continue;
    for (const plain of [false, true]) {
      try {
        const text = await ask(env, model, img, prompt, plain);
        if (text) {
          // Written straight from the record in hand: reading it back to patch
          // it would cost an extra operation on every photo of every batch.
          await batch.putPhoto(env, code, { ...photo, aiCaption: text, aiModel: model });
          return text;
        }
        last = new Error('empty reply');
        break;
      } catch (err) {
        last = err;
        if (err.step) await cool.rest(model);
        if (err.plain) continue;    // same model, without the parts it refused
        if (!err.step) return Promise.reject(err);   // a real error: no model helps
        break;
      }
    }
  }
  const err = last || new Error('every model is resting');
  // Rate limits and resting models clear on their own, so the caller should
  // leave the photo pending rather than writing it off.
  if (!last || last.step) err.retry = true;
  throw err;
}

/**
 * Caption one photo the moment it is filed, from the webhook that filed it.
 *
 * This is what makes an ordinary job — a few dozen photos — arrive already
 * written up, with no tick to wait for. It gives up cheaply and silently: the
 * photo is already on the queue, so anything not done here is done by the next
 * tick, and nothing about the bot's reply depends on it.
 */
export async function captionOnArrival(env, code, rec) {
  if (!env.GEMINI_KEY || !rec || rec.caption) return null;

  const cool = await cooling(env);
  const { ladder } = await ladderFor(env);
  // Gemini said "too fast" a moment ago and the rest of the burst is still
  // coming. Stop before reading the library or downloading anything: every
  // photo behind this one would otherwise pay for the same refusal.
  if (!ladder.some((m) => cool.ready(m))) return null;

  // Outside the try on purpose: only a failure to caption should write the photo
  // off, never a storage hiccup reading the library.
  const lib = await library(env);
  try {
    return await captionOne(env, code, rec, lib, cool, ladder);
  } catch (err) {
    if (!err.retry) await batch.updatePhoto(env, code, rec.id, { aiCaption: '' });
    return null;
  }
}

/** Every batch that still exists — the slow way, for a rescan. */
async function openCodes(env) {
  const codes = [];
  let cursor;
  do {
    const page = await env.BATCHES.list({ prefix: 'batch:', cursor });
    for (const k of page.keys) {
      const m = /^batch:([A-Z0-9]+):meta$/.exec(k.name);
      if (m) codes.push(m[1]);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return codes;
}
