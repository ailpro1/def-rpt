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

// Which batches still have photos waiting for a caption. The captioning tick
// reads this one key and stops there when it is empty — listing keys to find
// that out costs a list operation every minute of every day, which is how a
// bot that nobody touched used up a month's free allowance in a weekend.
const QUEUE_KEY = 'queue:pending';

export async function queueList(env) {
  const raw = await env.BATCHES.get(QUEUE_KEY);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

export async function queueAdd(env, code) {
  const codes = await queueList(env);
  if (codes.includes(code)) return codes;              // already queued: no write
  const next = [...codes, code];
  await env.BATCHES.put(QUEUE_KEY, JSON.stringify(next), { expirationTtl: TTL_SECONDS });
  return next;
}

export async function queueRemove(env, code) {
  const codes = await queueList(env);
  if (!codes.includes(code)) return codes;
  const next = codes.filter((c) => c !== code);
  await env.BATCHES.put(QUEUE_KEY, JSON.stringify(next), { expirationTtl: TTL_SECONDS });
  return next;
}

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
/**
 * The fields anything other than captioning needs. KV can carry this alongside
 * the key, so a listing returns it without a read per photo — which is the
 * difference between a batch costing one request and costing one per photo.
 */
export function summary(rec) {
  return {
    id: rec.id,
    section: rec.section,
    caption: rec.aiCaption || rec.caption || '',
    captionSource: rec.aiCaption ? 'ai' : (rec.caption ? 'typed' : ''),
    tried: rec.aiCaption !== undefined || !!rec.caption,
    takenAt: rec.takenAt,
    takenSource: rec.takenSource,
    w: rec.w,
    h: rec.h,
  };
}

/** Write a photo, keeping its summary on the key. Exported for the captioner,
 * which already holds the record and has no reason to read it back first. */
export const putPhoto = (env, code, rec) =>
  env.BATCHES.put(photoKey(code, rec.id), JSON.stringify(rec), {
    expirationTtl: TTL_SECONDS,
    metadata: summary(rec),
  });

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
  await putPhoto(env, meta.code, rec);
  // Only a photo that needs a caption puts its batch in the queue.
  if (!rec.caption) await queueAdd(env, meta.code);
  return rec;
}

/**
 * Every photo's summary, in the order they were sent, from the key listing
 * alone — a page of a thousand keys is one request, however big the job.
 *
 * Nothing on a hot path may read photos one by one: a 200-photo batch would
 * then cost 200 reads every time a photo is served or the chat is acked, and a
 * Worker is cut off long before that.
 */
export async function listSummaries(env, code) {
  const out = [];
  let cursor;
  do {
    const page = await env.BATCHES.list({ prefix: `batch:${code}:p:`, cursor });
    for (const k of page.keys) {
      if (k.metadata) out.push(k.metadata);
      else out.push({ id: Number(k.name.split(':').pop()), section: 'GENERAL', caption: '', tried: false });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  out.sort((a, b) => a.id - b.id);
  return out;
}

/** One photo's full record. */
export async function getPhoto(env, code, id) {
  const raw = await env.BATCHES.get(photoKey(code, id));
  return raw ? JSON.parse(raw) : null;
}

/** Every full record. Only for a pass that genuinely needs all of them. */
export async function listPhotos(env, code) {
  const out = [];
  for (const s of await listSummaries(env, code)) {
    const rec = await getPhoto(env, code, s.id);
    if (rec) out.push(rec);
  }
  return out;
}

export async function updatePhoto(env, code, id, patch) {
  const current = await getPhoto(env, code, id);
  if (!current) return null;
  const rec = { ...current, ...patch };
  await putPhoto(env, code, rec);
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

/**
 * Retire a batch. The meta and chat keys go first, because those are what make
 * the code work — once they are gone the batch is gone as far as anyone can
 * tell. The photo keys are then cleared within a budget rather than all at
 * once; every key already carries a 14-day expiry, so anything left over is
 * swept up by KV itself instead of costing this request a read apiece.
 */
export async function deleteBatch(env, meta, budget = 40) {
  await queueRemove(env, meta.code);
  await env.BATCHES.delete(metaKey(meta.code));
  await env.BATCHES.delete(chatKey(meta.chatId));
  const summaries = await listSummaries(env, meta.code);
  for (const s of summaries.slice(0, budget)) {
    await env.BATCHES.delete(photoKey(meta.code, s.id));
  }
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
    pending: photos.filter((p) => (p.tried !== undefined ? !p.tried : (p.aiCaption === undefined && !p.caption))).length,
    sections: order.map((title) => ({ title, photos: bySection.get(title) })),
  };
}

/** Per-section counts, for the /list reply. */
export function tally(photos) {
  const counts = new Map();
  for (const p of photos) counts.set(p.section, (counts.get(p.section) || 0) + 1);
  return [...counts.entries()];
}
