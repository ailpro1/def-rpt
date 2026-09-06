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

## Features

- **Projects** — one per property. Sections (CAR PORCH, KITCHEN, BATH 3 …) added
  individually or from a template.
- **Photos** — live camera capture or device library. Downscaled on-device to a
  report-sized JPEG plus a grid thumbnail, with EXIF orientation applied.
- **Captions** — quick-pick chips, grouped library, optional second line, batch apply,
  move between sections, reorder.
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
npm start          # or any static file server
# open http://localhost:8080
```

Then **Share → Add to Home Screen** on iOS, or **Install** in Chrome, to run it
full-screen as an app.

It must be served over `https://` (or `localhost`) for the service worker, the camera
and persistent storage to work.

### Deploy

Copy the repository to any static host (GitHub Pages, Netlify, S3, an internal web
server). All paths are relative, so it works from a subdirectory.

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
 NO. 4, JALAN KLEBANG SEROJA 6, ...               page 1 of 3
```

**Title** is the project, **Group** is the section. The address prints in the footer
of every page (or Settings → Page footer, if you set your own).

Pages are laid out at true A4 and scaled down only for the screen, so print output
is 1:1.

**On iPhone:** tap Print, pinch out on the preview, then share to Files to save a PDF.

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
tools/make-icons.mjs    regenerates the PWA icons (no dependencies)
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

**Choose model automatically** is on by default. Each job runs on the cheapest model
that can do it, and steps to the next one by itself when a model is rate limited,
missing or returns nothing:

| Job | Order tried |
|---|---|
| Single caption | `flash-lite` → `flash` |
| Batch captions | `flash` → `flash-lite` |
| Summary, chat | `flash` → `flash-lite` |

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

## Notes

- Photos never leave the device unless you share them, back up, or use the assistant.
- Storage is per-browser: installing to the Home Screen and then using Safari
  separately gives you two separate stores. Back up before changing device.
