// Creates or updates the hawkes/gen-public secret in AWS Secrets Manager for the standalone
// public commercial Hawkes Gen Cloud server (hawkesgen.com).
// Reads default ANTHROPIC_API_KEY / ELEVENLABS_API_KEY from hawkesgen/.env and merges CLI flags.
// Secret values are never printed.
//
//   node deploy/gen-public-secrets.mjs --stripe-key sk_... --stripe-webhook whsec_...
//   node deploy/gen-public-secrets.mjs --stripe-key sk_... --stripe-webhook whsec_... --anthropic-key sk-ant-... --elevenlabs-key ...

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { cfg, PROJECTS, readEnvFile, log } from './aws.mjs';

export const SECRET_NAME = 'hawkes/gen-public';
export const REQUIRED_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY'];

export function buildPublicSecretPayload(argv = process.argv.slice(2), baseEnv = {}, existingSecret = {}) {
  const opt = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const value = {
    ...existingSecret,
    ...(baseEnv.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: baseEnv.ANTHROPIC_API_KEY } : {}),
    ...(baseEnv.ELEVENLABS_API_KEY ? { ELEVENLABS_API_KEY: baseEnv.ELEVENLABS_API_KEY } : {}),
    ...(baseEnv.STRIPE_SECRET_KEY ? { STRIPE_SECRET_KEY: baseEnv.STRIPE_SECRET_KEY } : {}),
    ...(baseEnv.STRIPE_WEBHOOK_SECRET ? { STRIPE_WEBHOOK_SECRET: baseEnv.STRIPE_WEBHOOK_SECRET } : {}),
  };
  const stripeKey = opt('stripe-key');
  const stripeWebhook = opt('stripe-webhook');
  const anthropicKey = opt('anthropic-key');
  const elevenlabsKey = opt('elevenlabs-key');

  if (stripeKey) value.STRIPE_SECRET_KEY = stripeKey;
  if (stripeWebhook) value.STRIPE_WEBHOOK_SECRET = stripeWebhook;
  if (anthropicKey) value.ANTHROPIC_API_KEY = anthropicKey;
  if (elevenlabsKey) value.ELEVENLABS_API_KEY = elevenlabsKey;

  for (const k of REQUIRED_KEYS) {
    if (!value[k]) {
      throw new Error(`Missing ${k} (pass --stripe-key / --stripe-webhook or set ${k} in hawkesgen/.env)`);
    }
  }
  return value;
}

export async function upsertPublicSecrets(argv = process.argv.slice(2)) {
  const sm = new SecretsManagerClient(cfg);
  let existing = {};
  try {
    const cur = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    if (cur.SecretString) existing = JSON.parse(cur.SecretString);
  } catch (e) {
    if (e.name !== 'ResourceNotFoundException') throw e;
  }

  const env = readEnvFile(path.join(PROJECTS, 'hawkesgen', '.env'));
  const value = buildPublicSecretPayload(argv, env, existing);
  const SecretString = JSON.stringify(value);

  try {
    await sm.send(new CreateSecretCommand({
      Name: SECRET_NAME,
      Description: 'API and Stripe keys for the standalone public Hawkes Gen Cloud server (hawkesgen.com)',
      SecretString,
      Tags: [{ Key: 'Project', Value: 'hawkes-gen-public' }],
    }));
    log(`created secret ${SECRET_NAME} with`, Object.keys(value).join(', '));
  } catch (e) {
    if (e.name !== 'ResourceExistsException') throw e;
    await sm.send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString }));
    log(`updated secret ${SECRET_NAME} with`, Object.keys(value).join(', '));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  upsertPublicSecrets().catch((e) => {
    console.error(`[deploy] ${e.message ?? e}`);
    process.exit(1);
  });
}
