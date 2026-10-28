# AWS Bedrock - Cloud Deployment Checklist

## What Was Changed for Deployment

### 1. Secrets Upload Script (`deploy/secrets.mjs`)

✅ **Updated to include Bedrock credentials**

The script now uploads these additional keys to AWS Secrets Manager (`hawkes/gen`):
- `AWS_BEDROCK_KEY` (optional, paired with SECRET)
- `AWS_BEDROCK_SECRET` (optional, paired with KEY)
- `AWS_BEDROCK_REGION` (optional, only if KEY+SECRET are set)

**Validation:** Both KEY and SECRET must be set together, or both omitted. Setting only one throws an error.

### 2. Secrets Fetch Script (`hawkesgen/bin/fetch-secrets.mjs`)

✅ **No changes needed** - automatically handles new keys

The script downloads the `hawkes/gen` secret and writes all keys to `/run/hawkes/gen.env`. New keys are automatically included.

### 3. Provider Implementation (`hawkesgen/src/providers/bedrock.ts`)

✅ **Reads credentials from environment**

Priority order:
1. `AWS_BEDROCK_KEY` / `AWS_BEDROCK_SECRET` / `AWS_BEDROCK_REGION`
2. Falls back to `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_DEFAULT_REGION`

On the server, the credentials come from `/run/hawkes/gen.env` (fetched from Secrets Manager).

## Deployment Steps

### For the Cloud Server (studio.hawkesgen.ai / gen.hawkesgen.ai)

#### 1️⃣ Add Keys Locally (Your PC)

Edit `C:\Projects\hawkesgen\.env`:

```bash
AWS_BEDROCK_KEY=AKIAIOSFODNN7EXAMPLE
AWS_BEDROCK_SECRET=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AWS_BEDROCK_REGION=us-east-1
```

#### 2️⃣ Upload to AWS Secrets Manager

```bash
cd C:\Projects\hawkesstudio\deploy
node secrets.mjs
```

Expected output:
```
updated secret hawkes/gen with ELEVENLABS_API_KEY, ANTHROPIC_API_KEY, AWS_BEDROCK_KEY, AWS_BEDROCK_SECRET, AWS_BEDROCK_REGION
```

#### 3️⃣ Verify Secret in AWS Console (Optional)

1. Open AWS Secrets Manager console
2. Find secret: `hawkes/gen`
3. Click "Retrieve secret value"
4. Confirm `AWS_BEDROCK_KEY`, `AWS_BEDROCK_SECRET`, `AWS_BEDROCK_REGION` are present

#### 4️⃣ Server Will Fetch on Next Restart

The server's systemd unit runs `bin/fetch-secrets.mjs` before starting Hawkes Gen:

```ini
ExecStartPre=+/srv/hawkes/hawkesgen/bin/fetch-secrets.mjs /run/hawkes/gen.env
EnvironmentFile=-/run/hawkes/gen.env
```

**To apply immediately:**

```bash
# SSH to server
ssh hawkes@<server-ip>

# Restart Gen (fetches secrets first)
sudo systemctl restart hawkes-gen

# Check logs
sudo journalctl -u hawkes-gen -n 50
```

Or wait for the next code deploy (deploys restart services).

#### 5️⃣ Enable Bedrock Backend

**Option A: Via SSH**

```bash
ssh hawkes@<server-ip>
nano /srv/hawkes/hawkesgen/.data/settings.json
```

Add:
```json
{
  "claude": {
    "backend": "bedrock"
  }
}
```

**Option B: Via Dashboard**

1. Open https://gen.hawkesgen.ai
2. Login as `j`
3. Settings tab → Claude Backend → select "bedrock"
4. Save

No restart needed - settings reload immediately.

## Verification

### Check if Bedrock is Configured

```bash
# On the server
ssh hawkes@<server-ip>
cat /run/hawkes/gen.env | grep BEDROCK
```

Should output:
```
AWS_BEDROCK_KEY=AKIA...
AWS_BEDROCK_SECRET=wJal...
AWS_BEDROCK_REGION=us-east-1
```

### Test a Claude Call

```bash
# On your PC
hawkesgen.cmd run llm.text --project test --param prompt="Say hello from Bedrock" --param model="claude-haiku-5-5"
```

Check the Gen dashboard (Jobs tab) - should show:
- Provider: `bedrock`
- Billing: billed per token (not Max plan)

### Check Studio Fallback

Studio automatically uses Gen's backend for reviews. To test:

```bash
# Force a review to use Claude
studio.cmd playtest doseofdestruction smoke --wait
```

Check the playtest review job in Gen - should use Bedrock if `settings.claude.backend = "bedrock"`.

## Troubleshooting

### "AWS_BEDROCK_KEY and AWS_BEDROCK_SECRET must both be set"

You set only one of the keys in `.env`. Either:
- Set both keys
- Or omit both (falls back to AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)

Then re-run `node secrets.mjs`.

### Secret Not Updating

```bash
# Force re-upload
cd C:\Projects\hawkesstudio\deploy
node secrets.mjs

# On server, check what was fetched
ssh hawkes@<server-ip>
sudo systemctl stop hawkes-gen
sudo /srv/hawkes/hawkesgen/bin/fetch-secrets.mjs /run/hawkes/gen.env
cat /run/hawkes/gen.env | grep BEDROCK
sudo systemctl start hawkes-gen
```

### "Bedrock model not available"

Check the region. Not all models are in all regions.

```bash
# Try us-east-1 (has all models)
echo 'AWS_BEDROCK_REGION=us-east-1' >> C:\Projects\hawkesgen\.env
node deploy/secrets.mjs
```

## IAM Permissions

The server's IAM role needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "arn:aws:bedrock:*::foundation-model/anthropic.claude-*"
    }
  ]
}
```

Check current role:

```bash
# On server
aws sts get-caller-identity
aws iam get-role --role-name <role-name>
```

## Rollback

To remove Bedrock keys:

1. Remove from `hawkesgen/.env`:
   ```bash
   # Delete these lines
   AWS_BEDROCK_KEY=...
   AWS_BEDROCK_SECRET=...
   AWS_BEDROCK_REGION=...
   ```

2. Re-upload secrets:
   ```bash
   node deploy/secrets.mjs
   ```

3. On server, restart:
   ```bash
   sudo systemctl restart hawkes-gen
   ```

Keys will be removed from `/run/hawkes/gen.env` but won't break anything (Bedrock provider checks for them).

## Summary

✅ Bedrock credentials deploy the same way as ANTHROPIC_API_KEY and ELEVENLABS_API_KEY
✅ Upload via `deploy/secrets.mjs` → AWS Secrets Manager → Server fetches automatically
✅ Keys never touch disk (stored in `/run/hawkes/` = tmpfs)
✅ Enable via settings.json or dashboard
✅ No code changes needed on server
