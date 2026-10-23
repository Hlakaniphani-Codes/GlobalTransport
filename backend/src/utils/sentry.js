function sanitizeEvent(event) {
  delete event.user;
  event.transaction = 'HTTP request';
  event.breadcrumbs = [];
  event.extra = undefined;
  if (event.request) {
    event.request = {
      method: event.request.method,
      url: '/',
    };
  }
  return event;
}

function initializeSentry(dsn) {
  if (!dsn) return null;
  let Sentry;
  try {
    Sentry = require('@sentry/node');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error(
      'SENTRY_DSN requires the optional @sentry/node package to be installed.',
      { cause: error }
    );
  }
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    tracesSampleRate: 0.05,
    beforeSend: sanitizeEvent,
    beforeSendTransaction: sanitizeEvent,
  });
  return Sentry;
}

module.exports = { initializeSentry, sanitizeEvent };
