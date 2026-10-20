// The hawkes-broadcast unit (bin/broadcast-stream.mjs), shared by deploy.mjs (a fresh server) and hawkes-pull.mjs (every
// deploy: it installs this text when it differs and restarts the encoder when its script changed). The encoder runs all
// the time and idles until the Director bar's Go live (src/onair.ts), so Restart=always and enabled at boot.
export const BROADCAST_UNIT = `
[Unit]
Description=Hawkes: the broadcast page to Twitch (separate from Studio; idle until Go live)
After=hawkes-studio.service hawkes-secrets.service

[Service]
User=hawkes
WorkingDirectory=/srv/hawkes/hawkesstudio
Environment=BROADCAST_URL=http://127.0.0.1:8791/broadcast.html?product=yoobaland&clean=1
EnvironmentFile=-/run/hawkes/twitch.env
ExecStart=/usr/bin/node bin/broadcast-stream.mjs --go
Restart=always
RestartSec=15
KillMode=control-group

[Install]
WantedBy=multi-user.target
`.trim() + '\n';
