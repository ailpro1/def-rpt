// Insta Report intake — the whole server side.
//
// It is a postbox, not a database: Telegram keeps the photo bytes, the app keeps
// the report, and this holds a few kilobytes of "which photo, which section"
// until the app collects them. That is what keeps it inside free plans with no
// payment method on the account — see worker/README.md.
//
// It used to caption the photos too, and that was the mistake. Captioning meant
// a second AI setup with its own key and its own model handling, a queue, and a
// schedule to work through it — none of which could be seen from here when it
// went wrong, and all of which had to be kept in step with the app's own
// assistant. It is the app's job now. What is left has no schedule, no AI key
// and no state beyond the batch itself: there is nothing here to go stale.

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
      // `build` is a fingerprint of the pasted file, printed by worker/build.mjs.
      // "Did my paste actually land?" has cost more time here than any bug, and
      // this answers it in one look.
      if (path === '/health') return json({ ok: true, build: buildStamp() });

      // What the bot is holding, in one place. Nothing here is a secret — codes
      // and counts only — but it lists keys, so it is behind the webhook secret
      // and never automatic.
      if (path === '/api/status') {
        if (url.searchParams.get('secret') !== env.TG_WEBHOOK_SECRET) {
          return json({ ok: false, error: 'That secret does not match TG_WEBHOOK_SECRET.' }, 401);
        }
        return json(await status(env));
      }

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

/** The bundle's fingerprint, or 'dev' when running from src/ under Node. */
const buildStamp = () => (typeof BUILD_STAMP === 'string' ? BUILD_STAMP : 'dev');

/**
 * What the bot is holding, answered from stored state rather than from what
 * anyone believes is deployed. Kept after the captioner was taken out, because
 * the thing it was really good for was never captions: it is the only way to
 * see which build is live and which batches exist without importing them.
 */
async function status(env) {
  const codes = [];
  let cursor;
  do {
    const page = await env.BATCHES.list({ prefix: 'batch:', cursor });
    for (const k of page.keys) {
      const m = /^batch:([A-Z0-9]+):meta$/.exec(k.name);
      if (m) codes.push(m[1]);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  const batches = [];
  for (const code of codes.slice(0, 20)) {
    const meta = await batch.getMeta(env, code);
    const photos = await batch.listSummaries(env, code);
    batches.push({
      code,
      project: meta && meta.project ? meta.project.name : '',
      status: meta ? meta.status : 'missing',
      photos: photos.length,
      typedCaptions: photos.filter((p) => p.caption).length,
    });
  }

  const total = batches.reduce((n, b) => n + b.photos, 0);
  return {
    ok: true,
    build: buildStamp(),
    batches,
    note: batches.length
      ? `${batches.length} batch(es) waiting, ${total} photo(s) in total. `
        + 'Import them from Projects > + > Import from Telegram; captions are written there.'
      : 'Nothing is waiting. Send /project to the bot to start one.',
  };
}

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

  // Deliberately no local check of what a token or a secret should look like.
  // Telegram is the authority on its own credentials, and a guess at the format
  // here would sit between the user and a perfectly good token. Ask Telegram,
  // and if it says no, describe what is stored so the bad paste is visible.
  const hook = `${url.origin}/tg/webhook`;
  try {
    await tg.setWebhook(env, hook, secret);
  } catch (err) {
    return json({
      ok: false,
      error: `Telegram refused: ${err.message}`,
      webhook: hook,
      check: describe(token, secret),
      hint: hintFor(err.message, token, secret),
    }, 502);
  }
  const me = await tg.getMe(env).catch(() => ({}));
  return json({ ok: true, bot: me.username || null, webhook: hook });
}

/**
 * The shape of the stored values, never the values themselves. Enough to spot a
 * paste that picked up a label, a quote, a line break or an invisible
 * character — safe to paste into a chat when asking for help.
 */
function describe(token, secret) {
  const colon = token.indexOf(':');
  const common = (v) => {
    // Name the odd characters by code point. A lookalike dash is invisible in a
    // dashboard field and is the usual reason a token that looks perfect fails.
    const odd = [...new Set([...v].filter((c) => c < ' ' || c > '~'))]
      .map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
    return {
      length: v.length,
      hasWhitespace: /\s/.test(v),
      hasQuotes: /['"]/.test(v),
      nonAscii: odd.length > 0,
      nonAsciiCharacters: odd,
    };
  };
  return {
    TG_TOKEN: {
      ...common(token),
      hasColon: colon > 0,
      digitsBeforeColon: colon > 0 && /^\d+$/.test(token.slice(0, colon)),
      charsAfterColon: colon > 0 ? token.length - colon - 1 : 0,
    },
    TG_WEBHOOK_SECRET: {
      ...common(secret),
      // Telegram only accepts these in a secret_token.
      onlyLettersNumbersDashUnderscore: /^[A-Za-z0-9_-]{1,256}$/.test(secret),
    },
  };
}

// The characters that masquerade as a hyphen or an underscore in a token.
const LOOKALIKES = {
  '\u2010': 'a hyphen (U+2010) rather than a plain -',
  '\u2011': 'a non-breaking hyphen (U+2011) rather than a plain -',
  '\u2012': 'a figure dash (U+2012) rather than a plain -',
  '\u2013': 'an en dash (\u2013) rather than a plain -',
  '\u2014': 'an em dash (\u2014) rather than a plain -',
  '\u2212': 'a minus sign (U+2212) rather than a plain -',
  '\u200B': 'an invisible zero-width space',
  '\u200E': 'an invisible left-to-right mark',
  '\u200F': 'an invisible right-to-left mark',
  '\uFEFF': 'an invisible byte-order mark',
};

/** Turn the common failures into the actual next action. */
function hintFor(message, token, secret) {
  // Check this before anything else: the value can be the perfect length and
  // shape and still fail on one character that looks right and is not.
  const odd = [...token].find((c) => c < ' ' || c > '~');
  if (odd) {
    const name = LOOKALIKES[odd];
    return 'TG_TOKEN contains a character that is not a plain letter, digit, colon, underscore '
      + `or hyphen${name ? ` \u2014 it has ${name}` : ''}. This happens when the token is copied `
      + 'through something that auto-formats, turning a hyphen into a dash. Copy it again '
      + 'straight from BotFather\u2019s message (/mybots > your bot > API Token), replace '
      + 'TG_TOKEN, and Deploy.';
  }
  if (/secret_token/i.test(message)) {
    return 'Change TG_WEBHOOK_SECRET to letters, numbers, underscore and hyphen only, '
      + 'Deploy, then visit this address again with the new value.';
  }
  if (/unauthorized|not found/i.test(message)) {
    if (!/^\d+:/.test(token)) {
      return 'What is stored in TG_TOKEN does not start with digits and a colon, so it is '
        + 'probably not the token — check you did not swap it with another value, or paste a '
        + 'label like "TG_TOKEN=" along with it.';
    }
    return 'The token is the right shape but Telegram does not recognise it. Re-copy it from '
      + 'BotFather (/mybots > your bot > API Token), replace TG_TOKEN, and Deploy.';
  }
  if (/url/i.test(message)) {
    return 'Telegram could not accept this Worker address. It must be public https, which a '
      + 'workers.dev address is — check the Worker is deployed.';
  }
  return 'Send me the whole of this reply; it carries no secret values.';
}

async function serveManifest(env, code) {
  const meta = await batch.getMeta(env, code);
  if (!meta) return json({ error: 'unknown code' }, 404);
  // Summaries, not full records: a 200-photo batch is a couple of requests
  // rather than 200, which is the difference between working and being cut off.
  return json(batch.manifest(meta, await batch.listSummaries(env, code)));
}

/**
 * Stream one photo straight from Telegram to the app. Nothing is buffered and
 * nothing is re-encoded, so a 4MB photo costs the same CPU as a 40KB one.
 */
async function servePhoto(env, code, id) {
  const meta = await batch.getMeta(env, code);
  if (!meta) return json({ error: 'unknown code' }, 404);
  const photo = await batch.getPhoto(env, code, id);
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
