// AI assistant — Google AI Studio (Gemini). Optional and online-only: every other
// part of the app works with no connection. The key is stored on-device
// (IndexedDB), sent only to generativelanguage.googleapis.com, and is excluded
// from backup files.
//
// Two things this module works hard at, because the free tier is the target:
//   1. Sending as few tokens as possible (small images, ranked library, tight
//      prompts, capped replies, batching).
//   2. Picking the cheapest model that can do the job, and stepping to another
//      one by itself when a model is rate limited, missing or unhelpful.
import { getSettings, saveSettings } from './store.js';
import { rankCaptions } from './captions.js';
import { aiCopy } from './image.js';
import { DEFAULT_MODEL } from './assist.js';
import { offlineCaption, offlineSummary } from './fallback.js';

const HOST = 'https://generativelanguage.googleapis.com/v1beta/models';

// Cheapest capable model first. Vision captions are short and highly constrained,
// so Lite handles them; prose and multi-image ordering go to Flash first.
const LADDER = {
  caption: ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
  batch: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  text: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
};

// How many captions from the library to show the model. The ranker puts the ones
// that actually apply to this room at the top, so a long tail costs tokens for
// nothing.
const LIBRARY_HINTS = 24;
const COOLDOWN_MS = 90_000;

const cooling = new Map();          // model -> timestamp it may be used again
const isCool = (m) => (cooling.get(m) || 0) < Date.now();

/**
 * Ask the key which models it actually has. Model names change and differ by
 * key, so nothing here is hardcoded as fact — the ladder above is a preference
 * order, and this is the source of truth.
 */
export async function listModels() {
  const s = await getSettings();
  const key = s.ai?.key;
  if (!key) throw new Error('No API key set. Add one in Settings > AI Assistant.');
  if (!isOnline()) throw new Error('Offline — the model list needs a connection.');

  const found = [];
  let url = `${HOST}?pageSize=200`;
  for (let page = 0; page < 4 && url; page++) {
    const res = await fetch(url, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error?.message || ''; } catch { /* ignore */ }
      if (res.status === 400 || res.status === 403) throw new Error(`That API key was rejected. ${detail.slice(0, 120)}`);
      throw new Error(`Could not read the model list (${res.status}).`);
    }
    const data = await res.json();
    (data.models || []).forEach((m) => {
      if ((m.supportedGenerationMethods || []).includes('generateContent')) {
        found.push(String(m.name || '').replace(/^models\//, ''));
      }
    });
    url = data.nextPageToken ? `${HOST}?pageSize=200&pageToken=${encodeURIComponent(data.nextPageToken)}` : null;
  }
  // Newest-looking first, so the presets in Settings read sensibly.
  found.sort();
  return found;
}

const USABLE = (m) => !/embedding|aqa|imagen|image-generation|tts|native-audio|live/.test(m);

/**
 * Pick the closest model this key really has to the one we wanted.
 *
 * The one rule that matters: when we know what the key has, never hand back a
 * name that is not on that list. Returning the name we wished for produces a
 * 404 and an error quoting a model the user never chose, which is exactly how
 * this used to fail.
 */
function resolve(wanted, available) {
  const list = (available || []).filter(USABLE);
  if (!list.length) return wanted;              // nothing known: the ladder is all we have
  if (list.includes(wanted)) return wanted;

  const family = /lite/.test(wanted) ? 'lite' : /pro/.test(wanted) ? 'pro' : 'flash';
  const pick = (test) => list.find(test);
  const chosen = family === 'lite'
    ? pick((m) => /flash/.test(m) && /lite/.test(m)) || pick((m) => /flash/.test(m))
    : family === 'pro'
      ? pick((m) => /pro/.test(m) && !/vision/.test(m)) || pick((m) => /flash/.test(m))
      : pick((m) => /flash/.test(m) && !/lite/.test(m)) || pick((m) => /flash/.test(m));

  // Nothing familiar by name — a key whose models are all called something else
  // still has models, so use one rather than a name we know is wrong.
  return chosen || pick((m) => /gemini/.test(m)) || list[0];
}

export const isOnline = () => navigator.onLine;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function aiReady() {
  const s = await getSettings();
  return !!(s.ai && s.ai.enabled && s.ai.key && isOnline());
}

class Retryable extends Error {
  constructor(message, { cooldown = false, missing = false, plain = false } = {}) {
    super(message);
    this.cooldown = cooldown;
    this.missing = missing;
    // The model is there and the key is fine, but it will not take part of the
    // request — try it again with the optional pieces left out.
    this.plain = plain;
  }
}

/**
 * One generateContent call against a named model.
 *
 * `plain` drops the two optional pieces some models refuse: the system
 * instruction (Google also calls it the developer instruction) and the thinking
 * budget. The instruction is not lost — it is prepended to the prompt, which
 * every model accepts.
 */
async function callModel(model, key, parts, { system, maxTokens, temperature, plain = false }) {
  const generationConfig = { temperature, maxOutputTokens: maxTokens };
  // 2.5 Flash reasons before answering and those tokens come out of the same
  // budget, which can leave a short caption request with nothing left to say.
  // Captions do not need it, so turn it off where the model allows it.
  if (!plain && /flash/i.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  let sent = parts;
  const body = { contents: [{ role: 'user', parts: sent }], generationConfig };
  if (system && !plain) {
    body.systemInstruction = { parts: [{ text: system }] };
  } else if (system) {
    // Rules first, then the request, in the one field every model reads.
    sent = [{ text: system }, ...parts];
    body.contents = [{ role: 'user', parts: sent }];
  }

  let res;
  try {
    res = await fetch(`${HOST}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Retryable('Could not reach the assistant. Check your connection.');
  }

  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j.error && j.error.message) || ''; } catch { /* non-JSON body */ }
    if (res.status === 429) throw new Retryable('Rate limit reached on this key.', { cooldown: true });
    if (res.status === 404) {
      throw new Retryable(`Model "${model}" is not available for this key.`, { cooldown: true, missing: true });
    }
    if (res.status >= 500) throw new Retryable('Google AI Studio is unavailable right now.');
    if (res.status === 400 && /API key not valid/i.test(detail)) throw new Error('That API key was rejected. Check it in Settings > AI Assistant.');
    // "Developer instruction is not enabled for models/x", "thinking is not
    // supported", and friends: the request shape, not the key or the model.
    if (res.status === 400 && !plain
        && /instruction|thinking|not enabled|not supported|unsupported/i.test(detail)) {
      throw new Retryable(`${model} will not take part of that request.`, { plain: true });
    }
    if (res.status === 403) throw new Error('The API key is not authorised for this request.');
    throw new Error(`AI request failed (${res.status}). ${detail.slice(0, 160)}`);
  }

  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  const text = ((cand && cand.content && cand.content.parts) || [])
    .map((p) => p.text).filter(Boolean).join('').trim();

  if (!text) {
    const reason = (cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason);
    if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT') throw new Error('The model declined to answer for this photo.');
    throw new Retryable(reason === 'MAX_TOKENS' ? 'The reply was cut off.' : 'The assistant returned nothing.');
  }
  return text;
}

/**
 * Run a task on the cheapest model that works. Steps down the ladder on a rate
 * limit, a missing model or an unusable reply, then waits once and retries.
 * A model the user has pinned is used on its own.
 */
/**
 * What this key actually has, remembered between runs. Model names change and
 * differ by key, so auto mode cannot work from the hardcoded ladder alone — and
 * asking the user to go and press Test connection is the app making its own
 * problem someone else's.
 */
async function knownModels(s, { refresh = false } = {}) {
  if (!refresh && s.ai.available && s.ai.available.length) return s.ai.available;
  try {
    const found = await listModels();
    if (found.length) {
      await saveSettings({ ai: { ...s.ai, available: found, checkedAt: Date.now() } });
      return found;
    }
  } catch { /* offline or rejected: fall back to the ladder as written */ }
  return s.ai.available || [];
}

async function run(task, parts, { system, maxTokens = 1024, temperature = 0.2 } = {}) {
  const s = await getSettings();
  const key = s.ai?.key;
  if (!key) throw new Error('No API key set. Add one in Settings > AI Assistant.');
  if (!isOnline()) throw new Error('Offline — AI features need a connection.');

  const auto = s.ai.auto !== false;
  // In auto mode, find out what the key has before guessing at names.
  let available = auto ? await knownModels(s) : s.ai.available;

  const attempt = async () => {
    const wanted = auto ? (LADDER[task] || LADDER.text) : [s.ai.model || DEFAULT_MODEL];
    const ladder = [...new Set(wanted.map((m) => resolve(m, available)))];
    // On a key whose models are all named unfamiliarly, every rung can resolve
    // to the same one. Walk on into the rest of what the key has rather than
    // giving up after a single refusal.
    if (auto) {
      const rest = (available || []).filter(USABLE).filter((m) => !ladder.includes(m));
      ladder.push(...rest.slice(0, 2));
    }
    const ready = ladder.filter(isCool);
    const order = ready.length ? ready : ladder;   // everything cooling: try anyway

    let last = null;
    for (const model of order) {
      for (const plain of [false, true]) {
        try {
          return { text: await callModel(model, key, parts, { system, maxTokens, temperature, plain }) };
        } catch (err) {
          if (!(err instanceof Retryable)) throw err;
          if (err.cooldown) cooling.set(model, Date.now() + COOLDOWN_MS);
          last = err;
          // Only a refusal of the request shape is worth a second go at the
          // same model; anything else moves on.
          if (!err.plain) break;
        }
      }
    }
    return { failed: last, order };
  };

  let { text, failed: last, order } = await attempt();
  if (text !== undefined) return text;

  // Every model on the ladder was missing: the remembered list is out of date,
  // or was never fetched. Refresh it and try once more rather than handing the
  // user an instruction.
  if (auto && last && last.missing) {
    const fresh = await knownModels(s, { refresh: true });
    if (fresh.length && fresh.join() !== (available || []).join()) {
      available = fresh;
      cooling.clear();
      ({ text, failed: last, order } = await attempt());
      if (text !== undefined) return text;
    }
  }

  if (last && last.missing) {
    const tried = (order || []).join(', ');
    const have = (available || []).filter(USABLE).length;
    throw new Error(`None of the models this key offers would answer. Tried: ${tried}. `
      + `The key lists ${have} usable model(s). ${last.message}`);
  }
  // One paced retry on the preferred model — free-tier limits are per minute.
  await sleep(4000);
  try {
    return await callModel(order[0], key, parts, { system, maxTokens, temperature });
  } catch (err) {
    throw new Error(`${(last || err).message} Try again in a moment, or with fewer photos at once.`);
  }
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = reject;
  r.readAsDataURL(blob);
});

/** Downscale to one Gemini image tile before encoding, then base64 it. */
async function imagePart(blob, maxPx) {
  const small = await aiCopy(blob, maxPx);
  return { inline_data: { mime_type: 'image/jpeg', data: await blobToBase64(small) } };
}

/** The captions worth showing the model for this room, most likely first. */
async function libraryHint(sectionTitle) {
  const s = await getSettings();
  return rankCaptions(s.captionLib, s.usage, sectionTitle, LIBRARY_HINTS)
    .map((c) => c.text.replace(/\n/g, ' / '))
    .join(' | ');
}

const CAPTION_SYSTEM =
  'Caption photos for a building defect report. Reply with the caption only. '
  + 'UPPERCASE, 4-7 words, plain QA/QC wording a contractor can action. '
  + 'Reuse a caption from the library when one fits. '
  + 'No defect visible: describe the item factually. Technical terms stay in English.';

/** Caption a single photo. Falls back to the offline ranker when unavailable. */
export async function suggestCaption(blob, { sectionTitle = '' } = {}) {
  if (!(await aiReady())) return offlineCaption(sectionTitle);
  const s = await getSettings();
  const text = await run('caption', [
    await imagePart(blob, s.aiImagePx),
    { text: `Room: ${sectionTitle || 'unspecified'}\nLibrary: ${await libraryHint(sectionTitle)}` },
  ], { system: CAPTION_SYSTEM, maxTokens: 32, temperature: 0.1 });
  return { text: clean(text), offline: false };
}

const clean = (t) => t.replace(/^["'\s]+|["'.\s]+$/g, '').toUpperCase().slice(0, 90);

/**
 * Caption many photos, batched. One request carries several photos so the system
 * prompt and library are paid for once instead of once per photo.
 * `onProgress(done, total, results, startIndex)` fires per chunk so captions can
 * be saved as they arrive — a later failure never loses earlier work.
 */
export async function suggestCaptionsBatch(items, { sectionTitle = '', chunkSize = 8, onProgress } = {}) {
  const out = items.map(() => ({ text: '', offline: true }));
  if (!(await aiReady())) return out;

  const s = await getSettings();
  const hint = await libraryHint(sectionTitle);
  let done = 0;
  let failure = null;

  for (let start = 0; start < items.length; start += chunkSize) {
    const chunk = items.slice(start, start + chunkSize);
    const parts = [];
    for (let i = 0; i < chunk.length; i++) {
      parts.push({ text: `${i + 1}:` });
      parts.push(await imagePart(chunk[i].blob, s.aiImagePx));
    }
    parts.push({
      text: `Room: ${sectionTitle || 'unspecified'}\nLibrary: ${hint}\n`
        + `Return exactly ${chunk.length} numbered lines, one caption per photo, in order. Nothing else.`,
    });

    let results;
    try {
      const text = await run('batch', parts, {
        system: CAPTION_SYSTEM, maxTokens: 24 * chunk.length + 64, temperature: 0.1,
      });
      const lines = text.split('\n').map((l) => l.replace(/^\s*\d+[.):]\s*/, '').trim()).filter(Boolean);
      results = chunk.map((_, i) => ({ text: clean(lines[i] || ''), offline: false }));
    } catch (err) {
      failure = err;
      results = chunk.map(() => ({ text: '', offline: false }));
    }

    results.forEach((r, i) => { out[start + i] = r; });
    done += chunk.length;
    onProgress && onProgress(done, items.length, results, start);
    if (failure) break;             // stop burning quota once a chunk has failed
  }

  // Nothing came back at all: surface the reason the same way a single caption
  // does, rather than the bare model error the ladder happened to end on.
  if (failure && !out.some((r) => r.text)) {
    throw failure.missing
      ? new Error(`${failure.message} Check Settings > AI Assistant — the models this key offers may have changed.`)
      : failure;
  }
  return out;
}

/** Tidy a free-typed caption into report wording. */
export async function polishCaption(text, sectionTitle = '') {
  if (!(await aiReady())) return text.toUpperCase();
  const out = await run('text', [{ text: `Room: ${sectionTitle}. Rewrite as a report caption: ${text}` }],
    { system: CAPTION_SYSTEM, maxTokens: 32, temperature: 0.1 });
  return clean(out);
}

/** Collapse a caption list to "CAPTION x7" so repeats are not paid for twice. */
function tally(captions) {
  const counts = new Map();
  captions.forEach((c) => counts.set(c, (counts.get(c) || 0) + 1));
  return [...counts.entries()]
    .map(([c, n]) => (n > 1 ? `${c.replace(/\n/g, ' / ')} x${n}` : c.replace(/\n/g, ' / ')))
    .join('; ');
}

/** Draft the executive summary from the captured defect list. */
export async function draftSummary(project, sections) {
  const body = sections.map((s) => `${s.title}: ${tally(s.captions) || 'no items'}`).join('\n');
  if (!(await aiReady())) return offlineSummary(project, sections);
  return run('text', [{
    text: `Property: ${project.name}\nAddress: ${project.address}\nDate: ${project.inspectionDate}\n\nItems by location:\n${body}`,
  }], {
    system: 'Write the executive summary of a building defect inspection report. '
      + 'British/Australian spelling, plain QA/QC language, 120-200 words, 2-3 short paragraphs. '
      + 'Cover scope, the recurring defect types by trade, and the rectification requirement. '
      + 'Use only the items listed. Output the summary text only.',
    maxTokens: 900, temperature: 0.3,
  });
}

/** Which model a task would use right now, after resolution. */
export async function modelFor(task = 'text') {
  const s = await getSettings();
  const auto = s.ai.auto !== false;
  const wanted = auto ? (LADDER[task] || LADDER.text) : [s.ai.model || DEFAULT_MODEL];
  return resolve(wanted[0], s.ai.available);
}

/** Free-form assistant used by the chat sheet. */
export async function ask(question, context) {
  return run('text', [{ text: `${context ? `${context}\n\n` : ''}${question}` }], {
    system: 'You are the assistant inside Insta Report, a building defect inspection app. '
      + 'Answer briefly and practically for a site inspector. British/Australian spelling, metric units. '
      + 'Keep part and defect terminology in English.',
    maxTokens: 1200, temperature: 0.3,
  });
}

/** Group loose captions into report sections — used by the sort helper. */
export async function suggestSections(captions) {
  if (!(await aiReady())) return null;
  const out = await run('text', [{ text: `Captions:\n${captions.join('\n')}\n\nWhich section does each belong to?` }],
    { system: 'Return a JSON array of {"caption":"...","section":"..."} only. Sections are room names in UPPERCASE.', maxTokens: 900 });
  try { return JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1)); } catch { return null; }
}
