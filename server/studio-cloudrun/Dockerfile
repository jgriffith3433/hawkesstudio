# Hawkes Studio on Cloud Run (docs/studio-cloudrun.md): one image for the service `studio` (the dashboard, the API, the
# database and the daily loop; one instance at most, none while idle) and the job `studio-agent` (one execution per
# agent's, scout's or Talk's Claude Code pass). The build context is `git archive` of one commit
# (tools/studio-cloudrun/build.mjs), so .env, .data and deploy/.keys are never in it. Litestream keeps studio.db in
# Cloud Storage.
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
# pseudo-terminal (claude-accounts.ts); curl and ca-certificates for Litestream's download; procps for ps.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git git-lfs ca-certificates curl util-linux procps \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz" \
      | tar -xz -C /usr/local/bin litestream \
    && litestream version

# Claude Code: agents, scouts and Talk run it in the job; the service runs it for the Claude sign-in and its own calls.
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code && claude --version

# The job's unprivileged user: the pass runs as it, the runner (root) keeps the clone token (cloudjob-run.ts).
RUN useradd --create-home --uid 1001 --shell /bin/bash agent

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .
COPY server/studio-cloudrun/litestream.yml /etc/litestream.yml
RUN chmod +x server/studio-cloudrun/entrypoint.sh && mkdir -p /data /tmp/projects

ENTRYPOINT ["server/studio-cloudrun/entrypoint.sh"]
