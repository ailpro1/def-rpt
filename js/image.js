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
  return { blob, thumb, meta: { w: big.w, h: big.h, srcW: sw, srcH: sh, size: blob.size, ts: Date.now() } };
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
