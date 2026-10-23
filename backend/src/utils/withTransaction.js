const pool = require('../db');
const logger = require('./logger');

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

function waitForRetry(attempt) {
  const maximumDelayMs = Math.min(250, 25 * (2 ** attempt));
  const delayMs = Math.floor(Math.random() * maximumDelayMs);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function withTransaction(work, { retries = 3 } = {}) {
  if (typeof work !== 'function') {
    throw new TypeError('withTransaction requires a transaction callback.');
  }
  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError('Transaction retries must be a non-negative integer.');
  }

  for (let attempt = 0; ; attempt += 1) {
    const client = await pool.connect();
    let transactionStarted = false;
    let clientReleased = false;
    const releaseClient = () => {
      if (clientReleased) return;
      clientReleased = true;
      client.release();
    };
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          logger.error('Database transaction rollback failed.', {
            code: rollbackError.code ?? 'UNKNOWN_ERROR',
          });
        }
      }
      if (RETRYABLE_SQLSTATES.has(error.code) && attempt < retries) {
        releaseClient();
        logger.warn('Retrying PostgreSQL transaction after a transient conflict.', {
          code: error.code,
        });
        await waitForRetry(attempt);
        continue;
      }
      throw error;
    } finally {
      releaseClient();
    }
  }
}

module.exports = withTransaction;
