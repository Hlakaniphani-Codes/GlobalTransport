# Global Ride Transport

Global Ride Transport coordinates worker commutes between passengers and independent drivers. The platform consists of a PostgreSQL-backed Express API, an Expo mobile app for drivers and passengers, and a React admin web app.

## Requirements

- Node.js and npm
- PostgreSQL
- A reachable API host for the mobile app and admin web app

## Configuration

Copy each folder's `.env.example` to `.env` and set values for the environment. Do not commit `.env` files.

| File | Variable | Purpose |
| --- | --- | --- |
| `backend/.env` | `DATABASE_URL` | PostgreSQL connection string; required before the API or migration runner starts. |
| `backend/.env` | `JWT_SECRET` | Secret used to sign and verify sessions; required before the API starts. Use a long, randomly generated value. |
| `backend/.env` | `NODE_ENV` | Runtime environment, such as `development` or `production`. |
| `backend/.env` | `PORT` | API listen port (defaults to `3000`). |
| `backend/.env` | `CORS_ORIGINS` | Comma-separated allowed web origins; configure the deployed admin origin. |
| `backend/.env` | `DATABASE_SSL` | Enable PostgreSQL TLS when required by the database host. |
| `backend/.env` | `DB_POOL_MAX` | Maximum PostgreSQL connection pool size (defaults to `10`). |
| `backend/.env` | `DB_POOL_MIN`, `DB_IDLE_TIMEOUT_MS`, `DB_CONNECT_TIMEOUT_MS` | PostgreSQL pool minimum, idle timeout (30,000 ms default), and connection timeout (5,000 ms default). |
| `backend/.env` | `STATEMENT_TIMEOUT_MS`, `IDLE_IN_TRANSACTION_TIMEOUT_MS` | PostgreSQL statement and idle-transaction timeouts (15,000 ms defaults). |
| `backend/.env` | `SLOW_QUERY_MS` | Slow-query logging threshold in milliseconds (defaults to `200`). |
| `backend/.env` | `REQUEST_TIMEOUT_MS` | Maximum API request duration in milliseconds (defaults to `30,000`). |
| `backend/.env` | `WORKER_BATCH_SIZE`, `NOTIFICATION_RETENTION_DAYS` | Maximum notification jobs per worker tick (defaults to `200`) and read-notification retention in days (defaults to `90`). |
| `backend/.env` | `REDIS_URL` | Optional Redis URL used only for shared rate-limit storage. Without Redis, production startup warns that rate limits are process-local. |
| `backend/.env` | `METRICS_TOKEN` | Bearer token protecting `/metrics`; required when exposing metrics in production. |
| `backend/.env` | `LOADTEST_ALLOW`, `LOADTEST_DATABASE_URL`, `LOADTEST_PASSWORD` | Explicit opt-in, dedicated disposable database URL and fixture-account password for guarded load-test tools. Never configure these for production. |
| `backend/.env` | `LOADTEST_BASE_URL`, `LOADTEST_ENVIRONMENT`, `LOADTEST_ADMIN_*`, `LOADTEST_*_TOKEN_COUNT` | Staging/test API target and separately provisioned test-admin credentials/token counts. Use only for load testing; keep credentials private. |
| `backend/.env` | `TRIP_START_WINDOW_MINUTES` | Earliest trip-start window for drivers (defaults to `90`). |
| `backend/.env` | `OVERDUE_GRACE_MINUTES` | How long a never-started accepted trip remains startable after its last planned stop (defaults to `30`). |
| `backend/.env` | `AUTO_MISS_AFTER_MINUTES` | Minutes after the last planned stop before an accepted, never-started trip is automatically marked missed (defaults to `60`). |
| `backend/.env` | `LATE_WITHDRAW_HOURS` | A driver withdrawal is flagged late when it is closer than this interval to the first stop (defaults to `12`). |
| `backend/.env` | `UNASSIGNED_ALERT_HOURS` | Admin attention window for trips without an accepted driver (defaults to `3`). |
| `backend/.env` | `REQUEST_EXPIRE_GRACE_MINUTES` | Grace after a pending request's scheduled time before it expires without a trip (defaults to `15`). |
| `backend/.env` | `CHANGE_CANCEL_EXEMPT_HOURS` | Period after a trip change during which passenger cancellation is exempt from late-cancel warning (defaults to `24`). |
| `backend/.env` | `NO_SHOW_WAIT_MINUTES` | Minutes a driver must wait after arrival before reporting a passenger no-show (defaults to `5`). |
| `backend/.env` | `LATE_CANCELLATION_HOURS` | Cancellation threshold for late flags (defaults to `2`). |
| `backend/.env` | `ETA_STALE_MINUTES` | Minutes after which a driver-entered arrival time is considered stale (defaults to `15`). |
| `backend/.env` | `EXPO_ACCESS_TOKEN` | Optional Expo push API access token. |
| `backend/.env` | `SMS_PROVIDER` | SMS transport selection: `none`, `bulksms`, `clickatell`, or `twilio` (defaults to `none`). |
| `backend/.env` | `BULKSMS_USERNAME`, `BULKSMS_PASSWORD` | BulkSMS credentials when that provider is selected. |
| `backend/.env` | `CLICKATELL_API_KEY` | Clickatell credential when that provider is selected. |
| `backend/.env` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Twilio credentials and sender when that provider is selected. |
| `backend/.env` | `OFFER_SMS_FALLBACK_SECONDS` | Delay before an unconfirmed trip-offer push can fall back to SMS (defaults to `120`). |
| `backend/.env` | `TRIP_REMINDER_MINUTES` | Lead time for driver trip reminders (defaults to `60`). |
| `admin/.env` | `VITE_API_URL` | Admin API base URL, including `/api/v1`. |
| `admin/.env` | `VITE_SUPPORT_EMAIL` | Support email shown in the admin app. |
| `mobile/.env` | `EXPO_PUBLIC_API_URL` | API host without `/api/v1`; the mobile client adds that path. |
| `mobile/.env` | `EXPO_PUBLIC_LEGAL_BASE_URL` | Base URL for the published terms and privacy pages. |
| `mobile/.env` | `EXPO_PUBLIC_TRIP_START_WINDOW_MINUTES` | Driver trip-start window displayed by the mobile app (defaults to `90`; keep it aligned with the backend setting). |
| `mobile/.env` | `EXPO_PUBLIC_SUPPORT_PHONE` | Optional support phone number displayed to drivers, preferably in international format. |
| `mobile/.env` | `APP_IDENTIFIER`, `EAS_PROJECT_ID` | Expo/EAS application identity; `EAS_PROJECT_ID` is required for Expo push-token registration. |
| `mobile/.env` | `IOS_BUILD_NUMBER`, `ANDROID_VERSION_CODE` | Platform-specific release build numbers. |

For a physical phone or Android emulator, replace `localhost` in `EXPO_PUBLIC_API_URL` with an address that the device can reach. Expo `EXPO_PUBLIC_` values are bundled into the client and must not contain secrets.

## Database setup

Create an empty PostgreSQL database, configure `backend/.env`, then run:

```powershell
cd backend
npm install
npm run migrate
```

The migration runner installs the current schema and applies numbered SQL migrations from `backend/database` in numeric order within a transaction. Migration `010_trip_lifecycle.sql` adds lifecycle statuses, closure and reschedule metadata, withdrawal history, lifecycle indexes, and planned trip-end synchronization. Migration `011_trip_stop_eta.sql` adds driver-entered arrival-time fields and clears them when a stop progresses. Migration `012_performance_indexes.sql` adds idempotent indexes for notification dequeue, live trips, changed-trip acknowledgements, passenger trip stops, withdrawals, and declined offers. Run migrations before starting an API version that uses these columns.

## Run the applications

Install dependencies with `npm ci` in each app folder.

```powershell
# API
cd backend
npm run dev

# Admin web app (in a separate terminal)
cd admin
npm run dev

# Driver and passenger mobile app (in a separate terminal)
cd mobile
npm start
```

The API health endpoints are `GET /health/live` (process liveness) and `GET /health/ready` (PostgreSQL, applied migrations, and a worker heartbeat younger than two minutes). The Render blueprint checks `/health/ready`; run `npm run migrate` before deploying a new backend version. The compatibility endpoint `GET /health` checks PostgreSQL only. Admin authentication uses `POST /api/v1/admin/auth/login`; driver and passenger authentication use the mobile auth routes.

## Checks

Run from each application folder:

```powershell
npm run lint
npm test                 # backend only
npm run build            # admin only
npx tsc --noEmit         # mobile type check
```

Run the mobile responsive layout matrix from `mobile/` with:

```powershell
npm run test:layout
```

This exports the Expo web app, then checks the key authentication, driver, passenger, and account screens at 320, 360, 390, 430, and 768 px. API calls are mocked. Playwright screenshots and failure artifacts are written to `mobile/e2e/screenshots/`, which is git-ignored. Install the Playwright Chromium browser once with `npx playwright install chromium` if it is not already available. To run one case, append Playwright arguments, for example `npm run test:layout -- --grep "driver-home at 320px"`.

## Performance and load testing

Review [docs/PERFORMANCE.md](./docs/PERFORMANCE.md) for the production performance goals and PostgreSQL connection-budget calculation, [docs/MONITORING.md](./docs/MONITORING.md) for metrics/alerts, and [docs/LOAD_TESTING.md](./docs/LOAD_TESTING.md) for the guarded fixtures, concurrency tests, and k6 scenarios. Do not use production data or treat a laptop run as deployment evidence.

After selecting Render app/database plans, calculate the connection peak using `API instances x DB_POOL_MAX + worker + migration/operations connections`. Keep that total at or below 80% of the database connection limit; the remaining 20% is an operational reserve. Plan sizing depends on the tested workload and the provider plan's connection limit—there are no hardcoded provider prices or assumed capacity guarantees.

## Trip operations

Trips are planned and offered as series. An admin creates one or more dated trips from pending passenger ride requests, selects eligible drivers in order, and starts a timed offer queue. Drivers accept or decline the series offer in the mobile app. Times are interpreted in `Africa/Johannesburg`.

Admins choose the stop sequence and planned time for each stop group. A trip going to work has an arrival target for workplace drop-offs; a trip going home has no workplace arrival target, and its first planned stop is used as the trip's schedule time. Each stop uses the address saved on its passenger request, so trips can include different workplaces. Maps navigation is driver-initiated; the platform does not calculate routes or driving-time estimates.

During an active trip, drivers process grouped stops in order and report delays, no-shows, drop-off exceptions, or incidents in the mobile app. Passengers see their own stop details and live trip status; driver contact details are shown only during the permitted contact window.

## Trip lifecycle and time

Trip timing and upcoming/overdue status are decided by the PostgreSQL-backed API using `timestamptz`; the clients refresh trip state at least every 60 seconds and when a screen regains focus. All displayed times use the `Africa/Johannesburg` time zone and 24-hour format.

- An accepted trip remains startable from the configured start window before its first stop until `ends_at + OVERDUE_GRACE_MINUTES`. An overdue trip that has not started is shown under driver attention, not as the next or an upcoming trip.
- If an accepted trip still has not started by `ends_at + AUTO_MISS_AFTER_MINUTES`, the worker closes it as missed and updates its ride requests. Expired unassigned trips are cancelled; pending ride requests with no trip expire after `REQUEST_EXPIRE_GRACE_MINUTES`.
- Drivers can withdraw an accepted trip before it starts, report an overdue trip that did not happen, or end an in-progress trip early. Withdrawals closer than `LATE_WITHDRAW_HOURS` to the first stop are recorded as late. Driver and admin actions are retained in the trip event history.
- Passenger trip history includes completed, cancelled, and missed trips. Requests that expired or belonged to a missed trip include a request-again option. Admins can reschedule, mark a never-started trip missed, reinstate eligible future passengers, and send passenger updates.
- Rescheduling a trip records the prior schedule. When the driver is retained, the trip requires driver acknowledgement. Passenger cancellation warnings honor the `CHANGE_CANCEL_EXEMPT_HOURS` exemption.

## Notifications

Notifications are transactional. The API stores each inbox message and its push/SMS delivery jobs in PostgreSQL before sending. The worker retries due jobs and checks Expo receipts; revoked Expo tokens are removed from future sends. Notification copy is kept free of passenger names and contact details. Users can manage push and SMS preferences in the mobile Account screen, and the inbox remains available even when external delivery preferences are off.

To test push notifications, configure `mobile/.env` with the reachable API URL and the EAS project ID, install the app as a development build on a physical iOS or Android device, sign in, and allow notifications. Expo Go is not a substitute for validating production push credentials. The app registers the device token after permission is granted and refreshes it on later app starts.

- For Android, configure Firebase Cloud Messaging credentials for the Expo/EAS project and build a new development or release client. The app creates `offers`, `trip_updates`, and `general` notification channels.
- For iOS, configure the Apple Push Notification service credentials for the Expo/EAS project and build a new client. Test on a physical device with the correct bundle identifier and provisioning.
- Set `EXPO_ACCESS_TOKEN` on the backend only when Expo push access-token authentication is enabled.
- Keep `SMS_PROVIDER=none` to disable SMS sends. Select `bulksms`, `clickatell`, or `twilio` only after setting its corresponding credentials. Those provider adapters are currently stubs and will report “not configured”; no SMS will be sent until a provider integration is completed.
- `OFFER_SMS_FALLBACK_SECONDS` controls the delayed offer fallback; `TRIP_REMINDER_MINUTES` controls the driver trip reminder lead time.

Push and inbox notifications are available through the outbox. SMS delivery is not yet available because the provider-specific adapters remain stubs.

## Testing notifications

Device notifications require an installed native development, preview or release build; the browser cannot receive operating-system push notifications, and Expo Go on Android cannot validate this app's device push flow. The Account screen reports when push is unavailable in the current environment.

1. Set `EXPO_PUBLIC_API_URL` and `EAS_PROJECT_ID` for local development in `mobile/.env`. For remote EAS builds, set `EAS_PROJECT_ID` and `APP_IDENTIFIER` in the EAS build environment and replace the example API/legal URLs in the selected `mobile/eas.json` profile with the deployed URLs.
2. Configure the platform credentials in the Expo/EAS project: Firebase Cloud Messaging credentials for Android and an Apple Push Notification service key for iOS. A new native build is required after adding or changing native notification configuration.
3. Start the API and its notification worker with PostgreSQL available, sign in on the installed app, and grant notification permission.
4. In the app, open **Account → Notifications** and check that permission is on and the device is registered. Choose **Send a test notification**; the API sends the signed-in user a test push, limited to three requests per hour.

The test button verifies the configured delivery path only when the device has a registered Expo push token and the platform credentials and worker are operational. It does not make web or unsupported Expo Go environments capable of receiving device notifications.
"# GlobalTransport" 
