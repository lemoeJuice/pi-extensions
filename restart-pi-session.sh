#!/usr/bin/env bash
set -euo pipefail

# Compatibility name: reload the same session in place, without terminating Pi,
# creating a second writer, or guessing a session file by modification time.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec node "$script_dir/reload-pi-sessions.mjs" --current "$@"
