// Stores the GitHub Copilot token in AWS Secrets Manager as hawkes/copilot. The studio server's hawkes-secrets
// service writes it to /run/hawkes/copilot.env as COPILOT_GITHUB_TOKEN. Studio and Gen pass it to the Copilot
// harness (`copilot`, bin/copilot-agent.mjs). It draws on the Copilot plan's premium requests.
//
// The token must be a fine-grained personal access token with the "Copilot Requests" permission (or an OAuth
// token). Classic tokens (ghp_...) are refused by the Copilot CLI.
//
//   node deploy/copilot-key.mjs        paste it at the prompt (or have COPILOT_GITHUB_TOKEN in the environment)
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

const token = (process.env.COPILOT_GITHUB_TOKEN || await ask('Copilot token, a fine-grained PAT with Copilot Requests (input hidden): ')).replace(/\s+/g, '');
if (token.length < 20) {
  console.error(`That doesn't look like a whole token: got ${token.length} characters. Nothing stored.`);
  process.exit(1);
}
if (token.startsWith('ghp_')) {
  console.error('That is a classic personal access token: the Copilot CLI refuses those. Make a fine-grained one with the "Copilot Requests" permission. Nothing stored.');
  process.exit(1);
}
const sm = new SecretsManagerClient(cfg);
const SecretString = JSON.stringify({ COPILOT_GITHUB_TOKEN: token });
try {
  await sm.send(new CreateSecretCommand({ Name: 'hawkes/copilot', Description: 'GitHub Copilot token for the agent harness on the control server', SecretString, Tags: [{ Key: 'Project', Value: 'hawkes-cloud' }] }));
} catch (e) {
  if (e.name !== 'ResourceExistsException') throw e;
  await sm.send(new PutSecretValueCommand({ SecretId: 'hawkes/copilot', SecretString }));
}
console.log('Stored as hawkes/copilot. Run `sudo systemctl restart hawkes-secrets hawkes-gen hawkes-studio` on the server (or deploy) to pick it up.');
