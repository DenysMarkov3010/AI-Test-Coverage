/**
 * Keep the run log alive while a generation is in flight.
 *
 * A single LLM call takes tens of seconds, and nothing was printed for its whole duration — the
 * run looked stalled. This prints a tick every few seconds so the log shows the run is alive, and
 * one line with the elapsed time when the call returns.
 *
 * The interval is unref'd: a pending tick must never be the reason the process stays alive.
 */

const DEFAULT_INTERVAL_MS = 5000;

/**
 * @param {string} label - what is being waited on, e.g. "anthropic/claude-sonnet-5"
 * @param {{ intervalMs?: number, log?: Function }} [options]
 * @returns {() => number} stop function; returns the elapsed whole seconds
 */
function startHeartbeat(label, options = {}) {
  const intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
  const log = options.log || console.log;
  const startedAt = Date.now();
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);

  const timer = setInterval(() => {
    log(`   ⏳ Waiting for ${label}… ${elapsed()}s elapsed`);
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  let stopped = false;
  return () => {
    if (stopped) return elapsed();
    stopped = true;
    clearInterval(timer);
    return elapsed();
  };
}

module.exports = { startHeartbeat, DEFAULT_INTERVAL_MS };
