const CACHEABLE_PATHS = new Set([
  '/api/v1/admin/dashboard/summary',
  '/api/v1/admin/needs-attention',
  '/api/v1/admin/calendar',
  '/api/v1/admin/companies',
  '/api/v1/admin/workplaces',
  '/api/v1/workplaces',
]);

function createResponseCache({ ttlMs = 15_000, maxEntries = 500, now = Date.now } = {}) {
  const entries = new Map();

  function get(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function set(key, value) {
    entries.delete(key);
    entries.set(key, { value, expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  }

  function middleware(req, res, next) {
    const path = new URL(req.originalUrl, 'http://localhost').pathname;
    if (req.method !== 'GET' || !CACHEABLE_PATHS.has(path)) return next();

    const key = req.originalUrl;
    const cached = get(key);
    if (cached) {
      res.status(cached.status).json(cached.body);
      return undefined;
    }

    const originalJson = res.json;
    res.json = function cacheJsonResponse(body) {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        set(key, { status: res.statusCode, body });
      }
      return originalJson.call(this, body);
    };
    return next();
  }

  function invalidateMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') entries.clear();
    next();
  }

  return {
    clear: () => entries.clear(),
    invalidateMiddleware,
    middleware,
    size: () => entries.size,
  };
}

const responseCache = createResponseCache();

function invalidateResponseCache(req, res, next) {
  return responseCache.invalidateMiddleware(req, res, next);
}

module.exports = {
  createResponseCache,
  invalidateResponseCache,
  responseCacheMiddleware: responseCache.middleware,
};
