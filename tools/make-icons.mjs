// Generates the PWA icons with no external dependencies.
// Run: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function draw(size, { maskable = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const R = maskable ? size : size * 0.222;          // corner radius
  const inset = maskable ? size * 0.1 : 0;           // safe area for maskable
  const top = [0, 122, 255], bot = [88, 86, 214];

  const put = (x, y, [r, g, b], a = 255) => {
    const i = (y * size + x) * 4;
    const sa = a / 255, da = buf[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / oa);
    buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
    buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
    buf[i + 3] = Math.round(oa * 255);
  };

  const inRounded = (x, y, x0, y0, w, h, r) => {
    const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
    const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
    if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 0.5;
  };

  // background
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRounded(x + .5, y + .5, 0, 0, size, size, R)) continue;
      put(x, y, mix(top, bot, y / size));
    }
  }

  // white report page
  const pw = size * 0.46, ph = size * 0.58;
  const px = (size - pw) / 2, py = (size - ph) / 2 + inset * 0.05;
  const pr = size * 0.045;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inRounded(x + .5, y + .5, px, py, pw, ph, pr)) put(x, y, [255, 255, 255]);
    }
  }

  // photo block
  const iw = pw * 0.74, ih = ph * 0.36;
  const ix = px + (pw - iw) / 2, iy = py + ph * 0.09;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inRounded(x + .5, y + .5, ix, iy, iw, ih, size * 0.016)) {
        put(x, y, mix([255, 149, 0], [255, 59, 48], (x - ix) / iw));
      }
    }
  }

  // caption lines
  const lines = [0.54, 0.65, 0.76];
  lines.forEach((f, i) => {
    const lw = iw * (i === 2 ? 0.6 : 1);
    const lx = ix, ly = py + ph * f, lh = ph * 0.055;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (inRounded(x + .5, y + .5, lx, ly, lw, lh, lh / 2)) put(x, y, [174, 174, 178]);
      }
    }
  });

  return png(size, size, buf);
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
const out = (name, buf) => writeFileSync(new URL('../icons/' + name, import.meta.url), buf);
out('icon-192.png', draw(192));
out('icon-512.png', draw(512));
out('icon-180.png', draw(180));
out('icon-maskable-512.png', draw(512, { maskable: true }));
console.log('icons written');
