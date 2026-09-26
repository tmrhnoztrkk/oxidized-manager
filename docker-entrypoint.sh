#!/bin/sh
# Hands the data directory to the oxidized user and starts the manager without root.
set -e
DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
if [ "$(id -u)" = "0" ]; then
  # Bind mounts are created as root; only fix ownership when it differs (fast start with large git repos)
  if [ "$(stat -c %u "$DATA_DIR")" != "30000" ]; then
    chown -R oxidized:oxidized "$DATA_DIR"
  fi
  exec setpriv --reuid=oxidized --regid=oxidized --init-groups "$0" "$@"
fi
exec /opt/oxmgr/venv/bin/uvicorn app.main:app --app-dir /opt/oxmgr \
  --host 0.0.0.0 --port "${PORT:-8080}" --proxy-headers --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-127.0.0.1}" "$@"
