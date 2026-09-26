import { Runtime } from "../client.js";
import { DaytonaAuthenticationError, NotSupportedError } from "./errors.js";

/** The Runtime sandbox the adapter drives. */
export type RuntimeSandbox = Awaited<ReturnType<Runtime["sandboxes"]["create"]>>;
/** What `daytona.create` sends to Runtime. */
export type RuntimeCreate = NonNullable<Parameters<Runtime["sandboxes"]["create"]>[0]>;

/** Runtime-only options, for code that has been through the switch. */
export interface WithRuntime {
  /** A Runtime client to use instead of one made from the key. */
  client?: Runtime;
  /** Fields sent as they are with every create, over the adapter's own: for
   * example `{ funding: "trial" }`. */
  create?: Partial<RuntimeCreate>;
}

/** Daytona's client options, as far as they mean anything on Runtime. */
export interface DaytonaConfig {
  /** A Runtime key (`rtcloud_...`). Default: RUNTIME_API_KEY, then a Runtime
   * key left in DAYTONA_API_KEY, then the key `npx withruntime login` saved.
   * A Daytona key is never sent anywhere. */
  apiKey?: string;
  /** Refused: Runtime authenticates with keys. */
  jwtToken?: string;
  organizationId?: string;
  /** Daytona's API address. Ignored: this package talks only to Runtime
   * (RUNTIME_API_URL overrides Runtime's). */
  apiUrl?: string;
  serverUrl?: string;
  /** "us" is Runtime's one region; any other is refused. */
  target?: string;
  /** Accepted and ignored: Runtime's SDK does not export traces. */
  otelEnabled?: boolean;
  useDeprecatedPolling?: boolean;
  /** Accepted and ignored: Runtime's SDK sets its own request deadlines. */
  requestTimeoutMs?: number;
  _experimental?: Record<string, unknown>;
  /** Runtime-only: an explicit client, or fields for every create. */
  withruntime?: WithRuntime;
}

const env = (name: string): string | undefined =>
  typeof process === "undefined" ? undefined : process.env[name];

const isRuntimeKey = (key: string) => key.startsWith("rtcloud_");

/** Explicit Runtime key, then RUNTIME_API_KEY, then DAYTONA_API_KEY when it
 * holds a Runtime key; undefined lets the Runtime SDK find the saved login. */
export function pickKey(explicit?: string): string | undefined {
  if (explicit !== undefined && isRuntimeKey(explicit)) return explicit;
  const runtimeKey = env("RUNTIME_API_KEY");
  if (runtimeKey) return runtimeKey;
  if (explicit !== undefined && explicit !== "")
    throw new DaytonaAuthenticationError(
      "The apiKey passed is a Daytona API key, and it was not sent. Set RUNTIME_API_KEY to a Runtime key " +
        "(https://withruntime.com/account/keys, or run `npx withruntime login`), or pass the Runtime key as apiKey.",
    );
  const daytonaVariable = env("DAYTONA_API_KEY");
  return daytonaVariable && isRuntimeKey(daytonaVariable) ? daytonaVariable : undefined;
}

const clients = new Map<string, Runtime>();

/** The Runtime client for this configuration. */
export function clientFor(config: DaytonaConfig = {}): Runtime {
  if (config.jwtToken !== undefined || (config.organizationId !== undefined && !config.apiKey))
    throw new NotSupportedError(
      "Daytona JWT sign-in (jwtToken, organizationId)",
      "Use a Runtime key: set RUNTIME_API_KEY, or run `npx withruntime login` once.",
    );
  const target = config.target ?? env("DAYTONA_TARGET");
  if (target !== undefined && target !== "" && target !== "us")
    throw new NotSupportedError(
      `The Daytona target "${target}"`,
      'Runtime runs in one US region; remove target or use "us".',
    );
  if (config.withruntime?.client) return config.withruntime.client;
  const key = pickKey(config.apiKey);
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
