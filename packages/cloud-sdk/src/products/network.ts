import type { Sandbox } from "../sandbox.js";
import type { RequestOptions, Transport } from "../transport.js";

/** A sandbox's own network rules. */
export type NetworkRules = {
  /** false refuses every outbound connection. */
  internet: boolean;
  /** When not empty, only these web destinations are reachable: `example.com`,
   * `*.example.com` (subdomains, not the apex), an address or a CIDR range. */
  allow?: string[];
  /** Never reachable. Wins over everything. */
  deny?: string[];
  /** host:port pairs beyond ports 80 and 443, such as `db.example.com:5432` or
   * `github.com:22`. Paid sandboxes of organizations with a paid purchase
   * only. In the sandbox, `python3 /usr/local/lib/runtime/guest-egress.py
   * forward 5432 db.example.com:5432` gives psql a local port. */
  connect?: string[];
};
export type NetworkPolicy = Required<NetworkRules> & {
  sandboxId: string;
  version: number;
  /** The sandbox's host confirmed it enforces this version. */
  enforced: boolean;
  enforcedVersion: number;
  /** Ports reachable without a connect entry. */
  ports: number[];
  connectAllowed: boolean;
  /** paid, granted, not_paid, revoked, suspended, or trial (a sandbox without credit reaches ports 80 and 443 only). */
  connectReason: string;
  forbiddenPorts: number[];
  updatedAt: string | null;
};

/** `sbx.network`: turn the sandbox's internet off or on, narrow it to a list,
 * refuse destinations, or open host:port pairs. Changes apply at once, to open
 * connections too.
 *
 *   await sbx.network.set({ internet: true, allow: ["registry.npmjs.org"] });
 *   await sbx.network.set({ internet: false });
 */
export function sandboxNetwork(t: Transport, sandbox: Sandbox) {
  const path = () => `/v1/sandboxes/${encodeURIComponent(sandbox.id)}/network`;
  return {
    get: (options?: RequestOptions) =>
      t.json<NetworkPolicy>({ method: "GET", path: path(), ...options }),
    /** Replaces the rules. */
    set: (rules: NetworkRules, options?: RequestOptions) =>
      t.json<NetworkPolicy>({ method: "PUT", path: path(), body: rules, ...options }),
    /** No outbound connections at all. */
    off: (options?: RequestOptions) =>
      t.json<NetworkPolicy>({ method: "PUT", path: path(), body: { internet: false }, ...options }),
    /** The host's public-web policy and nothing narrower. */
    on: (options?: RequestOptions) =>
      t.json<NetworkPolicy>({ method: "PUT", path: path(), body: { internet: true }, ...options }),
  };
}
