# Secrets after AWS (2026-10-28)

AWS suspended the account, so AWS Secrets Manager (`hawkes/*`) and the control server's `/etc/hawkes/keys.env` are out
of reach. This is where each secret Studio and Gen used can come from now. Values are never written here.

| Secret (AWS name) | What it was for | Where it comes from now |
|---|---|---|
| `hawkes/gen`: Anthropic, ElevenLabs, xAI, Comfy.org, Bedrock keys | Gen's providers | **On J's PC** (`hawkesgen\.env`). Gen on Cloud Run takes them from there into Secret Manager (`tools/gen-cloudrun/deploy.ps1`). Bedrock is AWS: not used any more |
| `hawkes/gemini` | Gemini / Antigravity calls | **On J's PC** (`GEMINI_API_KEY` in `hawkesgen\.env`) |
| `hawkes/copilot` | GitHub Copilot CLI as a brain | **On J's PC** (`COPILOT_GITHUB_TOKEN`) |
| `hawkes/cursor` | Cursor's agent as Gen's and Studio's brain | **Not on the PC.** Re-issue a Cursor API key (cursor.com > Settings > API keys) if Cursor stays the brain |
| `hawkes/claude` | Claude Code login for Talk and agents (Max plan) | **Re-issue**: `claude setup-token` (J signs in; Studio's Settings > Claude accounts does the same once Studio runs again) |
| `hawkes/antigravity` | Antigravity's Google login | **Re-issue**: sign in again from Studio's Settings |
| `hawkes/github` | Studio's pushes, pull requests, rulesets | **On J's PC** (the stored token in `~/.git-credentials`, the one pilot.ps1 already used) |
| `hawkes/twitch` | On Air stream key | **On J's PC** (`TWITCH_STREAM_KEY` in `hawkesgen\.env`) |
| `hawkes/hawkesgen` | Studio's Gen key and Gen's deploy hook | **New**: Gen on Cloud Run starts with an empty key list; its owner key is `gen-owner-key` in Secret Manager, and Studio gets its own key from it |
| `hawkes/hawkesstudio`, `hawkes/previews`, `hawkes/caddy`, `hawkes/keys`, `hawkes/ready` | Studio's own keys (MCP key, web login, beta-site cookies, Caddy, internal) | **Make new ones** when Studio is set up again. The web password and the MCP key also sit in `hawkesstudio/deploy/.keys/` on the PC |
| Studio `.data/social.json` | YouTube and TikTok sign-ins | **Reconnect** from Studio's Social tab |
| Portal (Firebase Secret Manager): Stripe keys, Google sign-in secret, signing key, Resend key | The portal | **Safe**: already in Google's Secret Manager. `HAWKESGEN_KEY` must change to a key from the new Gen |
| SES (Studio's invite and reset email) | Studio mail | **Gone with AWS.** Studio mail moves to Resend, which the portal already uses |
