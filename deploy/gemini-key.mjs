// Stores the Gemini login in AWS Secrets Manager as hawkes/gemini. The studio server's hawkes-secrets service writes it
// to /run/hawkes/gemini.env. Studio and Gen pass it to the Gemini harness (`gemini`, bin/gemini-agent.mjs).
//
// Two ways, pick one:
//   node deploy/gemini-key.mjs            an AI Studio API key (GEMINI_API_KEY; billed on that key, not the Ultra plan)
//   node deploy/gemini-key.mjs --login    the Google account sign-in (Google AI Ultra): reads ~/.gemini/oauth_creds.json,
//                                         made by running `gemini` once and choosing "Sign in with Google"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { cfg } from './aws.mjs';

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
  });
}

let value;
if (process.argv.includes('--login')) {
  const file = path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini', 'oauth_creds.json');
  if (!fs.existsSync(file)) {
    console.error(`No ${file}. Run \`gemini\`, choose "Sign in with Google", then run this again. Nothing stored.`);
    process.exit(1);
  }
  value = { GEMINI_OAUTH_CREDS: Buffer.from(fs.readFileSync(file, 'utf8')).toString('base64') };
} else {
  const key = (process.env.GEMINI_API_KEY || await ask('Gemini API key (input hidden): ')).replace(/\s+/g, '');
  if (key.length < 20) {
    console.error(`That doesn't look like a whole key: got ${key.length} characters. Nothing stored.`);
    process.exit(1);
  }
  value = { GEMINI_API_KEY: key };
}
const sm = new SecretsManagerClient(cfg);
const SecretString = JSON.stringify(value);
try {
  await sm.send(new CreateSecretCommand({ Name: 'hawkes/gemini', Description: 'Gemini login for the agent harness on the control server', SecretString, Tags: [{ Key: 'Project', Value: 'hawkes-cloud' }] }));
} catch (e) {
  if (e.name !== 'ResourceExistsException') throw e;
  await sm.send(new PutSecretValueCommand({ SecretId: 'hawkes/gemini', SecretString }));
}
console.log('Stored as hawkes/gemini. Run `sudo systemctl restart hawkes-secrets hawkes-gen hawkes-studio` on the server (or deploy) to pick it up.');
