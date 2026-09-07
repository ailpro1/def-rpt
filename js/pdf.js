// Minimal PDF writer. Enough for this report and nothing more: pages, text in
// the base-14 fonts, rules, filled boxes and JPEG images.
//
// Why not the browser's print dialog: Safari and Chrome stamp their own header
// and footer (page URL, date, page numbers) onto printed output and there is no
// way for a page to switch that off. A report that goes to a client cannot carry
// "ailpro1.github.io/def-rpt" across the bottom. So the PDF is written here.
//
// Why no library: JPEGs go into a PDF byte-for-byte (DCTDecode), and the
// base-14 fonts need no embedding, so the whole job is a few hundred lines and
// stays offline with nothing to download.

const PT_PER_MM = 72 / 25.4;
const A4 = { w: 210, h: 297 };

/* Standard AFM widths, units per 1000 of font size. ASCII only — everything
   above 126 falls back, which is fine for report text. */
const W_HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,
  611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

const FONTS = {
  regular: { res: 'F1', base: 'Helvetica', widths: W_HELV },
  bold: { res: 'F2', base: 'Helvetica-Bold', widths: W_BOLD },
  mono: { res: 'F3', base: 'Courier-Bold', widths: null },   // Courier is 600 flat
};

/** Text width in mm. */
export function measure(text, { font = 'regular', size = 9 } = {}) {
  const f = FONTS[font] || FONTS.regular;
  let units = 0;
  for (const ch of String(text)) {
    if (!f.widths) { units += 600; continue; }
    const c = winAnsiByte(ch);
    units += (c >= 32 && c <= 126) ? f.widths[c - 32] : 556;
  }
  return (units / 1000) * size / PT_PER_MM;
}

/** Break text to a width, honouring existing newlines. */
export function wrap(text, widthMm, opts = {}) {
  const out = [];
  String(text).split('\n').forEach((para) => {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); return; }
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next, opts) <= widthMm || !line) line = next;
      else { out.push(line); line = word; }
    }
    out.push(line);
  });
  return out;
}

/* ---------- byte helpers ---------- */
/* WinAnsi puts the typographic punctuation people actually type in 0x80-0x9F,
   where Latin-1 has controls — so those need mapping rather than dropping. */
const WIN_ANSI = new Map(Object.entries({
  '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84, '\u2026': 0x85,
  '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88, '\u2030': 0x89, '\u0160': 0x8A,
  '\u2039': 0x8B, '\u0152': 0x8C, '\u017D': 0x8E, '\u2018': 0x91, '\u2019': 0x92,
  '\u201C': 0x93, '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
  '\u02DC': 0x98, '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B, '\u0153': 0x9C,
  '\u017E': 0x9E, '\u0178': 0x9F,
}).map(([ch, code]) => [ch, code]));

const winAnsiByte = (ch) => {
  const code = ch.charCodeAt(0);
  if (code < 256) return code;
  const mapped = WIN_ANSI.get(ch);
  if (mapped !== undefined) return mapped;
  return 63;                          // '?' for anything the encoding cannot carry
};

const latin1 = (str) => {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = winAnsiByte(str[i]);
  return bytes;
};
const pdfString = (str) => '(' + String(str)
  .replace(/[\\()]/g, (m) => '\\' + m)
  .replace(/[\r\n\t]/g, ' ') + ')';
const num = (n) => (Math.round(n * 1000) / 1000).toString();

/** Width, height and colour components of a baseline JPEG. */
export function jpegInfo(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint16(0) !== 0xffd8) throw new Error('Not a JPEG');
  let off = 2;
  while (off + 9 < v.byteLength) {
    if (v.getUint8(off) !== 0xff) { off++; continue; }
    const marker = v.getUint8(off + 1);
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    const size = v.getUint16(off + 2);
    // Any SOFn other than the arithmetic/lossless ones carries the dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: v.getUint16(off + 5), width: v.getUint16(off + 7), components: v.getUint8(off + 9) };
    }
    off += 2 + size;
  }
  throw new Error('Could not read JPEG size');
}

/* ---------- document ---------- */
export function createPdf({ width = A4.w, height = A4.h, title = '', author = '', subject = '' } = {}) {
  const pages = [];
  const images = [];            // { bytes, w, h, comps }
  const imageKey = new Map();   // dedupe identical bytes
  let cur = null;

  const toPt = (mm) => mm * PT_PER_MM;
  const yPt = (mm) => (height - mm) * PT_PER_MM;   // callers work top-down

  const api = {
    get pageCount() { return pages.length; },

    page() {
      cur = { ops: [], uses: new Set() };
      pages.push(cur);
      return api;
    },

    /** Filled and/or stroked rectangle. x,y = top-left, in mm. */
    rect(x, y, w, h, { fill, stroke, lineWidth = 0.2 } = {}) {
      const ops = cur.ops;
      ops.push('q');
      if (fill) ops.push(`${rgb(fill)} rg`);
      if (stroke) ops.push(`${rgb(stroke)} RG ${num(toPt(lineWidth))} w`);
      ops.push(`${num(toPt(x))} ${num(yPt(y + h))} ${num(toPt(w))} ${num(toPt(h))} re`);
      ops.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
      ops.push('Q');
      return api;
    },

    line(x1, y1, x2, y2, { color = [0, 0, 0], width = 0.35 } = {}) {
      cur.ops.push('q', `${rgb(color)} RG ${num(toPt(width))} w`,
        `${num(toPt(x1))} ${num(yPt(y1))} m ${num(toPt(x2))} ${num(yPt(y2))} l S`, 'Q');
      return api;
    },

    /** Single line of text. y is the baseline, measured from the page top. */
    text(str, x, y, { font = 'regular', size = 9, color = [0, 0, 0], align = 'left', letterSpacing = 0 } = {}) {
      const f = FONTS[font] || FONTS.regular;
      let tx = x;
      if (align !== 'left') {
        const w = measure(str, { font, size }) + letterSpacing * Math.max(0, String(str).length - 1);
        tx = align === 'right' ? x - w : x - w / 2;
      }
      cur.uses.add(f.res);
      cur.ops.push('BT', `/${f.res} ${num(size)} Tf`, `${rgb(color)} rg`,
        letterSpacing ? `${num(toPt(letterSpacing))} Tc` : '0 Tc',
        `1 0 0 1 ${num(toPt(tx))} ${num(yPt(y))} Tm`, `${pdfString(str)} Tj`, 'ET');
      return api;
    },

    /** Wrapped paragraph. Returns the height it consumed, in mm. */
    textBlock(str, x, y, w, { font = 'regular', size = 9, color = [0, 0, 0], lineHeight = 1.35, maxLines = 0 } = {}) {
      let lines = wrap(str, w, { font, size });
      if (maxLines && lines.length > maxLines) lines = lines.slice(0, maxLines);
      const step = (size / PT_PER_MM) * lineHeight;
      lines.forEach((line, i) => api.text(line, x, y + step * (i + 0.78), { font, size, color }));
      return step * lines.length;
    },

    /**
     * Place a JPEG. `fit: 'cover'` crops to fill the box (clipped), 'contain'
     * fits inside it.
     */
    image(bytes, x, y, w, h, { fit = 'cover' } = {}) {
      const key = bytes.byteLength + ':' + bytes[bytes.byteLength - 2] + ':' + bytes[3];
      let idx = imageKey.get(key);
      if (idx === undefined || images[idx].bytes.byteLength !== bytes.byteLength) {
        const info = jpegInfo(bytes);
        images.push({ bytes, w: info.width, h: info.height, comps: info.components });
        idx = images.length - 1;
        imageKey.set(key, idx);
      }
      const img = images[idx];
      const res = `Im${idx}`;
      cur.uses.add(res);

      const boxRatio = w / h;
      const imgRatio = img.w / img.h;
      let dw = w, dh = h, dx = x, dy = y;
      if (fit === 'cover') {
        if (imgRatio > boxRatio) { dh = h; dw = h * imgRatio; dx = x - (dw - w) / 2; }
        else { dw = w; dh = w / imgRatio; dy = y - (dh - h) / 2; }
      } else if (imgRatio > boxRatio) { dw = w; dh = w / imgRatio; dy = y + (h - dh) / 2; }
      else { dh = h; dw = h * imgRatio; dx = x + (w - dw) / 2; }

      cur.ops.push('q');
      // Clip to the cell so a cover-cropped photo cannot bleed into its neighbour.
      cur.ops.push(`${num(toPt(x))} ${num(yPt(y + h))} ${num(toPt(w))} ${num(toPt(h))} re W n`);
      cur.ops.push(`${num(toPt(dw))} 0 0 ${num(toPt(dh))} ${num(toPt(dx))} ${num(yPt(dy + dh))} cm`);
      cur.ops.push(`/${res} Do`, 'Q');
      return api;
    },

    build() { return assemble(); },
  };

  const rgb = (c) => Array.isArray(c)
    ? c.map((v) => num(v > 1 ? v / 255 : v)).join(' ')
    : '0 0 0';

  function assemble() {
    const chunks = [];
    let length = 0;
    const push = (data) => {
      const bytes = typeof data === 'string' ? latin1(data) : data;
      chunks.push(bytes);
      length += bytes.byteLength;
      return length;
    };

    // Object numbering: 1 catalog, 2 pages, 3 info, 4-6 fonts, then images,
    // then a content stream and a page dict for each page.
    const fontIds = { F1: 4, F2: 5, F3: 6 };
    const firstImage = 7;
    const firstPage = firstImage + images.length;
    const pageIds = pages.map((_, i) => firstPage + i * 2);
    const contentIds = pages.map((_, i) => firstPage + i * 2 + 1);

    const offsets = [];
    const obj = (id, body) => {
      offsets[id] = length;
      push(`${id} 0 obj\n`);
      push(body);
      push('\nendobj\n');
    };

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    obj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
    obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] >>`);
    const stamp = pdfDate(new Date());
    obj(3, `<< /Title ${pdfString(title)} /Author ${pdfString(author)} /Subject ${pdfString(subject)} `
      + `/Producer (Insta Report) /Creator (Insta Report) /CreationDate ${stamp} /ModDate ${stamp} >>`);

    Object.entries(FONTS).forEach(([, f]) => {
      obj(fontIds[f.res], `<< /Type /Font /Subtype /Type1 /BaseFont /${f.base} /Encoding /WinAnsiEncoding >>`);
    });

    images.forEach((img, i) => {
      const space = img.comps === 1 ? '/DeviceGray' : img.comps === 4 ? '/DeviceCMYK' : '/DeviceRGB';
      offsets[firstImage + i] = length;
      push(`${firstImage + i} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} `
        + `/ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.byteLength} >>\nstream\n`);
      push(img.bytes);
      push('\nendstream\nendobj\n');
    });

    pages.forEach((pg, i) => {
      const content = pg.ops.join('\n');
      const usedFonts = Object.entries(fontIds)
        .filter(([res]) => pg.uses.has(res))
        .map(([res, id]) => `/${res} ${id} 0 R`).join(' ');
      const usedImages = [...pg.uses].filter((r) => r.startsWith('Im'))
        .map((r) => `/${r} ${firstImage + Number(r.slice(2))} 0 R`).join(' ');
      obj(pageIds[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(width * PT_PER_MM)} ${num(height * PT_PER_MM)}] `
        + `/Resources << /Font << ${usedFonts} >> /XObject << ${usedImages} >> >> /Contents ${contentIds[i]} 0 R >>`);
      offsets[contentIds[i]] = length;
      push(`${contentIds[i]} 0 obj\n<< /Length ${latin1(content).byteLength} >>\nstream\n`);
      push(content);
      push('\nendstream\nendobj\n');
    });

    const maxId = contentIds.length ? contentIds[contentIds.length - 1] : 6;
    const xrefAt = length;
    push(`xref\n0 ${maxId + 1}\n0000000000 65535 f \n`);
    for (let id = 1; id <= maxId; id++) {
      push(`${String(offsets[id] || 0).padStart(10, '0')} 00000 n \n`);
    }
    push(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return new Blob([out], { type: 'application/pdf' });
  }

  function pdfDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    const tz = -d.getTimezoneOffset();
    const sign = tz >= 0 ? '+' : '-';
    return `(D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
      + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
      + `${sign}${p(Math.floor(Math.abs(tz) / 60))}'${p(Math.abs(tz) % 60)}')`;
  }

  return api;
}

export const PAGE = A4;
