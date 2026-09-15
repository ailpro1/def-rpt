// Insta Report intake — the whole server side.
//
// It is a postbox, not a database: Telegram keeps the photo bytes, the app keeps
// the report, and this holds a few kilobytes of "which photo, which section"
// until the app collects them. That is what keeps it inside free plans with no
// payment method on the account — see worker/README.md.

import { handleUpdate } from './bot.js';
import * as tg from './telegram.js';
import * as batch from './batch.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json', ...cors() },
});

// The app is served from GitHub Pages, so every API call is cross-origin.
const cors = () => ({
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    try {
      if (path === '/health') return json({ ok: true });

      if (path === '/tg/webhook' && request.method === 'POST') {
        // Telegram is the only caller that knows this header. Anything else is
        // someone poking at the URL.
        if (request.headers.get('x-telegram-bot-api-secret-token') !== env.TG_WEBHOOK_SECRET) {
          return json({ error: 'no' }, 401);
        }
        const update = await request.json();
        // Answer immediately and do the work after: Telegram retries an update
        // it thinks failed, which would file every photo twice.
        ctx.waitUntil(handleUpdate(env, update, ctx).catch((err) => console.error(err)));
        return json({ ok: true });
      }

      // Visited once, by hand, from a browser: it points Telegram at this very
      // Worker. The bot token stays here rather than going into a command line
      // or the address bar.
      if (path === '/tg/register') {
        if (url.searchParams.get('secret') !== env.TG_WEBHOOK_SECRET) {
          return json({ ok: false, error: 'That secret does not match TG_WEBHOOK_SECRET.' }, 401);
        }
        return register(env, url);
      }

      const manifestMatch = /^\/api\/batch\/([A-Z0-9]{4,16})$/.exec(path);
      if (manifestMatch) return serveManifest(env, manifestMatch[1]);

      const photoMatch = /^\/api\/photo\/([A-Z0-9]{4,16})\/(\d+)$/.exec(path);
      if (photoMatch) return servePhoto(env, photoMatch[1], Number(photoMatch[2]));

      const claimMatch = /^\/api\/batch\/([A-Z0-9]{4,16})\/claim$/.exec(path);
      if (claimMatch && request.method === 'POST') return claim(env, claimMatch[1]);

      return json({ error: 'not found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'server error' }, 500);
    }
  },
};

/**
 * Point Telegram at this Worker. This is the one step done by hand during
 * setup, so it says exactly what is wrong rather than falling into the generic
 * 500 — it is already behind the secret, so there is nothing to hide here.
 */
async function register(env, url) {
  const token = String(env.TG_TOKEN || '').trim();
  const secret = String(env.TG_WEBHOOK_SECRET || '');

  if (!token) {
    return json({ ok: false, error: 'TG_TOKEN is not set. Add it in the Worker\u2019s '
      + 'Settings > Variables and Secrets, as a Secret, then Deploy and try again.' }, 400);
  }
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
    return json({ ok: false, error: 'TG_TOKEN does not look like a bot token. It should be digits, '
      + 'a colon, then letters and numbers \u2014 like 8123456789:AAF... Re-copy it from BotFather, '
      + 'with no spaces or line breaks.' }, 400);
  }
  // Telegram is strict about this one and its error message is cryptic.
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    return json({ ok: false, error: 'TG_WEBHOOK_SECRET can only contain letters, numbers, '
      + 'underscore and hyphen \u2014 Telegram rejects anything else, including spaces and '
      + 'punctuation. Change it in Settings > Variables and Secrets, Deploy, then visit this '
      + 'address again with the new value.' }, 400);
  }

  const hook = `${url.origin}/tg/webhook`;
  try {
    await tg.setWebhook(env, hook, secret);
  } catch (err) {
    return json({ ok: false, error: `Telegram refused: ${err.message}`, webhook: hook }, 502);
  }
  const me = await tg.getMe(env).catch(() => ({}));
  return json({ ok: true, bot: me.username || null, webhook: hook });
}

async function serveManifest(env, code) {
  const meta = await batch.getMeta(env, code);
  if (!meta) return json({ error: 'unknown code' }, 404);
  const photos = await batch.listPhotos(env, code);
  return json(batch.manifest(meta, photos));
}

/**
 * Stream one photo straight from Telegram to the app. Nothing is buffered and
 * nothing is re-encoded, so a 4MB photo costs the same CPU as a 40KB one.
 */
async function servePhoto(env, code, id) {
  const meta = await batch.getMeta(env, code);
  if (!meta) return json({ error: 'unknown code' }, 404);
  const photos = await batch.listPhotos(env, code);
  const photo = photos.find((p) => p.id === id);
  if (!photo) return json({ error: 'unknown photo' }, 404);

  const upstream = await tg.openFile(env, photo.fileId);
  return new Response(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') || 'image/jpeg',
      'cache-control': 'private, max-age=3600',
      ...cors(),
    },
  });
}

/** The app has the photos now, so the batch can go. */
async function claim(env, code) {
  const meta = await batch.getMeta(env, code);
  if (!meta) return json({ error: 'unknown code' }, 404);
  await batch.deleteBatch(env, meta);
  return json({ ok: true });
}
