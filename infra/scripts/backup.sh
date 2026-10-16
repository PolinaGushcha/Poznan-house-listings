#!/usr/bin/env bash
# Database backup to S3 (Frankfurt, encrypted). Runs on the server.
# Usage: backup.sh <staging|production> [label]   — nightly via phl-backup.timer for production.
# Targets (Q-30): max 24 h data loss; daily dumps kept 35 days by the bucket lifecycle rule.
set -euo pipefail
ENVIRONMENT="${1:?environment required (staging|production)}"
LABEL="${2:-nightly}"
[[ "$ENVIRONMENT" =~ ^(staging|production)$ ]] || { echo "invalid environment: $ENVIRONMENT"; exit 2; }
[[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid label: $LABEL"; exit 2; }
# shellcheck disable=SC1091
source /opt/phl/host.env # PHL_OPS_BUCKET

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
KEY="backups/$ENVIRONMENT/$STAMP-$LABEL.sql.gz"

cd "/opt/phl/$ENVIRONMENT"
# Credentials stay inside the db container (its own POSTGRES_* variables); nothing is printed.
# shellcheck disable=SC2016 # expanded inside the container, not here
docker compose -p "phl-$ENVIRONMENT" --env-file .env --env-file runtime.env exec -T db \
  sh -c 'pg_dump --no-owner --format=plain -U "$POSTGRES_USER" -d "$POSTGRES_DB"' |
  gzip -9 |
  aws s3 cp --only-show-errors --sse AES256 - "s3://$PHL_OPS_BUCKET/$KEY"

echo "backup written: s3://$PHL_OPS_BUCKET/$KEY"
