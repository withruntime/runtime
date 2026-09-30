import type { RequestOptions, Transport } from "../transport.js";

/** One entry of the account's audit log. */
export type AuditEvent = {
  /** Position in the log. Pass the last page's `next` as `before`. */
  seq: string;
  id: string;
  /** When, ISO 8601 UTC. */
  at: string;
  /** What happened, like `member.role_changed`, `key.created` or `credit.purchased`. */
  action: string;
  actor: {
    /** `runtime` is Runtime itself: a payment, an expiry, a takedown. */
    kind: "person" | "agent" | "app" | "group" | "runtime";
    id: string | null;
    name: string | null;
    /** For an agent: the member whose key it is. */
    person: string | null;
  };
  target: { type: string | null; id: string | null };
  /** The facts that matter, such as an email, a role or an amount. Never a secret. */
  detail: Record<string, unknown>;
  /** The client address the request came from. */
  ip: string | null;
  requestId: string | null;
  via: "web" | "api" | "mcp" | "runtime";
  /** The sandbox the request came from, when code in it called the API at
   * http://runtime.internal. */
  sandbox: string | null;
};
export type AuditPage = { events: AuditEvent[]; next: string | null };

/** `runtime.audit`: the account's audit log, newest first. Needs a key for
 * every product or a read-only key, made by an owner or admin.
 *
 *   const { events, next } = await runtime.audit.list({ action: "member." });
 */
export function audit(t: Transport) {
  return {
    list: (
      query: {
        /** An action (`key.created`), or a group ending in a dot (`member.`, `credit.`). */
        action?: string;
        /** 1 to 200; 50 by default. */
        limit?: number;
        /** The previous page's `next`. */
        before?: string;
      } = {},
      options?: RequestOptions,
    ) => t.json<AuditPage>({ method: "GET", path: "/v1/audit", query, ...options }),
  };
}
