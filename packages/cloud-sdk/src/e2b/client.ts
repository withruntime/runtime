import { Runtime } from "../client.js";
import { AuthenticationError, NotSupportedError } from "./errors.js";

/** The Runtime sandbox the adapter drives. */
export type RuntimeSandbox = Awaited<ReturnType<Runtime["sandboxes"]["create"]>>;
/** What `Sandbox.create` sends to Runtime. */
export type RuntimeCreate = NonNullable<Parameters<Runtime["sandboxes"]["create"]>[0]>;

/** E2B's connection options, as far as they mean anything on Runtime. */
export interface ConnectionOpts {
  /** A Runtime key. Default: RUNTIME_API_KEY, then E2B_API_KEY if it holds a
   * Runtime key, then the key `npx withruntime login` saved. An E2B key
   * (`e2b_...`) is never sent anywhere. */
  apiKey?: string;
  /** Per call, retries included. */
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  /** Accepted and ignored, as E2B ignores them. */
  validateApiKey?: boolean;
  /** Accepted and ignored: Runtime's SDK retries by itself. */
  retries?: number;
  /** Accepted and ignored: Runtime's SDK does not take a logger. */
  logger?: unknown;
  /** E2B endpoints. Refused: this package only talks to Runtime. */
  domain?: string;
  apiUrl?: string;
  sandboxUrl?: string;
  debug?: boolean;
  headers?: Record<string, string>;
  apiHeaders?: Record<string, string>;
  proxy?: string;
}

/** Runtime-only options, for code that has been through the switch. */
export interface RuntimeOpts {
  /** A Runtime client to use instead of one made from the key. */
  client?: Runtime;
  /** Fields sent as they are with the create, over the adapter's own: for
   * example `{ funding: "trial" }`, `{ memoryMiB: 4096 }` or `{ region }`. */
  create?: Partial<RuntimeCreate>;
}

const env = (name: string): string | undefined =>
  typeof process === "undefined" ? undefined : process.env[name];

const isE2BKey = (key: string) => key.startsWith("e2b_");

/** Refuses the E2B-only connection options: they point at E2B, and quietly
 * dropping one would send the call somewhere its author did not mean. */
export function refuseE2BConnection(opts: ConnectionOpts = {}) {
  for (const field of [
    "domain",
    "apiUrl",
    "sandboxUrl",
    "headers",
    "apiHeaders",
    "proxy",
  ] as const) {
    if (opts[field] !== undefined)
      throw new NotSupportedError(
        `The E2B connection option "${field}"`,
        field === "proxy"
          ? "Set HTTPS_PROXY in the environment instead; Runtime's SDK reads it."
          : "Remove it: this package talks only to Runtime (RUNTIME_API_URL overrides the API origin).",
      );
  }
  if (opts.debug)
    throw new NotSupportedError(
      "E2B's debug mode (a local envd)",
      "Remove debug: true; there is no local Runtime guest to connect to.",
    );
}

const clients = new Map<string, Runtime>();

/** The Runtime client for these options: an explicit client, else one per key,
 * made once and reused so its connections stay open. */
export function clientFor(opts: ConnectionOpts & { runtime?: RuntimeOpts } = {}): Runtime {
  refuseE2BConnection(opts);
  if (opts.runtime?.client) return opts.runtime.client;
  const key = pickKey(opts.apiKey);
  const cacheKey = key ?? "";
  let client = clients.get(cacheKey);
  if (!client) {
    client = new Runtime(key ? { apiKey: key } : {});
    clients.set(cacheKey, client);
  }
  return client;
}

/** Explicit key, then RUNTIME_API_KEY, then E2B_API_KEY when it holds a
 * Runtime key; undefined lets the Runtime SDK find the saved login. */
export function pickKey(explicit?: string): string | undefined {
  const runtimeKey = env("RUNTIME_API_KEY");
  if (explicit !== undefined && !isE2BKey(explicit)) return explicit;
  if (runtimeKey) return runtimeKey;
  if (explicit !== undefined)
    throw new AuthenticationError(
      "The apiKey passed is an E2B API key (e2b_...), and it was not sent. Set RUNTIME_API_KEY to a Runtime key " +
        "(https://withruntime.com/account/keys, or run `npx withruntime login`), or pass the Runtime key as apiKey.",
    );
  // An E2B key left in E2B_API_KEY is skipped, never sent: the Runtime SDK
  // then uses the key `npx withruntime login` saved, or says none was found.
  const e2bVariable = env("E2B_API_KEY");
  return e2bVariable && !isE2BKey(e2bVariable) ? e2bVariable : undefined;
}

/** Test hook: forget the cached clients. */
export function resetClients() {
  clients.clear();
}

/** Request options for a Runtime call from E2B's. */
export function request(opts: { requestTimeoutMs?: number; signal?: AbortSignal } = {}) {
  return {
    ...(opts.requestTimeoutMs === undefined ? {} : { timeoutMs: opts.requestTimeoutMs }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
}
