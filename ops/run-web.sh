#!/usr/bin/env bash
# Entry point for launchd: load ~/althingi/.env, serve on 127.0.0.1:3050 with the READ-ONLY database role.
set -euo pipefail
export PATH=$HOME/.bun/bin:/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:$PATH
cd "$(dirname "$0")/.."
set -a; . "$HOME/althingi/.env"; set +a
export PORT=${PORT:-3050}
exec bun src/server.ts
