import type { RequestOptions, Transport } from "../transport.js";

/* Your sandboxes' outbound HTTP requests can carry Runtime's Web Bot Auth
 * signature (IETF draft, RFC 9421 HTTP message signatures), so sites behind
 * Cloudflare and other bot managers recognise them as Runtime's agents. Free,
 * off until you turn it on, and only for an account with credit.
 *
 *   await runtime.networks.signedRequests.set({ enabled: true });
 *
 * Runtime's browser adds the signature by itself; any other program gets the
 * headers from https://withruntime.com/api/signed-requests/sign (documented at
 * /docs/egress).
 */

export type SignedRequests = {
  /** Whether your sandboxes may get Runtime's request signature now. */
  enabled: boolean;
  /** Whether this account may turn it on: it must have credit. */
  allowed: boolean;
  /** Why not, when `allowed` is false: `no_credit`, `revoked` or `suspended`. */
  why: string | null;
  enabledAt: string | null;
  disabledAt: string | null;
};

export function signedRequests(t: Transport) {
  const path = "/v1/networks/signed-requests";
  return {
    /** On or off, and whether this account may turn it on. */
    get: (options?: RequestOptions) => t.json<SignedRequests>({ method: "GET", path, ...options }),
    /** `enabled: true` lets your sandboxes get Runtime's request signature;
     * `false` stops new signatures at once, and ones already given expire
     * within 5 minutes. */
    set: (input: { enabled: boolean }, options?: RequestOptions) =>
      t.json<SignedRequests>({ method: "PUT", path, body: input, ...options }),
  };
}
