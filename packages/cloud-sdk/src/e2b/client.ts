import { Runtime } from "../client.js";
import { AuthenticationError, InvalidArgumentError, NotSupportedError } from "./errors.js";

/** The Runtime sandbox the adapter drives. */
export type RuntimeSandbox = Awaited<ReturnType<Runtime["sandboxes"]["create"]>>;
/** What `Sandbox.create` sends to Runtime. */
export type RuntimeCreate = NonNullable<Parameters<Runtime["sandboxes"]["create"]>[0]>;

/** E2B's HTTP version for its API and sandboxes (e2b 2.52.0). */
export type HttpVersion = "1.1" | "2";

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
  /** Checked as E2B checks it (and E2B_HTTP_VERSION), then left to Runtime's
   * SDK, which picks its own transport. */
  httpVersion?: HttpVersion;
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
  // E2B refuses any other version, from the option or the environment.
  const version = opts.httpVersion ?? (env("E2B_HTTP_VERSION") || undefined);
  if (version !== undefined && version !== "1.1" && version !== "2")
    throw new InvalidArgumentError(
      `${opts.httpVersion === undefined ? "E2B_HTTP_VERSION" : "httpVersion"} must be '1.1' or '2', got '${version}'`,
    );
  if (opts.debug)
    throw new NotSupportedError(
      "E2B's debug mode (a local envd)",
      "Remove debug: true; there is no local Runtime guest to connect to.",
    );
}

const clients = new Map<string, Runtime>();

/** Connections the adapter's own client may hold at once: E2B's SDK has no
 * cap of its own, so an orchestrator that drives a thousand sandboxes from one
 * process runs every command at once. 4,096 is the widest room Runtime's edge
 * gives an address that has used a valid key (api.md, "Limits"); the edge and
 * the API answer anything past an account's room with a retry, which the
 * client waits out. Runtime's own SDK keeps 48. */
export const E2B_MAX_CONNECTIONS = 4096;

let warnedQueued = false;
/** Said once per process, the first time a call has to wait for a
 * connection: E2B never holds a call back, so a caller should hear it. */
export function warnQueued(maxConnections: number) {
  if (warnedQueued || typeof process === "undefined" || !process.emitWarning) return;
  warnedQueued = true;
  process.emitWarning(
    `More than ${maxConnections} calls and command streams are open at once from this process, so the rest wait their turn. ` +
      "Pass runtime: { client: new Runtime({ maxConnections }) } for more.",
    { code: "RUNTIME_E2B_QUEUED" },
  );
}

/** The Runtime client for these options: an explicit client, else one per key,
 * made once and reused so its connections stay open. */
export function clientFor(opts: ConnectionOpts & { runtime?: RuntimeOpts } = {}): Runtime {
  refuseE2BConnection(opts);
  if (opts.runtime?.client) return opts.runtime.client;
  const key = pickKey(opts.apiKey);
  const cacheKey = key ?? "";
  let client = clients.get(cacheKey);
  if (!client) {
    client = new Runtime({
      ...(key ? { apiKey: key } : {}),
      maxConnections: E2B_MAX_CONNECTIONS,
      onQueued: warnQueued,
    });
    clients.set(cacheKey, client);
  }
  return client;
}

/** Explicit key, then RUNTIME_API_KEY, then E2B_API_KEY when it holds a
 * Runtime key; undefined, when none is set, lets the Runtime SDK find the
 * saved login. An E2B key is refused, never sent. */
export function pickKey(explicit?: string): string | undefined {
  const runtimeKey = env("RUNTIME_API_KEY");
  if (explicit !== undefined && !isE2BKey(explicit)) return explicit;
  if (runtimeKey) {
    warnTwoKeys(runtimeKey, env("E2B_API_KEY"));
    return runtimeKey;
  }
  if (explicit !== undefined)
    throw new AuthenticationError(
      "The apiKey passed is an E2B API key (e2b_...), and it was not sent. Set RUNTIME_API_KEY to a Runtime key " +
        "(https://withruntime.com/account/keys, or run `npx withruntime login`), or pass the Runtime key as apiKey.",
    );
  // An E2B key left in E2B_API_KEY is never sent, and never quietly passed
  // over for the key `npx withruntime login` saved, which may be another
  // account's.
  const e2bVariable = env("E2B_API_KEY");
  if (e2bVariable && isE2BKey(e2bVariable))
    throw new AuthenticationError(
      "E2B_API_KEY holds an E2B API key (e2b_...), and it was not sent. Set RUNTIME_API_KEY to a Runtime key " +
        "(https://withruntime.com/account/keys, or run `npx withruntime login`), or put the Runtime key in E2B_API_KEY.",
    );
  return e2bVariable || undefined;
}

/** Where the key in use came from, as an error names it. */
export function keySource(explicit?: string): string {
  if (explicit !== undefined && !isE2BKey(explicit)) return "apiKey";
  if (env("RUNTIME_API_KEY")) return "RUNTIME_API_KEY";
  if (env("E2B_API_KEY")) return "E2B_API_KEY";
  return "the saved login";
}

let warnedTwoKeys = false;
/** Said once per process: RUNTIME_API_KEY wins, as in Runtime's own SDK, but
 * code written for E2B means E2B_API_KEY, so two different Runtime keys are
 * likely two accounts, and the wrong one fails later as a missing image
 * (5 October 2026). */
function warnTwoKeys(runtimeKey: string, e2bVariable: string | undefined) {
  if (!e2bVariable || isE2BKey(e2bVariable) || e2bVariable === runtimeKey) return;
  if (warnedTwoKeys || typeof process === "undefined" || !process.emitWarning) return;
  warnedTwoKeys = true;
  process.emitWarning(
    "RUNTIME_API_KEY and E2B_API_KEY hold different Runtime keys, which may be different accounts; this package uses " +
      "RUNTIME_API_KEY. Unset one, or set both to the same key.",
    { code: "RUNTIME_E2B_TWO_KEYS" },
  );
}

/** Test hook: forget the cached clients and the warnings. */
export function resetClients() {
  clients.clear();
  warnedQueued = false;
  warnedTwoKeys = false;
}

/** Request options for a Runtime call from E2B's. */
export function request(opts: { requestTimeoutMs?: number; signal?: AbortSignal } = {}) {
  return {
    ...(opts.requestTimeoutMs === undefined ? {} : { timeoutMs: opts.requestTimeoutMs }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
}
