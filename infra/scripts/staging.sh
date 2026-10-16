#!/usr/bin/env bash
# Starts or stops the staging stack to save memory on the shared server. Usage: staging.sh <start|stop|status>
set -euo pipefail
ACTION="${1:?start|stop|status}"
cd /opt/phl/staging
[[ -f runtime.env ]] || { echo "staging has not been deployed yet"; exit 1; }
compose() { docker compose -p phl-staging --env-file .env --env-file runtime.env "$@"; }
case "$ACTION" in
  start) compose start ;;
  stop) compose stop ;;
  status) compose ps ;;
  *) echo "unknown action: $ACTION"; exit 2 ;;
esac
