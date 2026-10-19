// Stores the Twitch stream key in AWS Secrets Manager as hawkes/twitch. The studio server's hawkes-secrets
// service writes it to /run/hawkes/twitch.env, and only hawkes-broadcast reads it. Hidden input; the key
// never passes through a chat or a file in git. It is not part of hawkes/gen.
//
//   node deploy/twitch-key.mjs                 paste it at the prompt
//   node deploy/twitch-key.mjs --from-gen-env  take TWITCH_STREAM_KEY from hawkesgen/.env, then remove that line
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
  const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).find((l) => /^\s*TWITCH_STREAM_KEY\s*=/.test(l));
  key = (line?.replace(/^\s*TWITCH_STREAM_KEY\s*=\s*/, '') ?? '').replace(/^['"]|['"]$/g, '').replace(/\s+/g, '');
} else {
  key = (await ask('Twitch stream key (input hidden): ')).replace(/\s+/g, '');
}
if (key.length < 20) {
  console.error(fromFile ? 'No stream key in hawkesgen/.env. Nothing stored.' : `That doesn't look like a whole stream key: got ${key.length} characters. Nothing stored.`);
  process.exit(1);
}
const sm = new SecretsManagerClient(cfg);
const SecretString = JSON.stringify({ TWITCH_STREAM_KEY: key });
try {
  await sm.send(new CreateSecretCommand({ Name: 'hawkes/twitch', Description: 'Twitch stream key for the studio broadcast', SecretString, Tags: [{ Key: 'Project', Value: 'hawkes-cloud' }] }));
} catch (e) {
  if (e.name !== 'ResourceExistsException') throw e;
  await sm.send(new PutSecretValueCommand({ SecretId: 'hawkes/twitch', SecretString }));
}
if (fromFile) {
  const text = fs.readFileSync(envPath, 'utf8');
  const next = text.split(/\r?\n/).filter((l) => !/^\s*TWITCH_STREAM_KEY\s*=/.test(l)).join('\n');
  fs.writeFileSync(envPath, next.endsWith('\n') || next.length === 0 ? next : next + '\n');
  console.log('Removed it from hawkesgen/.env.');
}
console.log('Stored as hawkes/twitch. The studio server picks it up the next time hawkes-secrets runs.');
