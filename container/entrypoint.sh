#!/bin/bash
set -e

# Shadow .env so the agent cannot read host secrets (requires root)
# Create empty file to bind over .env instead of using /dev/null
if [ "$(id -u)" = "0" ] && [ -f /workspace/project/.env ]; then
  touch /tmp/empty_env
  mount --bind /tmp/empty_env /workspace/project/.env
fi

# Compile agent-runner
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Capture stdin (secrets JSON) to temp file
cat > /tmp/input.json

# Drop privileges if running as root (main-group containers)
if [ "$(id -u)" = "0" ] && [ -n "$RUN_UID" ]; then
  chown "$RUN_UID:$RUN_GID" /tmp/input.json /tmp/dist
  exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups -- node /tmp/dist/index.js < /tmp/input.json
fi

exec node /tmp/dist/index.js < /tmp/input.json
