const { monitorEventLoopDelay } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const pool = require('../db');

const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
const eventLoopResetTimer = setInterval(() => eventLoopDelay.reset(), 10_000);
eventLoopResetTimer.unref();

function requestPath(req) {
  return new URL(req.originalUrl, 'http://localhost').pathname.replace(/^\/api\/v1/, '');
}

function isConditionalGetPath(path) {
  return path.startsWith('/admin/')
    || [
      '/driver/home',
      '/driver/offers',
      '/driver/trips',
      '/rides/trips',
      '/rides/requests',
      '/ride-requests',
      '/notifications',
    ].includes(path);
}

function isPollingPath(path) {
  return [
    '/driver/home',
    '/driver/offers',
    '/driver/trips',
    '/rides/trips',
    '/rides/requests',
    '/ride-requests',
    '/notifications',
  ].includes(path)
    || path.startsWith('/admin/')
    || /^\/(?:driver|rides)\/trips\/[^/]+$/.test(path);
}

function isWeakEtagMatch(header, etag) {
  if (!header) return false;
  const candidate = etag.replace(/^W\//, '');
  return header.split(',').some((item) => {
    const tag = item.trim();
    return tag === '*' || tag.replace(/^W\//, '') === candidate;
  });
}

function makeWeakEtag(payload) {
  const body = JSON.stringify(payload);
  const digest = createHash('sha1').update(body).digest('base64').replace(/=+$/, '');
  return `W/"${Buffer.byteLength(body).toString(16)}-${digest}"`;
}

function hasActiveTrip(payload) {
  const activeStatuses = new Set(['in_progress']);
  const trips = Array.isArray(payload?.trips) ? payload.trips : [];
  return activeStatuses.has(payload?.active_trip?.status)
    || activeStatuses.has(payload?.next_trip?.status)
    || trips.some((trip) => activeStatuses.has(trip.status))
    || activeStatuses.has(payload?.trip?.status);
}

function computePollAfterSeconds({
  path,
  payload,
  background = false,
  eventLoopLagMs = 0,
  poolWaitingCount = 0,
}) {
  if (background) return 120;

  let base = 60;
  if (['/driver/home', '/driver/trips', '/rides/trips'].includes(path)) {
    base = hasActiveTrip(payload) ? 15 : 60;
  } else if (/^\/(?:driver|rides)\/trips\/[^/]+$/.test(path)) {
    base = hasActiveTrip(payload) ? 15 : 60;
  } else if (path === '/driver/offers') {
    base = payload?.offers?.length ? 15 : 60;
  } else if (path.startsWith('/admin/') && hasActiveTrip(payload)) {
    base = 15;
  }

  if (eventLoopLagMs >= 250 || poolWaitingCount >= 5) return base * 4;
  if (eventLoopLagMs >= 75 || poolWaitingCount > 0) return base * 2;
  return base;
}

function createResponseBehavior({
  getEventLoopLagMs = () => eventLoopDelay.percentile(95) / 1e6,
  getPoolWaitingCount = () => pool.waitingCount,
} = {}) {
  return function responseBehavior(req, res, next) {
    if (req.method !== 'GET') return next();

    const path = requestPath(req);
    const conditional = isConditionalGetPath(path);
    if (conditional) res.setHeader('Cache-Control', 'private, no-cache');
    const polling = isPollingPath(path);
    if (!conditional && !polling) return next();

    const originalJson = res.json;
    res.json = function jsonWithPollingMetadata(payload) {
      if (res.statusCode < 200 || res.statusCode >= 300 || !payload || typeof payload !== 'object') {
        return originalJson.call(this, payload);
      }
      let body = payload;
      if (polling && !Array.isArray(payload)) {
        const pollAfterSeconds = computePollAfterSeconds({
          path,
          payload,
          background: req.get('x-client-app-state') === 'background',
          eventLoopLagMs: getEventLoopLagMs(),
          poolWaitingCount: getPoolWaitingCount(),
        });
        res.setHeader('X-Poll-After-Seconds', String(pollAfterSeconds));
        body = { ...payload, poll_after_seconds: pollAfterSeconds };
      }
      if (conditional) {
        const etag = makeWeakEtag(body);
        res.setHeader('ETag', etag);
        if (isWeakEtagMatch(req.get('if-none-match'), etag)) {
          return res.status(304).end();
        }
      }
      return originalJson.call(this, body);
    };
    return next();
  };
}

const responseBehavior = createResponseBehavior();

module.exports = {
  computePollAfterSeconds,
  createResponseBehavior,
  isWeakEtagMatch,
  isConditionalGetPath,
  makeWeakEtag,
  responseBehavior,
};
