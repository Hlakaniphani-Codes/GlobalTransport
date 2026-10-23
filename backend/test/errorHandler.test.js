const assert = require('node:assert/strict');
const { test } = require('node:test');
const AppError = require('../src/utils/AppError');
const { errorHandler } = require('../src/middleware/errorHandler');

function invokeErrorHandler(error) {
  const response = {
    headers: {},
    statusCode: null,
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  errorHandler(error, { id: 'request-id' }, response, () => {});
  return response;
}

test('pool connection timeouts map to a safe 503 with Retry-After', () => {
  const response = invokeErrorHandler(new Error('timeout exceeded when trying to connect'));
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['Retry-After'], '5');
  assert.deepEqual(response.body, {
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message: 'The service is temporarily unavailable. Please try again shortly.',
    },
  });
});

test('PostgreSQL pool exhaustion maps to 503', () => {
  const response = invokeErrorHandler(Object.assign(new Error('too many connections'), {
    code: '53300',
  }));
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['Retry-After'], '5');
});

test('explicit service-unavailable errors include Retry-After', () => {
  const response = invokeErrorHandler(new AppError(503, 'Please retry.'));
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['Retry-After'], '5');
});

test('unexpected non-Error rejections return a safe internal error response', () => {
  const response = invokeErrorHandler(null);
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, {
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected server error occurred.',
    },
  });
});
