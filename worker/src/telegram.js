// The slice of the Bot API this bot needs. Nothing here buffers a photo: the
// bytes go from Telegram to the app as a stream, which is what keeps the Worker
// inside the free plan's CPU budget.

const API = 'https://api.telegram.org';

async function call(env, method, body) {
  const res = await fetch(`${API}/bot${env.TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method} failed: ${data.description || res.status}`);
  return data.result;
}

export const sendMessage = (env, chatId, text, extra = {}) =>
  call(env, 'sendMessage', { chat_id: chatId, text, ...extra });

export const getFile = (env, fileId) => call(env, 'getFile', { file_id: fileId });

/**
 * Open the original bytes for a file_id. A file_path is short-lived, so it is
 * fetched fresh every time rather than cached; a file_id itself does not expire,
 * which is what lets Telegram be the photo store.
 */
export async function openFile(env, fileId) {
  const file = await getFile(env, fileId);
  const res = await fetch(`${API}/file/bot${env.TG_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`file download failed (${res.status})`);
  return res;
}

/** Post the manifest into the chat as a real file, for the fallback path. */
export async function sendDocument(env, chatId, filename, text, caption) {
  const form = new FormData();
  form.set('chat_id', String(chatId));
  if (caption) form.set('caption', caption);
  form.set('document', new File([text], filename, { type: 'application/json' }));
  const res = await fetch(`${API}/bot${env.TG_TOKEN}/sendDocument`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`sendDocument failed: ${data.description || res.status}`);
  return data.result;
}

/**
 * Pick the variant nearest a target width. Telegram ships several sizes of every
 * photo, so the right one for the model is already there — no resizing needed,
 * which a Worker could not afford to do anyway.
 */
export function pickSize(sizes, targetPx) {
  if (!sizes || !sizes.length) return null;
  const sorted = [...sizes].sort((a, b) => a.width - b.width);
  return sorted.find((s) => s.width >= targetPx) || sorted[sorted.length - 1];
}

/** The largest variant, which is what the report should print. */
export const largest = (sizes) =>
  (sizes && sizes.length ? [...sizes].sort((a, b) => b.width - a.width)[0] : null);
