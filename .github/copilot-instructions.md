# Global Ride Transport: project rules (follow in every task)

## Product
A platform for worker commuting. The company does not own vehicles; drivers own their vehicles. Roles: driver, passenger, admin. Admins sign in only through the admin web app. Drivers and passengers use the mobile app. Brand: white and blue.

## Stack (do not deviate)
- Mobile: React Native + Expo, TypeScript (strict), Expo Router, axios, expo-secure-store.
- Admin web: React + Vite + TypeScript (strict), react-router-dom, @tanstack/react-query, axios, Tailwind CSS.
- Backend: Node.js + Express (CommonJS), pg, bcryptjs, jsonwebtoken, zod, helmet, cors, dotenv, express-rate-limit.
- Database: PostgreSQL only, never MySQL. Parameterized queries ($1, $2), RETURNING, timestamptz, snake_case, error code 23505 for unique violations. Schema changes only through numbered .sql migrations in /backend/database.
- Google Maps and Google APIs are NOT used yet. Do not add them until told.

## Drivers, vehicles, passengers
- Drivers sign up in two steps (personal details, vehicle details) and accept terms and privacy. Driver and vehicle start as pending.
- Only an admin can approve, reject or suspend. Approval requires licence_number, licence_expiry and a complete vehicle record.
- Pending, rejected and suspended drivers see only a status screen. A rejected driver sees the reason and can resubmit vehicle details.
- A vehicle belongs to one driver. A driver has at most one live vehicle (pending or approved). Plate numbers are unique among live vehicles.
- Passengers type their own company name, workplace address, home address, home suburb and workplace suburb at signup. There is no workplace dropdown.
- Every admin write action is recorded in audit_logs.

## Trips
- Passengers submit their own ride requests (direction, date, time, optional repeat). Admins manually select pending requests for one date and direction, grouped by company and workplace, and may combine passengers from the same or nearby workplaces into a trip. Requests are selected by the admin; the system does not create passenger requests or choose passenger groupings. Each passenger has a pick-up and drop-off, and the pick-up must come first.
- Admins choose the exact stop sequence and enter a planned time for each stop; times must follow the chosen sequence, and every passenger's pick-up time must be before their drop-off time. For 'to_work', admins set a workplace arrival target; workplace drop-offs use that time, and suggested pick-up times are only starting values that admins can edit. For 'home', there is no workplace arrival target; admins set the order and time of every stop. Use each passenger request's own workplace address and suburb, including when a trip combines different workplaces. Consecutive stops at the same normalized address and type share one planned time. Show gaps between planned times and the total scheduled span as schedule intervals, not driving-time estimates. No routing provider or live travel-time estimate is configured.
- Direction 'to_work': pick-ups at homes, drop-offs at workplaces, arriving by the target time (`trips.scheduled_at`). Direction 'home': pick-ups at workplaces, drop-offs at homes; `trips.scheduled_at` is the first planned stop, not an arrival target. Times are 24-hour (20:28) in Africa/Johannesburg.
- A set of trips created together is a series (a single trip is a series of one). Offers are made per series; the driver accepts the whole series at once.
- Trip statuses: draft, offered, accepted, in_progress, completed, cancelled, unassigned, missed. Ride-request statuses also include missed and expired. A trip may be flagged has_issues. Stop statuses: pending, en_route, arrived, completed, skipped.
- Consecutive stops of the same type at the same normalised address form one displayed/actioned stop group; keep one database row per passenger. Drivers process groups in order. Completing or skipping a group moves the next group to en_route.
- A no-show starts its wait period when the driver arrives. Passenger-not-here is enabled only after NO_SHOW_WAIT_MINUTES (default 5), requires a reason, skips that passenger's pick-up and drop-off, and marks that ride request no_show.
- A drop-off exception (unreachable, address_problem, passenger_declined, other) requires a reason, skips that stop and flags the trip has_issues. The trip completes automatically when every stop is completed or skipped; requests are marked completed and skipped stops make it completed with issues.
- Offers: the admin picks an ordered list of candidate drivers and an offer window (default 30 minutes). The first gets a 'pending' offer with expires_at; the others are 'queued'. On decline or expiry the next candidate becomes 'pending'. When none remain, the trips become 'unassigned'. Expiry is decided by comparing expires_at in the database on every read and write; an in-process interval (30 seconds) only advances the queue. Accepting is atomic (transaction with SELECT ... FOR UPDATE) and assigns driver and vehicle to every trip in the series.
- Eligible driver: approved, vehicle approved, is_available true, passenger seats (vehicles.seat_count, excluding the driver) at least the largest passenger count in the series, and no overlapping accepted or in-progress trip (plus a 15 minute buffer).
- Privacy: an unaccepted offer shows only dates, times, workplace name, suburbs, passenger count and kilometres. Exact addresses, passenger names and phone numbers are returned only after acceptance and only while the trip is accepted or in progress. Passengers see the driver's name and vehicle after acceptance, and the driver's phone number only from 90 minutes before the first pick-up until the trip ends. Admins see everything.
- A driver can go online only when driver and vehicle are approved. A driver can start within TRIP_START_WINDOW_MINUTES before its first stop and until the configured overdue grace after its last planned stop.
- Cancellation: a passenger can cancel until the trip starts. If the request is already in a trip, the stop is removed (skipped, with the reason) and the trip continues; if no passengers remain, the trip is cancelled. A cancellation less than LATE_CANCELLATION_HOURS (default 2) before the pick-up is flagged cancelled_late. Record who cancelled, when and why.

## Trip lifecycle and time
- The server and PostgreSQL decide trip lifecycle using `timestamptz`; clients must not decide whether a trip is upcoming or overdue. Driver and passenger trip screens refresh at least every 60 seconds and when focused.
- Configuration defaults: `OVERDUE_GRACE_MINUTES=30`, `AUTO_MISS_AFTER_MINUTES=60`, `LATE_WITHDRAW_HOURS=12`, `UNASSIGNED_ALERT_HOURS=3`, `REQUEST_EXPIRE_GRACE_MINUTES=15`, and `CHANGE_CANCEL_EXEMPT_HOURS=24`. Validate these at startup and document them in `.env.example`.
- A trip's planned end is the time of its last planned stop and is kept in `trips.ends_at` whenever its stops change. An accepted trip may start from `TRIP_START_WINDOW_MINUTES` before its first planned stop through `ends_at + OVERDUE_GRACE_MINUTES`. After that, the driver may report that it did not happen; the worker closes a never-started accepted trip as `missed` after `ends_at + AUTO_MISS_AFTER_MINUTES`.
- `Next trip` is the nearest accepted trip that is not overdue, or an in-progress trip. Upcoming lists exclude past trips. Overdue accepted trips that have not started are shown only under `Needs your attention` until closed. History includes completed, cancelled, and missed trips. Passenger trip lists follow the same time rules.
- A pending ride request with no trip expires after `scheduled_at + REQUEST_EXPIRE_GRACE_MINUTES`. A draft or unassigned trip past its planned end is cancelled as expired/unassigned; an accepted trip that never starts is missed. Closing is transactional, idempotent, records `trip_events`, updates associated ride requests, and sends privacy-safe notifications.
- An accepted trip without an accepted driver that starts within `UNASSIGNED_ALERT_HOURS` requires admin attention. A changed accepted trip requires driver acknowledgement where applicable.
- Driver withdrawal reasons are `vehicle_problem`, `illness_or_emergency`, `personal`, `schedule_conflict`, and `other`. A report that a trip did not happen uses `could_not_start`, `vehicle_problem`, `passengers_unavailable`, `cancelled_by_company`, or `other`. `other` requires a note of at least five characters. Withdrawal records whether it was late based on whether the first stop is within `LATE_WITHDRAW_HOURS`.
- Notification titles and bodies must never include addresses, phone numbers, identification numbers, or passenger names. Use counts, dates, and times instead.

## Arrival time (ETA)
- ETA is entered by the driver after checking the route in Maps; do not add Maps APIs, automated route calculations, or GPS tracking.
- An ETA applies only to the current `en_route` stop group. Drivers enter 1–120 minutes from now and may update it. Store the absolute `eta_at` and update timestamp on every stop row in that group. Clear ETA values when the group is arrived, completed, or skipped.
- Drivers receive quick ETA options of 5, 10, 15, 20, 30, 45, and 60 minutes, plus manual minute entry. Keep the existing Navigate action and explain: “Check the route in Maps, then choose your arrival time.”
- A passenger sees an ETA only for their own current pick-up. Later own stops may show a projection calculated as `planned_at + max(0, current_stop_eta_at - current_stop.planned_at)`. Never return other passengers’ details.
- `ETA_STALE_MINUTES` defaults to 15. A stale ETA is not shown as a time; show “Your driver is on the way”. If the ETA is more than five minutes past, show “Your driver is a little late” without a time. Fresh ETA times use 24-hour `Africa/Johannesburg` formatting.
- Notify only passengers at the ETA stop group. The first ETA update sends “Your driver expects to arrive at about <HH:mm>.” Later notifications require a change of at least five minutes from the last notified ETA and are limited to once every five minutes per stop using an idempotency key with a minute bucket. Never include addresses, phone numbers, or names.
- Admin Live trips show the current ETA and its age, mark trips late when ETA is more than ten minutes behind plan, and include a “Running late” needs-attention item until the stop is completed.

## Production standard (non-negotiable)
This is a client-commissioned production application used by real people. It is NOT a demo.
User-facing text:
- Screens contain only what a user needs: titles, field labels, actions, short professional messages. NEVER put developer notes, explanations of how the system works, role notes, "coming soon" text, test data or technical wording on any screen.
- Login and signup screens contain only: app name, form fields, primary button, one secondary link, and terms/privacy consent on signup.
- Do not invent taglines or marketing copy. Use only "Global Ride Transport".
- Tone: concise, polite, corporate, plain English. Errors say what happened and what to do. Example: "We couldn't sign you in. Check your email and password and try again."
- Never reveal whether an email exists or what role an account has. Using the wrong app for a role returns the same generic sign-in error.
- Empty, loading and error states are designed, never blank. Terminology is consistent: Driver, Passenger, Vehicle, Trip.
Product decisions:
- Admins sign in only via POST /api/v1/admin/auth/login. The mobile login POST /api/v1/auth/login treats an admin account as invalid credentials. Neither app mentions the other.
- No default or seeded passwords, no demo accounts, no sample data. Seed data is limited to reference data (areas).
- An expired or invalid session returns the user quietly to sign-in.
- Approve, reject, suspend, cancel and other destructive actions require confirmation and are audit-logged.
Engineering quality:
- TypeScript strict, ESLint and Prettier configured, no unjustified `any`.
- No console.log in committed code; one central logger; never log personal data, tokens or passwords.
- Configuration only via environment variables with an .env.example in each folder; the backend fails fast at startup if a required variable is missing.
- Consistent API error shape { "error": { "code": "...", "message": "..." } }, correct HTTP status codes, user-safe messages only.
- Transactions for multi-table writes; indexes on filtered or joined columns.
- Security: helmet, rate limiting, validation on every endpoint, bcryptjs (12 rounds for new hashes), ID numbers returned to admins only, consent recorded, collect only needed data (POPIA).
- Unit tests for critical logic.
Screens and devices:
- Every screen works on small and large phones and tablets, with the keyboard open or closed, and with large system font sizes. Touch targets at least 48px, correct keyboard types, autoComplete and textContentType, labelled inputs, good contrast, safe areas, a clear "no connection" message.
- Before finishing any task, review your own output against this file and fix every violation.

## Layout rules
- Apply to mobile; admin must also be usable at 768 px and 1280 px.
- A label, button text, chip text, tab title or stat must never wrap mid-word or onto a second line. Use `numberOfLines={1}` with `adjustsFontSizeToFit` and `minimumFontScale={0.8}` on single-line labels; if it still does not fit, use `ellipsizeMode="tail"`. Paragraph text may wrap only between words and must never be clipped.
- Primary and secondary action buttons are full width and stacked vertically, never side by side, with a gap of 12. Only square icon-only buttons (48 x 48) may sit in a row, with at most three per row.
- Form fields are always stacked vertically on phones, including Name and Surname, date and time, and all pairs of fields. Side-by-side fields are allowed only at screen widths of at least 600 px.
- Rows mixing an icon, text and status chip use flex layouts where the text has `flex: 1` and `minWidth: 0`; chips and icons keep natural size with `flexShrink: 0`. Chips never shrink or wrap.
- Chip groups use `flexWrap` between whole chips only; each chip is one line.
- Never use fixed widths for text containers, absolute positioning for content, or percentage widths for text columns.
- Use compact (<360 px), regular (360–429 px) and large (430 px and above) width classes. Compact layouts use smaller padding, a 4 px smaller base font size and smaller headings. Cap global font scaling at `maxFontSizeMultiplier={1.3}` and ensure layouts remain usable at that scale.
- Minimum touch target is 48 px. Centre content with a maximum width of 480 px on large screens.
- When the keyboard opens, resize the usable screen and keep forms scrollable so focused fields and submit actions can be brought above it; apply the same behavior inside dialogs and bottom sheets.

## Contact and notification rules
- Passenger call and SMS actions appear only on a pick-up stop in `en_route` or `arrived` state, and only for passengers at that current stop. Never show passenger contact actions on drop-off stops, completed/upcoming stops or the Next Trip card.
- The Next Trip card has a “Contact dispatcher” call action and no individual passenger actions.
- Drop-off actions are “Dropped off” (primary), “Couldn't complete drop-off” (secondary, with reasons) and “Report a problem”.
- Every time-sensitive or important event reaches the device as an operating-system notification while the app is open, backgrounded or closed. In-app banners supplement, never replace, device notifications.
- Notification text is short, contains no addresses, phone numbers or passenger names, and tells the recipient what to do. Example: “Your trip hasn't started. Open the app to check its status.”

## Performance and reliability
Production performance targets at 1,000 concurrent users:
- Read response p95 below 500 ms.
- Write response p95 below 1,000 ms.
- Error rate below 0.5%.
- No HTTP 5xx responses during a 30-minute soak test.
- Database connections are never exhausted.
- Background worker lag remains below 60 seconds.

Engineering rules:
- Every list query is bounded and every list endpoint is paginated, with a maximum page size of 100.
- Do not use `SELECT *` in hot paths; select only the columns required by the caller.
- Avoid N+1 query patterns; use joins or bounded batch queries.
- Add indexes for columns used to filter, join, or sort production queries; verify index choices against representative PostgreSQL data and query plans.
- Keep transactions short. Never wait for external services while a transaction is open.
- Every external call, including Expo push, SMS, and storage, has an explicit timeout and runs outside database transactions.
- Use a consistent row-lock order across transactions to prevent deadlocks.
