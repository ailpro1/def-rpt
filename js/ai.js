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
import { getSettings } from './store.js';
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

export const isOnline = () => navigator.onLine;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function aiReady() {
  const s = await getSettings();
  return !!(s.ai && s.ai.enabled && s.ai.key && isOnline());
}

class Retryable extends Error {
  constructor(message, { cooldown = false } = {}) { super(message); this.cooldown = cooldown; }
}

/** One generateContent call against a named model. */
async function callModel(model, key, parts, { system, maxTokens, temperature }) {
  const generationConfig = { temperature, maxOutputTokens: maxTokens };
  // 2.5 Flash reasons before answering and those tokens come out of the same
  // budget, which can leave a short caption request with nothing left to say.
  // Captions do not need it, so turn it off where the model allows it.
  if (/flash/i.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const body = { contents: [{ role: 'user', parts }], generationConfig };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

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
    if (res.status === 404) throw new Retryable(`Model "${model}" was not found.`, { cooldown: true });
    if (res.status >= 500) throw new Retryable('Google AI Studio is unavailable right now.');
    if (res.status === 400 && /API key not valid/i.test(detail)) throw new Error('That API key was rejected. Check it in Settings > AI Assistant.');
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
async function run(task, parts, { system, maxTokens = 1024, temperature = 0.2 } = {}) {
  const s = await getSettings();
  const key = s.ai?.key;
  if (!key) throw new Error('No API key set. Add one in Settings > AI Assistant.');
  if (!isOnline()) throw new Error('Offline — AI features need a connection.');

  const auto = s.ai.auto !== false;
  const ladder = auto ? (LADDER[task] || LADDER.text) : [s.ai.model || DEFAULT_MODEL];
  const ready = ladder.filter(isCool);
  const order = ready.length ? ready : ladder;   // everything cooling: try anyway

  let last = null;
  for (const model of order) {
    try {
      return await callModel(model, key, parts, { system, maxTokens, temperature });
    } catch (err) {
      if (!(err instanceof Retryable)) throw err;
      if (err.cooldown) cooling.set(model, Date.now() + COOLDOWN_MS);
      last = err;
    }
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

  if (failure && !out.some((r) => r.text)) throw failure;
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
