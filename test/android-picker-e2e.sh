#!/usr/bin/env bash
set -euo pipefail
# Keep the device guard and artifact collection in one cross-platform runner.
node "$(dirname "$0")/android-picker-emulator.js" "$@"
