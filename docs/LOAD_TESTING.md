# Load and concurrency testing

Run load tests only against a dedicated staging environment that matches the intended production instance count, database plan, pool settings, and worker settings. Never point these scripts at production or production data. A successful laptop run is not deployment evidence: record results from a staging run with production-equivalent sizing and monitoring enabled.

## Prerequisites

- Apply the current PostgreSQL migrations to a dedicated, non-production load-test database.
- Install k6 on Windows using `winget install --id GrafanaLabs.k6 --exact` or `choco install k6`, then open a new terminal and verify `k6 version`.
- Install backend dependencies with `npm install` in `backend`.
- Create or verify an explicitly dedicated staging/test database. Set `LOADTEST_DATABASE_URL` to that database only; do not rely on `DATABASE_URL`.
- Choose a staging admin account (or several for higher admin concurrency) and set its credentials as environment variables. Never put credentials in the repository or in a committed file.

## Seed and token setup (PowerShell)

Review the database host and database name before running the seed. The seed and cleanup scripts require both `LOADTEST_ALLOW=true` and a non-production `NODE_ENV`; they refuse to fall back to the regular application database URL.

```powershell
$env:NODE_ENV = 'test'
$env:LOADTEST_ALLOW = 'true'
$env:LOADTEST_DATABASE_URL = 'postgres://<dedicated-test-user>:<password>@<staging-db-host>/<loadtest-db>'
$env:LOADTEST_PASSWORD = '<unique-load-test-account-password>'
$env:LOADTEST_ADMIN_USER_ID = '<provisioned-test-admin-uuid>'
npm run loadtest:seed
```

The seed creates 1,000 passenger accounts, 150 approved driver accounts and vehicles, ten workplaces, 300 trips, and 400 pending ride requests. Future fixtures are scheduled across the coming week at 05:00, 14:00, and 22:00 Johannesburg time; 20 accepted trips are also placed within the driver scenario's 90-minute start window so it can exercise trip execution. `LOADTEST_ADMIN_USER_ID` must resolve to an active admin in that dedicated test database; fixture trips are attributed to that admin, not to a passenger or driver. The seed refuses to run if the admin is missing or if prior load-test accounts exist. Do not manually remove or broaden the seed's fixture scope.
After a successful seed it also writes `loadtest/fixtures.json`, containing fixture identifiers and lifecycle states for the k6 driver execution scenario. This generated file is git-ignored and is removed by the guarded cleanup command.

Token creation logs in sequentially and observes `Retry-After`. The login endpoint's shared-IP ceiling means generating the full token set takes approximately one hour; avoid parallelizing login requests. Admin test accounts must be provisioned separately in staging. Use `LOADTEST_ADMIN_CREDENTIALS` as a JSON array of `{ "email": "...", "password": "..." }` objects to supply multiple admin accounts, or the singular `LOADTEST_ADMIN_EMAIL` and `LOADTEST_ADMIN_PASSWORD` variables for a low-concurrency run. The 50-admin mixed scenario requires 50 provisioned admin accounts to avoid concentrating all admin traffic on one per-user rate limit.

```powershell
$env:LOADTEST_ENVIRONMENT = 'staging'
$env:LOADTEST_BASE_URL = 'https://<staging-host>'
$env:LOADTEST_ADMIN_CREDENTIALS = '[{"email":"<staging-admin>","password":"<secret>"}]'
npm run loadtest:tokens
```

`LOADTEST_PASSENGER_TOKEN_COUNT` and `LOADTEST_DRIVER_TOKEN_COUNT` can reduce the number of accounts for smoke tests (maximums are 1,000 and 150). `loadtest/tokens.json` contains bearer credentials, is ignored by git, and must be treated as a secret. Remove it after the run.

## k6 scenarios

Each script requires `LOADTEST_ENVIRONMENT=staging` (or `test`), `LOADTEST_ALLOW=true`, `LOADTEST_BASE_URL`, and a locally generated `loadtest/tokens.json`.

```powershell
$env:LOADTEST_ALLOW = 'true'
$env:LOADTEST_ENVIRONMENT = 'staging'
$env:LOADTEST_BASE_URL = 'https://<staging-host>'
k6 run loadtest/passenger.js
k6 run loadtest/driver.js
k6 run loadtest/admin.js
k6 run loadtest/spike.js
k6 run loadtest/soak.js
k6 run loadtest/mixed.js
```

The scripts include ETag-aware polling, randomized polling jitter, server-provided polling delays, and bounded backoff on throttling or server errors. The spike scenario ramps from zero to 1,000 virtual users in two minutes and holds for five minutes; the soak scenario holds 300 virtual users for 30 minutes. The mixed scenario uses 700 passenger, 250 driver, and 50 admin virtual users. k6 thresholds encode p95 read latency below 500 ms, p95 write latency below 1,000 ms, and request failure rate below 0.5%. A passing threshold does not substitute for reviewing 5xx counts, database connections, pool waiters, or worker lag.

The current API does not expose a dedicated calendar endpoint. The admin script exercises the available dashboard, trip list/live list, needs-attention, pending-request, trip creation, eligible-driver, and offer endpoints; it does not claim to benchmark an unimplemented calendar API.

## Concurrency integration tests

The backend concurrency suite requires a disposable, dedicated PostgreSQL database containing the load-test fixtures. Configure `LOADTEST_DATABASE_URL` and `LOADTEST_ALLOW=true` only after verifying that database, then run:

```powershell
$env:NODE_ENV = 'test'
$env:LOADTEST_ALLOW = 'true'
$env:LOADTEST_DATABASE_URL = 'postgres://<dedicated-test-user>:<password>@<staging-db-host>/<loadtest-db>'
$env:LOADTEST_ADMIN_USER_ID = '<provisioned-test-admin-uuid>'
npm run test:concurrency
```

The suite requires a provisioned staging admin UUID for trip mutation checks. Concurrency scenarios mutate seeded fixtures, so clean and reseed the dedicated database before every repeat run. Without explicit load-test opt-in and a dedicated URL, the regular backend unit-test suite skips the database integration tests, while `npm run test:concurrency` fails closed. Do not run concurrency tests against production or a shared staging database that contains non-fixture data; the suite never falls back to `DATABASE_URL`.

## Interpreting and recording a run

Review the k6 summary together with `/metrics`, application structured logs, PostgreSQL connection/CPU metrics, and worker lag. The deployment targets are p95 reads below 500 ms, p95 writes below 1,000 ms, errors below 0.5%, zero 5xx responses during the full 30-minute soak, no database connection exhaustion, and worker lag below 60 seconds. Investigate any rate limiting, timeouts, connection waiters, or worker backlog even if aggregate thresholds pass.

| Date (UTC) | Commit | App/DB plan sizes | Virtual users / duration | p95 reads | p95 writes | Error rate | 5xx during soak | Peak pool waiters | Peak worker lag | Bottleneck found | Fix / follow-up |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| | | | | | | | | | | | |

After testing, remove only the generated load-test fixture data using the guarded cleanup script, after confirming the same dedicated database URL:

```powershell
npm run loadtest:clean
```
