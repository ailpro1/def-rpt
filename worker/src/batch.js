// A batch is one trip to a property: a project name, a running section, and the
// photos filed under it.
//
// Everything lives in KV, and the shape is chosen so the hot path never does a
// read-modify-write. Photos each get their own key, so two album items arriving
// at the same moment cannot overwrite one another — an append-only log that
// `/done` reads back with a prefix list. Only the small meta record is rewritten,
// and only by a command the user typed.
//
// Photo BYTES are never stored. Telegram already holds them and a file_id is
// permanent for the bot, so the batch carries identifiers and nothing heavier.

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no I/L/O/0/1
const CODE_LEN = 8;
const TTL_DAYS = 14;
export const TTL_SECONDS = TTL_DAYS * 86400;

const metaKey = (code) => `batch:${code}:meta`;
const photoKey = (code, id) => `batch:${code}:p:${String(id).padStart(12, '0')}`;
const chatKey = (chatId) => `chat:${chatId}`;

/** Codes are typed in by hand on a phone, so: no ambiguous glyphs, no vowels. */
export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export async function openBatch(env, chatId, projectName) {
  const code = newCode();
  const meta = {
    code,
    chatId,
    project: { name: (projectName || '').trim() },
    section: '',
    status: 'open',
    createdAt: Date.now(),
    closedAt: null,
    count: 0,
  };
  await putMeta(env, meta);
  await env.BATCHES.put(chatKey(chatId), code, { expirationTtl: TTL_SECONDS });
  return meta;
}

export const putMeta = (env, meta) =>
  env.BATCHES.put(metaKey(meta.code), JSON.stringify(meta), { expirationTtl: TTL_SECONDS });

export async function getMeta(env, code) {
  const raw = await env.BATCHES.get(metaKey(code));
  return raw ? JSON.parse(raw) : null;
}

/** The batch this chat is currently filing into, if any. */
export async function activeBatch(env, chatId) {
  const code = await env.BATCHES.get(chatKey(chatId));
  if (!code) return null;
  const meta = await getMeta(env, code);
  return meta && meta.status === 'open' ? meta : null;
}

export async function setSection(env, meta, title) {
  meta.section = String(title || '').trim().toUpperCase();
  await putMeta(env, meta);
  return meta;
}

/**
 * File one photo. `id` is the Telegram message_id, which also orders the batch:
 * album items can reach the webhook out of order, but their message ids do not
 * lie about the order they were sent in.
 */
export async function addPhoto(env, meta, photo) {
  const rec = {
    id: photo.id,
    fileId: photo.fileId,
    aiFileId: photo.aiFileId || photo.fileId,
    section: meta.section || 'GENERAL',
    caption: photo.caption || '',
    takenAt: photo.takenAt,
    takenSource: photo.takenSource || 'telegram',
    w: photo.w || 0,
    h: photo.h || 0,
    mediaGroupId: photo.mediaGroupId || '',
    // Filled in later by the captioning pass; absent means "not looked at yet".
    aiCaption: undefined,
  };
  await env.BATCHES.put(photoKey(meta.code, rec.id), JSON.stringify(rec), { expirationTtl: TTL_SECONDS });
  return rec;
}

/** Every photo in the batch, in the order they were sent. */
export async function listPhotos(env, code) {
  const out = [];
  let cursor;
  do {
    const page = await env.BATCHES.list({ prefix: `batch:${code}:p:`, cursor });
    for (const k of page.keys) {
      const raw = await env.BATCHES.get(k.name);
      if (raw) out.push(JSON.parse(raw));
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  out.sort((a, b) => a.id - b.id);
  return out;
}

export async function updatePhoto(env, code, id, patch) {
  const key = photoKey(code, id);
  const raw = await env.BATCHES.get(key);
  if (!raw) return null;
  const rec = { ...JSON.parse(raw), ...patch };
  await env.BATCHES.put(key, JSON.stringify(rec), { expirationTtl: TTL_SECONDS });
  return rec;
}

export async function dropPhoto(env, code, id) {
  await env.BATCHES.delete(photoKey(code, id));
}

export async function closeBatch(env, meta) {
  meta.status = 'closed';
  meta.closedAt = Date.now();
  await putMeta(env, meta);
  await env.BATCHES.delete(chatKey(meta.chatId));
  return meta;
}

export async function deleteBatch(env, meta) {
  const photos = await listPhotos(env, meta.code);
  for (const p of photos) await env.BATCHES.delete(photoKey(meta.code, p.id));
  await env.BATCHES.delete(metaKey(meta.code));
  await env.BATCHES.delete(chatKey(meta.chatId));
}

/**
 * What the app downloads: sections in the order they were first used, each with
 * its photos. No bytes — every photo is fetched separately from /api/photo, so a
 * manifest stays a couple of kilobytes however big the day was.
 */
export function manifest(meta, photos) {
  const order = [];
  const bySection = new Map();
  photos.forEach((p, i) => {
    const title = p.section || 'GENERAL';
    if (!bySection.has(title)) { bySection.set(title, []); order.push(title); }
    bySection.get(title).push({
      n: i + 1,
      id: p.id,
      caption: p.aiCaption || p.caption || '',
      captionSource: p.aiCaption ? 'ai' : (p.caption ? 'typed' : ''),
      takenAt: p.takenAt,
      takenSource: p.takenSource,
      w: p.w,
      h: p.h,
    });
  });
  return {
    format: 'instareport-intake',
    version: 1,
    code: meta.code,
    project: meta.project,
    status: meta.status,
    createdAt: meta.createdAt,
    closedAt: meta.closedAt,
    total: photos.length,
    pending: photos.filter((p) => p.aiCaption === undefined && !p.caption).length,
    sections: order.map((title) => ({ title, photos: bySection.get(title) })),
  };
}

/** Per-section counts, for the /list reply. */
export function tally(photos) {
  const counts = new Map();
  for (const p of photos) counts.set(p.section, (counts.get(p.section) || 0) + 1);
  return [...counts.entries()];
}
