// Stores the Cursor account key in AWS Secrets Manager as hawkes/cursor. The studio server's hawkes-secrets
// service writes it to /run/hawkes/cursor.env. Studio and Gen pass it to the Cursor harness (`agent`).
// It draws on the Cursor plan. It is not an xAI key and it is not part of hawkes/gen.
//
//   node deploy/cursor-key.mjs                 paste it at the prompt
//   node deploy/cursor-key.mjs --from-gen-env  take CURSOR_API_KEY from hawkesgen/.env, then remove that line
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { cfg, PROJECTS } from './aws.mjs';

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
  });
}

const envPath = path.join(PROJECTS, 'hawkesgen', '.env');
const fromFile = process.argv.includes('--from-gen-env');
let key = '';
if (fromFile) {
  const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).find((l) => /^\s*CURSOR_API_KEY\s*=/.test(l));
  key = (line?.replace(/^\s*CURSOR_API_KEY\s*=\s*/, '') ?? '').replace(/^['"]|['"]$/g, '').replace(/\s+/g, '');
} else {
  key = (await ask('Cursor API key (input hidden): ')).replace(/\s+/g, '');
}
if (key.length < 20) {
  console.error(fromFile ? 'No CURSOR_API_KEY in hawkesgen/.env. Nothing stored.' : `That doesn't look like a whole key: got ${key.length} characters. Nothing stored.`);
  process.exit(1);
}
const sm = new SecretsManagerClient(cfg);
const SecretString = JSON.stringify({ CURSOR_API_KEY: key });
try {
  await sm.send(new CreateSecretCommand({ Name: 'hawkes/cursor', Description: 'Cursor account key for the agent harness on the control server', SecretString, Tags: [{ Key: 'Project', Value: 'hawkes-cloud' }] }));
} catch (e) {
  if (e.name !== 'ResourceExistsException') throw e;
  await sm.send(new PutSecretValueCommand({ SecretId: 'hawkes/cursor', SecretString }));
}
if (fromFile) {
  const text = fs.readFileSync(envPath, 'utf8');
  const next = text.split(/\r?\n/).filter((l) => !/^\s*CURSOR_API_KEY\s*=/.test(l)).join('\n');
  fs.writeFileSync(envPath, next.endsWith('\n') || next.length === 0 ? next : next + '\n');
  console.log('Removed it from hawkesgen/.env.');
}
console.log('Stored as hawkes/cursor. The studio server picks it up the next time hawkes-secrets runs.');
