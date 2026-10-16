#!/usr/bin/env node
// Hawkes Studio MCP server (stdio). Runs src/mcp.ts with Node's type stripping.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp.ts');
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
