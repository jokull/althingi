#!/usr/bin/env bash
# Run ON THE LAPTOP. Syncs the repo to the mac-mini, installs deps, (re)loads the launchd service for the web app.
# The service listens on 127.0.0.1 only; exposure through Cloudflare is a separate, deliberate step (WP7).
set -euo pipefail
cd "$(dirname "$0")/.."
rsync -a --delete --exclude node_modules --exclude .git --exclude 'fixtures/sample/lagasafn_allt.zip' ./ mac-mini:Code/althingi/
ssh mac-mini "bash -s" <<'REMOTE'
set -e
export PATH=$HOME/.bun/bin:/opt/homebrew/bin:$PATH
cd ~/Code/althingi && bun install --silent
cp ops/com.jokull.althingi-web.plist ~/Library/LaunchAgents/
SVC=gui/$(id -u)/com.jokull.althingi-web
launchctl bootout "$SVC" 2>/dev/null || true
# bootout is asynchronous: wait until the service is really gone, then bootstrap with retries
for i in $(seq 1 15); do launchctl print "$SVC" >/dev/null 2>&1 || break; sleep 1; done
ok=0
for i in 1 2 3 4 5; do
  if launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jokull.althingi-web.plist 2>/dev/null; then ok=1; break; fi
  sleep 2
done
[ "$ok" = 1 ] || { echo "FAILED to bootstrap the web service" >&2; exit 1; }
launchctl kickstart -k "$SVC"
# the deploy only counts as done when the site answers
for i in $(seq 1 20); do
  if curl -fsS -m 3 http://127.0.0.1:3050/healthz >/dev/null 2>&1; then echo "healthz ok"; exit 0; fi
  sleep 1
done
echo "web service did not become healthy" >&2; exit 1
REMOTE
echo "deployed; check: ssh mac-mini curl -s localhost:3050/healthz"
