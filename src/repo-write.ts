// Writing a file an agent or Talk imported (mcp-tools.ts studio_gen_import) into its repo: in their own tool server,
// in their job, so nothing here opens Studio's database or config.

import fs from 'node:fs';
import path from 'node:path';

const fail = (message: string) => Object.assign(new Error(message), { status: 400 });

/** A path inside a repo for a file the agent asked for: relative, no "..", never under .git. */
export function safeRepoPath(p: unknown): string {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').some((x) => x === '..' || x === '') || s.split('/')[0] === '.git') throw fail('path: a file path inside the repo, like assets/medical/lab-hero.jpg');
  return s;
}

/** Writes the imported bytes under the repo root (the agent's tool, in its own job). */
export function writeImport(root: string, rel: string, bytes: Buffer) {
  const dest = path.resolve(root, safeRepoPath(rel));
  if (!dest.startsWith(path.resolve(root) + path.sep)) throw fail('path: inside the repo');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  return dest;
}
