#!/usr/bin/env bash
# Runs ON THE SERVER via AWS Systems Manager (see .github/actions/ssm-run).
# Usage: deploy.sh <staging|production> <image-tag>
# Steps: fetch release bundle and configuration → pre-deploy backup (production) → pull images
#        → start containers → health checks → automatic revert to the previous tag if unhealthy.
set -euo pipefail

ENVIRONMENT="${1:?environment required (staging|production)}"
TAG="${2:?image tag required}"
[[ "$ENVIRONMENT" =~ ^(staging|production)$ ]] || { echo "invalid environment: $ENVIRONMENT"; exit 2; }
[[ "$TAG" =~ ^[0-9a-f]{7,40}$ ]] || { echo "invalid image tag: $TAG"; exit 2; }

# shellcheck disable=SC1091
source /opt/phl/host.env # PHL_OPS_BUCKET, AWS_REGION, ECR_REGISTRY (written at instance creation)
export AWS_REGION ECR_REGISTRY

RELEASE_DIR="/opt/phl/releases/$TAG"
ENV_DIR="/opt/phl/$ENVIRONMENT"
mkdir -p "$RELEASE_DIR" "$ENV_DIR"

echo "==> Fetching release bundle $TAG"
aws s3 cp --only-show-errors "s3://$PHL_OPS_BUCKET/deploy/$TAG/bundle.tar.gz" - | tar -xz -C "$RELEASE_DIR"

write_env() { # $1 = SSM path, $2 = target file — values are never printed
  aws ssm get-parameters-by-path --path "$1" --with-decryption --recursive \
    --query 'Parameters[].[Name,Value]' --output text |
    awk -F'\t' -v p="$1" '
      # Values are single-quoted so docker compose keeps "$" literally (bcrypt hashes, passwords)
      index($2, "\047") { printf "parameter %s contains a single quote — not supported\n", $1 > "/dev/stderr"; bad=1; next }
      { name=$1; sub(p, "", name); print name "=\047" $2 "\047" }
      END { exit bad }' >"$2.tmp"
  chmod 600 "$2.tmp" && mv "$2.tmp" "$2"
}

echo "==> Updating edge proxy"
write_env "/phl/edge/" /opt/phl/edge/.env
cp "$RELEASE_DIR"/infra/compose/edge/* /opt/phl/edge/
docker network inspect edge >/dev/null 2>&1 || docker network create edge
(cd /opt/phl/edge && docker compose up -d --remove-orphans)

echo "==> Writing $ENVIRONMENT configuration"
write_env "/phl/$ENVIRONMENT/" "$ENV_DIR/.env"
cp "$RELEASE_DIR/infra/compose/app/compose.yml" "$ENV_DIR/compose.yml"
install -m 755 "$RELEASE_DIR/infra/scripts/backup.sh" /opt/phl/backup.sh
install -m 755 "$RELEASE_DIR/infra/scripts/staging.sh" /opt/phl/staging.sh

if [[ "$ENVIRONMENT" == "staging" ]]; then
  export WEB_MEM_LIMIT=384m API_MEM_LIMIT=256m DB_MEM_LIMIT=384m
fi
export APP_ENV="$ENVIRONMENT"

compose() { (cd "$ENV_DIR" && docker compose -p "phl-$ENVIRONMENT" "$@"); }

if [[ "$ENVIRONMENT" == "production" && -f "$ENV_DIR/runtime.env" ]] && compose ps --status running --services 2>/dev/null | grep -q '^db$'; then
  echo "==> Pre-deploy database backup"
  /opt/phl/backup.sh production "pre-deploy-$TAG"
fi

aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY" >/dev/null

PREVIOUS_TAG="$(cat "$ENV_DIR/current_tag" 2>/dev/null || true)"

start() {
  IMAGE_TAG="$1" compose pull --quiet
  IMAGE_TAG="$1" compose up -d --remove-orphans
}

healthy() { # waits up to 120 s for web and api containers to report healthy
  for _ in $(seq 1 24); do
    local unhealthy=0
    for svc in web api; do
      local id status
      id="$(compose ps -q "$svc")"
      status="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo missing)"
      [[ "$status" == "healthy" ]] || unhealthy=1
    done
    [[ $unhealthy -eq 0 ]] && return 0
    sleep 5
  done
  return 1
}

# Database migrations run here once the API has them (M1): IMAGE_TAG="$TAG" compose run --rm api npm run migrate

echo "==> Starting $ENVIRONMENT with image tag $TAG"
start "$TAG"
# Remembers what is running so backup.sh and staging.sh can call docker compose without deploy.sh
write_runtime_env() { # $1 = image tag now running
  {
    echo "APP_ENV=$APP_ENV"
    echo "ECR_REGISTRY=$ECR_REGISTRY"
    echo "IMAGE_TAG=$1"
    echo "WEB_MEM_LIMIT=${WEB_MEM_LIMIT:-512m}"
    echo "API_MEM_LIMIT=${API_MEM_LIMIT:-384m}"
    echo "DB_MEM_LIMIT=${DB_MEM_LIMIT:-768m}"
  } >"$ENV_DIR/runtime.env"
}

if healthy; then
  write_runtime_env "$TAG"
  echo "$PREVIOUS_TAG" >"$ENV_DIR/previous_tag"
  echo "$TAG" >"$ENV_DIR/current_tag"
  echo "==> $ENVIRONMENT is healthy on $TAG"
else
  echo "!! Health checks failed for $TAG"
  compose ps
  compose logs --tail 50 web api || true
  if [[ -n "$PREVIOUS_TAG" ]]; then
    echo "==> Reverting to previous tag $PREVIOUS_TAG"
    start "$PREVIOUS_TAG"
    write_runtime_env "$PREVIOUS_TAG"
    if healthy; then echo "==> Reverted to $PREVIOUS_TAG"; else echo "!! Revert also unhealthy — manual action needed"; fi
  fi
  exit 1
fi

if [[ "$ENVIRONMENT" == "production" ]]; then
  echo "==> Installing nightly backup timer"
  install -m 644 "$RELEASE_DIR/infra/scripts/phl-backup.service" /etc/systemd/system/phl-backup.service
  install -m 644 "$RELEASE_DIR/infra/scripts/phl-backup.timer" /etc/systemd/system/phl-backup.timer
  systemctl daemon-reload
  systemctl enable --now phl-backup.timer
fi

docker image prune -af --filter "until=168h" >/dev/null || true
