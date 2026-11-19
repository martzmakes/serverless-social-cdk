#!/usr/bin/env bash
# user-data.sh — AL2023 arm64 bootstrap for the firehose box.
#
# CDK substitutes two tokens before embedding this script:
#   {{ASSET_S3_URL}}      - s3://bucket/key for the box asset zip
#   {{SSM_REGISTRY_PARAM}} - SSM parameter name for the registry JSON
#
# The box runs as root on a t4g.nano (private workload, no public shell).
# Structured logs go to stdout → journald → CloudWatch (SSM agent routes them).

set -euo pipefail
exec > >(tee /var/log/firehose-bootstrap.log | logger -t firehose-bootstrap) 2>&1

echo "=== firehose-box bootstrap $(date -Iseconds) ==="

# ---------------------------------------------------------------------------
# 1. Install Node 22 (LTS) from the official tarball. NOT dnf: on a t4g.nano (418 MB
#    RAM) `dnf install` loading the AL2023 repo metadata was OOM-killed on both
#    the 2026-09-02 and the 2026-10-31 replacement boxes, which killed cloud-init
#    and left the box with no Node, no Caddy and nothing listening (relay stuck
#    at the May commits). The AMI already has curl, tar, gzip, python3 and aws.
# ---------------------------------------------------------------------------
NODE_DIST="https://nodejs.org/dist/latest-v22.x"
curl -fsSL --retry 5 --retry-all-errors "$NODE_DIST/SHASUMS256.txt" -o /tmp/node-shasums.txt
NODE_TGZ="$(awk '/linux-arm64\.tar\.gz$/ {print $2}' /tmp/node-shasums.txt)"
test -n "$NODE_TGZ"
curl -fsSL --retry 5 --retry-all-errors "$NODE_DIST/$NODE_TGZ" -o "/tmp/$NODE_TGZ"
(cd /tmp && grep " $NODE_TGZ\$" node-shasums.txt | sha256sum -c -)
tar -xzf "/tmp/$NODE_TGZ" -C /usr/local --strip-components=1
rm -f "/tmp/$NODE_TGZ" /tmp/node-shasums.txt
# The systemd unit below runs /usr/bin/node.
ln -sf /usr/local/bin/node /usr/bin/node
ln -sf /usr/local/bin/npm /usr/bin/npm

node --version
npm --version

# ---------------------------------------------------------------------------
# 2. Install Caddy — official arm64 static binary from the Caddy download API.
#    The box is IPv6-only (no public IPv4, see firehose-box.ts); GitHub's
#    release downloads have no AAAA record, caddyserver.com does.
# ---------------------------------------------------------------------------
CADDY_VERSION="v2.9.1"
CADDY_URL="https://caddyserver.com/api/download?os=linux&arch=arm64&version=${CADDY_VERSION}"

curl -fsSL --retry 5 --retry-all-errors "$CADDY_URL" -o /usr/bin/caddy
chmod +x /usr/bin/caddy

caddy version

# ---------------------------------------------------------------------------
# 3. Download the box asset from S3 and install it
# ---------------------------------------------------------------------------
ASSET_S3_URL="{{ASSET_S3_URL}}"
SSM_REGISTRY_PARAM="{{SSM_REGISTRY_PARAM}}"

# IPv6-only egress: the legacy regional endpoints (s3.us-east-1.amazonaws.com,
# dynamodb.us-east-1.amazonaws.com, ssm.us-east-1.amazonaws.com) are IPv4-only;
# the dual-stack ones answer over IPv6. The CLI and the SDK v3 both honour this.
export AWS_USE_DUALSTACK_ENDPOINT=true
mkdir -p /opt/firehose
aws s3 cp "$ASSET_S3_URL" /tmp/firehose-asset.zip
# python3 ships with the AMI; `unzip` would need dnf (see step 1).
python3 -m zipfile -e /tmp/firehose-asset.zip /opt/firehose
rm /tmp/firehose-asset.zip

# Install only the @aws-sdk/* runtime externals (bundled code needs none else)
cd /opt/firehose && npm ci --omit=dev

echo "Asset installed. Contents:"
ls -la /opt/firehose/

# ---------------------------------------------------------------------------
# 4. Write systemd unit for the node firehose server
# ---------------------------------------------------------------------------
cat > /etc/systemd/system/firehose.service << 'UNIT'
[Unit]
Description=Serverless Social Firehose Box
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/firehose
ExecStart=/usr/bin/node /opt/firehose/dist/server.bundle.cjs
Environment=PORT=8080
Environment=AWS_REGION=us-east-1
Environment=AWS_USE_DUALSTACK_ENDPOINT=true
Environment=SSM_REGISTRY_PARAM={{SSM_REGISTRY_PARAM}}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

# ---------------------------------------------------------------------------
# 5. Write systemd unit for Caddy
# ---------------------------------------------------------------------------
cat > /etc/systemd/system/caddy.service << 'UNIT'
[Unit]
Description=Caddy reverse proxy (firehose.serverless.social → localhost:8080)
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/bin/caddy run --config /opt/firehose/Caddyfile
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

# ---------------------------------------------------------------------------
# 6. Enable and start both services
# ---------------------------------------------------------------------------
systemctl daemon-reload
systemctl enable --now firehose
systemctl enable --now caddy

echo "=== bootstrap complete $(date -Iseconds) ==="
