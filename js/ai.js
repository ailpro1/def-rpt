// AI assistant. Optional and online-only: the app is fully usable without it.
// The key is stored on-device (IndexedDB) and is only ever sent to Anthropic.
import { getSettings } from './store.js';
import { rankCaptions } from './captions.js';

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

export const isOnline = () => navigator.onLine;

export async function aiReady() {
  const s = await getSettings();
  return !!(s.ai && s.ai.enabled && s.ai.key && isOnline());
}

async function call(messages, { system, maxTokens = 1024, temperature = 0.2 } = {}) {
  const s = await getSettings();
  if (!s.ai?.key) throw new Error('No API key set. Add one in Settings > AI Assistant.');
  if (!isOnline()) throw new Error('Offline — AI features need a connection.');
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': s.ai.key,
      'anthropic-version': VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: s.ai.model || 'claude-opus-5',
      max_tokens: maxTokens,
      temperature,
      system,
      messages,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`AI request failed (${res.status}). ${t.slice(0, 180)}`);
  }
  const data = await res.json();
  return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = reject;
  r.readAsDataURL(blob);
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
  const b64 = await blobToBase64(blob);
  const libText = library.slice(0, 60).join(' | ');
  const text = await call([{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
      { type: 'text', text: `Location: ${sectionTitle || 'unspecified'}.\nCaption library: ${libText}\n\nCaption this photo.` },
    ],
  }], { system: CAPTION_SYSTEM, maxTokens: 120, temperature: 0.1 });
  return { text: text.replace(/^["']|["']$/g, '').toUpperCase().slice(0, 90), offline: false };
}

/** Caption several photos in one request to keep it quick on site. */
export async function suggestCaptionsBatch(items, { sectionTitle = '', library = [] } = {}) {
  if (!(await aiReady())) return items.map(() => ({ text: '', offline: true }));
  const content = [];
  for (let i = 0; i < items.length; i++) {
    content.push({ type: 'text', text: `Photo ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await blobToBase64(items[i].blob) } });
  }
  content.push({
    type: 'text',
    text: `Location: ${sectionTitle || 'unspecified'}.\nCaption library: ${library.slice(0, 60).join(' | ')}\n\n`
      + `Return exactly ${items.length} lines, one caption per photo, in order, numbered "1. ", "2. " and so on. No other text.`,
  });
  const out = await call([{ role: 'user', content }], { system: CAPTION_SYSTEM, maxTokens: 60 * items.length + 200, temperature: 0.1 });
  const lines = out.split('\n').map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
  return items.map((_, i) => ({ text: (lines[i] || '').toUpperCase().slice(0, 90), offline: false }));
}

/** Tidy a free-typed caption into report wording. */
export async function polishCaption(text, sectionTitle = '') {
  if (!(await aiReady())) return text.toUpperCase();
  const out = await call(
    [{ role: 'user', content: `Location: ${sectionTitle}. Rewrite as a report caption: ${text}` }],
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
    role: 'user',
    content: `Property: ${project.name}\nAddress: ${project.address}\nInspection date: ${project.inspectionDate}\n\nRecorded items by location:\n${body}\n\n`
      + 'Write the executive summary for this defect inspection report.',
  }], {
    system: 'You write executive summaries for building defect inspection reports. '
      + 'Use British/Australian spelling, plain professional QA/QC language, and 120-200 words in 2-3 short paragraphs. '
      + 'State the scope, the main recurring defect types by trade, and the rectification requirement. '
      + 'Do not invent findings that are not in the list. Output the summary text only.',
    maxTokens: 700, temperature: 0.3,
  });
}

/** Free-form assistant used by the chat sheet. */
export async function ask(question, context) {
  return call([{ role: 'user', content: `${context ? `Report context:\n${context}\n\n` : ''}${question}` }], {
    system: 'You are the assistant inside Fast Report, a building defect inspection app. '
      + 'Answer briefly and practically for a site inspector. Use British/Australian spelling and metric units. '
      + 'Keep part and defect terminology in English.',
    maxTokens: 900, temperature: 0.3,
  });
}

/** Group loose captions into report sections — used by the sort helper. */
export async function suggestSections(captions) {
  if (!(await aiReady())) return null;
  const out = await call(
    [{ role: 'user', content: `Captions:\n${captions.join('\n')}\n\nSuggest the report sections these belong to.` }],
    { system: 'Return a JSON array of {"caption":"...","section":"..."} only. Sections are room names in UPPERCASE.', maxTokens: 800 });
  try { return JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1)); } catch { return null; }
}
