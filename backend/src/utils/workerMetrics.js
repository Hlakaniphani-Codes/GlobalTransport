let lastTick = {
  durationMs: 0,
  oldestDueJobAgeSeconds: 0,
  completedAt: null,
};

function recordWorkerTick({
  durationMs,
  oldestDueJobAgeSeconds,
  completedAt = new Date().toISOString(),
}) {
  lastTick = {
    durationMs,
    oldestDueJobAgeSeconds,
    completedAt,
  };
}

function getWorkerMetrics() {
  return { ...lastTick };
}

module.exports = { getWorkerMetrics, recordWorkerTick };
