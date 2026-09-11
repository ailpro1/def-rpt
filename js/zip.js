// Minimal ZIP writer, stored (uncompressed) entries only.
// A .docx is a ZIP of XML parts, and the photos inside it are already JPEG, so
// there is nothing worth deflating — which keeps this to a CRC and two headers.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const utf8 = (str) => new TextEncoder().encode(str);

/** MS-DOS date/time, as ZIP has stored it since 1989. */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function createZip() {
  const entries = [];
  return {
    /** @param data string | Uint8Array */
    add(name, data) {
      entries.push({ name, bytes: typeof data === 'string' ? utf8(data) : data });
      return this;
    },
    build(mime = 'application/zip') {
      const stamp = dosStamp(new Date());
      const parts = [];
      const central = [];
      let offset = 0;

      for (const entry of entries) {
        const nameBytes = utf8(entry.name);
        const crc = crc32(entry.bytes);
        const size = entry.bytes.length;

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);            // version needed
        local.setUint16(6, 0x0800, true);        // UTF-8 names
        local.setUint16(8, 0, true);             // stored
        local.setUint16(10, stamp.time, true);
        local.setUint16(12, stamp.date, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, size, true);
        local.setUint32(22, size, true);
        local.setUint16(26, nameBytes.length, true);
        local.setUint16(28, 0, true);
        parts.push(new Uint8Array(local.buffer), nameBytes, entry.bytes);

        const dir = new DataView(new ArrayBuffer(46));
        dir.setUint32(0, 0x02014b50, true);
        dir.setUint16(4, 20, true);
        dir.setUint16(6, 20, true);
        dir.setUint16(8, 0x0800, true);
        dir.setUint16(10, 0, true);
        dir.setUint16(12, stamp.time, true);
        dir.setUint16(14, stamp.date, true);
        dir.setUint32(16, crc, true);
        dir.setUint32(20, size, true);
        dir.setUint32(24, size, true);
        dir.setUint16(28, nameBytes.length, true);
        dir.setUint32(42, offset, true);
        central.push(new Uint8Array(dir.buffer), nameBytes);

        offset += 30 + nameBytes.length + size;
      }

      const centralSize = central.reduce((n, p) => n + p.length, 0);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(8, entries.length, true);
      end.setUint16(10, entries.length, true);
      end.setUint32(12, centralSize, true);
      end.setUint32(16, offset, true);

      return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: mime });
    },
  };
}
