// Stores J's GitHub fine-grained token in AWS Secrets Manager (hawkes/github) for the control server, without it
// passing through any chat or file. Run it in a terminal; the token is read with hidden input.
//
//   node deploy/github-token.mjs
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

const token = await ask('GitHub fine-grained token (input hidden): ');
if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(token)) {
  console.error('That doesn\'t look like a GitHub token (github_pat_...). Nothing stored.');
  process.exit(1);
}
const r = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'hawkes' } });
if (!r.ok) {
  console.error(`GitHub rejected the token (HTTP ${r.status}). Nothing stored.`);
  process.exit(1);
}
const login = (await r.json()).login;
const sm = new SecretsManagerClient(cfg);
const SecretString = JSON.stringify({ GITHUB_TOKEN: token, GITHUB_USER: login });
try {
  await sm.send(new CreateSecretCommand({ Name: 'hawkes/github', Description: 'GitHub token for the Hawkes control server', SecretString, Tags: [{ Key: 'Project', Value: 'hawkes-cloud' }] }));
} catch (e) {
  if (e.name !== 'ResourceExistsException') throw e;
  await sm.send(new PutSecretValueCommand({ SecretId: 'hawkes/github', SecretString }));
}
console.log(`Stored the token for ${login} as hawkes/github. Tell Claude it's done.`);
