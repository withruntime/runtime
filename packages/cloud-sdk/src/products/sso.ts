import type { RequestOptions, Transport } from "../transport.js";

/** One identity provider of the account. */
export type SsoConnection = {
  id: string;
  /** Names the connection in its sign-in URLs. */
  providerId: string;
  protocol: "oidc" | "saml";
  provider: "okta" | "entra" | "google" | "other";
  /** The email domain it answers for. */
  domain: string;
  /** When DNS proved the domain; null until then, and nobody signs in until then. */
  domainVerifiedAt: string | null;
  /** The TXT record that proves the domain. */
  verification: { type: "TXT"; name: string; value: string };
  defaultRole: "admin" | "developer" | "billing";
  /** Members other than owners sign in only through it. API keys are unaffected. */
  requireSso: boolean;
  createdAt: string;
};
export type SsoStatus = {
  connections: SsoConnection[];
  scim: {
    tokens: number;
    users: number;
    activeUsers: number;
    groups: { id: string; displayName: string; role: string | null }[];
  };
  /** Where an owner changes single sign-on. */
  manage: string;
};

/** `runtime.sso.get()`: the account's single sign-on and SCIM directory sync.
 * Read only; an owner changes it on the website. Needs a key made by an owner
 * or admin. */
export function sso(t: Transport) {
  return {
    get: (options?: RequestOptions) =>
      t.json<SsoStatus>({ method: "GET", path: "/v1/sso", ...options }),
  };
}
