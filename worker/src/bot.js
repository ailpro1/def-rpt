// What the site team sees. Every reply is one short line, because this is read
// one-handed, outdoors, on a phone.

import * as tg from './telegram.js';
import * as batch from './batch.js';
import { captionOnArrival } from './caption.js';

const HELP = [
  'Insta Report intake',
  '',
  '/project 23 JALAN KERUING — start a new batch',
  '/sec KITCHEN — file the photos that follow under this section',
  '/list — what is in the batch so far',
  '/undo — remove the last photo',
  '/done — finish and get the import code',
  '/cancel — throw the batch away',
  '',
  'Forward photos here from the site group. The date they were originally sent',
  'is kept, so forwarding a week of work at once still files it by the right day.',
].join('\n');

/** Parse "/sec KITCHEN" or "/sec@mybot KITCHEN" into ['sec', 'KITCHEN']. */
function parseCommand(text) {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec((text || '').trim());
  return m ? [m[1].toLowerCase(), (m[2] || '').trim()] : [null, ''];
}

export async function handleUpdate(env, update, ctx) {
  const msg = update.message || update.channel_post;
  if (!msg) return;

  const chatId = msg.chat && msg.chat.id;
  if (!allowed(env, chatId)) return;                  // silence, not an error page

  if (msg.photo || msg.document) return filePhoto(env, msg, chatId);

  const [cmd, rest] = parseCommand(msg.text);
  if (!cmd) return;

  switch (cmd) {
    case 'start':
    case 'help':
      return tg.sendMessage(env, chatId, HELP);
    case 'project':
      return startProject(env, chatId, rest);
    case 'sec':
    case 'section':
      return chooseSection(env, chatId, rest);
    case 'list':
      return listBatch(env, chatId);
    case 'undo':
      return undo(env, chatId);
    case 'done':
      return done(env, chatId, ctx);
    case 'cancel':
      return cancel(env, chatId);
    default:
      return tg.sendMessage(env, chatId, `Unknown command. ${'/help'} for the list.`);
  }
}

/** An empty allowlist means "not configured yet" and accepts nothing. */
function allowed(env, chatId) {
  const list = String(env.ALLOWED_CHATS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 && list.includes(String(chatId));
}

async function startProject(env, chatId, name) {
  if (!name) return tg.sendMessage(env, chatId, 'Name it: /project 23 JALAN KERUING');
  const open = await batch.activeBatch(env, chatId);
  if (open) {
    return tg.sendMessage(env, chatId,
      `A batch for ${open.project.name || 'this chat'} is still open. /done it first, or /cancel.`);
  }
  const meta = await batch.openBatch(env, chatId, name);
  return tg.sendMessage(env, chatId,
    `Batch open — ${meta.project.name}\nNow: /sec CAR PORCH, then send the photos.`);
}

async function chooseSection(env, chatId, title) {
  const meta = await batch.activeBatch(env, chatId);
  if (!meta) return tg.sendMessage(env, chatId, 'No batch open. Start with /project <name>.');
  if (!title) return tg.sendMessage(env, chatId, 'Name it: /sec KITCHEN');
  await batch.setSection(env, meta, title);
  return tg.sendMessage(env, chatId, `Section: ${meta.section}`);
}

/**
 * File a photo against the batch's current section.
 *
 * Telegram re-encodes anything sent as a photo and drops its EXIF, so the send
 * time is the best capture time available and is marked as such. A photo sent as
 * a document keeps its original bytes — the import side reads EXIF out of those.
 */
async function filePhoto(env, msg, chatId) {
  const meta = await batch.activeBatch(env, chatId);
  if (!meta) return;                                  // chatter before /project: ignore

  const asDocument = !!(msg.document && /^image\//.test(msg.document.mime_type || ''));
  if (!msg.photo && !asDocument) return;              // a PDF or a voice note is not a defect

  const big = asDocument ? null : tg.largest(msg.photo);
  // Telegram ships several sizes. Keep the biggest for the report and note the
  // one nearest a Gemini tile, so captioning never downloads more than it needs
  // — a Worker cannot resize, but it can choose.
  const small = asDocument ? null : tg.pickSize(msg.photo, Number(env.CAPTION_PX) || 768);
  const rec = await batch.addPhoto(env, meta, {
    id: msg.message_id,
    fileId: asDocument ? msg.document.file_id : big.file_id,
    aiFileId: asDocument ? msg.document.file_id : (small || big).file_id,
    caption: (msg.caption || '').trim(),
    takenAt: sentAt(msg) * 1000,
    takenSource: asDocument ? 'file' : 'telegram',
    w: asDocument ? 0 : big.width,
    h: asDocument ? 0 : big.height,
    mediaGroupId: msg.media_group_id || '',
  });

  // Write it up now, in the same breath as filing it. Telegram delivers every
  // photo as its own request, so this costs one Gemini call per request rather
  // than a queue anywhere, and a few dozen photos are captioned by the time the
  // last one is forwarded.
  //
  // Started here but returned rather than handed to ctx.waitUntil: this whole
  // function ALREADY runs inside the webhook's waitUntil, after the response
  // has gone back to Telegram, and a waitUntil called from there is not
  // something the runtime promises to honour — it can be dropped on the floor
  // without a word. Part of the returned promise, it cannot be. It runs
  // alongside the ack rather than delaying it, and failing changes nothing:
  // the photo is on the queue and the tick sweeps up the rest.
  const captioning = captionOnArrival(env, meta.code, rec).catch(() => {});

  // Album items arrive as separate updates seconds apart; acking each one would
  // bury the chat, so only the first of a group speaks.
  if (!rec.mediaGroupId || firstOfGroup(rec, msg)) {
    const photos = await batch.listSummaries(env, meta.code);
    const n = photos.filter((p) => p.section === rec.section).length;
    await tg.sendMessage(env, chatId, `✓ ${rec.section} · ${n}`,
      { disable_notification: true });
  }
  return captioning;
}

/**
 * When the photo was originally sent, not when it reached the bot. Photos are
 * forwarded from the site group in batches, so the forward time is just when
 * the office got round to it — a week of work would otherwise land on today.
 *
 * forward_origin is the current field and forward_date the older one; both are
 * read so this works whichever the Bot API sends. Nothing changes for a photo
 * sent to the bot directly.
 */
function sentAt(msg) {
  const origin = msg.forward_origin || {};
  return origin.date || msg.forward_date || msg.date || Math.floor(Date.now() / 1000);
}

// Telegram gives no "first of album" flag; the caption only rides on the first
// item, which is a good enough proxy and costs nothing to check.
const firstOfGroup = (rec, msg) => !!msg.caption || !rec.mediaGroupId;

async function listBatch(env, chatId) {
  const meta = await batch.activeBatch(env, chatId) || await lastClosed(env, chatId);
  if (!meta) return tg.sendMessage(env, chatId, 'No batch open. Start with /project <name>.');
  const photos = await batch.listSummaries(env, meta.code);
  if (!photos.length) return tg.sendMessage(env, chatId, `${meta.project.name} — no photos yet.`);
  const lines = batch.tally(photos).map(([sec, n]) => `${sec} — ${n}`);
  return tg.sendMessage(env, chatId,
    `${meta.project.name}\n${lines.join('\n')}\n${photos.length} photo(s) total.`);
}

async function undo(env, chatId) {
  const meta = await batch.activeBatch(env, chatId);
  if (!meta) return tg.sendMessage(env, chatId, 'No batch open.');
  const photos = await batch.listSummaries(env, meta.code);
  const last = photos[photos.length - 1];
  if (!last) return tg.sendMessage(env, chatId, 'Nothing to undo.');
  await batch.dropPhoto(env, meta.code, last.id);
  return tg.sendMessage(env, chatId, `Removed one from ${last.section}. ${photos.length - 1} left.`);
}

async function cancel(env, chatId) {
  const meta = await batch.activeBatch(env, chatId);
  if (!meta) return tg.sendMessage(env, chatId, 'No batch open.');
  await batch.deleteBatch(env, meta);
  return tg.sendMessage(env, chatId, 'Batch discarded.');
}

async function done(env, chatId, ctx) {
  const meta = await batch.activeBatch(env, chatId);
  if (!meta) return tg.sendMessage(env, chatId, 'No batch open.');
  const photos = await batch.listSummaries(env, meta.code);
  if (!photos.length) {
    await batch.deleteBatch(env, meta);
    return tg.sendMessage(env, chatId, 'Empty batch — discarded.');
  }
  await batch.closeBatch(env, meta);
  // So /list still answers after the batch is closed.
  await env.BATCHES.put(`chat:${chatId}:last`, meta.code, { expirationTtl: batch.TTL_SECONDS });

  const lines = batch.tally(photos).map(([sec, n]) => `${sec} — ${n}`);
  await tg.sendMessage(env, chatId, [
    `${meta.project.name} — done.`,
    ...lines,
    '',
    `Import code: ${meta.code}`,
    'Open Insta Report > + > Import from Telegram.',
  ].join('\n'));

  // The fallback: the same manifest as a file, for when typing a code is the
  // wrong shape of effort. It is metadata only, so it stays tiny.
  const doc = JSON.stringify(batch.manifest(meta, photos), null, 2);
  const send = tg.sendDocument(env, chatId, `${meta.code}.instareport.json`, doc,
    'Open this in Insta Report if you would rather not type the code.');
  if (ctx && ctx.waitUntil) ctx.waitUntil(send.catch(() => {}));
  else await send.catch(() => {});
}

/** /list after /done still answers, which is what someone checking would expect. */
async function lastClosed(env, chatId) {
  const code = await env.BATCHES.get(`chat:${chatId}:last`);
  return code ? batch.getMeta(env, code) : null;
}
