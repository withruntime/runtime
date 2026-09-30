import type { RequestOptions, Transport } from "../transport.js";

/** What this key may do, and the daily spending limit on its agent. Money is
 * integer microdollars in strings (1,000,000 = $1). */
export type KeyLimits = {
  /** full: every action. read: every read and nothing else (a read-only key).
   * selected: the actions the key names. */
  access: "full" | "read" | "selected" | null;
  daily: {
    /** The most this agent may commit in any 24 hours, or null for no limit. */
    limitMicros: string | null;
    /** Committed in the last 24 hours: charges settled plus money on hold. */
    usedMicros: string;
    /** What is left under the limit now, or null for no limit. */
    remainingMicros: string | null;
    window: "24h";
  };
  /** The account's free trial time in milliseconds, the same figures as
   * `usage.get()`, or null when the account has no trial. A trial sandbox
   * that has not ended holds its whole lease in `reservedMs`;
   * `availableMs = totalMs - usedMs - reservedMs`. */
  trial: { totalMs: number; usedMs: number; reservedMs: number; availableMs: number } | null;
};

/** `runtime.limits.get()`: whether this key is read-only, and what its agent
 * may still spend today. An owner sets the limit at
 * https://withruntime.com/account/keys; a key can read it, never change it.
 * Past it, a create, wake, extension or renewal fails with
 * `spending_limit_reached` (HTTP 402). */
export function limits(t: Transport) {
  return {
    get: (options?: RequestOptions) =>
      t.json<KeyLimits>({ method: "GET", path: "/v1/limits", ...options }),
  };
}
