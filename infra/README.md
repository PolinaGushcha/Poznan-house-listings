# Infrastructure

AWS setup for Poznan house listings, following **ADR-002**: the cheapest setup that still hosts the app in Poland.

| Part               | What                                                                                 | Where                                   |
| ------------------ | ------------------------------------------------------------------------------------ | --------------------------------------- |
| Server             | 1 × EC2 `t3.medium`, Amazon Linux 2023, 30 GB gp2 (encrypted), Elastic IP            | Warsaw Local Zone `eu-central-1-waw-1a` |
| Runtime            | Docker Compose: Caddy (HTTPS) + `phl-production` + `phl-staging` (web, api, PostGIS) | on the server                           |
| Images             | ECR `phl-web`, `phl-api` (immutable tags, scan on push, last 30 kept)                | Frankfurt `eu-central-1`                |
| Ops bucket         | `deploy/` bundles (90 days), `backups/` database dumps (35 days)                     | Frankfurt                               |
| Config and secrets | SSM Parameter Store `/phl/edge/`, `/phl/staging/`, `/phl/production/`                | Frankfurt                               |
| CI/CD access       | GitHub OIDC role `phl-github-deploy`, SSM Run Command (no SSH)                       | IAM                                     |
| Cost guard         | AWS Budget alert at 80 % and 100 % of the monthly limit                              | Billing                                 |
| Volume snapshots   | Weekly EBS snapshot (Sunday 01:00 UTC), 8 kept, via Data Lifecycle Manager           | Frankfurt                               |
| Alarms             | Status check, CPU > 80 %, low CPU credits → email (SNS)                              | CloudWatch                              |

Expected cost: about $40–50 a month (instance, gp2 volume, Elastic IP, ECR and S3). Check the AWS Pricing Calculator before you deploy.

```text
infra/
  cdk/       CDK app (TypeScript) – all AWS resources in one stack, PhlStack
  compose/   edge/ (Caddy) and app/ (one stack per environment)
  scripts/   deploy.sh, backup.sh, staging.sh, systemd backup timer
```

## Safe commands (no AWS changes)

```bash
cd infra/cdk
npm ci
npm test          # assertions on the generated template
npx cdk synth     # writes cdk.out/, contacts nothing
```

## First-time setup

> ⚠️ Steps marked **[confirm]** create billable resources or change live systems. Run them only after you have decided to go ahead.

### 1. Opt in to the Warsaw Local Zone [confirm]

```bash
aws ec2 modify-availability-zone-group --region eu-central-1 \
  --group-name eu-central-1-waw-1 --opt-in-status opted-in
```

### 2. Fill in `infra/cdk/cdk.json`

- `alertEmail`: receives the budget alert and the server alarms (status check, CPU, CPU credits). Confirm the subscription email from AWS. If you leave it empty, no budget or alarms are created.
- `monthlyBudgetUsd`: default `60`.
- `existingGithubOidcProviderArn`: set it only if your account already has the GitHub OIDC provider. Otherwise leave it empty and the stack creates one.
- `githubRepository`: already `PolinaGushcha/Poznan-house-listings`.

### 3. Deploy the stack [confirm]

```bash
cd infra/cdk
npx cdk bootstrap aws://<account-id>/eu-central-1   # once per account and region
npx cdk diff                                        # review what will be created
npx cdk deploy                                      # creates the resources
```

Note the outputs: `InstanceId`, `PublicIp`, `OpsBucketName`, `DeployRoleArn` and the ECR repository URIs.

The ops bucket is kept (RETAIN) if the stack is ever deleted, so backups survive. Deleting the stack is irreversible for the server and its data volume. Back up first, and only do it on purpose.

### 4. Create the SSM parameters

Use **SecureString** for anything secret. The variable name is the last part of the path. Values must not contain a single quote (`'`).

**`/phl/edge/`** (Caddy):

| Name                      | Example                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `ACME_EMAIL`              | your email address (Let's Encrypt notices)                                              |
| `PRODUCTION_DOMAIN`       | `<your-domain>`                                                                         |
| `STAGING_DOMAIN`          | `staging.<your-domain>`                                                                 |
| `STAGING_BASIC_AUTH_USER` | e.g. `preview`                                                                          |
| `STAGING_BASIC_AUTH_HASH` | output of `docker run --rm caddy:2-alpine caddy hash-password --plaintext '<password>'` |

**`/phl/production/`** and **`/phl/staging/`** (one set each, with different passwords):

| Name                            | Example                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `POSTGRES_USER`                 | `phl`                                                    |
| `POSTGRES_PASSWORD`             | a long random value (SecureString)                       |
| `POSTGRES_DB`                   | `phl`                                                    |
| `DATABASE_URL`                  | `postgresql://phl:<password>@db:5432/phl` (SecureString) |
| `LOG_LEVEL`                     | `info`                                                   |
| `CORS_ALLOWED_ORIGINS`          | empty (same origin)                                      |
| `OLD_TOWN_LAT` / `OLD_TOWN_LON` | `52.4083` / `16.9339`                                    |

Example:

```bash
aws ssm put-parameter --region eu-central-1 --type SecureString \
  --name /phl/production/POSTGRES_PASSWORD --value '<generated>'
```

`NEXT_PUBLIC_*` values are compiled into the web image at build time, so they are not read from SSM.

### 5. Configure GitHub

Set the repository variables and the `staging` and `production` environments as described in [`docs/ci-cd.md`](../docs/ci-cd.md#github-settings).

### 6. DNS [confirm]

At your domain registrar, create:

- `A <your-domain>` → `PublicIp`
- `A www.<your-domain>` → `PublicIp`
- `A staging.<your-domain>` → `PublicIp`

Caddy gets the HTTPS certificates automatically on the first request after DNS resolves.

### 7. First deploy

Merge to `main`. This deploys staging. Then run **Release to production** (see [`docs/ci-cd.md`](../docs/ci-cd.md)).

## Operations

- **Shell on the server:** AWS console → Systems Manager → Session Manager. No SSH.
- **Logs:** `docker compose -p phl-production logs -f api` (from `/opt/phl/production`).
- **Free memory:** run the **Staging on/off** workflow with `stop`.
- **Backups:** nightly at 02:30 Europe/Warsaw (`systemctl list-timers phl-backup.timer`). Also taken before every production deploy. Manual backup: `/opt/phl/backup.sh production manual`. Weekly volume snapshots (8 kept) cover a full server loss. Targets: up to 24 h of data loss, 4 h to restore.

### Restore a backup

> ⚠️ **[confirm]** This replaces the database contents. First take a fresh backup of the current state.

```bash
# on the server (Session Manager), as root
source /opt/phl/host.env
cd /opt/phl/production
aws s3 ls "s3://$PHL_OPS_BUCKET/backups/production/"          # pick a file
aws s3 cp "s3://$PHL_OPS_BUCKET/backups/production/<file>.sql.gz" /tmp/restore.sql.gz
C="docker compose -p phl-production --env-file .env --env-file runtime.env"
$C stop web api
gunzip -c /tmp/restore.sql.gz | $C exec -T db sh -c \
  'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB" && psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
$C start web api
rm /tmp/restore.sql.gz
```

Practise this on staging before the MVP release.
