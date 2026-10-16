#!/bin/bash
# First boot of the Hawkes control server (Ubuntu 24.04): system packages only. deploy.mjs puts the code,
# data and services in place afterwards. Progress: /var/log/hawkes-init.log, done when /var/lib/hawkes/ready exists.
set -euxo pipefail
exec > >(tee -a /var/log/hawkes-init.log) 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git ffmpeg python3-venv python3-pip unzip jq debian-keyring debian-archive-keyring apt-transport-https rsync sqlite3

# Node 24
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs

# Caddy (HTTPS with automatic Let's Encrypt certificates)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy

# A service user, the projects folder (the same layout as C:\Projects), and 4 GB of swap.
id hawkes >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/hawkes --shell /bin/bash hawkes
mkdir -p /srv/hawkes /var/lib/hawkes /etc/hawkes
chown -R hawkes:hawkes /srv/hawkes /var/lib/hawkes
if [ ! -f /swapfile ]; then fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi

# Automatic security updates.
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

touch /var/lib/hawkes/ready
