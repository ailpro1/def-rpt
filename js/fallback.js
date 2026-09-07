// What the assistant features do with no AI available — either because the key
// is missing, the device is offline, or this is the capture-only build.
import { getSettings } from './store.js';
import { rankCaptions } from './captions.js';

/** The caption most likely to apply here, by past use. Never looks at the photo. */
export async function offlineCaption(sectionTitle = '') {
  const s = await getSettings();
  const ranked = rankCaptions(s.captionLib, s.usage, sectionTitle, 1);
  return { text: ranked[0]?.text || '', offline: true };
}

/** Counts, not prose. Accurate, generic. */
export function offlineSummary(project, sections) {
  const total = sections.reduce((n, s) => n + s.captions.length, 0);
  return `A total of ${total} item(s) were recorded across ${sections.length} location(s) at `
    + `${project.address || project.name}. Items recorded require rectification by the contractor `
    + 'prior to handover. Refer to the photographic records in this report for the location and '
    + 'nature of each item.';
}
