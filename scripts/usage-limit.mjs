// A usage limit as a headless session's stream-json reports it (docs/platform-notes.md § (k)): a
// rejected `rate_limit_event`, whose `resetsAt` (epoch seconds) is when the window reopens. The
// unattended driver and the planning benchmark both wait one out, so both read it here.

// How long past a limit's reset a waiter sleeps before its next session, so it never starts a
// session the instant the window reopens.
export const RESET_MARGIN_MS = 60_000;

/**
 * The limit a stream-json event reports.
 * @param {object} event one parsed stream-json line
 * @returns {{resetAt: number|null}|null} the reset in epoch seconds (null when the event gives none)
 *   for a rejected `rate_limit_event`; null for any other event
 */
export function rejectedLimit(event) {
  if (event?.type !== "rate_limit_event" || event.rate_limit_info?.status !== "rejected") return null;
  const resetAt = event.rate_limit_info.resetsAt;
  return { resetAt: typeof resetAt === "number" ? resetAt : null };
}

/** Milliseconds to wait out a limit resetting at `resetAt` (epoch seconds) from `nowMs`: to the reset plus the margin, never negative. */
export const resetWaitMs = (resetAt, nowMs) => Math.max(resetAt * 1000 - nowMs, 0) + RESET_MARGIN_MS;
