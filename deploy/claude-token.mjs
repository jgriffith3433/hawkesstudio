// Stores J's Claude subscription token (from `claude setup-token`) in AWS Secrets Manager as hawkes/claude, so
// Talk and the agent workers on the control server use J's Claude Max plan instead of API tokens. Hidden input;
// the token never passes through a chat or a file.
//
//   claude setup-token                       (signs in with J's Claude account in the browser, prints a token)
//   node deploy/claude-token.mjs             (paste it here)
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

// The token often wraps across lines in a terminal: whitespace and line breaks inside it are removed.
const token = (await ask('Claude subscription token from "claude setup-token" (input hidden): ')).replace(/\s+/g, '');
if (!token.startsWith('sk-ant-oat') || token.length < 60) {
  console.error(`That doesn't look like a whole token from "claude setup-token": got ${token.length} characters starting "${token.slice(0, 10)}". It should start with sk-ant-oat and be about 100 characters. Nothing stored.`);
  process.exit(1);
}
const sm = new SecretsManagerClient(cfg);
const SecretString = JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: token });
try {
  await sm.send(new CreateSecretCommand({ Name: 'hawkes/claude', Description: 'Claude subscription token for Talk and agents on the control server', SecretString, Tags: [{ Key: 'Project', Value: 'hawkes-cloud' }] }));
} catch (e) {
  if (e.name !== 'ResourceExistsException') throw e;
  await sm.send(new PutSecretValueCommand({ SecretId: 'hawkes/claude', SecretString }));
}
console.log('Stored as hawkes/claude. Tell Claude it is done.');
