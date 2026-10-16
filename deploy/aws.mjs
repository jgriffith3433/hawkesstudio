// Shared AWS setup for the deploy scripts: credentials from hawkesgen/.env (the "claw" user), the state file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECTS = path.resolve(HERE, '..', '..');
export const STATE_FILE = path.join(HERE, '.state.json');
export const KEYS = path.join(HERE, '.keys');
fs.mkdirSync(KEYS, { recursive: true });

export function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, '')]));
}

const genEnv = readEnvFile(path.join(PROJECTS, 'hawkesgen', '.env'));
export const REGION = 'us-east-1';
export const cfg = { region: REGION, credentials: { accessKeyId: genEnv.AWS_ACCESS_KEY_ID, secretAccessKey: genEnv.AWS_SECRET_ACCESS_KEY } };
export const ACCOUNT = '028793236279';

export const state = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
export const saveState = (patch) => { const s = { ...state(), ...patch }; fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); return s; };

export async function myIp() {
  return (await (await fetch('https://checkip.amazonaws.com')).text()).trim();
}

export const log = (...a) => console.log('[deploy]', ...a);
