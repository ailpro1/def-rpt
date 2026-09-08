# Fast Report

Offline-first PWA for home building **defect inspection reports**. Capture or import
photos, caption them in one tap, annotate them, and print an A4 report that matches
the standard "Title / Group / photo grid / page n of m" layout.

No build step, no framework, no server. Static files + IndexedDB + a service worker.

---

## Why it is fast on site

| Task | Taps |
|---|---|
| Add photo | 1 (Take Photo) |
| Caption it | 1 (tap a chip) |
| Caption a whole batch | 2 (Apply one caption to all) |
| Annotate | drag on the photo |
| Report | 1 (Generate Report) → Print / Save as PDF |

Captions come from an editable library. The suggestion row is ranked offline by how
often you use each caption, how recently, and which location you are in — so the
caption you want is usually the first chip.

Typing in the caption box searches the same library and lists matches under the
field. A word prefix works (`grout`), so does an abbreviation (`ug` &rarr; UNFILLED
GROUT, `rdk` &rarr; RUSTED DOOR KNOB), and loose letters in order are the last
resort — dropped as soon as a real match exists, so two letters do not fill the list
with noise. Ties break on how often you use each caption. Picking one keeps the
keyboard up, and only the line being typed is replaced, so a second line can be
searched on its own.

## Features

- **Projects** — one per property. Sections (CAR PORCH, KITCHEN, BATH 3 …) added
  individually or from a template.
- **Photos** — live camera capture or device library. Downscaled on-device to a
  report-sized JPEG plus a grid thumbnail, with EXIF orientation applied.
- **Captions** — type-ahead search, quick-pick chips, grouped library, optional second
  line, batch apply, move between sections, reorder.
- **Photo timestamps** — the capture time is read from the photo's own EXIF
  (`DateTimeOriginal`), falling back to the file's date and then to import time, and
  printed camera-style on each report photo. Format, position and on/off are in
  Settings; any photo's time can be corrected by hand if the camera clock was wrong.
- **Annotation** — circle, arrow, box, freehand, text, dot; six colours, three widths,
  undo/clear. Strokes are stored as normalised vectors, so a photo stays re-editable
  and re-renders at any size. A flattened JPEG is generated for the report and sharing.
- **AI assistant** (optional, online) — Google AI Studio (Gemini). Suggests a caption
  from the photo, captions batches, drafts the executive summary from the recorded
  items, and answers questions about the inspection. Picks the model itself and is
  built to stay inside the free tier. Everything else works with no connection.
- **Report** — cover page (logo, title, property, metadata), executive summary with an
  item-count table, optional notes/limitations page, then paginated photo pages.
  2 / 4 / 6 / 8 photos per page. Print or Save as PDF via the OS print dialog.
- **Settings** — company details and logo, report title, cover text, summary text,
  notes, page footer, photo size, photos per page. Per-project overrides for cover
  and summary.
- **Backup** — full backup or a single project as one self-contained `.json` file
  (photos included), shared through the native share sheet or downloaded. Restore
  merges or replaces.
- **Offline** — app shell precached by the service worker; all data in IndexedDB with
  persistent storage requested so iOS does not evict it.
- **Automatic updates** — a new version installs in the background and waits. When
  nothing is open the app shows *"App is updating. Please wait…"*, hands over and
  reloads onto the new version. It never swaps mid-annotation, and data is untouched.

## Run it

```bash
node tools/build.mjs      # writes dist/admin, dist/site and a chooser page
cd dist && python3 -m http.server 8080
# open http://localhost:8080
```

To work on the source directly (single app, full features):

```bash
npm start          # or any static file server
# open http://localhost:8080
```

Then **Share → Add to Home Screen** on iOS, or **Install** in Chrome, to run it
full-screen as an app.

It must be served over `https://` (or `localhost`) for the service worker, the camera
and persistent storage to work.

### Deploy

`.github/workflows/pages.yml` builds both apps and publishes `dist/` to GitHub Pages
on every push. One repo, one branch, one deploy, two installable apps:

```
https://<user>.github.io/<repo>/          chooser
https://<user>.github.io/<repo>/site/     Site app
https://<user>.github.io/<repo>/admin/    Office app
```

One-time setup: in the repository on GitHub, go to **Settings → Pages** and set
**Source** to **GitHub Actions**. Nothing else. The workflow already deploys from
`main`, `master` or the feature branch, whichever you push to, and can also be run
by hand from the **Actions** tab.

The workflow fails the build if the Site app still contains any assistant code, so
the capture app can never start shipping network calls by accident.

Any other static host works too — build, then upload `dist/`. All paths are relative.

### The two builds

`js/build.js` is the only file that differs; `tools/build.mjs` rewrites it per
variant and deletes what that variant does not ship.

| | Site | Office |
|---|---|---|
| `ai` | `false` — `ai.js` and the assistant screen are **absent from the download**, not just hidden | `true` |
| `dbName` | `instareport-site` | `instareport` |
| Photo size | 1200px | 1600px |
| Backup | One project per file only | Full backup or one project |
| Manifest `id` | `./site/` | `./admin/` |

Separate database names matter: GitHub Pages serves both from one origin, and
IndexedDB is scoped to the origin, so without this the two apps would share one
store on a phone that has both installed.

### The handoff

1. Site app: capture the job, caption, annotate.
2. Settings → **Export project to send** → share the `.json` file (WhatsApp as a
   document, Drive, AirDrop — a 150-photo job is roughly 40&nbsp;MB, so email will
   usually refuse it).
3. Office app: Settings → **Restore from file** → *Merge into this device*.
4. Finish the captions, draft the summary, print the report.

A single-project file carries no settings, so it cannot overwrite the office's
company details, logo or caption library.

## Report layout

Photo pages reproduce the standard inspection layout:

```
Title:  NO. 4 KLEBANG SEROJA        Group:  CAR PORCH
──────────────────────────────────────────────────────────────
 [photo]              [photo]
 RUSTED LATCH         RUSTED STRIKE HOLE
 [photo]              [photo]
 ...
──────────────────────────────────────────────────────────────
 NO. 4, JALAN KLEBANG SEROJA 6, ...              page 4 of 17
```

Page numbers run through the whole report by default — `page 4 of 17` — so the
number matches the page you are on in the PDF. Settings → **Page numbers** →
*Per section* restores the older style that restarts at each section.

**Title** is the project, **Group** is the section. The address prints in the footer
of every page (or Settings → Page footer, if you set your own). Each photo carries its
capture time in the corner, `2026.08.15 17:23` by default.

### Photo timestamps

| Source | When it is used |
|---|---|
| EXIF `DateTimeOriginal` | Whenever the photo carries it — the true capture time |
| EXIF `DateTime` | Fallback within the same photo |
| File `lastModified` | No EXIF; iOS sets this from the capture |
| Import time | Nothing else available — the photo sheet flags this as "check this" |

Settings → Photo Timestamp sets the format (`2026.08.15 17:23`, `15/08/2026 17:23`,
12-hour, or date only), the corner, and whether the stamp is burned into photos shared
out of the app on their own. The report draws its own stamp rather than burning it into
the stored image, so it stays switchable and the original photo is never altered.

Each photo's time is shown in its sheet under **Captured** and can be corrected there.
Times travel in backup files, so a report built on another device keeps them.

**Wrong-clock check.** A site phone set to the wrong date stamps every photo months
out, and that normally only surfaces while the report is being written. The project
screen flags photos whose capture time sits more than two days from the inspection
date, works out the common offset, and offers to move them all onto the inspection
date keeping each photo's time of day — or to change the inspection date instead.

Pages are laid out at true A4 and scaled down only for the screen.

### Save PDF

**Save PDF** writes the file itself — the app contains a small PDF writer
(`js/pdf.js`) and lays the report out from the data (`js/report-pdf.js`), then hands
you the file through the share sheet.

This exists because Safari and Chrome stamp their own header and footer onto printed
output — the page address, the date, their own page numbering — and a page cannot
switch that off. A report going to a client cannot carry
`ailpro1.github.io/def-rpt` across the bottom. Written directly, the PDF carries
nothing but the report.

- True A4 (595.28 × 841.89 pt), one page per report page
- Photos embedded byte-for-byte as JPEG (`DCTDecode`) — no re-encoding, no quality loss
- Base-14 fonts, so nothing is embedded and the file stays small
- Filename from the project: `IR-2026-014 - No 4 Klebang Seroja - 2026-09-05.pdf`
- `Print instead` is still there in Report Options if you want the browser dialog

Roughly 300 KB per ten photos, so a 150-photo job lands around 40 MB.

## Project layout

```
index.html              shell + tab bar
manifest.webmanifest    PWA manifest
sw.js                   service worker (precache + offline fallback)
css/app.css             iOS-style design system
css/report.css          A4 report + print rules
js/app.js               hash router, boot, offline indicator
js/db.js                IndexedDB wrapper
js/store.js             projects / sections / photos / settings
js/image.js             decode, downscale, annotate render, flatten
js/captions.js          default caption + section library, offline ranker
js/ai.js                Google AI Studio (Gemini) calls (optional)
js/backup.js            export / import / share
js/ui.js                DOM helpers, sheets, alerts, rows
js/screens/*.js         one module per screen
js/pdf.js               minimal PDF writer (pages, text, rules, JPEG images)
js/report-pdf.js        lays the report out as a PDF, from the data
js/build.js             build profile — the only file that differs per app
js/assist.js            the assistant's public surface; loads ai.js on demand
js/fallback.js           what the assistant features do with no AI
tools/make-icons.mjs    regenerates the PWA icons (no dependencies)
tools/build.mjs         builds dist/admin, dist/site and the chooser
```

## Data model

| Store | Contents |
|---|---|
| `projects` | property, client, reference, inspector, date, report overrides |
| `sections` | ordered locations within a project |
| `photos` | caption, second line, annotation ops, order, blob references |
| `blobs` | image bytes, kept apart so list views stay cheap |
| `settings` | branding, report defaults, caption library, usage stats, AI config |

## AI assistant setup

Settings → Assistant → AI assistant. Enable it, paste a Google AI Studio key
(`AIza…`, from [aistudio.google.com](https://aistudio.google.com)), and tap
**Test connection**.

### Model selection

**Test connection** asks your key which models it has (`GET /v1beta/models`), keeps
the list, and offers it as the presets. Model names change over time and differ
between keys, so nothing is hardcoded as fact — the ladder below is a preference
order, and the stored list is the source of truth.

**Choose model automatically** is on by default. Each job asks for the cheapest model
that can do it; the request is then resolved to the closest model the key really has
(by family — lite, flash, pro), and steps to the next one by itself when a model is
rate limited, missing or returns nothing:

| Job | Preference |
|---|---|
| Single caption | lite → flash |
| Batch captions | flash → lite |
| Summary, chat | flash → lite |

So a key that has `gemini-flash-lite-latest` but not `gemini-2.5-flash-lite` still
works, with no configuration. A model that genuinely does not exist is reported as
such rather than retried.

A model that returns 429 is put on a 90-second cooldown and skipped until it clears.
After the ladder is exhausted the app waits 4 seconds and retries once, because
free-tier limits are per minute. Turn the switch off to pin one model instead.

### Staying inside the free tier

The assistant is built to send as little as possible:

| Measure | Effect |
|---|---|
| Photos downscaled to 768px before sending | Fits one Gemini image tile — about a quarter of the tokens the 1600px report copy would cost |
| Caption library trimmed to the 24 most likely for that room | Instead of the whole library on every request |
| Batched 8 photos per request | System prompt and library paid for once, not eight times |
| Reply capped at ~24 tokens per caption, thinking off on Flash | A four-word caption cannot run long |
| Repeated captions collapsed to `UNFILLED GROUT x7` | Summary and chat context stay small on big jobs |
| Already-captioned photos skipped | Re-running a batch only fills the gaps |

Captions are written to the database **as each batch of 8 lands**, so a rate limit
part-way through a long section keeps everything already done.

Settings → Capture → **AI photo detail** (Low / Standard / High) trades tokens
against how much fine detail the model can see. Standard (768px) suits most defect
work; use High for hairline cracks.

A typical 3–4 hour inspection — 150 photos — is roughly 20 requests.

The key is stored on that device only, is sent to `generativelanguage.googleapis.com`
and nowhere else, and is **excluded from backup files**. Without a key the app falls
back to offline suggestions from the caption library.

Google may use free-tier requests to improve their models. Use a billed key for
client photos that must stay private.

### Using a different provider

Only `callModel()` and the small `imagePart()` helper in `js/ai.js` are
Gemini-specific. Every feature builds provider-neutral prompts, so swapping to
another vision model is a change to those two functions plus the model ladder.

## Android and iOS

Both apps are built for either. Everything the app relies on — service worker,
IndexedDB, `<input capture>`, canvas, Web Share, print — works on Chrome/Edge on
Android and on Safari on iOS 16.4+.

| | Android (Chrome) | iOS (Safari) |
|---|---|---|
| Install | "Install app" prompt, or menu → Add to Home screen | Share → Add to Home Screen |
| Storage eviction | Rare | Stricter; the app requests persistent storage |
| Save PDF | Share sheet, or a download | Share sheet → Save to Files |
| Share a file | Works | Works |
| EXIF capture time | Read | Read |

Firefox on Android has no Web Share for files; backup export falls back to a plain
download there.

## Notes

- Photos never leave the device unless you share them, back up, or use the assistant.
- Storage is per-browser: installing to the Home Screen and then using Safari
  separately gives you two separate stores. Back up before changing device.
