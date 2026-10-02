import type { RequestOptions, Transport } from "../transport.js";

/* Your sandboxes reach each other by name. Paid accounts only, free, and off
 * until you turn it on; an account that has not added credit gets
 * `payment_required` (402).
 *
 *   await runtime.network.private.set({ enabled: true });
 *   // in any of your sandboxes: psql -h db.sandbox.internal -p 5432
 *
 * A sandbox is reached at <name>.sandbox.internal:<port> (the name it was
 * created with) or <id>.sandbox.internal:<port>, over TCP, on any port but
 * 10800, 10802 and 10853. Only your organization's sandboxes answer.
 */

export type PrivateNetwork = {
  /** Whether your sandboxes reach each other by name now. */
  enabled: boolean;
  /** `sandbox.internal`. */
  suffix: string;
  /** Whether this account may turn it on: paid accounts only. */
  allowed: boolean;
  /** Why not, when `allowed` is false: `not_paid`, `revoked` or `suspended`. */
  why: string | null;
  enabledAt: string | null;
  disabledAt: string | null;
};

export function privateNetwork(t: Transport) {
  const path = "/v1/network/private";
  return {
    /** On or off, and whether this account may turn it on. */
    get: (options?: RequestOptions) => t.json<PrivateNetwork>({ method: "GET", path, ...options }),
    /** `enabled: true` lets your sandboxes reach each other by name; `false`
     * stops it and cuts open connections between them within seconds. */
    set: (input: { enabled: boolean }, options?: RequestOptions) =>
      t.json<PrivateNetwork>({ method: "PUT", path, body: input, ...options }),
  };
}
