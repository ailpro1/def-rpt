// Enough of the Workers runtime to exercise the real code in plain Node: a KV
// namespace that behaves like the real one (string values, prefix list, cursor)
// and a Telegram that records what the bot said instead of sending it.

export class FakeKV {
  constructor() { this.map = new Map(); this.writes = 0; this.reads = 0; }

  async get(key) { this.reads++; return this.map.has(key) ? this.map.get(key) : null; }

  async put(key, value) { this.writes++; this.map.set(key, String(value)); }

  async delete(key) { this.map.delete(key); }

  // The real list() pages; page it here too so the caller's cursor loop is
  // actually exercised rather than trivially satisfied.
  async list({ prefix = '', cursor, limit = 3 } = {}) {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = keys.slice(start, start + limit);
    const end = start + slice.length;
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: end >= keys.length,
      cursor: String(end),
    };
  }
}

/** Collects every Bot API call so a test can assert on what the site team sees. */
export function fakeTelegram() {
  const sent = [];
  const files = new Map();      // file_id -> bytes
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = u.split('/').pop();

    if (u.includes('/file/bot')) {
      const id = u.split('/').pop();
      const bytes = files.get(id) || new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });
    }

    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    sent.push({ method, body, form: init.body instanceof FormData ? init.body : null });

    if (method === 'getFile') return json({ ok: true, result: { file_path: `photos/${body.file_id}` } });
    return json({ ok: true, result: { message_id: sent.length } });
  };
  const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  return { sent, files, fetchImpl, texts: () => sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.text) };
}

export function makeEnv(kv, extra = {}) {
  return {
    BATCHES: kv,
    TG_TOKEN: 'test-token',
    TG_WEBHOOK_SECRET: 'shh',
    ALLOWED_CHATS: '-100123',
    CAPTION_PX: '768',
    ...extra,
  };
}

export const ctx = { waitUntil: (p) => p };

/* ---- synthetic Telegram updates ---- */

let nextId = 1000;

export const cmd = (text, chatId = -100123) => ({
  message: { message_id: nextId++, date: 1789000000, chat: { id: chatId }, text },
});

export const photo = ({ caption = '', chatId = -100123, group = '', date = 1789000000, id } = {}) => ({
  message: {
    message_id: id || nextId++,
    date,
    chat: { id: chatId },
    ...(caption ? { caption } : {}),
    ...(group ? { media_group_id: group } : {}),
    photo: [
      { file_id: `f${nextId}_s`, width: 320, height: 240 },
      { file_id: `f${nextId}_m`, width: 800, height: 600 },
      { file_id: `f${nextId}_l`, width: 1280, height: 960 },
    ],
  },
});

export const document_ = ({ caption = '', chatId = -100123 } = {}) => ({
  message: {
    message_id: nextId++,
    date: 1789000000,
    chat: { id: chatId },
    ...(caption ? { caption } : {}),
    document: { file_id: `d${nextId}`, mime_type: 'image/jpeg', file_name: 'IMG_0042.JPG' },
  },
});

/* ---- tiny assertion helpers ---- */

let passed = 0;
const failures = [];

export function check(name, cond, detail = '') {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

export function report(title) {
  console.log(`\n${title}: ${passed} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log('  FAIL ' + f));
  if (failures.length) process.exitCode = 1;
}
