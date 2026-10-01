/**
 * asyncLock.js — a per-key async mutex, in-process only.
 *
 * The app runs as a single PM2 instance (no clustering), so this is
 * sufficient to close races between two concurrent requests for the same
 * resource (e.g. two status-change requests for the same contract) without
 * needing a distributed lock.
 */
const tails = new Map();

// Runs fn() after every previously-queued call for the same key has settled.
// A rejection from one call never breaks the chain for the next. Returns the
// promise for THIS call specifically (its own resolution/rejection, not a
// swallowed one).
function withLock(key, fn) {
  const tail = (tails.get(key) || Promise.resolve()).catch(() => {});
  const next = tail.then(fn);
  const guarded = next.catch(() => {});
  tails.set(key, guarded);
  // Cleanup runs off 'guarded' (never rejects), not 'next' — calling
  // .finally() directly on 'next' would create an unobserved promise that
  // rejects whenever 'next' does, reported as an unhandled rejection.
  guarded.finally(() => { if (tails.get(key) === guarded) tails.delete(key); });
  return next;
}

module.exports = { withLock };
