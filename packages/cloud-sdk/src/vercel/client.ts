import { Runtime } from "../client.js";
import { AuthenticationError } from "./errors.js";

/** The Runtime sandbox the adapter drives. */
export type RuntimeSandbox = Awaited<ReturnType<Runtime["sandboxes"]["create"]>>;
/** What `Sandbox.create` sends to Runtime. */
export type RuntimeCreate = NonNullable<Parameters<Runtime["sandboxes"]["create"]>[0]>;

/** Vercel's credentials. A Vercel token is never sent anywhere: only a
 * Runtime key (`rtcloud_...`) given as `token` is used. */
export interface Credentials {
  token?: string;
  teamId?: string;
  projectId?: string;
}

/** Runtime-only options, for code that has been through the switch. The key
 * is `withruntime` because Vercel's own `runtime` field names a Node.js or
 * Python version. */
export interface WithRuntime {
  /** A Runtime client to use instead of one made from the key. */
  client?: Runtime;
  /** Fields sent as they are with the create, over the adapter's own: for
   * example `{ funding: "trial" }` or `{ memoryMiB: 8192 }`. */
  create?: Partial<RuntimeCreate>;
}

const env = (name: string): string | undefined =>
  typeof process === "undefined" ? undefined : process.env[name];

const isRuntimeKey = (key: string) => key.startsWith("rtcloud_");

const clients = new Map<string, Runtime>();

/** The key to use: a Runtime key given as `token`, then RUNTIME_API_KEY, then
 * the key `npx withruntime login` saved (undefined lets the Runtime SDK find
 * it). A Vercel token passed as `token` is refused, never sent. */
export function pickKey(token?: string): string | undefined {
  if (token !== undefined && isRuntimeKey(token)) return token;
  const runtimeKey = env("RUNTIME_API_KEY");
  if (runtimeKey) return runtimeKey;
  if (token !== undefined && token !== "")
    throw new AuthenticationError(
      "The token passed is a Vercel token, and it was not sent. Set RUNTIME_API_KEY to a Runtime key " +
        "(https://withruntime.com/account/keys, or run `npx withruntime login`), or pass the Runtime key as token.",
    );
  return undefined;
}

/** The Runtime client for these options: an explicit client, else one per key,
 * made once and reused so its connections stay open. */
export function clientFor(opts: Credentials & { withruntime?: WithRuntime } = {}): Runtime {
  if (opts.withruntime?.client) return opts.withruntime.client;
  const key = pickKey(opts.token);
  let client = clients.get(key ?? "");
  if (!client) {
    client = new Runtime(key ? { apiKey: key } : {});
    clients.set(key ?? "", client);
  }
  return client;
}

/** Test hook: forget the cached clients. */
export function resetClients() {
  clients.clear();
}

export function signalOf(opts?: { signal?: AbortSignal }) {
  return opts?.signal ? { signal: opts.signal } : {};
}
