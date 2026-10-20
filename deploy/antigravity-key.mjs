// Stores the Antigravity (`agy`) login in AWS Secrets Manager as hawkes/antigravity. The server's hawkes-secrets service
// writes it to /run/hawkes/antigravity.env as AGY_CREDS; bin/antigravity-agent.mjs puts it in each agent user's home.
//
//   node deploy/antigravity-key.mjs <path to antigravity-oauth-token>
//
// On Linux `agy` writes that file at ~/.gemini/antigravity-cli/antigravity-oauth-token after you sign in once
// (ssh in, `sudo -iu hawkes agy`). Windows and macOS keep the login in the keychain, so sign in on the server.
import fs from 'node:fs';
import { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { cfg } from './aws.mjs';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Usage: node deploy/antigravity-key.mjs <path to antigravity-oauth-token>. Nothing stored.');
  process.exit(1);
}
const raw = fs.readFileSync(file, 'utf8');
try {
  if (!JSON.parse(raw)?.token?.refresh_token) throw new Error('no refresh token');
} catch {
  console.error('That file is not an agy login (no token.refresh_token). Nothing stored.');
  process.exit(1);
}
const sm = new SecretsManagerClient(cfg);
const SecretString = JSON.stringify({ AGY_CREDS: Buffer.from(raw).toString('base64') });
try {
  await sm.send(new CreateSecretCommand({ Name: 'hawkes/antigravity', Description: 'Antigravity (Google AI plan) login for the agent harness on the control server', SecretString, Tags: [{ Key: 'Project', Value: 'hawkes-cloud' }] }));
} catch (e) {
  if (e.name !== 'ResourceExistsException') throw e;
  await sm.send(new PutSecretValueCommand({ SecretId: 'hawkes/antigravity', SecretString }));
}
console.log('Stored as hawkes/antigravity. Deploy (or restart hawkes-secrets hawkes-gen hawkes-studio on the server) to pick it up.');
