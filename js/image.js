// Image pipeline: decode -> downscale -> JPEG. Runs entirely on-device so
// capture stays fast and works offline.

const canvasOf = (w, h) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
};

export async function decode(source) {
  // imageOrientation honours EXIF so portrait phone shots are not sideways.
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(source, { imageOrientation: 'from-image' }); }
    catch { /* Safari <16.4 lacks the option — fall through */ }
    try { return await createImageBitmap(source); } catch { /* fall through */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(source);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

/* ------------------------- capture time ------------------------- */

/**
 * When the photo was actually taken. EXIF DateTimeOriginal is the truth when it
 * is there; a file's lastModified is next best (iOS sets it from the capture);
 * import time is the last resort.
 */
export async function readTakenAt(file) {
  let ts = null;
  try { ts = await exifDate(file); } catch { /* unreadable EXIF is not an error */ }
  if (ts) return { takenAt: ts, takenSource: 'exif' };
  const lm = file && file.lastModified;
  // Ignore obviously wrong clocks (pre-2000, or in the future).
  if (lm && lm > 946684800000 && lm <= Date.now() + 864e5) return { takenAt: lm, takenSource: 'file' };
  return { takenAt: Date.now(), takenSource: 'now' };
}

async function exifDate(file) {
  if (!file || !file.slice) return null;
  const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;   // not a JPEG

  let off = 2;
  while (off + 4 <= v.byteLength) {
    if (v.getUint8(off) !== 0xff) break;
    const marker = v.getUint8(off + 1);
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
    if (marker === 0xda) break;                                     // start of scan
    const size = v.getUint16(off + 2);
    if (size < 2) break;
    if (marker === 0xe1 && off + 10 <= v.byteLength
        && v.getUint32(off + 4) === 0x45786966 && v.getUint16(off + 8) === 0) {  // "Exif\0\0"
      const found = tiffDate(v, off + 10);
      if (found) return found;
    }
    off += 2 + size;
  }
  return null;
}

function tiffDate(v, base) {
  if (base + 8 > v.byteLength) return null;
  const le = v.getUint16(base) === 0x4949;
  if (v.getUint16(base + 2, le) !== 0x2a) return null;

  const ifd = (at) => {
    const map = new Map();
    if (at + 2 > v.byteLength) return map;
    const n = v.getUint16(at, le);
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > v.byteLength) break;
      map.set(v.getUint16(e, le), { type: v.getUint16(e + 2, le), count: v.getUint32(e + 4, le), at: e + 8 });
    }
    return map;
  };
  const ascii = (ent) => {
    if (!ent || ent.type !== 2 || ent.count < 19) return null;
    const p = ent.count > 4 ? base + v.getUint32(ent.at, le) : ent.at;
    let out = '';
    for (let k = 0; k < 19; k++) {
      if (p + k >= v.byteLength) return null;
      out += String.fromCharCode(v.getUint8(p + k));
    }
    return out;
  };

  const ifd0 = ifd(base + v.getUint32(base + 4, le));
  let text = null;
  const ptr = ifd0.get(0x8769);                        // ExifIFD
  if (ptr) {
    const sub = ifd(base + v.getUint32(ptr.at, le));
    text = ascii(sub.get(0x9003)) || ascii(sub.get(0x9004));   // DateTimeOriginal, DateTimeDigitized
  }
  if (!text) text = ascii(ifd0.get(0x0132));           // DateTime

  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text || '');
  if (!m) return null;
  const ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isNaN(ts) ? null : ts;
}

export function toBlob(canvas, type = 'image/jpeg', quality = 0.82) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export function fit(w, h, max) {
  if (w <= max && h <= max) return { w, h };
  const r = w > h ? max / w : max / h;
  return { w: Math.round(w * r), h: Math.round(h * r) };
}

/** Downscale a captured/uploaded file to a report-sized JPEG + a grid thumb. */
export async function ingest(file, { maxPx = 1600, quality = 0.82, thumbPx = 320 } = {}) {
  const when = await readTakenAt(file);
  const bmp = await decode(file);
  const sw = bmp.width, sh = bmp.height;

  const big = fit(sw, sh, maxPx);
  const c1 = canvasOf(big.w, big.h);
  const x1 = c1.getContext('2d');
  x1.imageSmoothingQuality = 'high';
  x1.drawImage(bmp, 0, 0, big.w, big.h);
  const blob = await toBlob(c1, 'image/jpeg', quality);

  const small = fit(sw, sh, thumbPx);
  const c2 = canvasOf(small.w, small.h);
  const x2 = c2.getContext('2d');
  x2.imageSmoothingQuality = 'medium';
  x2.drawImage(bmp, 0, 0, small.w, small.h);
  const thumb = await toBlob(c2, 'image/jpeg', 0.7);

  if (bmp.close) bmp.close();
  return {
    blob, thumb,
    meta: {
      w: big.w, h: big.h, srcW: sw, srcH: sh, size: blob.size, ts: Date.now(),
      takenAt: when.takenAt, takenSource: when.takenSource,
    },
  };
}

/**
 * Small copy for the assistant. Gemini bills images in 768x768 tiles, so a photo
 * that fits inside one tile costs about a quarter of what the 1600px report copy
 * costs, with no useful loss for four-word captions.
 */
export async function aiCopy(blob, maxPx = 768, quality = 0.72) {
  const bmp = await decode(blob);
  const { w, h } = fit(bmp.width, bmp.height, maxPx);
  const c = canvasOf(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  return toBlob(c, 'image/jpeg', quality);
}

/** Burn annotation ops into a new JPEG (used for report + share). */
export async function flatten(srcBlob, ops, { maxPx = 1600, quality = 0.85 } = {}) {
  const bmp = await decode(srcBlob);
  const { w, h } = fit(bmp.width, bmp.height, maxPx);
  const c = canvasOf(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  drawOps(ctx, ops, w, h);
  if (bmp.close) bmp.close();
  return toBlob(c, 'image/jpeg', quality);
}

/** Render vector annotation ops. Coordinates are normalised 0..1. */
export function drawOps(ctx, ops, w, h) {
  const base = Math.max(w, h);
  (ops || []).forEach((op) => {
    const lw = Math.max(2, (op.width || 0.006) * base);
    ctx.save();
    ctx.strokeStyle = op.color || '#ff3b30';
    ctx.fillStyle = op.color || '#ff3b30';
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = lw * 0.9;
    const P = (p) => [p[0] * w, p[1] * h];

    if (op.type === 'ellipse' && op.points.length >= 2) {
      const [x0, y0] = P(op.points[0]);
      const [x1, y1] = P(op.points[1]);
      ctx.beginPath();
      ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (op.type === 'rect' && op.points.length >= 2) {
      const [x0, y0] = P(op.points[0]);
      const [x1, y1] = P(op.points[1]);
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    } else if (op.type === 'line' && op.points.length >= 2) {
      const [x0, y0] = P(op.points[0]);
      const [x1, y1] = P(op.points[1]);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    } else if (op.type === 'arrow' && op.points.length >= 2) {
      const [x0, y0] = P(op.points[0]);
      const [x1, y1] = P(op.points[1]);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const head = lw * 4;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - head * Math.cos(ang - Math.PI / 7), y1 - head * Math.sin(ang - Math.PI / 7));
      ctx.lineTo(x1 - head * Math.cos(ang + Math.PI / 7), y1 - head * Math.sin(ang + Math.PI / 7));
      ctx.closePath(); ctx.fill();
    } else if (op.type === 'free' && op.points.length > 1) {
      ctx.beginPath();
      op.points.forEach((p, i) => {
        const [x, y] = P(p);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    } else if (op.type === 'dot' && op.points.length) {
      const [x, y] = P(op.points[0]);
      ctx.beginPath(); ctx.arc(x, y, lw * 1.6, 0, Math.PI * 2); ctx.fill();
    } else if (op.type === 'text' && op.points.length && op.text) {
      const size = Math.max(12, (op.size || 0.045) * base);
      const [x, y] = P(op.points[0]);
      ctx.font = `700 ${size}px -apple-system, "SF Pro Text", Helvetica, Arial, sans-serif`;
      ctx.textBaseline = 'top';
      const lines = String(op.text).split('\n');
      const pad = size * 0.28;
      const wMax = Math.max(...lines.map((l) => ctx.measureText(l).width));
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(x - pad, y - pad, wMax + pad * 2, lines.length * size * 1.18 + pad * 2);
      ctx.fillStyle = op.color || '#ffcc00';
      lines.forEach((l, i) => ctx.fillText(l, x, y + i * size * 1.18));
    }
    ctx.restore();
  });
}

const urlCache = new Map();
export function blobUrl(id, blob) {
  if (!blob) return '';
  if (urlCache.has(id)) return urlCache.get(id);
  const u = URL.createObjectURL(blob);
  urlCache.set(id, u);
  return u;
}
export function revokeUrl(id) {
  if (urlCache.has(id)) { URL.revokeObjectURL(urlCache.get(id)); urlCache.delete(id); }
}
export function revokeAll() {
  urlCache.forEach((u) => URL.revokeObjectURL(u));
  urlCache.clear();
}

/* ------------------------- timestamp stamp ------------------------- */

/** Camera-style stamp, drawn in image pixels so it scales with the photo. */
export function drawStamp(ctx, text, w, h, position = 'br') {
  if (!text) return;
  const size = Math.max(11, Math.round(Math.min(w, h) * 0.032));
  const pad = Math.round(size * 0.45);
  ctx.save();
  ctx.font = `600 ${size}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  ctx.textBaseline = 'alphabetic';
  const tw = ctx.measureText(text).width;
  const left = position.endsWith('l');
  const top = position.startsWith('t');
  const x = left ? pad * 2 : w - pad * 2 - tw;
  const y = top ? pad * 2 + size : h - pad * 2;
  ctx.fillStyle = 'rgba(0,0,0,.22)';   // matches the report's plate
  ctx.fillRect(x - pad, y - size, tw + pad * 2, size + pad * 1.4);
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,.85)';
  ctx.shadowBlur = size * 0.35;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * A one-off copy with annotations and a timestamp burned in, for sharing a
 * photo outside the app. Nothing stored changes — the report draws its own
 * stamp, so burning it here would double up.
 */
export async function stampedCopy(blob, text, { position = 'br', ops = null, maxPx = 1600, quality = 0.85 } = {}) {
  const bmp = await decode(blob);
  const { w, h } = fit(bmp.width, bmp.height, maxPx);
  const c = canvasOf(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  if (ops && ops.length) drawOps(ctx, ops, w, h);
  drawStamp(ctx, text, w, h, position);
  if (bmp.close) bmp.close();
  return toBlob(c, 'image/jpeg', quality);
}
