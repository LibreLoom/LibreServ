#!/bin/bash
# Sol Connect deploy: thin wrapper around the shared script (infra/connect-deploy/).
#
#   sudo ./sol/connect/deploy/deploy.sh                 # newest signed release from the stable feed
#   sudo ./sol/connect/deploy/deploy.sh --channel beta
#   sudo ./sol/connect/deploy/deploy.sh --version 0.2.0 [--allow-downgrade]
#   sudo ./sol/connect/deploy/deploy.sh --head          # build this checkout (dev)
#
# See infra/connect-deploy/deploy.sh --help. Per-unit settings (install dir, ports,
# service user, key) are in infra/connect-deploy/units/sol-connect.conf.
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../infra/connect-deploy" && pwd)/deploy.sh" sol-connect "$@"
