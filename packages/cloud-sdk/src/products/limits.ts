import type { Usage } from "../types.js";
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
  /** Machine time the account can still run without credit, the same
   * figures as `usage.get()`'s `trial`, or null when it has none. */
  trial: Usage["trial"];
  /** Every limit the account is held to, with what it uses of each now: the
   * numbers a create past one is refused `quota_exceeded` by (its
   * `details.limit` names the row). Null when they can't be read. */
  account: AccountLimit[] | null;
  /** The account's prepaid credit and how long it lasts. */
  credit: {
    /** Credit left to spend now, in microdollars. */
    availableMicros: string;
    /** What the account spends in a day at this month's pace, or null when
     * nothing has been spent yet. */
    dailyPaceMicros: string | null;
    /** Days the credit lasts at that pace, or null when nothing is being spent. */
    runwayDays: number | null;
    /** `state` is "low" when the runway is under this many days. */
    lowBelowDays: number;
    /** ok: enough. low: under `lowBelowDays` of runway. empty: none left. */
    state: "ok" | "low" | "empty";
    /** owner: a person pays for this account. agent: it was opened with a
     * wallet and no person pays, so its own agent adds credit with
     * `runtime billing topup <usd>`. */
    addedBy: "owner" | "agent";
  };
};

/** One of the account's limits, as https://withruntime.com/account/limits shows it. */
export type AccountLimit = {
  /** `<kind>.<dimension>`: sandbox.count, sandbox.vcpu, sandbox.memory_mib, volume.count… */
  limit: string;
  label: string;
  /** What `max` and `used` count: things, or MiB. */
  unit: "count" | "mib";
  max: number;
  used: number;
};

/** `runtime.limits.get()`: whether this key is read-only, what its agent
 * may still spend today, and the account's limits with what it uses of each. An owner sets the limit at
 * https://withruntime.com/account/keys; a key can read it, never change it.
 * Past it, a create, wake, extension or renewal fails with
 * `spending_limit_reached` (HTTP 402). */
export function limits(t: Transport) {
  return {
    get: (options?: RequestOptions) =>
      t.json<KeyLimits>({ method: "GET", path: "/v1/limits", ...options }),
  };
}
