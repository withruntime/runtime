import type { RequestOptions, Transport } from "../transport.js";

/* `runtime.keys`: keys made by a key, with no browser, for agent swarms
 * (docs: keys, "Run a swarm"). One paid account, a key per worker, each with
 * its own daily cap; a worker's key sees only what that worker made; revoke
 * it when the worker is done. Needs a full-access key an owner or admin made
 * (a wallet account's key is one). Money is integer microdollars
 * (1,000,000 = $1).
 *
 * A key limited to sandboxes (`sandboxes` and `actions`) does only what it is
 * given, to only those sandboxes, called by id: a watcher that looks at one
 * sandbox and restarts it holds no key to the rest of the account. */

/** What a key limited to sandboxes may do to them. get reads them; create
 *  starts, wakes and restarts them (never makes one), and is the one that
 *  spends; stop stops and pauses them; exec runs commands and processes;
 *  read_file and write_file reach their files. */
export type LimitedKeyAction = "get" | "create" | "stop" | "exec" | "read_file" | "write_file";

export type NewKey = FullOrReadKey | LimitedKey;

type FullOrReadKey = {
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
  sandboxes?: never;
  actions?: never;
};

/** A key limited to these sandboxes and these actions on them. */
export type LimitedKey = {
  name: string;
  /** 1 to 20 sandbox ids this key acts on, outside every compartment. */
  sandboxes: string[];
  actions: LimitedKeyAction[];
  /** Only with create, the one action that spends. */
  dailyLimitMicros?: number | null;
  access?: never;
  reach?: never;
};

export type MadeKey = {
  /** The key itself. Shown once: store it now. */
  key: string;
  keyId: string;
  agentId: string;
  orgId: string;
  name: string;
  /** selected: a key limited to sandboxes. */
  access: "full" | "read" | "selected";
  /** sandboxes: only the sandboxes it names. */
  reach: "agent" | "account" | "sandboxes";
  dailyLimitMicros: number | null;
  /** The sandboxes it is limited to, or null. */
  sandboxes: string[] | null;
  /** Its actions, when it has named ones, or null. */
  actions: string[] | null;
  /** The making key's expiry, or null for until revoked. */
  expires: string | null;
  /** The id of the key that made it. */
  madeBy: string;
};

/** What `keys.update` changes: either or both. */
export type KeyChange = {
  /** account: everything in the account (only from an account-wide key).
   *  agent: back to only what the key's own agent makes. */
  reach?: "agent" | "account";
  /** The most its agent may commit in any 24 hours, or null for none. */
  dailyLimitMicros?: number | null;
};

export type ListedKey = {
  keyId: string;
  agentId: string;
  name: string;
  access: "full" | "read" | "selected";
  reach: "agent" | "account" | "sandboxes";
  dailyLimitMicros: number | null;
  sandboxes: string[] | null;
  actions: string[] | null;
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
    /** Change a key's reach or daily limit (null removes it). A key widens
     *  only the keys it made, never past itself; it narrows any key it sees,
     *  and never changes itself. Returns the key as `list` shows it. */
    update: (keyId: string, change: KeyChange, options?: RequestOptions) =>
      t.json<ListedKey>({
        method: "PATCH",
        path: `/v1/keys/${encodeURIComponent(keyId)}`,
        body: change,
        ...options,
      }),
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
