#!/usr/bin/env bash
# post-build-openclaw-sync.sh — Called after pi-mono-fork builds to sync the
# openclaw pi-harness extension.
#
# Wired via package.json postbuild hook or called directly from update-pi.
# Silently skips if ~/openclaw/scripts/sync-pi-harness.sh does not exist.
#
# Usage (from pi-mono-fork root):
#   ./scripts/post-build-openclaw-sync.sh

set -euo pipefail

OPENCLAW_SYNC="${OPENCLAW_DIR:-$HOME/openclaw}/scripts/sync-pi-harness.sh"

if [[ ! -f "$OPENCLAW_SYNC" ]]; then
  # Not an error — openclaw may not be installed or configured
  exit 0
fi

echo "▸ Syncing pi-harness extension in ~/openclaw..."
bash "$OPENCLAW_SYNC" "$@"
