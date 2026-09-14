# Insta Report intake bot

Site staff post photos to their Telegram group; you forward them to this bot,
which files them by section so the admin app can collect a whole job with an
8-character code. It runs on a Cloudflare Worker and is built to cost nothing.

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

2. **Get your own user id.** Message `@userinfobot` and it replies with your id.
   That is the only chat the bot will accept — you forward photos to it in a
   private chat, so there is nothing to add to the site group, no admin rights
   to grant, and no bot the team can reach.

3. **Cloudflare.** Create a free account. Then:

   ```sh
   npm install -g wrangler          # or npx wrangler for one-offs
   wrangler login
   wrangler kv namespace create BATCHES
   ```

   Put the id it prints into `wrangler.toml`, and your user id into
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

## Using it

Site staff post to their own group as they always have. You forward from there
into the bot, in whatever order suits you:

```
/project 23 JALAN KERUING      start a batch
/sec CAR PORCH                 file what follows under this section
<forward the car porch photos> each one acked: ✓ CAR PORCH · 3
/sec KITCHEN                   switch section
/list                          counts so far
/undo                          drop the last photo
/done                          closes it, replies with the import code
/cancel                        throw it away
```

In Telegram, select the photos in the group → **Forward** → the bot. An album
forwards as an album, and a caption the team typed travels with it.

**Capture times.** A forwarded message carries the date it was *originally*
sent, and that is what the bot records — so forwarding a week of work in one
sitting still files each photo under the day it was taken, not today.

The time that prints in the report is the one burnt into the photo by the
camera. The stored time only orders the photos and lets the app spot a batch
that has landed on the wrong day, where the project screen offers to retime the
lot to the inspection date.

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

Runs the real handlers against a fake KV and a stubbed Telegram — a whole job,
forwarded photos keeping their original date, the HTTP API, the allowlist, and
the KV write count. No wrangler, no network, no account needed.

`python3 worker/test/e2e.py` goes further: the real Worker on one port and the
built admin app on another, driven in headless Chromium, so a batch really does
become a project.

## Known limits

- **KV is eventually consistent.** A photo forwarded in the same second as the
  `/sec` before it can land in the previous section. The per-photo ack and
  `/list` are there to catch it. Leave a beat after `/sec`.
- **Telegram compresses photos** to around 1280px. Fine at 2 or 4 per page,
  softer than the app's own 1600px capture.
- **One batch per chat at a time.** `/done` or `/cancel` before starting another.
- **Photos already carry a timestamp** from the site team's camera, and the app
  draws its own on export. Switch "Photo timestamps" off in the export sheet, or
  a report of forwarded photos shows two.
- Batches expire from KV after 14 days, and `claim` deletes them immediately.
