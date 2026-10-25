// Puts the API keys the server needs into AWS Secrets Manager as hawkes/gen (a JSON object), from hawkesgen/.env.
// Values are never printed. AWS keys are not copied: the server uses its IAM role.
//
//   node deploy/secrets.mjs
import path from 'node:path';
import { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { cfg, PROJECTS, readEnvFile, log } from './aws.mjs';

const env = readEnvFile(path.join(PROJECTS, 'hawkesgen', '.env'));
const value = { ELEVENLABS_API_KEY: env.ELEVENLABS_API_KEY, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY };
if (env.XAI_API_KEY) value.XAI_API_KEY = env.XAI_API_KEY;
// ComfyUI partner nodes (Seedance, Kling, Veo... templates api_*) bill this Comfy.org account (Gen's comfy client).
if (env.COMFY_ORG_API_KEY) value.COMFY_ORG_API_KEY = env.COMFY_ORG_API_KEY;
// AWS Bedrock credentials (optional fallback for Claude when direct API hits limits).
if (env.AWS_BEDROCK_KEY && env.AWS_BEDROCK_SECRET) {
  value.AWS_BEDROCK_KEY = env.AWS_BEDROCK_KEY;
  value.AWS_BEDROCK_SECRET = env.AWS_BEDROCK_SECRET;
  if (env.AWS_BEDROCK_REGION) value.AWS_BEDROCK_REGION = env.AWS_BEDROCK_REGION;
} else if (env.AWS_BEDROCK_KEY || env.AWS_BEDROCK_SECRET) {
  throw new Error('AWS_BEDROCK_KEY and AWS_BEDROCK_SECRET must both be set (or both omitted)');
}
for (const [k, v] of Object.entries(value)) if (!v) throw new Error(`${k} is not in hawkesgen/.env`);
const sm = new SecretsManagerClient(cfg);
const SecretString = JSON.stringify(value);
try {
  await sm.send(new CreateSecretCommand({ Name: 'hawkes/gen', Description: 'API keys for Hawkes Gen on the control server', SecretString, Tags: [{ Key: 'Project', Value: 'hawkes-cloud' }] }));
  log('created secret hawkes/gen with', Object.keys(value).join(', '));
} catch (e) {
  if (e.name !== 'ResourceExistsException') throw e;
  await sm.send(new PutSecretValueCommand({ SecretId: 'hawkes/gen', SecretString }));
  log('updated secret hawkes/gen with', Object.keys(value).join(', '));
}
