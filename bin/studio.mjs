#!/usr/bin/env node
// Hawkes Studio CLI. Runs src/cli.ts with Node's type stripping.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
