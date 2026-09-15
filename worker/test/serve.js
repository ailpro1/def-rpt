// Runs the Worker on a Node HTTP server, seeded with a batch, so the app can be
// driven against the real handlers without wrangler or an account.
//
//   node worker/test/serve.js [port]
//
// Prints the batch code it created.
import { createServer } from 'node:http';
import worker from '../src/index.js';
import { handleUpdate } from '../src/bot.js';
import { FakeKV, fakeTelegram, makeEnv, ctx, cmd, photo } from './harness.js';

const port = Number(process.argv[2] || 8790);

// A real JPEG, so the app's decoder has something to work with: a 2x2 grey
// image, the smallest thing that survives createImageBitmap.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy'
  + 'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAgACADASIA'
  + 'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA'
  + 'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3'
  + 'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm'
  + 'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMB'
  + 'AAIRAxEAPwD3+iiigD//2Q==', 'base64');

const tgStub = fakeTelegram();
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/file/bot')) {
    return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
  }
  return tgStub.fetchImpl(url, init);
};

const kv = new FakeKV();
const env = makeEnv(kv);

await handleUpdate(env, cmd('/project 23 JALAN KERUING'), ctx);
await handleUpdate(env, cmd('/sec CAR PORCH'), ctx);
await handleUpdate(env, photo({ caption: 'OVERVIEW' }), ctx);
await handleUpdate(env, photo({ caption: 'POOR FINISHING' }), ctx);
await handleUpdate(env, cmd('/sec kitchen'), ctx);          // lower case on purpose
await handleUpdate(env, photo({ caption: 'UNFILLED GROUT' }), ctx);
await handleUpdate(env, cmd('/sec MASTER BED'), ctx);       // needs fuzzy matching
await handleUpdate(env, photo(), ctx);
// Padding, so a test can interrupt an import partway through.
const extra = Number(process.argv[3] || 0);
for (let i = 0; i < extra; i++) await handleUpdate(env, photo(), ctx);
const code = await kv.get('chat:-100123');
await handleUpdate(env, cmd('/done'), ctx);

createServer(async (req, res) => {
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
  });
  const out = await worker.fetch(request, env, ctx);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(port, () => console.log(`CODE=${code} PORT=${port}`));
