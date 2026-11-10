// A plain static file server for a site's folder (local.ts): what `python3 -m http.server` did, in Node, which Studio's
// image always has. On 2026-11-10 Studio's cloud image had no python3, so every static site's playtest of a change failed
// with "spawn python3 ENOENT" ("The fixed version didn't start"). Usage: node static-child.mjs <port> (serves the cwd on
// 127.0.0.1). A folder answers with its index.html; nothing outside the folder is served.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = fs.realpathSync(process.cwd());
const port = Number(process.argv[2]);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.xml': 'application/xml',
  '.gz': 'application/gzip', '.br': 'application/octet-stream', '.data': 'application/octet-stream', '.bin': 'application/octet-stream',
};

http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  let file = path.join(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      if (!rel.endsWith('/')) { res.writeHead(301, { Location: `${rel}/` }).end(); return; }
      file = path.join(file, 'index.html');
    }
    fs.stat(file, (e2, st2) => {
      if (e2 || !st2.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': st2.size, 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  });
}).listen(port, '127.0.0.1');
