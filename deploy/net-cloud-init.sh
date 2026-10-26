#!/bin/bash
# First boot of the Hawkes Net box (Ubuntu 24.04 arm64): system packages and tuning only. hawkesgen's deploy/net/setup.mjs
# puts the code, the service and Caddy in place afterwards. Progress: /var/log/hawkes-init.log; done when
# /var/lib/hawkes/ready exists.
set -euxo pipefail
exec > >(tee -a /var/log/hawkes-init.log) 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git jq debian-keyring debian-archive-keyring apt-transport-https

# Node 24
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs

# Caddy (HTTPS with automatic Let's Encrypt certificates)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy

# The service user and folders.
id hawkes >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/hawkes --shell /bin/bash hawkes
mkdir -p /srv/hawkes /var/lib/hawkes /etc/hawkes
chown -R hawkes:hawkes /srv/hawkes /var/lib/hawkes

# Many sockets: every player is one long-lived connection (Caddy's and the relay's file limits are in their units).
cat > /etc/sysctl.d/90-hawkes-net.conf <<'EOF'
fs.file-max = 2097152
fs.nr_open = 2097152
net.core.somaxconn = 8192
net.core.netdev_max_backlog = 16384
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.ip_local_port_range = 10240 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 120
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 4
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
EOF
sysctl --system
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nLimitNOFILE=1048576\n' > /etc/systemd/system/caddy.service.d/limits.conf
systemctl daemon-reload

# A little swap, and automatic security updates.
if [ ! -f /swapfile ]; then fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

touch /var/lib/hawkes/ready
