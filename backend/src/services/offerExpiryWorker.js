const ADVISORY_LOCK_ID = 714335243;
const RECEIPT_ADVISORY_LOCK_ID = 714335245;
const logger = require('../utils/logger');
const workerMetrics = require('../utils/workerMetrics');
const metrics = require('../utils/metrics');

async function runOfferExpiryWorker(
  pool,
  processExpired,
  processNotifications = async () => {},
  processLifecycle = async () => {},
  getQueueLag = async () => 0
) {
  const startedAt = process.hrtime.bigint();
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [ADVISORY_LOCK_ID]
    );
    locked = result.rows[0]?.locked === true;
    if (!locked) return false;
    try {
      await processExpired();
    } catch (error) {
      logger.error('Trip offer expiry processing failed.', error.code || error.name || 'UNKNOWN_ERROR');
    }
    try {
      await processLifecycle();
    } catch (error) {
      logger.error('Trip lifecycle processing failed.', error.code || error.name || 'UNKNOWN_ERROR');
    }
    try {
      await processNotifications();
    } catch (error) {
      logger.warn('Notification worker run failed.', error.code || error.name || 'UNKNOWN_ERROR');
    }
    return true;
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
      } catch (error) {
        logger.error('Trip offer expiry worker advisory unlock failed.', error.code || error.name || 'UNKNOWN_ERROR');
      } finally {
        client.release();
      }
    } else {
      client.release();
    }
    let oldestDueJobAgeSeconds = 0;
    try {
      oldestDueJobAgeSeconds = await getQueueLag();
    } catch (error) {
      logger.warn('Notification queue lag measurement failed.', error.code || error.name || 'UNKNOWN_ERROR');
    }
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    workerMetrics.recordWorkerTick({ durationMs, oldestDueJobAgeSeconds });
    metrics.recordWorkerTickMetrics({ durationMs, oldestDueJobAgeSeconds });
    logger.info('Worker tick completed.', {
      duration_ms: durationMs,
      oldest_due_job_age_seconds: oldestDueJobAgeSeconds,
    });
  }
}

async function runNotificationReceiptWorker(pool, processReceipts) {
  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    logger.warn('Notification receipt worker could not connect to PostgreSQL.', error.code || error.name || 'UNKNOWN_ERROR');
    return false;
  }
  let locked = false;
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [RECEIPT_ADVISORY_LOCK_ID]
    );
    locked = result.rows[0]?.locked === true;
    if (!locked) return false;
    await processReceipts();
    return true;
  } catch (error) {
    logger.warn('Notification receipt worker failed.', error.code || error.name || 'UNKNOWN_ERROR');
    return false;
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [RECEIPT_ADVISORY_LOCK_ID]);
      } catch (error) {
        logger.error('Notification receipt worker advisory unlock failed.', error.code || error.name || 'UNKNOWN_ERROR');
      } finally {
        client.release();
      }
    } else {
      client.release();
    }
  }
}

module.exports = { runNotificationReceiptWorker, runOfferExpiryWorker };
