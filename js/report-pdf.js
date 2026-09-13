// Builds the report as a real PDF, from the data rather than from the DOM, so
// the output carries nothing the browser wants to add to a printed page.
// Geometry here mirrors css/report.css — change both together.
import { createPdf, measure, wrap, PAGE } from './pdf.js';
import {
  getBlob, displayBlobId, isOkCaption, photoTakenAt, componentBlocks, defectSummary,
} from './store.js';
import { formatStamp, fmtDate } from './ui.js';

const MM = 25.4 / 72;                 // one point, in mm

const L = {
  top: 14, side: 12, bottom: 12,
  headSize: 9, footSize: 8.5, capSize: 8.2, stampSize: 5.6,
  colGap: 5, rowGap: 4,
  rule: 0.42,                         // 1.2pt
};
const contentW = PAGE.w - L.side * 2;
const headBaseline = L.top + L.headSize * MM * 0.8;
const headRule = L.top + L.headSize * MM + 1.8;
const gridTop = headRule + 4;
const footRule = PAGE.h - L.bottom - 4.5;
const footBaseline = footRule + 1.5 + L.footSize * MM * 0.8;
const gridBottom = footRule - 4;

const STAMP_SHADE = 0.22;   // timestamp plate opacity; mirrored in css/report.css and js/image.js
const GREY = [51, 51, 51];
const RULE_GREY = [153, 153, 153];

const bytesOf = async (blobId) => {
  const blob = await getBlob(blobId);
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
};

function header(doc, titleValue, groupValue) {
  const labelW = measure('Title:', { font: 'bold', size: L.headSize });
  doc.text('Title:', L.side, headBaseline, { font: 'bold', size: L.headSize });
  doc.text(titleValue.toUpperCase(), L.side + labelW + 2, headBaseline, { size: L.headSize });

  const gx = L.side + contentW * 0.5;
  const groupW = measure('Group:', { font: 'bold', size: L.headSize });
  doc.text('Group:', gx, headBaseline, { font: 'bold', size: L.headSize });
  doc.text(String(groupValue || '').toUpperCase(), gx + groupW + 2, headBaseline, { size: L.headSize });

  doc.line(L.side, headRule, PAGE.w - L.side, headRule, { width: L.rule });
}

function footer(doc, left, right) {
  doc.line(L.side, footRule, PAGE.w - L.side, footRule, { width: L.rule });
  if (left) doc.text(left, L.side, footBaseline, { size: L.footSize, color: GREY });
  if (right) doc.text(right, PAGE.w - L.side, footBaseline, { size: L.footSize, align: 'right' });
}

/**
 * @param opts { format, cover, summary, summaryTable, notes, perPage, stamp,
 *               numbering, draft }
 *   format 'captions' — a caption under every photo (the original layout)
 *   format 'table'    — numbered photos, with a LOCATION/COMPONENT/DEFECT table
 *                       at the bottom of each section
 * @returns {Promise<Blob>}
 */
export async function buildReportPdf({ project, settings, data, opts }) {
  const doc = createPdf({
    title: `${settings.reportTitle || 'DEFECT INSPECTION REPORT'} — ${project.name}`,
    author: settings.company || settings.preparedBy || '',
    subject: project.address || '',
  });
  // Footer left is whatever the user typed, nothing more: the address is
  // already in the header's Title, and once a page is enough.
  const footLeft = settings.footerText || '';
  const perSection = opts.numbering === 'section';

  // Page counts are worked out before anything is drawn, so a footer can say
  // "page 4 of 17" on the page where it is printed.
  const tableFormat = opts.format === 'table';

  // Work out the body pages for whichever layout is in play.
  const plan = tableFormat ? planTableFormat(data, opts.perPage) : null;

  const sectionPages = tableFormat
    ? plan.map((blocks) => blocks.reduce((n, b) => n + b.pages.length, 0))
    : data.map((d) => captionPageCount(d.photos, opts.perPage));
  const totalPages = (opts.cover ? 1 : 0)
    + (opts.summary ? 1 : 0)
    + (opts.notes && settings.notesBody ? 1 : 0)
    + sectionPages.reduce((a, b) => a + b, 0);
  let pageNo = 0;
  const nextPage = () => { doc.page(); return ++pageNo; };

  /* ---------- cover ---------- */
  if (opts.cover) {
    nextPage();
    let y = L.top + 6;
    if (settings.logoBlobId) {
      const logo = await bytesOf(settings.logoBlobId);
      if (logo) { doc.image(logo, L.side, y, 60, 26, { fit: 'contain' }); y += 32; }
    }
    y += 6;
    doc.text(settings.coverKicker || 'INSPECTION REPORT', L.side, y, { size: 10, color: [85, 85, 85], letterSpacing: 0.5 });
    y += 9;
    const titleLines = wrap(settings.reportTitle || 'DEFECT INSPECTION REPORT', contentW, { font: 'bold', size: 26 });
    titleLines.forEach((line) => { doc.text(line, L.side, y + 8, { font: 'bold', size: 26 }); y += 26 * MM * 1.12; });
    y += 4;
    doc.rect(L.side, y, 38, 0.85, { fill: [0, 0, 0] });
    y += 10;
    [project.name, project.address].filter(Boolean).forEach((line) => {
      y += doc.textBlock(line, L.side, y, contentW, { size: 12, color: GREY, lineHeight: 1.35 });
    });

    const coverBody = project.coverOverride || settings.coverBody;
    if (coverBody) { y += 8; doc.textBlock(coverBody, L.side, y, contentW, { size: 10, lineHeight: 1.5 }); }

    // Metadata sits on the lower part of the page, like the screen version.
    const rows = [
      ['Client', project.client],
      ['Reference', project.ref],
      ['Unit type', project.unitType],
      ['Inspection date', fmtDate(project.inspectionDate)],
      ['Inspected by', project.inspector || settings.preparedBy],
      ['Prepared by', settings.company],
      ['Contact', settings.contact],
    ].filter(([, v]) => v);
    let my = PAGE.h - L.bottom - 10 - rows.length * 8;
    rows.forEach(([k, v]) => {
      doc.line(L.side, my, PAGE.w - L.side, my, { width: 0.18, color: [187, 187, 187] });
      doc.text(k.toUpperCase(), L.side, my + 5.4, { font: 'bold', size: 8.5, letterSpacing: 0.15 });
      doc.textBlock(v, L.side + 34, my + 4.2, contentW - 34, { size: 10, maxLines: 2 });
      my += 8;
    });
    if (opts.draft) draftMark(doc);
  }

  /* ---------- executive summary ---------- */
  if (opts.summary) {
    nextPage();
    header(doc, project.name, settings.summaryTitle || 'EXECUTIVE SUMMARY');
    let y = gridTop;
    y += doc.textBlock(project.summaryOverride || settings.summaryBody || '', L.side, y, contentW,
      { size: 10, lineHeight: 1.5 });

    if (opts.summaryTable && data.length) {
      y += 8;
      const cols = [contentW - 44, 22, 22];
      const head = ['Location', 'Photos', 'Items'];
      const rows = data.map((d) => [
        d.section.title,
        String(d.photos.length),
        String(d.photos.filter((p) => p.caption && !isOkCaption(p.caption)).length),
      ]);
      rows.push(['Total',
        String(data.reduce((n, d) => n + d.photos.length, 0)),
        String(data.reduce((n, d) => n + d.photos.filter((p) => p.caption && !isOkCaption(p.caption)).length, 0))]);

      const rowH = 6.4;
      doc.rect(L.side, y, contentW, rowH, { fill: [238, 238, 238], stroke: RULE_GREY, lineWidth: 0.18 });
      let cx = L.side;
      head.forEach((h, i) => {
        doc.text(h.toUpperCase(), i === 0 ? cx + 2 : cx + cols[i] - 2, y + 4.4,
          { font: 'bold', size: 8.5, align: i === 0 ? 'left' : 'right', letterSpacing: 0.1 });
        cx += cols[i];
      });
      y += rowH;
      rows.forEach((r, ri) => {
        const last = ri === rows.length - 1;
        doc.rect(L.side, y, contentW, rowH, { stroke: RULE_GREY, lineWidth: 0.18 });
        cx = L.side;
        r.forEach((cell, i) => {
          doc.text(cell, i === 0 ? cx + 2 : cx + cols[i] - 2, y + 4.4,
            { size: 9, font: last ? 'bold' : 'regular', align: i === 0 ? 'left' : 'right' });
          cx += cols[i];
        });
        y += rowH;
      });
    }
    footer(doc, footLeft, perSection ? '' : `page ${pageNo} of ${totalPages}`);
    if (opts.draft) draftMark(doc);
  }

  /* ---------- notes ---------- */
  if (opts.notes && settings.notesBody) {
    nextPage();
    header(doc, project.name, settings.notesTitle || 'NOTES & LIMITATIONS');
    doc.textBlock(settings.notesBody, L.side, gridTop, contentW, { size: 10, lineHeight: 1.5 });
    footer(doc, footLeft, perSection ? '' : `page ${pageNo} of ${totalPages}`);
    if (opts.draft) draftMark(doc);
  }

  /* ---------- photo pages: defect-table format ---------- */
  if (tableFormat) {
    for (let si = 0; si < data.length; si++) {
      const d = data[si];
      const blocks = plan[si];
      let first = true;
      for (let bi = 0; bi < blocks.length; bi++) {
        const b = blocks[bi];
        for (let pi = 0; pi < b.pages.length; pi++) {
          const [from, to] = b.pages[pi];
          nextPage();
          header(doc, project.name, d.section.title);

          let y = gridTop;
          if (first) {
            // Wrapped, not a single line: a long section or component name would
            // otherwise run off the right edge of the page.
            y += doc.textBlock(d.section.title.toUpperCase(), L.side, y, contentW,
              { font: 'bold', size: T.sectionHeadSize, lineHeight: 1.2, maxLines: 2 }) + 1.5;
            first = false;
          }
          // A single unnamed block would only repeat the section heading.
          const showBlockHead = b.component || blocks.length > 1;
          if (pi === 0 && showBlockHead) {
            const label = b.component
              ? `${bi + 1}.0 ${d.section.title.toUpperCase()} (${b.component})`
              : `${bi + 1}.0 ${d.section.title.toUpperCase()}`;
            y += doc.textBlock(label, L.side, y, contentW,
              { font: 'bold', size: T.blockHeadSize, lineHeight: 1.2, maxLines: 2 }) + 2;
          }

          for (let i = from; i < to; i++) {
            const photo = b.photos[i];
            const slot = i - from;
            const cx = L.side + (slot % 2) * (T.numCol + photoW + T.colGap);
            const cy = y + Math.floor(slot / 2) * photoRowH;
            // The number replaces a caption: the defect table refers to it.
            doc.text(String(i + 1), cx + T.numCol / 2, cy + 4.5, { size: 9, align: 'center' });
            const jpeg = await bytesOf(displayBlobId(photo));
            if (jpeg) {
              doc.image(jpeg, cx + T.numCol, cy, photoW, photoH, { fit: 'cover' });
              if (opts.stamp) {
                const text = formatStamp(photoTakenAt(photo), settings.stampFormat);
                if (text) stamp(doc, text, cx + T.numCol, cy, photoW, photoH, settings.stampPosition || 'br');
              }
            } else {
              doc.rect(cx + T.numCol, cy, photoW, photoH, { fill: [238, 238, 238] });
            }
          }

          // The table closes the block, pinned to the bottom of its last page.
          if (pi === b.pages.length - 1) {
            defectTable(doc, L.side, gridBottom - b.tableH,
              d.section.title, b.component, b.defect);
          }

          footer(doc, footLeft, perSection
            ? `page ${pi + 1} of ${b.pages.length}`
            : `page ${pageNo} of ${totalPages}`);
          if (opts.draft) draftMark(doc);
        }
      }
    }
    return doc.build();
  }

  /* ---------- photo pages: caption format ---------- */
  // Components head their block here too; the band is reserved on every page so
  // photos stay the same size whether or not a heading is printed above them.
  const anyComponent = data.some((d) => d.photos.some((p) => p.component));
  const headBand = photoHeadBand(anyComponent);
  const { cols, colW, rowH, gridStart } = gridMetrics(opts.perPage, headBand);

  for (const d of data) {
    const blocks = componentBlocks(d.photos);
    const chunks = [];
    blocks.forEach((b, bi) => {
      for (let i = 0; i < b.photos.length; i += opts.perPage) {
        chunks.push({ photos: b.photos.slice(i, i + opts.perPage), block: b, bi, first: i === 0 });
      }
      if (!b.photos.length) chunks.push({ photos: [], block: b, bi, first: true });
    });
    if (!chunks.length) chunks.push({ photos: [], block: { component: '' }, bi: 0, first: true });

    for (let c = 0; c < chunks.length; c++) {
      nextPage();
      header(doc, project.name, d.section.title);

      // The caption band is sized to the longest caption on THIS page, so a
      // three-line note is printed in full instead of being cut at two. Every
      // photo on the page still gets the same box.
      const capLines = captionLines(chunks[c].photos, opts.perPage, headBand);
      const capH = capLines ? CAP_LINE * capLines + CAP_GAP : 0;
      const imgH = rowH - capH;

      const b = chunks[c].block;
      if (chunks[c].first && (b.component || blocks.length > 1)) {
        const label = b.component
          ? `${chunks[c].bi + 1}.0 ${d.section.title.toUpperCase()} (${b.component})`
          : `${chunks[c].bi + 1}.0 ${d.section.title.toUpperCase()}`;
        doc.textBlock(label, L.side, gridTop, contentW,
          { font: 'bold', size: T.blockHeadSize, lineHeight: 1.2, maxLines: 2 });
      }

      for (let i = 0; i < chunks[c].photos.length; i++) {
        const photo = chunks[c].photos[i];
        const cx = L.side + (i % cols) * (colW + L.colGap);
        const cy = gridStart + Math.floor(i / cols) * (rowH + L.rowGap);

        const jpeg = await bytesOf(displayBlobId(photo));
        if (jpeg) {
          doc.image(jpeg, cx, cy, colW, imgH, { fit: 'cover' });
          if (opts.stamp) {
            const text = formatStamp(photoTakenAt(photo), settings.stampFormat);
            if (text) stamp(doc, text, cx, cy, colW, imgH, settings.stampPosition || 'br');
          }
        } else {
          doc.rect(cx, cy, colW, imgH, { fill: [238, 238, 238] });
        }

        const caption = [photo.caption, photo.caption2].filter(Boolean).join('\n');
        if (caption) {
          doc.textBlock(caption.toUpperCase(), cx, cy + imgH + CAP_GAP, colW,
            { size: L.capSize, lineHeight: 1.28, maxLines: capLines });
        }
      }

      footer(doc, footLeft, perSection
        ? `page ${c + 1} of ${chunks.length}`
        : `page ${pageNo} of ${totalPages}`);
      if (opts.draft) draftMark(doc);
    }
  }

  return doc.build();
}

/* ------------------------- defect-table format ------------------------- */
/* Photos run two to a row with a number beside each, and each COMPONENT block
   closes with a LOCATION / COMPONENT / DEFECT table pinned to the bottom of its
   last page. Header and footer are unchanged from the caption format. */

const T = {
  numCol: 8,            // the narrow column carrying the picture number
  colGap: 4,
  rowGap: 4,
  tableFont: 8,
  cellPadX: 2,
  cellPadY: 1.6,
  // 0.5pt hairlines all but disappear at phone zoom, so the grid is drawn at 1pt.
  tableRule: 0.35,
  sectionHeadSize: 14,
  blockHeadSize: 11,
};
// Full content width: LOCATION | value | COMPONENT | value
const T_COLS = [24, 66, 30, 66];

const photoW = (contentW - (T.numCol + T.colGap) * 2 + T.colGap) / 2;
const photoH = photoW / (4 / 3);
const photoRowH = photoH + T.rowGap;

const lineH = (size) => size * MM * 1.25;

/** Height the defect table will need, so space can be reserved for it. */
function tableHeight(doc, location, component, defect) {
  const spanW = T_COLS[1] + T_COLS[2] + T_COLS[3] - T.cellPadX * 2;
  const row1 = Math.max(
    lineH(T.tableFont),
    ...[[location, T_COLS[1]], [component, T_COLS[3]]].map(([v, w]) =>
      wrap(v || '-', w - T.cellPadX * 2, { size: T.tableFont }).length * lineH(T.tableFont)),
  ) + T.cellPadY * 2;
  const row2 = wrap(defect || '-', spanW, { size: T.tableFont }).length * lineH(T.tableFont) + T.cellPadY * 2;
  void doc;
  return row1 + row2;
}

function defectTable(doc, x, y, location, component, defect) {
  const f = T.tableFont;
  const spanW = T_COLS[1] + T_COLS[2] + T_COLS[3];
  const cell = (cx, cy, w, h, text, bold) => {
    doc.rect(cx, cy, w, h, { stroke: [0, 0, 0], lineWidth: T.tableRule });
    doc.textBlock(text || '', cx + T.cellPadX, cy + T.cellPadY, w - T.cellPadX * 2,
      { size: f, font: bold ? 'bold' : 'regular', lineHeight: 1.25 });
  };

  const h1 = Math.max(
    lineH(f),
    ...[[location, T_COLS[1]], [component, T_COLS[3]]].map(([v, w]) =>
      wrap(v || '-', w - T.cellPadX * 2, { size: f }).length * lineH(f)),
  ) + T.cellPadY * 2;
  const h2 = wrap(defect || '-', spanW - T.cellPadX * 2, { size: f }).length * lineH(f) + T.cellPadY * 2;

  let cx = x;
  cell(cx, y, T_COLS[0], h1, 'LOCATION', true); cx += T_COLS[0];
  cell(cx, y, T_COLS[1], h1, location || '-'); cx += T_COLS[1];
  cell(cx, y, T_COLS[2], h1, 'COMPONENT', true); cx += T_COLS[2];
  cell(cx, y, T_COLS[3], h1, component || '');

  cell(x, y + h1, T_COLS[0], h2, 'DEFECT', true);
  cell(x + T_COLS[0], y + h1, spanW, h2, defect || '-');
  return h1 + h2;
}

/**
 * The page plan for the defect-table format. Exported so the on-screen preview
 * paginates identically to the PDF — the table's height decides how many photos
 * fit on a block's last page, and that is not something the preview can guess.
 */
const CAP_LINE = L.capSize * MM * 1.28;   // one caption line
const CAP_GAP = 1.4;                      // photo to caption

/** Room a component heading takes above the grid, or 0 when none is printed. */
export function photoHeadBand(anyComponent) {
  return anyComponent ? lineH(T.blockHeadSize) * 2 + 2 : 0;
}

/** The caption-format grid, shared with the on-screen preview. */
export function gridMetrics(perPage, headBand = 0) {
  const cols = perPage <= 2 ? 1 : 2;
  const rows = Math.ceil(perPage / cols);
  const colW = (contentW - L.colGap * (cols - 1)) / cols;
  const gridStart = gridTop + headBand;
  const rowH = (gridBottom - gridStart - L.rowGap * (rows - 1)) / rows;
  return { cols, rows, colW, rowH, gridStart };
}

/**
 * Caption lines to allow on one page: the longest caption on it, so nothing is
 * cut. Capped so the band cannot take more than 45% of the row — past that the
 * photo, which is the point of the page, would be too small to read.
 */
export function captionLines(photos, perPage, headBand = 0) {
  const { colW, rowH } = gridMetrics(perPage, headBand);
  let n = 0;
  for (const p of photos) {
    const caption = [p.caption, p.caption2].filter(Boolean).join('\n');
    if (!caption) continue;
    n = Math.max(n, wrap(caption.toUpperCase(), colW, { size: L.capSize }).length);
  }
  if (!n) return 0;
  // Two lines minimum, so a page of short captions looks exactly as it always
  // has and photo size only changes where a caption actually needs the room.
  const room = Math.max(2, Math.floor((rowH * 0.45 - CAP_GAP) / CAP_LINE));
  return Math.min(Math.max(n, 2), room);
}

/** Pages a section needs in the caption format, now that blocks start a page. */
export function captionPageCount(photos, perPage) {
  const blocks = componentBlocks(photos);
  if (!blocks.length) return 1;
  return blocks.reduce((n, b) => n + Math.max(1, Math.ceil(b.photos.length / perPage)), 0);
}

export function planTableFormat(data, perPage) {
  return data.map((d) => componentBlocks(d.photos).map((b) => {
    const defect = defectSummary(b.photos);
    const tableH = tableHeight(null, d.section.title, b.component, defect);
    return { ...b, defect, tableH, pages: paginateBlock(b.photos.length, perPage, tableH) };
  }));
}

/**
 * Split a block's photos across pages, leaving room on the final page for the
 * defect table so it can sit at the bottom of the section.
 */
function paginateBlock(count, perPage, tableH) {
  const cols = 2;
  // Allow for the section and block headings above the photos, either of which
  // can wrap to a second line.
  const headRoom = lineH(T.sectionHeadSize) * 2 + lineH(T.blockHeadSize) * 2 + 4;
  const fullRows = Math.max(1, Math.floor((gridBottom - gridTop - headRoom) / photoRowH));
  const perFull = Math.min(perPage, fullRows * cols);
  const lastRows = Math.max(0, Math.floor((gridBottom - gridTop - headRoom - tableH - 4) / photoRowH));
  const perLast = Math.max(cols, lastRows * cols);

  const pages = [];
  let i = 0;
  if (count === 0) return [[0, 0]];
  while (i < count) {
    const remaining = count - i;
    if (remaining <= perLast) { pages.push([i, count]); break; }
    // Never leave a tail so large that the table would sit on top of a photo.
    let take = perFull;
    if (remaining - take === 0) take = Math.max(cols, perFull - cols);
    pages.push([i, i + take]);
    i += take;
  }
  return pages;
}

/** Camera-style capture time, inside the photo. */
function stamp(doc, text, x, y, w, h, position) {
  const size = L.stampSize;
  const padX = 1, padY = 0.7;
  const tw = measure(text, { font: 'mono', size });
  const boxW = tw + padX * 2;
  const boxH = size * MM + padY * 2;
  const bx = position.endsWith('l') ? x + 1.2 : x + w - 1.2 - boxW;
  const by = position.startsWith('t') ? y + 1.2 : y + h - 1.2 - boxH;
  // Barely-there plate. The white text is the timestamp; the plate only stops
  // it disappearing on a pale wall, so it stays close to clear and a dark ghost
  // a hair behind the text does the rest of the work.
  doc.rect(bx, by, boxW, boxH, { fill: [0, 0, 0], opacity: STAMP_SHADE });
  const tx = bx + padX;
  const ty = by + padY + size * MM * 0.78;
  doc.text(text, tx + 0.12, ty + 0.12, { font: 'mono', size, color: [0, 0, 0] });
  doc.text(text, tx, ty, { font: 'mono', size, color: [255, 255, 255] });
}

/** Diagonal DRAFT marking, for anything not being issued. */
function draftMark(doc) {
  const text = 'DRAFT — NOT FOR ISSUE';
  doc.text(text, PAGE.w / 2, PAGE.h / 2, { font: 'bold', size: 30, color: [225, 225, 225], align: 'center' });
}

export function reportFilename(project) {
  const clean = (s) => String(s || '').replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim();
  const date = (project.inspectionDate || new Date().toISOString().slice(0, 10));
  const parts = [clean(project.ref), clean(project.name) || 'Inspection Report', date].filter(Boolean);
  return `${parts.join(' - ')}.pdf`;
}
