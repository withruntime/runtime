import type { RequestOptions, Transport } from "../transport.js";

/* `runtime.keys`: keys made by a key, with no browser, for agent swarms
 * (docs: keys, "Run a swarm"). One paid account, a key per worker, each with
 * its own daily cap; a worker's key sees only what that worker made; revoke
 * it when the worker is done. Needs a full-access key an owner or admin made
 * (a wallet account's key is one). Money is integer microdollars
 * (1,000,000 = $1). */

export type NewKey = {
  /** The key's name, and its agent's: up to 80 characters. */
  name: string;
  /** full (the default): every action. read: every read, nothing else. */
  access?: "full" | "read";
  /** agent (the default): the key sees and acts on only what it makes.
   *  account: everything in the account; only an account-wide key makes one. */
  reach?: "agent" | "account";
  /** The most its agent may commit in any 24 hours, or null for none. Needed
   *  when the making key has a limit: the limits of the keys a key made add
   *  up to at most its own. */
  dailyLimitMicros?: number | null;
};

export type MadeKey = {
  /** The key itself. Shown once: store it now. */
  key: string;
  keyId: string;
  agentId: string;
  orgId: string;
  name: string;
  access: "full" | "read";
  reach: "agent" | "account";
  dailyLimitMicros: number | null;
  /** The making key's expiry, or null for until revoked. */
  expires: string | null;
  /** The id of the key that made it. */
  madeBy: string;
};

export type ListedKey = {
  keyId: string;
  agentId: string;
  name: string;
  access: "full" | "read" | "selected";
  reach: "agent" | "account";
  dailyLimitMicros: number | null;
  /** Committed in the last 24 hours: settled plus held, as the limit counts. */
  dailyUsedMicros: number;
  /** The key that made it, or null for one made on the website. */
  madeBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
};

/** One key's spend, from `GET /v1/usage?key=`. Microdollars as strings. */
export type KeyUsage = {
  keyId: string;
  agentId: string;
  name: string;
  madeBy: string | null;
  revokedAt: string | null;
  dailyLimitMicros: string | null;
  dailyUsedMicros: string;
  spentMicros: string;
  heldMicros: string;
  runningSandboxes: number;
  resources: number;
};

export function keys(t: Transport) {
  return {
    /** Make a key with this one. It never has more than this key, and is in
     *  the audit log as made by it. At most 100 live in an account. */
    create: (input: NewKey, options?: RequestOptions) =>
      t.json<MadeKey>({ method: "POST", path: "/v1/keys", body: input, ...options }),
    /** This key and the keys it made (every key, for an account-wide key),
     *  live first, with what each spent in the last 24 hours. */
    list: async (options?: RequestOptions) =>
      (await t.json<{ keys: ListedKey[] }>({ method: "GET", path: "/v1/keys", ...options })).keys,
    /** Revoke this key or one it made: a worker's, when the worker is done. */
    revoke: (keyId: string, options?: RequestOptions) =>
      t.json<{ keyId: string; revokedAt: string }>({
        method: "DELETE",
        path: `/v1/keys/${encodeURIComponent(keyId)}`,
        ...options,
      }),
    /** What one key spent: itself, or a key it made. */
    usage: async (keyId: string, options?: RequestOptions) =>
      (
        await t.json<{ key: KeyUsage }>({
          method: "GET",
          path: "/v1/usage",
          query: { key: keyId },
          ...options,
        })
      ).key,
  };
}
