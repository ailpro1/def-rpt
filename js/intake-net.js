// The only part of the app that talks to the intake Worker. Dropped entirely
// from the capture build — see tools/build.mjs.
import { getSettings } from './store.js';

const TIMEOUT_MS = 20000;

// The app is served over https, so a plain-http bot would be blocked as mixed
// content anyway — except on localhost, where `wrangler dev` lives.
const secure = (url) => /^https:\/\//i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url);

async function base() {
  const s = await getSettings();
  const url = String(s.intake?.url || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('No intake address set. Add it in Settings > Telegram intake.');
  if (!secure(url)) throw new Error('The intake address must start with https://');
  return url;
}

/** Every call is short and cancellable: a phone on site drops signal constantly. */
async function call(url, init = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The intake bot did not answer. Check the connection.');
    throw new Error('Could not reach the intake bot.');
  } finally {
    clearTimeout(timer);
  }
}

const clean = (code) => String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function fetchManifest(code) {
  const id = clean(code);
  if (!id) throw new Error('Enter the code from the Telegram message.');
  const res = await call(`${await base()}/api/batch/${id}`);
  if (res.status === 404) throw new Error(`No batch with code ${id}. It may have been imported already.`);
  if (!res.ok) throw new Error(`The intake bot returned ${res.status}.`);
  const data = await res.json();
  if (data.format !== 'instareport-intake') throw new Error('That address is not an Insta Report intake bot.');
  return data;
}

export async function fetchPhoto(code, id) {
  const res = await call(`${await base()}/api/photo/${clean(code)}/${id}`);
  if (!res.ok) throw new Error(`Photo ${id} could not be fetched (${res.status}).`);
  return res.blob();
}

/** Tell the bot the photos are safely on this device, so it can drop them. */
export async function claimBatch(code) {
  try {
    const res = await call(`${await base()}/api/batch/${clean(code)}/claim`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;      // the import already succeeded; the batch will expire anyway
  }
}

/**
 * Send the caption library to the bot, so it hints the model with the office's
 * own wording rather than the list built into the Worker.
 */
export async function pushLibrary(secret) {
  const s = await getSettings();
  const res = await call(`${await base()}/api/library?secret=${encodeURIComponent(secret)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(s.captionLib || []),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `The bot answered ${res.status}.`);
  return data;
}

export async function testConnection(url) {
  const root = String(url || '').trim().replace(/\/+$/, '');
  if (!secure(root)) throw new Error('The address must start with https://');
  const res = await call(`${root}/health`);
  if (!res.ok) throw new Error(`The address answered ${res.status}.`);
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error('That address answered, but it is not an intake bot.');
  return true;
}
