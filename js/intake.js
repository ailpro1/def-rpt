// Telegram intake — the public surface. Screens talk to this, never to
// intake-net.js directly.
//
// Same arrangement as assist.js/ai.js: in the capture-only build `BUILD.intake`
// is false and intake-net.js is never fetched, because it is not in the bundle
// the phone downloads. The site app stays entirely offline.
import { BUILD } from './build.js';

export const intakeEnabled = !!BUILD.intake;

let pending = null;
const net = () => (pending || (pending = import('./intake-net.js')));

export async function fetchManifest(code) {
  if (!intakeEnabled) throw new Error('Import is not part of this app.');
  return (await net()).fetchManifest(code);
}

export async function fetchPhoto(code, id) {
  if (!intakeEnabled) throw new Error('Import is not part of this app.');
  return (await net()).fetchPhoto(code, id);
}

export async function claimBatch(code) {
  if (!intakeEnabled) return false;
  return (await net()).claimBatch(code);
}

export async function testConnection(url) {
  if (!intakeEnabled) throw new Error('Import is not part of this app.');
  return (await net()).testConnection(url);
}

export async function openInbox(code = '') {
  if (!intakeEnabled) return;
  const mod = await import('./screens/inbox.js');
  return mod.openInbox(code);
}

/** A manifest read from a file rather than pulled by code. */
export function readManifestFile(text) {
  const data = JSON.parse(text);
  if (data.format !== 'instareport-intake') throw new Error('That is not an Insta Report batch file.');
  return data;
}
