function createCircuitBreaker({
  failureThreshold = 5,
  openMs = 60_000,
  clock = () => Date.now(),
} = {}) {
  let consecutiveFailures = 0;
  let openUntil = 0;

  function isOpen() {
    if (openUntil && clock() >= openUntil) openUntil = 0;
    return openUntil > clock();
  }

  return {
    isOpen,
    recordFailure() {
      if (isOpen()) return;
      consecutiveFailures += 1;
      if (consecutiveFailures >= failureThreshold) {
        openUntil = clock() + openMs;
        consecutiveFailures = 0;
        return true;
      }
      return false;
    },
    recordSuccess() {
      consecutiveFailures = 0;
    },
    retryAfterSeconds() {
      return Math.max(1, Math.ceil((openUntil - clock()) / 1_000));
    },
  };
}

module.exports = { createCircuitBreaker };
