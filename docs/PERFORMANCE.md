# Performance and reliability

## Production targets

At 1,000 concurrent users:

- Read response-time p95: under 500 ms.
- Write response-time p95: under 1,000 ms.
- Error rate: under 0.5%.
- No HTTP 5xx responses during a 30-minute soak test.
- Database connections are never exhausted.
- Background worker lag stays under 60 seconds.

These targets must be measured against a staging environment with production-equivalent service and database plans. See `docs/LOAD_TESTING.md` when the repeatable load-test suite is available. Do not treat mocked tests, a developer laptop, or unseeded query plans as proof of these targets.

## PostgreSQL connection budget

Pool settings are controlled by `DB_POOL_MAX` (default 10), `DB_POOL_MIN` (default 0), `DB_IDLE_TIMEOUT_MS` (default 30000), and `DB_CONNECT_TIMEOUT_MS` (default 5000). Each API instance creates its own pool. Include worker and migration connections in the calculation:

```text
peak connections =
  (API instances x DB_POOL_MAX)
  + worker connections
  + migration connections
  + other operational connections
```

Keep the calculated peak at or below 80% of the PostgreSQL plan's connection limit; the remaining 20% is reserved for maintenance and operational access. If the calculation exceeds that budget, lower the per-instance pool size or instance count before deployment. Do not rely on connection timeouts as capacity management.

| Render PostgreSQL plan | PostgreSQL connection limit | API instances | DB_POOL_MAX | Worker connections | Migration/operations connections | Calculated peak | 80% budget | Within budget? |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| To be selected | To be confirmed | To be selected | 10 default | To be measured | To be confirmed | — | — | Pending |

Set `STATEMENT_TIMEOUT_MS` (default 15000) and `IDLE_IN_TRANSACTION_TIMEOUT_MS` (default 15000) to bound expensive statements and abandoned transactions. Slow queries are logged when they exceed `SLOW_QUERY_MS` (default 200); query text is normalized and parameter values are not logged.
