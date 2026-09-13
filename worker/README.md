# Insta Report intake bot

Site staff send photos to a Telegram group; this files them by section and the
admin app collects them with an 8-character code. It runs on a Cloudflare Worker
and is built to cost nothing.

## Why it stores nothing

Photo bytes stay in Telegram. A `file_id` never expires for the bot, so this
Worker keeps only "which photo, which section, which caption" — a couple of
kilobytes per batch in Workers KV — and streams the bytes through on demand when
the app asks.

That is a deliberate choice, not a shortcut:

- **No R2.** R2 has a free allowance but Cloudflare wants a payment method on the
  account before it can be enabled. Nothing here needs it.
- **No base64 of photos anywhere.** The Workers free plan caps CPU per request;
  streaming a photo costs almost none, encoding one costs a lot.
- **One KV write per photo.** The test run files 8 photos and 9 commands in 14
  writes, against a free allowance of 1,000 a day.

**Before deploying, check these still hold** — they are what the design rests on:

| | Free allowance assumed |
|---|---|
| Workers | 100,000 requests/day, 10ms CPU per invocation |
| Workers KV | 1,000 writes/day, 100,000 reads/day, 1GB |
| Cron Triggers | 3 per account |

If any of that has changed, stop and re-decide rather than reaching for a paid
plan. The safest guarantee is the simplest one: **do not put a payment method on
the Cloudflare account.** Then nothing can bill, whatever anyone adds later.

## Setup

1. **Make the bot.** In Telegram, message `@BotFather` → `/newbot` → keep the
   token it gives you. Treat it like a password: it goes into `wrangler secret`
   below, never into a file, a chat, or this repo.

2. **Add the bot to the site group** and make it an admin (otherwise Telegram
   hides other people's messages from it). Send `/id`-style: post any message,
   then find the chat id — easiest is to add `@RawDataBot` briefly, or read it
   from the Worker log on the first webhook hit.

3. **Cloudflare.** Create a free account. Then:

   ```sh
   npm install -g wrangler          # or npx wrangler for one-offs
   wrangler login
   wrangler kv namespace create BATCHES
   ```

   Put the id it prints into `wrangler.toml`, and the group's chat id into
   `ALLOWED_CHATS`. An empty allowlist accepts nothing, which is the right
   default for a bot anyone can find by name.

4. **Secrets.** Run these locally; each prompts for the value:

   ```sh
   wrangler secret put TG_TOKEN            # from BotFather
   wrangler secret put TG_WEBHOOK_SECRET   # any long random string you invent
   ```

5. **Deploy and register the webhook:**

   ```sh
   wrangler deploy
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -H 'content-type: application/json' \
     -d '{"url":"https://<your-worker>.workers.dev/tg/webhook",
          "secret_token":"<TG_WEBHOOK_SECRET>",
          "allowed_updates":["message","channel_post"]}'
   ```

6. **Point the app at it.** Insta Report (admin) → Settings → Telegram intake →
   paste `https://<your-worker>.workers.dev` → Test connection.

## Using it on site

```
/project 23 JALAN KERUING      start a batch
/sec CAR PORCH                 file what follows under this section
<send photos>                  each one acked: ✓ CAR PORCH · 3
/sec KITCHEN                   switch section
/list                          counts so far
/undo                          drop the last photo
/done                          closes it, replies with the import code
/cancel                        throw it away
```

A caption typed with a photo is kept. In an album, Telegram only carries the
caption on the first item, so it applies to the whole album.

**Capture times.** Telegram re-encodes anything sent as a *photo* and strips its
EXIF, so the send time is used and marked as such — the app flags these and can
retime a whole batch to the inspection date in one go. Send as **File** when the
real capture time matters; the original bytes survive and the app reads the EXIF
out of them.

## API the app uses

| Route | |
|---|---|
| `GET /api/batch/:code` | the manifest: sections, captions, photo ids |
| `GET /api/photo/:code/:id` | that photo's bytes, streamed from Telegram |
| `POST /api/batch/:code/claim` | app has them; drop the batch |
| `GET /health` | liveness |

## Tests

```sh
node worker/test/run.js
```

Runs the real handlers against a fake KV and a stubbed Telegram — a whole day on
site, the HTTP API, the allowlist, and the KV write count. No wrangler, no
network, no account needed.

## Known limits

- **KV is eventually consistent.** A photo sent in the same second as the `/sec`
  before it can land in the previous section. `/list` and the per-photo ack exist
  so that is caught on site rather than at 11pm. Leave a beat after `/sec`.
- **Telegram compresses photos** to around 1280px. Fine at 2 or 4 per page,
  softer than the app's own 1600px capture.
- **One batch per chat at a time.** `/done` or `/cancel` before starting another.
- Batches expire from KV after 14 days, and `claim` deletes them immediately.
