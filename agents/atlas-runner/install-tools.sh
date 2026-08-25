#!/bin/sh
npm install -g --no-fund --no-audit @deepseek-ai/dsh@0.1.0-rc.8
curl -fsSLo /usr/local/bin/forgejo-runner https://code.forgejo.org/forgejo/runner/releases/download/v13.0.0/forgejo-runner-13.0.0-linux-amd64
chmod 0755 /usr/local/bin/forgejo-runner
useradd --create-home --uid 10000 --shell /bin/bash atlas
mkdir -p /data /opt/dsh
