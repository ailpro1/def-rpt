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
   **Copy it somewhere safe.** This is the password to your bot — anyone with it
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

    If anything is wrong it tells you exactly what, in plain words — a missing
    token, a secret with an illegal character, or Telegram's own refusal.

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

## If something does not work

| What you see | What it usually means |
|---|---|
| The bot never replies to anything | `ALLOWED_CHATS` is not your ID (step 15), or step 17 was skipped |
| Step 17 complains about the secret not matching | the value after `secret=` in the address differs from `TG_WEBHOOK_SECRET` — check for a trailing space |
| Step 17 says the secret can only contain letters, numbers, `_` and `-` | your secret has a space or punctuation in it. Change it in step 15, Deploy, then use the new value in step 17 |
| Step 17 says the token is not set, or does not look like a bot token | `TG_TOKEN` is missing or was pasted with a space or line break — re-enter it in step 15 and Deploy |
| Step 17 says "Telegram refused: … Unauthorized" | the token is a real shape but not a real token — re-copy it from BotFather |
| Step 17 says "Telegram refused" something else | the message is Telegram's own words; send it to me and I'll decode it |
| App says "That address answered, but it is not an intake bot" | the paste in step 13 did not deploy, or the address has a typo |
| App says "No batch with code…" | that batch was already imported — a batch is deleted once it lands — or the code is mistyped |
| Bot says "No batch open" | `/project` was never sent, or `/done` already ran |
| Photos are ignored, no tick | no batch open: send `/project <name>` first |

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
/list                          what is in the batch so far
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
