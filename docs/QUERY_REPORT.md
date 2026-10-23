# Query audit report

## Scope and measurement status

This is the code-level inventory for current backend read paths used by the mobile app and admin web app. The database tests currently mock `pool.query`; they do not provide production-like PostgreSQL plans or timings. Before recording timings, Task 10 must create a disposable test database with the guarded load-test seed. Run each candidate as `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` against that database, capture the JSON, and compare before/after results. No timings are fabricated here.

A dedicated calendar endpoint and a support inbox endpoint/service were not found in the current routes. The planner uses date-filtered `/api/v1/admin/trips` and `/api/v1/admin/ride-requests` queries. The current support experience does not expose an inbox query.

## Endpoint and query inventory

| Surface | Route and service | Query shape to review |
| --- | --- | --- |
| Driver home | `GET /api/v1/driver/home`, `driverTripService.getHome` | Seven concurrent profile, next-trip, count, offer, overdue, acknowledgement, and in-progress queries; correlated stop lookups. |
| Driver offers | `GET /api/v1/driver/offers`, `driverTripService.listOffers` | Offer/trip join with passenger-count and suburb aggregates; currently runs offer expiry processing before the read. |
| Driver upcoming/history | `GET /api/v1/driver/trips`, `driverTripService.listTrips` | Upcoming uses count plus bounded offset pages; history uses 25-row timestamp/UUID cursor pages. The query includes correlated stop, request, exception, and no-show counts. |
| Driver trip detail | `GET /api/v1/driver/trips/:tripId`, `driverTripExecutionService.loadTrip` | Trip, ordered stops/passengers, passenger count, and event history. |
| Passenger trips/history | `GET /api/v1/rides/trips`, `passengerTripService` | Upcoming remains bounded at 100; history uses 25-row timestamp/UUID cursor pages. The query includes own-stop JSON and correlated rating/status counts. |
| Passenger active trip | `GET /api/v1/rides/trips/:tripId`, `passengerTripService.getMine` | Trip/request detail, own stop JSON, ratings, and a second ordered all-stop query for ETA projection. |
| Passenger requests | `GET /api/v1/ride-requests`, `rideRequestService.listMine` | 25-row timestamp/UUID cursor pages with the repeat-weekday correlated subquery. |
| Passenger notification inbox | `GET /api/v1/notifications`, `notifications.listNotifications` | Cursor query over `(created_at, id)` plus unread count. |
| Admin notification log | `GET /api/v1/admin/notifications`, `notifications.listNotificationLog` | Count plus page query over recent jobs/notifications/users. |
| Admin planning requests | `GET /api/v1/admin/trip-requests`, `rideRequestService.listPendingRequests` | Pending unassigned requests joined to passengers, users, workplaces, and companies; page-based, default 25/max 100. |
| Admin request list | `GET /api/v1/admin/ride-requests`, `adminRideRequestService.list` | Count plus filtered page query with user/workplace joins and search predicates. |
| Admin eligible drivers | `GET /api/v1/admin/eligible-drivers`, `tripService.listEligibleDrivers` | Eligibility joins with active-trip and pending-offer anti-joins. |
| Admin trips/planner calendar | `GET /api/v1/admin/trips`, `tripAdminService.listTrips` | Count plus filtered page query, with correlated passenger count. Date filters are the planner's calendar data source. |
| Admin live trips | `GET /api/v1/admin/trips/live`, `tripAdminService.listLiveTrips` | In-progress trips with active-stop JSON, event time, incidents, no-show, and exception aggregates; page-based, default 25/max 100. |
| Admin trip detail | `GET /api/v1/admin/trips/:tripId`, `tripAdminService.getTrip` | Trip detail plus parallel stop, passenger, offer, event, rating, and withdrawal queries. |
| Admin dashboard | `GET /api/v1/admin/dashboard/summary`, `operationsController.dashboardSummary` | Five concurrent counts/aggregates, including currently unassigned and today's trip states. |
| Admin needs attention | `GET /api/v1/admin/needs-attention`, `incidentService.getNeedsAttention` | Fifteen concurrent bounded queries/aggregates for documents, incidents, lifecycle events, withdrawals, trips, and notifications. |
| Admin incidents | `GET /api/v1/admin/incidents`, `incidentService.list` | Count plus filtered page query, emergency/status priority ordering. |
| Admin documents/application queues | `GET /api/v1/admin/drivers`, `/drivers/applications`, `/vehicles`, `/vehicles/pending`, `/vehicles/applications`, `reviewService` | Page-based, default 25/max 100; inventory, pending queues, and application queues return pagination metadata. |
| Public/reference data | `GET /api/v1/workplaces`, `/api/v1/admin/companies`, `/api/v1/admin/workplaces`, `workplaceService` | Ordered bounded lists; page-based, default 25/max 100. Existing desktop/mobile admin clients aggregate pages for selector data; Fleet uses visible page navigation. |
| Support inbox | Not present | No support inbox route or service exists to audit. |

## Pagination and index changes

Page normalization, metadata, and opaque cursor encoding/validation are centralized in `backend/src/utils/pagination.js`. Page-based services clamp to a maximum of 100. Notification, passenger trip/request, and driver trip histories and driver offers use cursor pages; tests cover cursor boundaries and continuation predicates. Some bounded per-user/detail responses still need a route-by-route decision on whether they are list endpoints.

Migration `012_performance_indexes.sql` adds idempotent partial/composite indexes for pending notification dequeue order, live trips, changed-trip acknowledgement queues, passenger-specific trip stops, recent withdrawals, and recent declined offers. These are candidates based on query predicates and ordering; retain them only after comparing plans and write/storage cost on the seeded database.

The passenger upcoming-trips route, approved-driver directory, and eligible-driver endpoints now use the shared pagination helper with a default page size of 25 and a maximum of 100. The admin trip planner requests bounded pages while preserving access to all eligible drivers. Transactional offer checks restrict eligibility queries to the selected or queued driver IDs. The admin needs-attention and trip-detail read paths also use explicit projections instead of wildcard column selection. Tests cover the page-size clamps and the needs-attention projection.

The route-by-route SQL review and the seeded `EXPLAIN (ANALYZE, BUFFERS)` comparison are not complete yet. In particular, migration `012` has not been validated against representative seeded query plans, and the ten-row timing table below must remain unfilled until measurements are captured. Complete that measurement pass after the guarded Task 10 seed is available; do not infer timings from mocked tests or local development data.

## Slowest-query comparison

Pending the disposable seeded PostgreSQL database. Fill in the ten slowest read/write statements from `pg_stat_statements` and representative endpoint plans, including buffer counts and row estimates, then record before/after values after index/query changes.

| Rank | Route/query | Before p95 / execution ms | Before buffers | Change | After p95 / execution ms | After buffers |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| 1 | Pending seeded measurement | — | — | — | — | — |
| 2 | Pending seeded measurement | — | — | — | — | — |
| 3 | Pending seeded measurement | — | — | — | — | — |
| 4 | Pending seeded measurement | — | — | — | — | — |
| 5 | Pending seeded measurement | — | — | — | — | — |
| 6 | Pending seeded measurement | — | — | — | — | — |
| 7 | Pending seeded measurement | — | — | — | — | — |
| 8 | Pending seeded measurement | — | — | — | — | — |
| 9 | Pending seeded measurement | — | — | — | — | — |
| 10 | Pending seeded measurement | — | — | — | — | — |

## `pg_stat_statements`

Enable the extension through the selected PostgreSQL plan's supported `shared_preload_libraries` configuration, restart PostgreSQL if required, then run `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` in the application database. Review aggregate query statistics with `pg_stat_statements` and reset only in a disposable benchmark database before a measured run. Confirm plan support and permissions with the database provider; do not change production database settings during this code audit.
