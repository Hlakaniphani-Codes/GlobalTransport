# Monitoring

## Metrics endpoint

`GET /metrics` returns Prometheus text exposition and requires
`Authorization: Bearer <METRICS_TOKEN>`. Set `METRICS_TOKEN` in every backend
environment; production startup refuses to run without it. Keep the token in
the deployment secret store and do not include it in dashboards or logs.

From PowerShell, inspect the endpoint without printing the token:

```powershell
$headers = @{ Authorization = "Bearer $env:METRICS_TOKEN" }
Invoke-WebRequest -Uri "https://<staging-api>/metrics" -Headers $headers
```

The application exports:

| Metric | Meaning |
|---|---|
| `http_requests_total` | Completed requests, grouped by route pattern and status class |
| `http_request_duration_seconds` | Request latency histogram, grouped by route pattern and status class |
| `http_requests_in_flight` | Requests currently being handled |
| `event_loop_lag_seconds` | Mean event-loop delay since the previous scrape |
| `db_pool_total_connections`, `db_pool_idle_connections`, `db_pool_waiting_connections` | PostgreSQL pool state |
| `db_query_duration_seconds` | Query latency histogram grouped by route pattern |
| `worker_tick_duration_seconds`, `worker_oldest_due_job_age_seconds` | Worker runtime and oldest unclaimed due-job age |
| `notification_jobs` | Current job count by status |
| `active_offers`, `trips_in_progress` | Current pending, unexpired offers and in-progress trips |

Business gauges refresh at most once every 15 seconds. The route label uses
Express route patterns; unmatched requests use the single `unmatched` label to
avoid cardinality growth and accidental exposure of request paths.

## Recommended alerts

Use a five-minute evaluation window unless otherwise noted. Tune notification
thresholds only after collecting staging baselines.

| Alert | Suggested condition |
|---|---|
| API error rate | `sum(rate(http_requests_total{status_class=~"5xx"}[5m])) / clamp_min(sum(rate(http_requests_total[5m])), 1) > 0.005` |
| Read p95 latency | `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{route=~"<read-route-patterns>"}[5m]))) > 0.5` seconds |
| Write p95 latency | Same query for write route patterns, threshold `1` second |
| Database pool waiters | `db_pool_waiting_connections > 0` for one minute; page if sustained or increasing |
| Worker lag | `worker_oldest_due_job_age_seconds > 60` for two consecutive scrapes |
| Failed notification share | `sum(notification_jobs{status="failed"}) / clamp_min(sum(notification_jobs), 1) > 0.05` for 10 minutes |
| Database CPU | Alert at sustained 80% utilization; use the database provider's database metrics |
| Database connections | Alert at 80% of the plan's connection limit and verify the 20% reserve remains available |

For latency queries, replace `<read-route-patterns>` and the write equivalent
with the route patterns used by the deployed app. The HTTP histogram has a
`status_class` label as well; exclude aborted or failed classes if the alert is
intended to describe only successful responses.

## Logs and tracing

Backend logs are structured JSON and contain request ID, Express route pattern,
status, and duration. Unmatched routes are logged as `unmatched`; query strings,
request bodies, and personal fields are not logged. Slow-query logs include a
normalized statement with literal values removed.

When `SENTRY_DSN` is configured, the optional Sentry SDK samples performance
traces at 5%. Default PII is disabled and request user, body, headers, cookies,
and breadcrumbs are removed before events are sent.

Configure Render's health check path as `/health/ready`. It returns success
only when PostgreSQL responds within 400 ms, every migration file is recorded
as applied, and the local worker heartbeat is less than two minutes old.
`/health/live` checks only that the process can serve requests.
