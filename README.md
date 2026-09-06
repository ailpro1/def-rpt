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
- **AI assistant** (optional, online) — suggests a caption from the photo, captions a
  batch in one request, drafts the executive summary from the recorded items, and
  answers questions about the inspection. Everything else works with no connection.
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
Title:  CAR PORCH     Group:  NO. 4, JALAN KLEBANG SEROJA 6, ...
──────────────────────────────────────────────────────────────
 [photo]              [photo]
 RUSTED LATCH         RUSTED STRIKE HOLE
 [photo]              [photo]
 ...
──────────────────────────────────────────────────────────────
                                                  page 1 of 3
```

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
js/ai.js                Anthropic API calls (optional)
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

Settings → Assistant → AI assistant. Enable it and paste an Anthropic API key.

The key is stored on that device only, is sent to `api.anthropic.com` and nowhere
else, and is **excluded from backup files**. Without a key the app falls back to
offline suggestions from the caption library.

## Notes

- Photos never leave the device unless you share them, back up, or use the assistant.
- Storage is per-browser: installing to the Home Screen and then using Safari
  separately gives you two separate stores. Back up before changing device.
