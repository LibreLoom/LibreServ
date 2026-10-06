#!/bin/bash
# Luna Connect deploy: thin wrapper around the shared script (infra/connect-deploy/).
#
#   sudo ./luna/connect/deploy/deploy.sh                 # newest signed release from the stable feed
#   sudo ./luna/connect/deploy/deploy.sh --channel beta
#   sudo ./luna/connect/deploy/deploy.sh --version 0.2.0 [--allow-downgrade]
#   sudo ./luna/connect/deploy/deploy.sh --head          # reset to origin/main and build (dev)
#   sudo ./luna/connect/deploy/deploy.sh --head --force  # sick peer or both down (recovery)
#   sudo ./luna/connect/deploy/deploy.sh --no-pull       # build the current checkout as-is
#   sudo ./luna/connect/deploy/deploy.sh --branch NAME   # reset to origin/NAME and build
#
# See infra/connect-deploy/deploy.sh --help. Per-unit settings (install dir, ports,
# soft drain, service user, key) are in infra/connect-deploy/units/luna-connect.conf.
set -euo pipefail
args=("$@")
for i in "${!args[@]}"; do
    # --no-pull used to imply --head; keep that.
    [ "${args[$i]}" = "--no-pull" ] && args+=("--head")
done
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../infra/connect-deploy" && pwd)/deploy.sh" luna-connect "${args[@]}"
