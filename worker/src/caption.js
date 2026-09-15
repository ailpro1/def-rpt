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
// Nothing here is on the critical path: captioning runs from a cron tick, a few
// photos at a time, and a photo that fails simply arrives blank.

import * as tg from './telegram.js';
import * as batch from './batch.js';

const HOST = 'https://generativelanguage.googleapis.com/v1beta/models';
const LADDER = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const COOLDOWN_MS = 90_000;
const HINTS = 24;                 // library entries shown to the model
const COOLDOWN_KEY = 'ai:cooldown';

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

async function ask(env, model, imageB64, prompt) {
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: 'image/jpeg', data: imageB64 } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 32,
      // Flash reasons before answering out of the same budget, which can leave
      // a short caption with nothing left to say.
      ...(/flash/i.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
    systemInstruction: { parts: [{ text: SYSTEM }] },
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
    throw err;
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  return clean(parts.map((p) => p.text).filter(Boolean).join(''));
}

/* ------------------------- the pass ------------------------- */

/**
 * Caption up to `max` photos that have none. Returns what it did, which is what
 * the cron log and the manual trigger report.
 */
export async function captionPending(env, max = 6) {
  if (!env.GEMINI_KEY) return { ok: false, reason: 'GEMINI_KEY is not set', done: 0 };

  const lib = await library(env);
  const cool = await cooling(env);
  const out = { ok: true, done: 0, failed: 0, remaining: 0, errors: [] };

  for (const code of await openCodes(env)) {
    const photos = await batch.listPhotos(env, code);
    const meta = await batch.getMeta(env, code);
    if (!meta) continue;

    for (const p of photos) {
      // A caption the site team typed wins: they were standing in front of it.
      if (p.caption || p.aiCaption !== undefined) continue;
      if (out.done + out.failed >= max) { out.remaining++; continue; }

      try {
        await captionOne(env, code, p, lib, cool);
        out.done++;
      } catch (err) {
        out.failed++;
        if (out.errors.length < 3) out.errors.push(err.message);
        // Mark it tried so one unreadable photo cannot block the queue forever.
        await batch.updatePhoto(env, code, p.id, { aiCaption: '' });
      }
    }
  }
  return out;
}

async function captionOne(env, code, photo, lib, cool) {
  // The variant nearest a Gemini tile, chosen when the photo arrived. Older
  // batches only have the full-size one.
  const file = await tg.openFile(env, photo.aiFileId || photo.fileId);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const prompt = `Room: ${photo.section || 'unspecified'}\nLibrary: ${libraryHint(lib, photo.section)}`;
  const img = base64(bytes);

  let last = null;
  for (const model of LADDER) {
    if (!cool.ready(model)) continue;
    try {
      const text = await ask(env, model, img, prompt);
      if (text) {
        await batch.updatePhoto(env, code, photo.id, { aiCaption: text, aiModel: model });
        return text;
      }
      last = new Error('empty reply');
    } catch (err) {
      last = err;
      if (err.step) await cool.rest(model);
      if (!err.step) break;         // a real error: another model will not help
    }
  }
  throw last || new Error('no model available');
}

/** Every batch that still exists, newest first. */
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
