# Hawkes Studio on Cloud Run (docs/studio-cloudrun.md): one image for the service `studio` (the dashboard, the API, the
# database and the daily loop; one instance at most, none while idle) and the job `studio-agent` (one execution per
# agent's, scout's or Talk's Claude Code pass). The build context is `git archive` of one commit
# (tools/studio-cloudrun/build.mjs), so .env, .data and deploy/.keys are never in it. Litestream keeps studio.db in
# Cloud Storage.
# Studio's Unity check (src/unitycheck.ts): Roslyn, published self-contained so the agent image needs no .NET install.
FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim AS unitycheck
COPY tools/unity-check /src/unity-check
RUN dotnet publish /src/unity-check -c Release -r linux-x64 --self-contained true -p:PublishSingleFile=true -o /out

FROM node:24-bookworm-slim

ARG LITESTREAM_VERSION=0.3.13
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    STUDIO_SERVER=1 \
    STUDIO_DATA=/data \
    STUDIO_PROJECTS=/tmp/projects \
    STUDIO_DETACH=cloudrun \
    CLAUDE_CONFIG_DIR=/data/claude-home \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# git for the product repos (cloned on demand) and the agents' worktrees; util-linux's `script` for the Claude sign-in's
# pseudo-terminal (claude-accounts.ts); curl and ca-certificates for Litestream's download; procps for ps. python3 and
# ffmpeg: the checks of projects that need them (a web app's tests: Hawkes Gen's run Python helpers and ffmpeg).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git git-lfs ca-certificates curl util-linux procps python3 python3-venv ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz" \
      | tar -xz -C /usr/local/bin litestream \
    && litestream version

# Claude Code: agents, scouts and Talk run it in the job; the service runs it for the Claude sign-in and its own calls.
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code && claude --version

# The other harnesses (brains.ts; J, 2026-11-09: "Be able to sign into all AI coding agent providers with subscription
# usage"): GitHub Copilot CLI, Gemini CLI and OpenAI's Codex CLI from npm; Cursor's `agent` and Antigravity's `agy` from
# their own installers, into /opt/ai-clis (readable by the job's `agent` user) with links in /usr/local/bin. Until
# 2026-11-09 only Claude Code was here, so Antigravity's sign-in failed with "agy: not found". One that fails to install
# doesn't fail the image: Settings says that provider isn't installed and Studio runs on the others.
RUN for p in @github/copilot @google/gemini-cli @openai/codex; do \
      npm install -g --no-audit --no-fund "$p" || echo "WARNING: $p did not install"; \
    done; \
    mkdir -p /opt/ai-clis/cursor /opt/ai-clis/agy; \
    (HOME=/opt/ai-clis/cursor sh -c 'curl -fsSL https://cursor.com/install | bash' && ln -sf /opt/ai-clis/cursor/.local/bin/agent /usr/local/bin/agent) || echo "WARNING: Cursor's agent did not install"; \
    (HOME=/opt/ai-clis/agy sh -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash' && install -m 0755 /opt/ai-clis/agy/.local/bin/agy /usr/local/bin/agy) || echo "WARNING: agy did not install"; \
    chmod -R a+rX /opt/ai-clis; \
    for b in copilot gemini codex agent agy; do command -v "$b" >/dev/null && echo "installed: $b" || echo "missing: $b"; done

# The job's unprivileged user: the pass runs as it, the runner (root) keeps the clone token (cloudjob-run.ts).
RUN useradd --create-home --uid 1001 --shell /bin/bash agent

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .
COPY --from=unitycheck /out/unity-check /opt/unity-check/unity-check
COPY server/studio-cloudrun/litestream.yml /etc/litestream.yml
RUN chmod +x server/studio-cloudrun/entrypoint.sh && mkdir -p /data /tmp/projects

ENTRYPOINT ["server/studio-cloudrun/entrypoint.sh"]
