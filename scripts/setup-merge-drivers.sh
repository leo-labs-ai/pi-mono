#!/usr/bin/env bash
#
# Register the local git merge drivers this fork's .gitattributes relies on.
# Run once per clone (merge-driver config lives in .git/config, not in-tree).
#
#   ./scripts/setup-merge-drivers.sh
#
# Drivers registered:
#   merge=ours  -> keep the fork's version of a file on every merge.
#                  Used for packages/ai/src/{models,image-models}.generated.ts,
#                  which are generated from LIVE provider API fetches and so never
#                  match upstream's snapshot. Without this, every upstream sync
#                  hard-conflicts on them. Refresh deliberately instead:
#                    npm --prefix packages/ai run refresh-models
set -euo pipefail

git config merge.ours.driver true

echo "Registered merge driver: merge.ours.driver = true"
echo "Fork .gitattributes merge=ours entries are now active for this clone."
