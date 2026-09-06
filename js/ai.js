// AI assistant — Google AI Studio (Gemini). Optional and online-only: every other
// part of the app works with no connection. The key is stored on-device
// (IndexedDB), sent only to generativelanguage.googleapis.com, and is excluded
// from backup files.
import { getSettings } from './store.js';
import { rankCaptions } from './captions.js';

const HOST = 'https://generativelanguage.googleapis.com/v1beta/models';
export const DEFAULT_MODEL = 'gemini-2.5-flash';

export const isOnline = () => navigator.onLine;

export async function aiReady() {
  const s = await getSettings();
  return !!(s.ai && s.ai.enabled && s.ai.key && isOnline());
}

/**
 * One Gemini generateContent call.
 * @param parts  Gemini `parts` array for a single user turn.
 */
async function call(parts, { system, maxTokens = 1024, temperature = 0.2 } = {}) {
  const s = await getSettings();
  const key = s.ai?.key;
  if (!key) throw new Error('No API key set. Add one in Settings > AI Assistant.');
  if (!isOnline()) throw new Error('Offline — AI features need a connection.');

  const model = s.ai.model || DEFAULT_MODEL;
  const generationConfig = { temperature, maxOutputTokens: maxTokens };
  // 2.5 Flash reasons before answering and those tokens come out of the same
  // budget, which can leave a short caption request with nothing left to say.
  // Captions do not need it, so turn it off where the model allows it.
  if (/flash/i.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig,
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  let res;
  try {
    res = await fetch(`${HOST}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the assistant. Check your connection.');
  }

  if (!res.ok) throw new Error(await describeError(res, model));

  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  const text = ((cand && cand.content && cand.content.parts) || [])
    .map((p) => p.text).filter(Boolean).join('').trim();

  if (!text) {
    const reason = (cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason);
    if (reason === 'MAX_TOKENS') throw new Error('The reply was cut off. Try again or use a shorter request.');
    if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT') throw new Error('The model declined to answer for this photo.');
    throw new Error('The assistant returned nothing. Try again.');
  }
  return text;
}

async function describeError(res, model) {
  let detail = '';
  try {
    const j = await res.json();
    detail = (j.error && j.error.message) || '';
  } catch { /* non-JSON error body */ }
  if (res.status === 400 && /API key not valid/i.test(detail)) return 'That API key was rejected. Check it in Settings > AI Assistant.';
  if (res.status === 403) return 'The API key is not authorised for this request.';
  if (res.status === 404) return `Model "${model}" was not found. Check the model name in Google AI Studio.`;
  if (res.status === 429) return 'Rate limit reached on this key. Wait a moment, or caption fewer photos at once.';
  if (res.status >= 500) return 'Google AI Studio is unavailable right now. Try again shortly.';
  return `AI request failed (${res.status}). ${detail.slice(0, 160)}`;
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = reject;
  r.readAsDataURL(blob);
});

const imagePart = async (blob) => ({
  inline_data: { mime_type: blob.type || 'image/jpeg', data: await blobToBase64(blob) },
});

const CAPTION_SYSTEM =
  'You caption photographs for a building defect inspection report in Malaysia. '
  + 'Reply with the caption only — no preamble, no quotes, no full stops at the end. '
  + 'Use UPPERCASE, four to seven words, plain QA/QC wording that a contractor can action '
  + '(for example: UNFILLED GROUT, HOLLOW TILE, IMPROPER JOINT AT FRAME, UNEVEN PLASTER (WAVY SURFACE), '
  + 'RUSTED DOOR KNOB, POOR FINISHING). Keep all technical terms in English. '
  + 'If the photo shows no defect, describe the item factually instead. '
  + 'Prefer a caption from the supplied library when one fits.';

/** Caption a single photo. Falls back to the offline ranker when unavailable. */
export async function suggestCaption(blob, { sectionTitle = '', library = [] } = {}) {
  const s = await getSettings();
  if (!(await aiReady())) {
    const ranked = rankCaptions(s.captionLib, s.usage, sectionTitle, 1);
    return { text: ranked[0]?.text || '', offline: true };
  }
  const text = await call([
    await imagePart(blob),
    { text: `Location: ${sectionTitle || 'unspecified'}.\nCaption library: ${library.slice(0, 60).join(' | ')}\n\nCaption this photo.` },
  ], { system: CAPTION_SYSTEM, maxTokens: 120, temperature: 0.1 });
  return { text: text.replace(/^["']|["']$/g, '').toUpperCase().slice(0, 90), offline: false };
}

/** Caption several photos in one request to keep it quick on site. */
export async function suggestCaptionsBatch(items, { sectionTitle = '', library = [] } = {}) {
  if (!(await aiReady())) return items.map(() => ({ text: '', offline: true }));
  const parts = [];
  for (let i = 0; i < items.length; i++) {
    parts.push({ text: `Photo ${i + 1}:` });
    parts.push(await imagePart(items[i].blob));
  }
  parts.push({
    text: `Location: ${sectionTitle || 'unspecified'}.\nCaption library: ${library.slice(0, 60).join(' | ')}\n\n`
      + `Return exactly ${items.length} lines, one caption per photo, in order, numbered "1. ", "2. " and so on. No other text.`,
  });
  const out = await call(parts, { system: CAPTION_SYSTEM, maxTokens: 60 * items.length + 200, temperature: 0.1 });
  const lines = out.split('\n').map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
  return items.map((_, i) => ({ text: (lines[i] || '').toUpperCase().slice(0, 90), offline: false }));
}

/** Tidy a free-typed caption into report wording. */
export async function polishCaption(text, sectionTitle = '') {
  if (!(await aiReady())) return text.toUpperCase();
  const out = await call([{ text: `Location: ${sectionTitle}. Rewrite as a report caption: ${text}` }],
    { system: CAPTION_SYSTEM, maxTokens: 100, temperature: 0.1 });
  return out.toUpperCase().slice(0, 90);
}

/** Draft the executive summary from the captured defect list. */
export async function draftSummary(project, sections) {
  const body = sections.map((s) => `${s.title}: ${s.captions.join('; ') || 'no items'}`).join('\n');
  if (!(await aiReady())) {
    const total = sections.reduce((n, s) => n + s.captions.length, 0);
    return `A total of ${total} item(s) were recorded across ${sections.length} location(s) at ${project.address || project.name}. `
      + 'Items recorded require rectification by the contractor prior to handover. '
      + 'Refer to the photographic records in this report for the location and nature of each item.';
  }
  return call([{
    text: `Property: ${project.name}\nAddress: ${project.address}\nInspection date: ${project.inspectionDate}\n\n`
      + `Recorded items by location:\n${body}\n\nWrite the executive summary for this defect inspection report.`,
  }], {
    system: 'You write executive summaries for building defect inspection reports. '
      + 'Use British/Australian spelling, plain professional QA/QC language, and 120-200 words in 2-3 short paragraphs. '
      + 'State the scope, the main recurring defect types by trade, and the rectification requirement. '
      + 'Do not invent findings that are not in the list. Output the summary text only.',
    maxTokens: 900, temperature: 0.3,
  });
}

/** Free-form assistant used by the chat sheet. */
export async function ask(question, context) {
  return call([{ text: `${context ? `Report context:\n${context}\n\n` : ''}${question}` }], {
    system: 'You are the assistant inside Fast Report, a building defect inspection app. '
      + 'Answer briefly and practically for a site inspector. Use British/Australian spelling and metric units. '
      + 'Keep part and defect terminology in English.',
    maxTokens: 1200, temperature: 0.3,
  });
}

/** Group loose captions into report sections — used by the sort helper. */
export async function suggestSections(captions) {
  if (!(await aiReady())) return null;
  const out = await call([{ text: `Captions:\n${captions.join('\n')}\n\nSuggest the report sections these belong to.` }],
    { system: 'Return a JSON array of {"caption":"...","section":"..."} only. Sections are room names in UPPERCASE.', maxTokens: 900 });
  try { return JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1)); } catch { return null; }
}
