// A second scratch Studio for test/memory-transfer.test.ts: its own data folder and products, a memory with a game's
// knowledge in it, and the memory routes over HTTP (no other part of Studio). Prints {"port": n} once it listens.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const dir = process.env.STUDIO_DATA!;
fs.mkdirSync(dir, { recursive: true });

const mem = await import('../../src/memory.ts');
const api = await import('../../src/memory-api.ts');

const J = { who: 'J' } as const;
mem.writeMemory({ kind: 'canon', title: 'Yooba was a farmer before the village burned', body: 'The Overlord burned his village; he left to find the way home.', product: 'yooba', source: 'Docs/Story.md' }, J);
mem.writeMemory({ kind: 'canon', title: 'Slimes are villagers, never enemies', body: 'Never make a slime an enemy.', product: 'yooba', source: 'Docs/Story.md' }, J);
mem.writeMemory({ kind: 'decision', title: 'Yooba Land is web only, no XR', body: 'The VR build is retired.', product: 'yooba', quote: 'no more XR. web now', source: 't_0000000000aa' }, J);
mem.writeMemory({ kind: 'convention', title: 'The WebGL build goes to Game/ via YoobaWebBuild', body: 'Run the YoobaWebBuild menu; the key is sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX0123 for nothing.', product: 'yooba' }, J);
mem.writeMemory({ kind: 'lesson', title: 'URP shaders strip on WebGL unless listed', body: 'Add them to Always Included Shaders.', product: 'yooba' }, J);
mem.writeMemory({ kind: 'preference', title: 'Short hover text on every Yooba Land button', product: 'yooba' }, J);
mem.writeMemory({ kind: 'state', title: 'Halfway through the lobby rewrite', product: 'yooba' }, J);
mem.writeMemory({ kind: 'lesson', title: 'An unconfirmed note an agent left about audio', product: 'yooba' }, { who: 'agent', id: 'c_000000000009' });
mem.writeMemory({ kind: 'canon', title: 'Another game entirely has its own canon', product: 'other' }, J);

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readJson = async (req: http.IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    const link = /^\/api\/memory\/export\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (link && req.method === 'GET') return await api.handleExportLink(req, res, link[1], send);
    await api.handleMemory(req, res, url, send, readJson);
  } catch (e: any) {
    send(res, e?.status ?? 400, { error: e?.message ?? String(e) });
  }
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: (server.address() as any).port, data: path.basename(dir) })));
