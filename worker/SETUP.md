# Setting up the intake bot

About 20 minutes. No software to install, no command line, no credit card.

You need: Telegram on your phone, a web browser, and this repo open so you can
copy one file.

---

## Part 1 · Make the bot — 5 min

1. In Telegram, search for **@BotFather** (blue tick) and tap **Start**.
2. Send `/newbot`.
3. It asks for a **name**. This is just the display name: `Insta Report Intake`.
4. It asks for a **username**. It must end in `bot` and be unused, for example
   `talon_insta_intake_bot`.
5. It replies with a **token** that looks like `8123456789:AAF…`.
   **Copy it straight into Cloudflare in step 15 if you can.** Passing it through
   a notes app, a document or a chat can silently turn the hyphens into dashes,
   and Telegram then rejects it. This is the password to your bot — anyone with it
   can read and send your bot's messages. Don't put it in a chat, a shared
   document, or a message to Claude.
6. Tap the `t.me/…` link in BotFather's reply, then press **Start**. This opens
   your private chat with the bot, which is where you will forward photos.

## Part 2 · Find your Telegram ID — 1 min

7. Search for **@userinfobot** and tap **Start**. It replies with something like
   `Id: 123456789`. Note that number down.

   This is how the bot knows to listen to you and ignore everyone else.

## Part 3 · Cloudflare account — 3 min

8. Go to **cloudflare.com** → **Sign Up**. It is free. Verify your email.
9. **Do not add a payment card.** Nothing in this setup needs one, and an
   account with no card on it cannot bill you — that is your guarantee, stronger
   than any setting.

## Part 4 · Make the storage — 2 min

10. In the left sidebar: **Storage & Databases** → **KV** → **Create a
    namespace**. Name it exactly `BATCHES`, then Create.

    (This holds a few kilobytes per job — which photo belongs to which section.
    The photos themselves stay in Telegram.)

## Part 5 · Make the Worker — 5 min

11. Left sidebar: **Compute (Workers)** → **Create** → **Start with Hello
    World** → **Deploy**.
12. Give it a name like `insta-intake`. Its address will be
    **`https://insta-intake.YOUR-NAME.workers.dev`** — note it down, you need it
    twice later.
13. Open **Edit code**. Select everything in the editor and delete it. Then open
    **`worker/dist/worker.js`** from this repo, copy the whole file, paste it in,
    and press **Deploy**.

## Part 6 · Wire it together — 3 min

14. In the Worker, go to **Settings** → **Bindings** → **Add** → **KV
    namespace**.
    - Variable name: `BATCHES`
    - KV namespace: the `BATCHES` you made in step 10

    Save.

15. Still in **Settings** → **Variables and Secrets**, add three:

    | Name | Type | Value |
    |---|---|---|
    | `ALLOWED_CHATS` | Text | your ID from step 7 |
    | `TG_TOKEN` | **Secret** | the token from step 5 |
    | `TG_WEBHOOK_SECRET` | **Secret** | a password you make up, about 20 characters — **write it down**, you need it once in step 17 |

    **The webhook secret may only contain letters, numbers, `_` and `-`.**
    Telegram refuses anything else — no spaces, no `!@#$%`. `TalonIntake2026xyz`
    is fine; `Talon Intake!2026` is not.

    The two marked Secret are hidden after saving and cannot be read back, which
    is the point.

16. Press **Deploy** again so the settings take effect.

## Part 7 · Introduce Telegram to the Worker — 30 sec

17. In your browser, visit this address, with your own two values filled in:

    ```
    https://insta-intake.YOUR-NAME.workers.dev/tg/register?secret=YOUR_WEBHOOK_SECRET
    ```

    If anything is wrong, Telegram's own reason comes back along with a `hint`
    saying what to change. The Worker does not second-guess your token — it asks
    Telegram and reports the answer.

    You should see something like:

    ```json
    {"ok":true,"bot":"talon_insta_intake_bot","webhook":"https://insta-intake.YOUR-NAME.workers.dev/tg/webhook"}
    ```

    That is Telegram being told where to deliver your messages. You only ever do
    this once.

## Part 8 · Point the app at it — 1 min

18. Open **Insta Report** (the office app) → **Settings** → **Telegram Intake**
    → paste `https://insta-intake.YOUR-NAME.workers.dev` → **Test connection**.

    It should say *Connected. The bot is answering.* Save.

## Part 9 · Try it — 5 min

19. Open your bot in Telegram and send, one message at a time:

    ```
    /project TEST HOUSE
    /sec KITCHEN
    ```

    Then forward or send two photos. Each gets a tick back: `✓ KITCHEN · 1`.
    Then send `/done`. It replies with an 8-character code.

20. In the app: **Projects** → **+** → **Import from Telegram** → type the code
    → **Fetch batch**. Check the sections it found, then **Import**.

21. Open the project — two photos under KITCHEN. Delete the test project when
    you are happy.

**You are set up.** From now on it is just: `/project`, `/sec`, forward,
`/done`, import.

---

## Turning on AI captions — 5 min, optional

Without this the bot collects and sorts, and photos arrive with whatever caption
the site team typed. With it, photos arrive already captioned and your job is to
read and correct rather than write.

It uses the same free Google AI Studio key the app uses. You can use the same
key in both places.

22. In the Worker: **Settings** → **Variables and Secrets** → Add
    `GEMINI_KEY`, type **Secret**, value = your Google AI Studio key. **Deploy**.

    That is all captioning needs for an ordinary job. Each photo is captioned
    the moment it lands, in the same breath as being filed, so by the time you
    have finished forwarding a room it is already written up.

23. **Give the Worker an alarm clock.**

    Step 22 handles a few dozen photos. It cannot handle a few hundred: Google's
    free tier takes about fifteen requests a minute, so forwarding a whole day's
    work in one go means most of them are turned away. Those photos are not
    lost — they go on a list of unfinished work — but something has to come back
    for them later, and the Worker only wakes when something calls it. A cron
    trigger is Cloudflare waking it on a schedule.

    **Settings** → **Trigger Events** (or **Triggers**) → **Add** → **Cron
    Trigger**, and enter:

    ```
    */2 * * * *
    ```

    That is "every two minutes" — five fields for minute, hour, day, month and
    weekday; `*` means "every one of these" and `*/2` means "every second one".
    Save.

    Each wake-up it clears up to six of the leftovers, then goes back to sleep.
    When there are none it reads a single key and stops, which costs the account
    almost nothing. Skip this step and small jobs still get captioned; a big
    forwarding session will come through half blank.

    **Do not set this to every minute.** The free plan's smallest allowance is
    1,000 key *listings* a day. An earlier version searched for work on every
    tick, which at one a minute is 1,440 listings and had a real account's
    storage blocked over a weekend in which nobody touched the bot. The Worker
    no longer searches — it keeps a list — but there is nothing to gain from
    firing twice as often, so leave it at two minutes.

24. **Check it works, without waiting for the alarm.** Optional — this just
    turns "is it working?" into a five-second answer.

    Forward a photo with **no** caption, then visit this address (the same
    secret as step 17):

    ```
    https://YOUR-WORKER.workers.dev/api/caption/run?secret=YOUR_WEBHOOK_SECRET
    ```

    It means "do the captioning now, and tell me what happened". You should see:

    ```json
    {"ok":true,"done":1,"failed":0,"remaining":0,"errors":[]}
    ```

    `done: 1` is one photo captioned. If the key is missing or wrong it says so
    instead of pretending. Then send `/done` and import — the caption is there.

25. Optional but worth it: **Insta Report → Settings → Telegram Intake → Send
    caption library to the bot**. It asks for the webhook secret once. Without
    this the bot hints the model with the caption list built into it, which is
    the app's defaults but not the entries you have added since.

**What to expect.** A small job — a few dozen photos — is captioned as you
forward it and is ready the moment you send `/done`. A big one runs into
Google's free rate limit partway through, and the rest is cleared at about 180
photos an hour by the alarm clock in step 23, so 200 photos are finished within
the hour. Import before it finishes and the screen tells you how many are still
coming; you can wait, or import and use the app's own assistant.

A caption the site team typed is never overwritten — they were standing in front
of it. Captioning failures are not fatal: that photo simply arrives blank.

## If an import stops partway

A big job can be interrupted — the phone sleeps, the signal drops, the browser
reclaims the tab. Nothing is lost and nothing needs undoing:

- Every imported photo remembers which batch and message it came from, so
  **importing the same code again tops up what is missing** rather than
  doubling what is there. The screen says how many are already in, and the
  button counts only what it will add.
- The bot only forgets a batch after an import that fetched every photo, so the
  code keeps working while anything is outstanding.
- If the code has stopped working but photos are still missing, the import was
  complete as far as the bot was concerned — the missing ones never reached it.
  Send `/list` before `/done` to check the bot's counts against what you
  forwarded.

---

## If something does not work

| What you see | What it usually means |
|---|---|
| The bot never replies to anything | `ALLOWED_CHATS` is not your ID (step 15), or step 17 was skipped |
| Step 17 complains about the secret not matching | the value after `secret=` in the address differs from `TG_WEBHOOK_SECRET` — check for a trailing space |
| Step 17 says the secret can only contain letters, numbers, `_` and `-` | your secret has a space or punctuation in it. Change it in step 15, Deploy, then use the new value in step 17 |
| Step 17 says `TG_TOKEN is not set` | the variable is missing, or was added but not Deployed |
| Step 17 says "Telegram refused: … Unauthorized" or "Not Found" | the token is wrong. Re-copy it from BotFather: **/mybots** → your bot → **API Token** |
| …and the hint mentions a dash or an invisible character | the token picked up a lookalike character on the way — an en dash instead of a hyphen is the usual one. Copy it straight from BotFather's message rather than from a document or a note, and paste it into the field without editing |
| Step 17 says "Telegram refused" anything else | it comes back with a `hint` telling you what to do, and a `check` describing what is stored — send me the whole reply if it is still unclear |
| App says "That address answered, but it is not an intake bot" | the paste in step 13 did not deploy, or the address has a typo |
| App says "No batch with code…" | that batch was already imported — a batch is deleted once it lands — or the code is mistyped |
| Bot says "No batch open" | `/project` was never sent, or `/done` already ran |
| Photos are ignored, no tick | no batch open: send `/project <name>` first |
| Fewer photos imported than you sent | run the import again with the same code — photos already in are skipped, so only the missing ones come down. If the code no longer works, the bot never received the rest: check `/list` against what you forwarded |
| "Could not reach the intake bot" on a big batch | the Worker is out of date. Re-paste `worker/dist/worker.js` (step 13) and Deploy. Before this fix, a large batch cost the Worker one storage read per photo on every request, and Cloudflare cut it off — the browser reports that as unreachable, because the error page it gets back carries no CORS headers |
| Anything at all to do with captions | visit `/api/status?secret=YOUR_WEBHOOK_SECRET` first. It lists every batch, what each is still waiting on, whether the key is set, and says in plain words which of those is the problem |
| You re-pasted the Worker and nothing changed | check the paste actually landed: `/health` reports a build stamp, and `node worker/build.mjs` prints the one it should be. If they differ, the old file is still running |
| No captions at all, on any photo | `GEMINI_KEY` is missing or wrong (step 22). `/api/status` says so outright, and lists the models your key can actually reach |
| You replaced the key and it still will not caption | the old key's model list and any resting models are remembered for a few minutes. `/api/caption/run?secret=…&reset=1` forgets both and tries again now |
| Photos waiting but `/api/caption/run` says `"idle":true` | the queue has lost them — they were filed before the queue existed. Run `/api/caption/run?secret=…&rescan=1` once; it captions them and puts them back on the queue for good |
| Captions on the first photos of a big batch, then nothing | Google's free rate limit, which is normal. The rest are captioned by the cron trigger over the following hour. If they never arrive, the alarm clock in step 23 is what is missing |
| Cloudflare emails that KV is blocked for exceeding a free limit | the allowance resets daily. Check the cron is `*/2 * * * *` and not every minute, and that the Worker is up to date — an idle tick should read one key and list none. The bot keeps collecting photos meanwhile; only captioning pauses |
| Captions missed on an older batch | the queue of work is kept in one key. If it is ever lost, `/api/caption/run?secret=…&rescan=1` searches every batch instead. It costs listings, so it is never automatic |
| `/api/caption/run` reports `failed` | its `errors` carry Google's own words. `429` is the free-tier rate limit and sorts itself out on later ticks |

**Reading a refusal.** It carries a `check` block describing what is stored —
`"TG_TOKEN":{"length":46,"hasColon":true,"charsAfterColon":35,"nonAscii":false,…}`
— never the values themselves, so it is safe to share when asking for help.
A healthy token reads 46 long, `hasColon: true`, 35 characters after the colon,
and everything else false. `nonAscii: true` is the one that catches people out:
the token looks perfect but carries a lookalike dash. `nonAsciiCharacters` names
it.

Live logs help: in the Worker, open **Logs** → **Begin log stream**, then send
the bot a message and watch what arrives.

## Updating the bot later

When the code in `worker/src/` changes, run `node worker/build.mjs` (or take the
updated `worker/dist/worker.js` straight from the repo) and repeat **step 13** —
paste over the editor and Deploy. Your settings, secrets and KV binding all stay
as they are.

## Day-to-day use

```
/project 23 JALAN KERUING      start a job
/sec CAR PORCH                 file what comes next under this section
<forward the photos>           each one acked: ✓ CAR PORCH · 3
/sec KITCHEN                   switch section
/list                          what is in the batch so far, plus its code and caption count
/undo                          remove the last photo
/done                          finish, get the import code
/cancel                        throw the batch away
```

In the site group, select the photos → **Forward** → your bot. An album forwards
as an album, and any caption the team typed comes with it.

Leave a beat after `/sec` before forwarding — a photo arriving in the same
instant can land in the previous section. The tick after each photo tells you
where it went.

**Remember:** your photos already have a timestamp printed on them by the site
team's camera. Switch **Photo timestamps** off in the export sheet, or the
report prints two.
