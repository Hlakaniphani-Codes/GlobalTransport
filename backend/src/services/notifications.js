const pool = require('../db');
const logger = require('../utils/logger');
const withTransaction = require('../utils/withTransaction');
const AppError = require('../utils/AppError');
const { randomUUID } = require('node:crypto');
const { createCircuitBreaker } = require('../utils/circuitBreaker');
const {
  DEFAULT_PAGE_SIZE,
  normalizePagination,
  paginationMetadata,
} = require('../utils/pagination');

const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const MAX_ATTEMPTS = 5;
const PAGE_SIZE = DEFAULT_PAGE_SIZE;
const expoCircuitBreaker = createCircuitBreaker();
let receiptBackoffUntil = 0;
let receiptFailureCount = 0;

function recordExpoFailure() {
  if (expoCircuitBreaker.recordFailure()) {
    logger.warn('Expo circuit breaker opened.', { open_seconds: 60 });
  }
}

function makeIdempotencyKey(type, entityId, userId) {
  return `${type}:${entityId}:${userId}`;
}

async function deferJob(job, delaySeconds) {
  await pool.query(
    `UPDATE notification_jobs
     SET status = 'pending',
         next_attempt_at = now() + ($2 * interval '1 second'),
         claimed_at = NULL
     WHERE id = $1`,
    [job.id, delaySeconds]
  );
}

function normalizeChannels(channels) {
  const requested = new Set(channels);
  if (requested.has('sms-fallback')) requested.add('push');
  return [...requested].filter((channel) => ['push', 'sms', 'sms-fallback'].includes(channel));
}

function safeData(data = {}) {
  const permitted = ['screen', 'trip_id', 'offer_id', 'notification_id'];
  return Object.fromEntries(
    Object.entries(data).filter(([key, value]) =>
      permitted.includes(key) && typeof value === 'string' && value.length <= 120)
  );
}

function containsPhoneNumber(value) {
  return /(?:\+?\d[\d ().-]{5,}\d)/.test(value);
}

function validateMessage(title, body) {
  if (containsPhoneNumber(title) || containsPhoneNumber(body)) {
    throw new Error('Notification text must not contain a phone number.');
  }
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('en-ZA', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Africa/Johannesburg',
  }).format(new Date(value));
}

async function notifyOfferPending(queryable, offerId) {
  const result = await queryable.query(
    `SELECT offer.id, offer.driver_user_id, offer.window_minutes, trip.scheduled_at,
            count(DISTINCT stop.ride_request_id)::int AS passenger_count
     FROM trip_offers offer
     JOIN trips trip ON trip.id = offer.trip_id
     JOIN trip_stops stop ON stop.trip_id = trip.id AND stop.stop_type = 'pickup'
     WHERE offer.id = $1 AND offer.status = 'pending' AND offer.expires_at > now()
     GROUP BY offer.id, trip.scheduled_at`,
    [offerId]
  );
  const offer = result.rows[0];
  if (!offer) return null;
  return notify(offer.driver_user_id, {
    type: 'offer_received',
    title: 'New trip offer',
    body: `New trip offer: ${offer.passenger_count} passengers on ${formatDateTime(offer.scheduled_at)}. Respond within ${offer.window_minutes} minutes.`,
    data: { screen: 'offers', offer_id: offer.id },
    channels: ['push', 'sms-fallback'],
    priority: 'high',
    idempotencyKey: makeIdempotencyKey('offer_received', offer.id, offer.driver_user_id),
  }, queryable);
}

async function notifyOfferStatus(queryable, offerId, type, title, body) {
  const result = await queryable.query(
    `SELECT driver_user_id FROM trip_offers WHERE id = $1`,
    [offerId]
  );
  const driverId = result.rows[0]?.driver_user_id;
  if (!driverId) return null;
  return notify(driverId, {
    type,
    title,
    body,
    data: { screen: 'offers', offer_id: offerId },
    channels: ['push'],
    idempotencyKey: makeIdempotencyKey(type, offerId, driverId),
  }, queryable);
}

async function notifyTripPassengers(queryable, tripId, type, options = {}) {
  const tripResult = await queryable.query(
    `SELECT trip.id, trip.scheduled_at, trip.delay_minutes, trip.driver_user_id,
            driver.name AS driver_first_name, vehicle.make AS vehicle_make,
            vehicle.colour AS vehicle_colour
     FROM trips trip
     JOIN users driver ON driver.id = trip.driver_user_id
     LEFT JOIN vehicles vehicle ON vehicle.id = trip.vehicle_id
     WHERE trip.id = $1 AND trip.driver_user_id IS NOT NULL
       AND (trip.status IN ('accepted','in_progress')
         OR ($2 = 'trip_completed' AND trip.status = 'completed'))`,
    [tripId, type]
  );
  if (tripResult.rowCount !== 1) return;
  const trip = tripResult.rows[0];
  const values = [tripId, type];
  let requestCondition = '';
  if (options.rideRequestId) {
    values.push(options.rideRequestId);
    requestCondition = `AND request.id = $${values.length}`;
  } else if (options.rideRequestIds?.length) {
    values.push(options.rideRequestIds);
    requestCondition = `AND request.id = ANY($${values.length}::uuid[])`;
  }
  const passengers = await queryable.query(
    `SELECT DISTINCT request.passenger_user_id
     FROM ride_requests request
     WHERE request.trip_id = $1
       AND (
         request.status = 'assigned'
         OR ($2 = 'no_show_recorded' AND request.status = 'no_show')
         OR ($2 = 'trip_completed' AND request.status = 'completed')
       ) ${requestCondition}`,
    values
  );
  const messages = {
    trip_scheduled: {
      title: 'Your trip is scheduled',
      body: `Your trip is scheduled for ${formatDateTime(trip.scheduled_at)} with ${trip.driver_first_name}. Vehicle: ${[trip.vehicle_make, trip.vehicle_colour].filter(Boolean).join(', ')}.`,
      entityId: tripId,
    },
    trip_changed: {
      title: 'Your trip has changed',
      body: 'Your trip details have changed. Check the app for the latest schedule.',
      entityId: tripId,
    },
    trip_cancelled: {
      title: 'Your trip was cancelled',
      body: `Your trip on ${formatDateTime(trip.scheduled_at)} was cancelled by the transport team.`,
      entityId: tripId,
    },
    request_cancelled: {
      title: 'Your ride request was cancelled',
      body: 'Your ride request was cancelled by the transport team.',
      entityId: options.rideRequestId ?? tripId,
    },
    driver_running_late: {
      title: 'Your driver is running late',
      body: `Your driver is running ${options.minutes} minutes late.`,
      entityId: tripId,
    },
    driver_on_the_way: {
      title: 'Your driver is on the way',
      body: 'Your driver is on the way to your pick-up.',
      entityId: options.stopId ?? tripId,
    },
    driver_eta: {
      title: 'Arrival time update',
      body: '',
      entityId: options.stopId ?? tripId,
    },
    driver_arrived: {
      title: 'Your driver has arrived',
      body: 'Your driver has arrived at your pick-up.',
      entityId: options.stopId ?? tripId,
    },
    trip_completed: {
      title: 'Trip complete',
      body: 'Your trip is complete. Rate your driver in the app.',
      entityId: tripId,
    },
    no_show_recorded: {
      title: 'Pick-up missed',
      body: 'You were marked as a no-show for your pick-up. Contact support if this is incorrect.',
      entityId: options.stopId ?? tripId,
    },
  };
  const message = messages[type];
  if (!message) return;
  const body = type === 'driver_eta'
    ? `Your driver expects to arrive at about ${new Intl.DateTimeFormat('en-ZA', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'Africa/Johannesburg',
    }).format(new Date(options.etaAt))}.`
    : message.body;
  await Promise.all(passengers.rows.map(({ passenger_user_id: userId }) => notify(userId, {
    type,
    title: message.title,
    body,
    data: { screen: 'passenger', trip_id: tripId },
    channels: ['push'],
    idempotencyKey: options.idempotencySuffix
      ? makeIdempotencyKey(type, `${message.entityId}:${options.idempotencySuffix}`, userId)
      : makeIdempotencyKey(type, message.entityId, userId),
  }, queryable)));
}

async function notifyAssignedSeriesPassengers(queryable, seriesId) {
  const trips = await queryable.query(
    `SELECT id FROM trips
     WHERE series_id = $1 AND status = 'accepted' AND driver_user_id IS NOT NULL`,
    [seriesId]
  );
  await Promise.all(trips.rows.map(({ id }) => notifyTripPassengers(queryable, id, 'trip_scheduled')));
}

async function notifyDriverAccount(userId, type, title, body, entityId = userId, queryable = null) {
  return notify(userId, {
    type,
    title,
    body,
    data: { screen: 'account' },
    channels: ['push'],
    idempotencyKey: makeIdempotencyKey(type, entityId, userId),
  }, queryable);
}

async function notifyDriverTrip(queryable, userId, tripId, type, title, body) {
  return notify(userId, {
    type,
    title,
    body,
    data: { screen: 'driver', trip_id: tripId },
    channels: ['push'],
    idempotencyKey: makeIdempotencyKey(type, tripId, userId),
  }, queryable);
}

async function notify(userId, input, queryable = null) {
  validateMessage(input.title, input.body);
  if (!queryable) {
    return withTransaction((client) => notify(userId, input, client));
  }
  const idempotencyKey = input.idempotencyKey
    ?? makeIdempotencyKey(input.type, input.data?.trip_id ?? input.data?.offer_id ?? 'general', userId);
  const recipient = await queryable.query(
      `SELECT is_active, notifications_push_enabled, notifications_sms_enabled
       FROM users WHERE id = $1 FOR SHARE`,
      [userId]
    );
  if (recipient.rowCount !== 1 || !recipient.rows[0]?.is_active) return null;

  const preferences = recipient.rows[0];
  const channels = normalizeChannels(input.channels ?? ['push']);
  const jobs = channels.filter((channel) => {
    if (channel === 'push') return preferences.notifications_push_enabled;
    return preferences.notifications_sms_enabled;
  });
  const inserted = await queryable.query(
      `INSERT INTO notifications (user_id, type, title, body, data, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, user_id, type, title, body, data, created_at`,
      [userId, input.type, input.title, input.body, safeData(input.data), idempotencyKey]
    );
  if (inserted.rowCount === 0) {
    const existing = await queryable.query(
        `SELECT id, user_id, type, title, body, data, created_at
         FROM notifications WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
    return existing.rows[0] ?? null;
  }

  for (const channel of jobs) {
    const fallback = channel === 'sms-fallback';
    const storedChannel = fallback ? 'sms' : channel;
    await queryable.query(
        `INSERT INTO notification_jobs
           (notification_id, channel, next_attempt_at, idempotency_key)
         VALUES ($1, $2, now() + ($3 * interval '1 second'), $4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          inserted.rows[0].id,
          storedChannel,
          fallback ? Number(process.env.OFFER_SMS_FALLBACK_SECONDS ?? 120) : 0,
          `${idempotencyKey}:${channel}`,
        ]
      );
  }
  return inserted.rows[0];
}

function retryDelaySeconds(attempt) {
  return Math.min(60 * (2 ** Math.max(0, attempt - 1)), 3600);
}

function retryAfterSeconds(response) {
  const value = response.headers?.get?.('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

function getExpoHeaders() {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (process.env.EXPO_ACCESS_TOKEN?.trim()) {
    headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN.trim()}`;
  }
  return headers;
}

function getAndroidChannel(type) {
  if (type.startsWith('offer_')) return 'offers';
  if (type.startsWith('trip_') || type.startsWith('driver_')) return 'trip_updates';
  return 'general';
}

async function sendPush(job) {
  const tokens = await pool.query(
    `SELECT id, token, platform
     FROM push_tokens
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY last_seen_at DESC`,
    [job.user_id]
  );
  if (tokens.rowCount === 0) {
    return { skipped: 'No active push device is registered.' };
  }

  const channelId = getAndroidChannel(job.type);
  const messages = tokens.rows.map((token) => ({
    to: token.token,
    title: job.title,
    body: job.body,
    data: safeData(job.data),
    sound: 'default',
    priority: channelId === 'general' ? 'default' : 'high',
    channelId,
  }));
  const receipts = [];
  for (let offset = 0; offset < messages.length; offset += 100) {
    const batchTokens = tokens.rows.slice(offset, offset + 100);
    let response;
    try {
      response = await fetch(EXPO_SEND_URL, {
        method: 'POST',
        headers: getExpoHeaders(),
        body: JSON.stringify(messages.slice(offset, offset + 100)),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      recordExpoFailure();
      throw error;
    }
    if (!response.ok) {
      recordExpoFailure();
      if (response.status === 429 || response.status >= 500) {
        const error = new Error(`Expo push service temporarily unavailable (${response.status}).`);
        error.retryAfterSeconds = retryAfterSeconds(response);
        throw error;
      }
      throw new Error(`Expo push service rejected the request (${response.status}).`);
    }
    expoCircuitBreaker.recordSuccess();
    const payload = await response.json();
    for (const [index, ticket] of (payload.data ?? []).entries()) {
      const token = batchTokens[index];
      if (!token) continue;
      if (ticket.status === 'error') {
        if (ticket.details?.error === 'DeviceNotRegistered') {
          await pool.query(
            `UPDATE push_tokens SET revoked_at = now()
             WHERE id = $1 AND revoked_at IS NULL`,
            [token.id]
          );
          continue;
        }
        throw new Error(`Expo push delivery failed (${ticket.details?.error ?? 'unknown'}).`);
      }
      if (ticket.id) receipts.push({ receipt_id: ticket.id, token_id: token.id });
    }
  }
  return { receipt_ids: receipts };
}

async function sendSms(phoneNumber, text) {
  const provider = (process.env.SMS_PROVIDER ?? 'none').toLowerCase();
  if (provider === 'none') return { skipped: 'SMS provider is disabled.' };
  const providers = {
    bulksms: ['BULKSMS_USERNAME', 'BULKSMS_PASSWORD'],
    clickatell: ['CLICKATELL_API_KEY'],
    twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
  };
  const requiredCredentials = providers[provider];
  if (!requiredCredentials) throw new Error('SMS provider configuration is invalid.');
  if (requiredCredentials.some((name) => !process.env[name]?.trim())) {
    throw new Error(`${provider} SMS provider is not configured.`);
  }
  void phoneNumber;
  void text;
  throw new Error(`${provider} SMS provider is not configured.`);
}

async function finishJob(jobId, { status, error = null, receiptIds = null }) {
  await pool.query(
    `UPDATE notification_jobs
     SET status = $2, last_error = $3, provider_receipt_id = $4,
         sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
         finished_at = now(),
         claimed_at = NULL
     WHERE id = $1`,
    [jobId, status, error, receiptIds ? JSON.stringify(receiptIds) : null]
  );
}

async function retryJob(job, error) {
  const status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  const delay = Math.max(retryDelaySeconds(job.attempts), error.retryAfterSeconds ?? 0);
  await pool.query(
    `UPDATE notification_jobs
     SET status = $2, last_error = $3,
         next_attempt_at = CASE WHEN $2 = 'pending'
           THEN now() + ($4 * interval '1 second') ELSE next_attempt_at END,
         finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END,
         claimed_at = NULL
     WHERE id = $1`,
    [job.id, status, error.message, delay]
  );
}

async function isFallbackNeeded(job) {
  const push = await pool.query(
    `SELECT status, provider_receipt_id FROM notification_jobs
     WHERE notification_id = $1 AND channel = 'push'
     ORDER BY created_at LIMIT 1`,
    [job.notification_id]
  );
  if (push.rowCount === 0 || push.rows[0].status === 'skipped' || push.rows[0].status === 'failed') {
    return true;
  }
  const receipts = JSON.parse(push.rows[0].provider_receipt_id ?? '[]');
  return !receipts.some((receipt) => receipt.status === 'ok');
}

async function processJob(job) {
  if (job.channel === 'push' && expoCircuitBreaker.isOpen()) {
    await deferJob(job, expoCircuitBreaker.retryAfterSeconds());
    return;
  }
  if (job.is_offer_fallback) {
    const offer = await pool.query(
      `SELECT status FROM trip_offers
       WHERE id = $1 AND status = 'pending' AND expires_at > now()`,
      [job.data?.offer_id]
    );
    if (offer.rowCount !== 1) {
      await finishJob(job.id, { status: 'skipped', error: 'Trip offer is no longer pending.' });
      return;
    }
    if (!(await isFallbackNeeded(job))) {
      await finishJob(job.id, { status: 'skipped', error: 'Push delivery was confirmed.' });
      return;
    }
  }
  if (job.channel === 'sms') {
    const recipient = await pool.query(
      `SELECT u.contact_number FROM users u
       WHERE u.id = $1 AND u.is_active = TRUE AND u.notifications_sms_enabled = TRUE`,
      [job.user_id]
    );
    if (recipient.rowCount !== 1 || !recipient.rows[0].contact_number) {
      await finishJob(job.id, { status: 'skipped', error: 'Recipient has no SMS contact enabled.' });
      return;
    }
    const smsText = job.is_offer_fallback
      ? `${job.body} Open the app to respond.`
      : job.body;
    const result = await sendSms(recipient.rows[0].contact_number, smsText);
    if (result.skipped) {
      await finishJob(job.id, { status: 'skipped', error: result.skipped });
      return;
    }
    await finishJob(job.id, { status: 'sent' });
    return;
  }

  const result = await sendPush(job);
  if (result.skipped) {
    await finishJob(job.id, { status: 'skipped', error: result.skipped });
  } else {
    await finishJob(job.id, {
      status: 'sent',
      receiptIds: result.receipt_ids,
    });
  }
}

async function processReceipts() {
  if (expoCircuitBreaker.isOpen()) return;
  if (Date.now() < receiptBackoffUntil) return;
  const result = await pool.query(
    `SELECT id, provider_receipt_id FROM notification_jobs
     WHERE channel = 'push' AND status = 'sent'
       AND provider_receipt_id IS NOT NULL
       AND sent_at >= now() - interval '24 hours'
       AND provider_receipt_id LIKE '%"status":"pending"%'
     ORDER BY sent_at LIMIT 100`
  );
  const receiptIds = result.rows.flatMap((job) => {
    try {
      return JSON.parse(job.provider_receipt_id).filter((receipt) => receipt.status === 'pending');
    } catch (error) {
      logger.warn('Malformed stored Expo receipt data was skipped.', {
        job_id: job.id,
        code: error.name || 'UNKNOWN_ERROR',
      });
      return [];
    }
  });
  for (let offset = 0; offset < receiptIds.length; offset += 300) {
    const batch = receiptIds.slice(offset, offset + 300);
    if (batch.length === 0) continue;
    let response;
    try {
      response = await fetch(EXPO_RECEIPTS_URL, {
        method: 'POST',
        headers: getExpoHeaders(),
        body: JSON.stringify({ ids: batch.map(({ receipt_id: id }) => id) }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      recordExpoFailure();
      throw error;
    }
    if (!response.ok) {
      recordExpoFailure();
      if (response.status === 429 || response.status >= 500) {
        receiptFailureCount += 1;
        const backoffSeconds = Math.max(
          retryAfterSeconds(response),
          Math.min(60 * (2 ** Math.min(receiptFailureCount - 1, 6)), 3_600)
        );
        receiptBackoffUntil = Date.now() + backoffSeconds * 1_000;
        logger.warn('Expo receipt service requested backoff.', {
          status: response.status,
          backoff_seconds: backoffSeconds,
        });
        break;
      }
      throw new Error(`Expo receipt service rejected the request (${response.status}).`);
    }
    expoCircuitBreaker.recordSuccess();
    receiptFailureCount = 0;
    const payload = await response.json();
    for (const job of result.rows) {
      let receipts;
      try {
        receipts = JSON.parse(job.provider_receipt_id);
      } catch (error) {
        logger.warn('Malformed stored Expo receipt data was skipped.', {
          job_id: job.id,
          code: error.name || 'UNKNOWN_ERROR',
        });
        continue;
      }
      let changed = false;
      for (const receipt of receipts) {
        const receiptResult = payload.data?.[receipt.receipt_id];
        if (!receiptResult) continue;
        receipt.status = receiptResult.status;
        changed = true;
        if (receiptResult.details?.error === 'DeviceNotRegistered') {
          await pool.query(
            `UPDATE push_tokens SET revoked_at = now()
             WHERE id = $1 AND revoked_at IS NULL`,
            [receipt.token_id]
          );
        }
      }
      if (changed) {
        const failed = receipts.length > 0
          && receipts.every((receipt) => receipt.status === 'error');
        await pool.query(
          `UPDATE notification_jobs
           SET provider_receipt_id = $2,
               status = CASE WHEN $3 THEN 'failed' ELSE status END,
               last_error = CASE WHEN $3 THEN 'Expo push delivery failed.' ELSE last_error END
           WHERE id = $1 AND status = 'sent'`,
          [job.id, JSON.stringify(receipts), failed]
        );
      }
    }
  }
}

async function processScheduledNotifications() {
    const [expiringOffers, tripReminders, overdueTrips, documentNotices] = await Promise.all([
      pool.query(
        `SELECT offer.id, offer.driver_user_id
         FROM trip_offers offer
         WHERE offer.status = 'pending'
           AND offer.expires_at BETWEEN now() + interval '4 minutes 30 seconds'
                                    AND now() + interval '5 minutes 30 seconds'
         LIMIT 100`
      ),
      pool.query(
        `SELECT trip.id, trip.driver_user_id
         FROM trips trip
         JOIN LATERAL (
           SELECT planned_at FROM trip_stops
           WHERE trip_id = trip.id ORDER BY sequence LIMIT 1
         ) first_stop ON TRUE
         WHERE trip.status = 'accepted'
           AND trip.driver_user_id IS NOT NULL
           AND first_stop.planned_at BETWEEN now() + ($1 * interval '1 minute') - interval '30 seconds'
                                         AND now() + ($1 * interval '1 minute') + interval '30 seconds'
         LIMIT 100`,
      [Number(process.env.TRIP_REMINDER_MINUTES ?? 60)]
      ),
      pool.query(
        `SELECT trip.id, trip.driver_user_id
         FROM trips trip
         JOIN LATERAL (
           SELECT planned_at FROM trip_stops
           WHERE trip_id = trip.id ORDER BY sequence LIMIT 1
         ) first_stop ON TRUE
         WHERE trip.status = 'accepted'
           AND trip.driver_user_id IS NOT NULL
           AND first_stop.planned_at <= now() - interval '10 minutes'
           AND NOT EXISTS (
             SELECT 1 FROM notifications n
             WHERE n.user_id = trip.driver_user_id AND n.type = 'trip_not_started'
               AND n.idempotency_key = 'trip_not_started:' || trip.id || ':' || trip.driver_user_id
           )
         LIMIT 100`
      ),
      pool.query(
        `SELECT d.user_id, d.user_id AS entity_id, 'driver_licence' AS document_type,
                d.licence_expiry AS expires_at, threshold.days
         FROM drivers d CROSS JOIN (VALUES (30), (7), (1)) AS threshold(days)
         WHERE d.licence_expiry = CURRENT_DATE + threshold.days
         UNION ALL
         SELECT d.user_id, d.user_id, 'prdp', d.prdp_expiry, threshold.days
         FROM drivers d CROSS JOIN (VALUES (30), (7), (1)) AS threshold(days)
         WHERE d.prdp_expiry = CURRENT_DATE + threshold.days
         UNION ALL
         SELECT vehicle.driver_user_id, vehicle.id, 'vehicle_licence_disc',
                vehicle.licence_disc_expiry, threshold.days
         FROM vehicles vehicle CROSS JOIN (VALUES (30), (7), (1)) AS threshold(days)
         WHERE vehicle.licence_disc_expiry = CURRENT_DATE + threshold.days
         UNION ALL
         SELECT d.user_id, d.user_id, 'driver_licence', d.licence_expiry, 0
         FROM drivers d WHERE d.licence_expiry < CURRENT_DATE
         UNION ALL
         SELECT d.user_id, d.user_id, 'prdp', d.prdp_expiry, 0
         FROM drivers d WHERE d.prdp_expiry < CURRENT_DATE
         UNION ALL
         SELECT vehicle.driver_user_id, vehicle.id, 'vehicle_licence_disc',
                vehicle.licence_disc_expiry, 0
         FROM vehicles vehicle WHERE vehicle.licence_disc_expiry < CURRENT_DATE
         LIMIT 300`
      ),
    ]);
    for (const offer of expiringOffers.rows) {
      await notify(offer.driver_user_id, {
        type: 'offer_expiring',
        title: 'Trip offer expiring soon',
        body: 'A trip offer expires in 5 minutes. Respond in the app.',
        data: { screen: 'offers', offer_id: offer.id },
        channels: ['push'],
        idempotencyKey: makeIdempotencyKey('offer_expiring', offer.id, offer.driver_user_id),
      });
    }
    for (const trip of tripReminders.rows) {
      await notify(trip.driver_user_id, {
        type: 'trip_reminder',
        title: 'Trip coming up',
        body: `Your trip starts in ${Number(process.env.TRIP_REMINDER_MINUTES ?? 60)} minutes.`,
        data: { screen: 'driver', trip_id: trip.id },
        channels: ['push'],
        idempotencyKey: makeIdempotencyKey('trip_reminder', trip.id, trip.driver_user_id),
      });
    }
    for (const trip of overdueTrips.rows) {
      await notify(trip.driver_user_id, {
        type: 'trip_not_started',
        title: 'Trip start reminder',
        body: 'Your trip has not started. Please open the app and check its status.',
        data: { screen: 'driver', trip_id: trip.id },
        channels: ['push'],
        idempotencyKey: makeIdempotencyKey('trip_not_started', trip.id, trip.driver_user_id),
      });
    }
    for (const document of documentNotices.rows) {
      const isExpired = document.days === 0;
      const documentName = {
        driver_licence: 'driver licence',
        prdp: 'professional driving permit',
        vehicle_licence_disc: 'vehicle licence disc',
      }[document.document_type];
      const type = isExpired ? 'document_expired' : `document_expiring_${document.days}`;
      await notifyDriverAccount(
        document.user_id,
        type,
        isExpired ? 'Document expired' : 'Document expiring soon',
        isExpired
          ? `Your ${documentName} has expired. Renew it to continue accepting trips.`
          : `Your ${documentName} expires in ${document.days} days. Renew it before it expires.`,
        `${document.document_type}:${document.entity_id}:${document.days}`,
      );
    }
}

async function processDueJobs(batchSize = Number(process.env.WORKER_BATCH_SIZE ?? 200)) {
  const due = await withTransaction((client) => client.query(
    `WITH due_jobs AS (
       SELECT job.id
       FROM notification_jobs job
       WHERE job.status = 'pending'
         AND job.next_attempt_at <= now()
         AND (job.claimed_at IS NULL OR job.claimed_at < now() - interval '5 minutes')
       ORDER BY job.next_attempt_at, job.id
       LIMIT $1
       FOR UPDATE OF job SKIP LOCKED
     ), claimed_jobs AS (
       UPDATE notification_jobs job
       SET attempts = job.attempts + 1, claimed_at = now()
       FROM due_jobs
       WHERE job.id = due_jobs.id
       RETURNING job.id, job.notification_id, job.channel, job.attempts, job.idempotency_key
     )
     SELECT job.id, job.notification_id, job.channel, job.attempts,
            notification.user_id, notification.type, notification.title,
            notification.body, notification.data,
            (job.idempotency_key LIKE '%:sms-fallback') AS is_offer_fallback
     FROM claimed_jobs job
     JOIN notifications notification ON notification.id = job.notification_id
     ORDER BY job.id`,
    [batchSize]
  ));
  let nextJob = 0;
  const concurrency = Math.min(50, due.rows.length);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextJob < due.rows.length) {
      const job = due.rows[nextJob];
      nextJob += 1;
      try {
        await processJob(job);
      } catch (error) {
        logger.warn('Notification delivery attempt failed.', error.code || error.name || 'UNKNOWN_ERROR', {
          job_id: job.id,
          channel: job.channel,
        });
        try {
          await retryJob(job, error);
        } catch (retryError) {
          logger.error('Notification job retry scheduling failed.', {
            job_id: job.id,
            code: retryError.code || retryError.name || 'UNKNOWN_ERROR',
          });
        }
      }
    }
  }));
}

async function getWorkerLag() {
  const result = await pool.query(
    `SELECT COALESCE(
       EXTRACT(EPOCH FROM (now() - MIN(next_attempt_at))),
       0
     )::double precision AS oldest_due_job_age_seconds
     FROM notification_jobs
     WHERE status = 'pending' AND next_attempt_at <= now()
       AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')`
  );
  return Number(result.rows[0]?.oldest_due_job_age_seconds ?? 0);
}

async function deleteInBatches(query, before, label) {
  let deleted = 0;
  while (true) {
    const result = await pool.query(query, [before, 1_000]);
    deleted += result.rowCount;
    if (result.rowCount < 1_000) break;
  }
  return { [label]: deleted };
}

async function processDataRetention({
  retentionDays = Number(process.env.NOTIFICATION_RETENTION_DAYS ?? 90),
  clock = () => new Date(),
} = {}) {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [714335244]);
    locked = result.rows[0]?.locked === true;
    if (!locked) return null;

    const now = clock();
    const notificationCutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    const finishedCutoff = new Date(now.getTime() - 30 * 86_400_000);
    const pushTokenCutoff = finishedCutoff;
    const summary = {};
    Object.assign(summary, await deleteInBatches(
      `WITH old_jobs AS (
         SELECT job.id
         FROM notification_jobs job
         JOIN notifications notification ON notification.id = job.notification_id
         WHERE job.status IN ('sent','failed','skipped')
           AND COALESCE(job.finished_at, job.sent_at, notification.created_at) < $1
         ORDER BY COALESCE(job.finished_at, job.sent_at, notification.created_at), job.id
         LIMIT $2
         FOR UPDATE OF job SKIP LOCKED
       )
       DELETE FROM notification_jobs job USING old_jobs
       WHERE job.id = old_jobs.id`,
      finishedCutoff,
      'finished_jobs'
    ));
    Object.assign(summary, await deleteInBatches(
      `WITH old_notifications AS (
         SELECT notification.id
         FROM notifications notification
         WHERE notification.read_at < $1
           AND NOT EXISTS (
             SELECT 1 FROM notification_jobs job
             WHERE job.notification_id = notification.id AND job.status = 'pending'
           )
         ORDER BY notification.read_at, notification.id
         LIMIT $2
         FOR UPDATE OF notification SKIP LOCKED
       )
       DELETE FROM notifications notification USING old_notifications
       WHERE notification.id = old_notifications.id`,
      notificationCutoff,
      'read_notifications'
    ));
    Object.assign(summary, await deleteInBatches(
      `WITH old_tokens AS (
         SELECT id FROM push_tokens
         WHERE revoked_at < $1
         ORDER BY revoked_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM push_tokens token USING old_tokens
       WHERE token.id = old_tokens.id`,
      pushTokenCutoff,
      'revoked_push_tokens'
    ));
    logger.info('Data retention batch completed.', summary);
    return summary;
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [714335244]);
      } finally {
        client.release();
      }
    } else {
      client.release();
    }
  }
}

async function registerToken(userId, token, platform, deviceName) {
  const result = await pool.query(
    `INSERT INTO push_tokens (user_id, token, platform, device_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE
       SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
           device_name = EXCLUDED.device_name, last_seen_at = now(), revoked_at = NULL
     RETURNING id, platform, device_name, created_at, last_seen_at`,
    [userId, token, platform, deviceName ?? null]
  );
  return result.rows[0];
}

async function sendTestNotification(userId) {
  return notify(userId, {
    type: 'notification_test',
    title: 'Test notification',
    body: 'Your device notifications are working.',
    data: { screen: 'account' },
    channels: ['push'],
    idempotencyKey: `notification_test:${randomUUID()}:${userId}`,
  });
}

async function revokeToken(userId, token) {
  await pool.query(
    `UPDATE push_tokens SET revoked_at = now()
     WHERE user_id = $1 AND token = $2 AND revoked_at IS NULL`,
    [userId, token]
  );
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id })).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed.created_at !== 'string'
      || Number.isNaN(Date.parse(parsed.created_at))
      || !/^[0-9a-f-]{36}$/i.test(parsed.id)
    ) throw new Error('Invalid cursor');
    return parsed;
  } catch {
    throw new AppError(400, 'Notification cursor is invalid.');
  }
}

async function listNotifications(userId, cursor) {
  const decoded = decodeCursor(cursor);
  const values = [userId];
  const cursorCondition = decoded
    ? 'AND (created_at, id) < ($2::timestamptz, $3::uuid)'
    : '';
  if (decoded) values.push(decoded.created_at, decoded.id);
  values.push(PAGE_SIZE + 1);
  const [notifications, unread] = await Promise.all([
    pool.query(
      `SELECT id, type, title, body, data, read_at, created_at
       FROM notifications
       WHERE user_id = $1 ${cursorCondition}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values
    ),
    pool.query(
      `SELECT count(*)::int AS unread_count
       FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [userId]
    ),
  ]);
  const hasMore = notifications.rows.length > PAGE_SIZE;
  const rows = hasMore ? notifications.rows.slice(0, PAGE_SIZE) : notifications.rows;
  return {
    notifications: rows,
    unread_count: unread.rows[0].unread_count,
    next_cursor: hasMore ? encodeCursor(rows.at(-1)) : null,
  };
}

async function markRead(userId, notificationId) {
  const result = await pool.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, now())
     WHERE id = $1 AND user_id = $2
     RETURNING id, read_at`,
    [notificationId, userId]
  );
  return result.rows[0] ?? null;
}

async function markAllRead(userId) {
  const result = await pool.query(
    `UPDATE notifications SET read_at = now()
     WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
  return result.rowCount;
}

async function updatePreferences(userId, input) {
  const result = await pool.query(
    `UPDATE users
     SET notifications_push_enabled = COALESCE($2, notifications_push_enabled),
         notifications_sms_enabled = COALESCE($3, notifications_sms_enabled)
     WHERE id = $1
     RETURNING notifications_push_enabled AS push_enabled,
               notifications_sms_enabled AS sms_enabled`,
    [userId, input.push_enabled ?? null, input.sms_enabled ?? null]
  );
  return result.rows[0] ?? null;
}

async function getPreferences(userId) {
  const result = await pool.query(
    `SELECT notifications_push_enabled AS push_enabled,
            notifications_sms_enabled AS sms_enabled
     FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

async function listNotificationLog({ page, page_size: pageSize, status, type }) {
  const pagination = normalizePagination({ page, page_size: pageSize });
  const values = [];
  const conditions = ["notification.created_at >= now() - interval '24 hours'"];
  if (status) {
    values.push(status);
    conditions.push(`job.status = $${values.length}`);
  }
  if (type) {
    values.push(type);
    conditions.push(`notification.type = $${values.length}`);
  }
  const where = conditions.join(' AND ');
  const [count, rows] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS total FROM notification_jobs job
       JOIN notifications notification ON notification.id = job.notification_id
       WHERE ${where}`,
      values
    ),
    pool.query(
      `      SELECT job.id, job.channel, job.status, job.last_error,
             notification.created_at,
             notification.type, notification.title, notification.body,
             user_row.name AS recipient_name, user_row.surname AS recipient_surname,
             user_row.role AS recipient_role
      FROM notification_jobs job
      JOIN notifications notification ON notification.id = job.notification_id
      JOIN users user_row ON user_row.id = notification.user_id
      WHERE ${where}
      ORDER BY notification.created_at DESC, job.id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, pagination.page_size, (pagination.page - 1) * pagination.page_size]
    ),
  ]);
  const pageMetadata = paginationMetadata(count.rows[0].total, pagination);
  return {
    notifications: rows.rows,
    pagination: pageMetadata,
  };
}

async function failedLast24HoursCount() {
  const result = await pool.query(
    `SELECT count(*)::int AS count
     FROM notification_jobs job
     JOIN notifications notification ON notification.id = job.notification_id
     WHERE job.status = 'failed'
       AND notification.created_at >= now() - interval '24 hours'`
  );
  return result.rows[0].count;
}

module.exports = {
  failedLast24HoursCount,
  getPreferences,
  listNotificationLog,
  listNotifications,
  makeIdempotencyKey,
  markAllRead,
  markRead,
  notify,
  notifyAssignedSeriesPassengers,
  notifyDriverAccount,
  notifyDriverTrip,
  notifyOfferPending,
  notifyOfferStatus,
  notifyTripPassengers,
  getWorkerLag,
  processDataRetention,
  processDueJobs,
  processReceipts,
  processScheduledNotifications,
  registerToken,
  revokeToken,
  sendTestNotification,
  retryJob,
  retryDelaySeconds,
  sendSms,
  updatePreferences,
};
