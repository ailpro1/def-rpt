// The assistant's public surface. Screens talk to this, never to ai.js directly.
//
// In the capture-only build `BUILD.ai` is false and ai.js is never fetched — the
// network code is not merely hidden, it is absent from the bundle the phone
// downloads.
import { BUILD } from './build.js';
import { offlineCaption, offlineSummary } from './fallback.js';

export const aiEnabled = BUILD.ai;
export const DEFAULT_MODEL = 'gemini-2.5-flash';
export const MODEL_CHOICES = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];

let pending = null;
const ai = () => (pending || (pending = import('./ai.js')));

export async function aiReady() {
  if (!BUILD.ai) return false;
  return (await ai()).aiReady();
}

export async function suggestCaption(blob, opts = {}) {
  if (!BUILD.ai) return offlineCaption(opts.sectionTitle);
  return (await ai()).suggestCaption(blob, opts);
}

export async function suggestCaptionsBatch(items, opts = {}) {
  if (!BUILD.ai) return items.map(() => ({ text: '', offline: true }));
  return (await ai()).suggestCaptionsBatch(items, opts);
}

export async function draftSummary(project, sections) {
  if (!BUILD.ai) return offlineSummary(project, sections);
  return (await ai()).draftSummary(project, sections);
}

export async function ask(question, context) {
  if (!BUILD.ai) throw new Error('The assistant is not part of this app.');
  return (await ai()).ask(question, context);
}

export async function listModels() {
  if (!BUILD.ai) return [];
  return (await ai()).listModels();
}

export async function modelFor(task = 'text') {
  if (!BUILD.ai) return null;
  return (await ai()).modelFor(task);
}

export async function openAssistant(project) {
  if (!BUILD.ai) return;
  const mod = await import('./screens/assistant.js');
  return mod.openAssistant(project);
}
