// AI assistant — Claude. Optional and online-only: every other part of the app
// works with no connection. The key is stored on-device (IndexedDB), sent only
// to api.anthropic.com, and is excluded from backup files.
//
// This module used to be four times its length, nearly all of it working around
// a free tier: a model ladder, a cooldown map, model discovery because names
// differed per key, and a retry that dropped parts of the request some models
// refused. A paid key on one known model deletes every one of those problems.
// One model, one request shape, one retry for the one thing that is genuinely
// transient. Anything more is a moving part waiting to fail quietly.
import { getSettings } from './store.js';
import { rankCaptions } from './captions.js';
import { aiCopy } from './image.js';
import { offlineCaption, offlineSummary } from './fallback.js';

const HOST = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

// Claude Haiku 4.5. Captioning a defect photo is a short, tightly constrained
// job — the cheapest current model does it well, and at roughly 1,000 input
// tokens a photo a 200-photo inspection costs about twenty US cents.
export const MODEL = 'claude-haiku-4-5';

// How many captions from the library to show the model. The ranker puts the
// ones that actually apply to this room at the top, so a long tail costs tokens
// for nothing.
const LIBRARY_HINTS = 24;

export const isOnline = () => navigator.onLine;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function aiReady() {
  const s = await getSettings();
  return !!(s.ai && s.ai.enabled && s.ai.key && isOnline());
}

/** A failure worth trying again: rate limits and Anthropic being busy. */
class Retryable extends Error {
  constructor(message, { waitMs = 0 } = {}) {
    super(message);
    this.waitMs = waitMs;
  }
}

/**
 * One request to the Messages API.
 *
 * `anthropic-dangerous-direct-browser-access` is what lets a browser call this
 * at all. The name is a warning about the usual case — a public site shipping a
 * shared key to strangers. Here the key is the office's own, typed into their
 * own app on their own device, which is the same footing as any desktop tool.
 */
async function once(key, content, { system, maxTokens, temperature }) {
  let res;
  try {
    res = await fetch(HOST, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: [{ role: 'user', content }],
      }),
    });
  } catch {
    throw new Retryable('Could not reach the assistant. Check your connection.', { waitMs: 2000 });
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* non-JSON body */ }

    if (res.status === 401) throw new Error('That API key was rejected. Check it in Settings > AI Assistant.');
    if (res.status === 403) throw new Error('That API key is not allowed to make this request.');
    if (res.status === 400 && /credit|balance|billing/i.test(detail)) {
      throw new Error('The Anthropic account is out of credit. Top it up at console.anthropic.com.');
    }
    if (res.status === 429) {
      // Anthropic says how long to wait; believe it rather than guessing.
      const after = Number(res.headers.get('retry-after')) || 0;
      throw new Retryable('Rate limit reached on this key.', { waitMs: after ? after * 1000 : 5000 });
    }
    if (res.status === 529 || res.status >= 500) {
      throw new Retryable('Claude is busy right now.', { waitMs: 3000 });
    }
    throw new Error(`AI request failed (${res.status}). ${detail.slice(0, 160)}`);
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('The model declined to answer for this photo.');

  const text = (data.content || []).filter((b) => b.type === 'text')
    .map((b) => b.text).join('').trim();
  if (!text) {
    throw new Retryable(data.stop_reason === 'max_tokens'
      ? 'The reply was cut off.' : 'The assistant returned nothing.', { waitMs: 1500 });
  }
  return text;
}

/** One retry, paced by what the server asked for. Two attempts, then the truth. */
async function run(content, { system, maxTokens = 1024, temperature = 0.2 } = {}) {
  const s = await getSettings();
  const key = s.ai?.key;
  if (!key) throw new Error('No API key set. Add one in Settings > AI Assistant.');
  if (!isOnline()) throw new Error('Offline — AI features need a connection.');

  try {
    return await once(key, content, { system, maxTokens, temperature });
  } catch (err) {
    if (!(err instanceof Retryable)) throw err;
    await sleep(err.waitMs);
    try {
      return await once(key, content, { system, maxTokens, temperature });
    } catch (again) {
      throw new Error(`${again.message} Try again in a moment, or with fewer photos at once.`);
    }
  }
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = reject;
  r.readAsDataURL(blob);
});

/** Downscale before encoding: Claude bills an image by its area, so a photo sent
 * at capture size costs several times what the same photo costs at 768px, and
 * reads no better for a defect. */
async function imageBlock(blob, maxPx) {
  const small = await aiCopy(blob, maxPx);
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: await blobToBase64(small) },
  };
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
  + 'No defect visible: describe the item factually. Technical terms stay in English. '
  // The site team's camera app burns a date into the photo. It is not the
  // defect and must never become the caption.
  + 'Ignore any date or time printed on the photo.';

const clean = (t) => t.replace(/^["'\s]+|["'.\s]+$/g, '').toUpperCase().slice(0, 90);

/** Caption a single photo. Falls back to the offline ranker when unavailable. */
export async function suggestCaption(blob, { sectionTitle = '' } = {}) {
  if (!(await aiReady())) return offlineCaption(sectionTitle);
  const s = await getSettings();
  const text = await run([
    await imageBlock(blob, s.aiImagePx),
    { type: 'text', text: `Room: ${sectionTitle || 'unspecified'}\nLibrary: ${await libraryHint(sectionTitle)}` },
  ], { system: CAPTION_SYSTEM, maxTokens: 64, temperature: 0.1 });
  return { text: clean(text), offline: false };
}

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
    const content = [];
    for (let i = 0; i < chunk.length; i++) {
      content.push({ type: 'text', text: `${i + 1}:` });
      content.push(await imageBlock(chunk[i].blob, s.aiImagePx));
    }
    content.push({
      type: 'text',
      text: `Room: ${sectionTitle || 'unspecified'}\nLibrary: ${hint}\n`
        + `Return exactly ${chunk.length} numbered lines, one caption per photo, in order. Nothing else.`,
    });

    let results;
    try {
      const text = await run(content, {
        system: CAPTION_SYSTEM, maxTokens: 32 * chunk.length + 128, temperature: 0.1,
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
    if (failure) break;             // stop spending once a chunk has failed
  }

  if (failure && !out.some((r) => r.text)) throw failure;
  return out;
}

/** Tidy a free-typed caption into report wording. */
export async function polishCaption(text, sectionTitle = '') {
  if (!(await aiReady())) return text.toUpperCase();
  const out = await run([{ type: 'text', text: `Room: ${sectionTitle}. Rewrite as a report caption: ${text}` }],
    { system: CAPTION_SYSTEM, maxTokens: 64, temperature: 0.1 });
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
  return run([{
    type: 'text',
    text: `Property: ${project.name}\nAddress: ${project.address}\nDate: ${project.inspectionDate}\n\nItems by location:\n${body}`,
  }], {
    system: 'Write the executive summary of a building defect inspection report. '
      + 'British/Australian spelling, plain QA/QC language, 120-200 words, 2-3 short paragraphs. '
      + 'Cover scope, the recurring defect types by trade, and the rectification requirement. '
      + 'Use only the items listed. Output the summary text only.',
    maxTokens: 1200, temperature: 0.3,
  });
}

/** Free-form assistant used by the chat sheet. */
export async function ask(question, context) {
  return run([{ type: 'text', text: `${context ? `${context}\n\n` : ''}${question}` }], {
    system: 'You are the assistant inside Insta Report, a building defect inspection app. '
      + 'Answer briefly and practically for a site inspector. British/Australian spelling, metric units. '
      + 'Keep part and defect terminology in English.',
    maxTokens: 1500, temperature: 0.3,
  });
}

/** Group loose captions into report sections — used by the sort helper. */
export async function suggestSections(captions) {
  if (!(await aiReady())) return null;
  const out = await run([{ type: 'text', text: `Captions:\n${captions.join('\n')}\n\nWhich section does each belong to?` }],
    { system: 'Return a JSON array of {"caption":"...","section":"..."} only. Sections are room names in UPPERCASE.', maxTokens: 1200 });
  try { return JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1)); } catch { return null; }
}
