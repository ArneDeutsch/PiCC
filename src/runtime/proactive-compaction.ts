/**
 * Proactive early compaction — the extension-side margin lever.
 *
 * PiCC watches context usage at each turn boundary and triggers Pi's own compaction
 * *early* (before Pi's fixed hard trigger) so a long session never rides at the ~99%
 * edge where a single oversized output or a transient network blip can be fatal. Pi
 * exposes no `reserveTokens` setter to extensions, so compacting sooner is the reachable
 * substitute for a larger reserve.
 *
 * This module is the PURE decision core: a side-effect-free function of
 * `(usage, threshold, pendingState)`. All I/O — reading usage, calling `ctx.compact()`,
 * emitting the user notice, resetting the pending state on `session_compact` — lives in the
 * event handlers that consume this.
 */

/**
 * The subset of Pi's `ContextUsage` this decision reads. `percent` is on the **0–100
 * scale** and can be `null` right after a compaction (before the next LLM response); the
 * whole object can be `undefined` when the host has no usage yet. `tokens`/`contextWindow`
 * are unused here but modeled so the real 3-field shape type-checks.
 */
export interface ContextUsageShape {
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
}

/**
 * Anti-thrash state carried between turn boundaries.
 *
 * - `pending` is set when a proactive compaction has been requested and we are waiting for
 *   it to take effect; `turnsRemaining` counts down the bounded fallback that clears a stuck
 *   pending flag when no `session_compact` success arrives (compaction failure fires no
 *   event to the extension).
 * - `cooldownRemaining` counts down a settling window that begins after a *completed*
 *   compaction: for that many turns no proactive compaction fires even if usage is still at
 *   or above threshold, so a compaction that fails to drop usage below the threshold (a low
 *   threshold, or a large preserved floor) can't back-to-back re-compact and re-notify.
 */
export interface ProactivePendingState {
  pending: boolean;
  turnsRemaining: number;
  cooldownRemaining: number;
}

/** Outcome of one turn-boundary evaluation: whether to compact, plus the next pending state. */
export interface ProactiveDecision {
  compact: boolean;
  pending: ProactivePendingState;
}

/**
 * Turns a proactive-compaction request stays pending before the fallback re-evaluates.
 * Prevents a persistent (event-less) compaction failure from deadlocking the feature while
 * still suppressing per-turn thrash once over threshold: after this many turns with no
 * `session_compact` success the request is treated as failed and re-evaluated.
 */
export const PROACTIVE_PENDING_MAX_TURNS = 3;

/**
 * Turns a completed compaction suppresses further proactive compaction. Distinct from the
 * pending fallback: this window opens only on a `session_compact` SUCCESS, so a silently
 * failed compaction (no event) still re-fires via the pending fallback above.
 */
export const PROACTIVE_COOLDOWN_TURNS = 3;

/** The cleared/initial pending state — no request outstanding, no cooldown. */
export function initialPendingState(): ProactivePendingState {
  return { pending: false, turnsRemaining: 0, cooldownRemaining: 0 };
}

/**
 * State to adopt after a `session_compact` SUCCESS: no request outstanding, but a cooldown
 * window open so the immediately-following turns can't re-compact if usage stayed high.
 */
export function pendingStateAfterCompaction(): ProactivePendingState {
  return { pending: false, turnsRemaining: 0, cooldownRemaining: PROACTIVE_COOLDOWN_TURNS };
}

/**
 * Decide, at a turn boundary, whether to proactively compact.
 *
 * Rules, in order:
 * - While a prior request is still pending, never re-trigger; age the bounded fallback. Once
 *   it expires, fall through and re-evaluate this same turn (so a silently-failed compaction
 *   re-fires as soon as the window elapses rather than one turn later).
 * - While a post-compaction cooldown is open, age it and never compact — the anti-thrash
 *   guard against a compaction that doesn't drop usage below threshold.
 * - Otherwise compact when a numeric `percent` meets or exceeds the threshold. `undefined`
 *   usage, a `null`/absent `percent`, or a `null` `tokens` all read as "don't compact" —
 *   the `typeof === "number"` gate means no `null >= threshold` comparison ever runs.
 *
 * Pure: no throws, no side effects.
 */
export function decideProactiveCompaction(
  usage: ContextUsageShape | undefined,
  threshold: number,
  pending: ProactivePendingState,
): ProactiveDecision {
  if (pending.pending) {
    const turnsRemaining = pending.turnsRemaining - 1;
    if (turnsRemaining > 0) {
      return {
        compact: false,
        pending: { pending: true, turnsRemaining, cooldownRemaining: pending.cooldownRemaining },
      };
    }
    // Fallback window elapsed with no `session_compact` success: treat the request as failed
    // and re-evaluate this turn with a cleared pending flag.
    pending = { pending: false, turnsRemaining: 0, cooldownRemaining: pending.cooldownRemaining };
  }

  if (pending.cooldownRemaining > 0) {
    return {
      compact: false,
      pending: { pending: false, turnsRemaining: 0, cooldownRemaining: pending.cooldownRemaining - 1 },
    };
  }

  const percent = usage?.percent;
  if (typeof percent === "number" && percent >= threshold) {
    return {
      compact: true,
      pending: { pending: true, turnsRemaining: PROACTIVE_PENDING_MAX_TURNS, cooldownRemaining: 0 },
    };
  }

  return { compact: false, pending };
}
