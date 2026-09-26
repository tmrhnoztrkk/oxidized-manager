#!/bin/sh
# End-to-end test: builds the image, starts two managers, fake devices and Gitea, runs e2e.py.
#   tests/e2e/run.sh           run and tear down
#   KEEP=1 tests/e2e/run.sh    leave the containers running afterwards (UI: http://localhost:18080)
set -eu
cd "$(dirname "$0")"
DC="docker compose -f docker-compose.e2e.yml"
cleanup() { [ "${KEEP:-0}" = "1" ] || $DC down -v --remove-orphans >/dev/null 2>&1; }
trap cleanup EXIT

$DC down -v --remove-orphans >/dev/null 2>&1 || true
$DC build --quiet
$DC up -d --wait hq branch r1 r2 r3 gitea

echo "waiting for Gitea…"
for i in $(seq 1 60); do
  $DC exec -T gitea curl -fs http://localhost:3000/api/v1/version >/dev/null 2>&1 && break
  sleep 2
done
$DC exec -T -u git gitea gitea admin user create --admin --username gadmin --password Gitea-pass-123 \
  --email gadmin@example.com --must-change-password=false >/dev/null

status=0
$DC exec -T hq /opt/oxmgr/venv/bin/python /e2e/e2e.py || status=$?
if [ "$status" != "0" ]; then
  echo "---- hq logs";     $DC logs --tail=80 hq
  echo "---- branch logs"; $DC logs --tail=40 branch
fi
exit $status
