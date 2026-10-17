import { Runtime } from "../client.js";
import { CredentialsError, NotSupportedError } from "./errors.js";

/** The Runtime sandbox the adapter drives. */
export type RuntimeSandbox = Awaited<ReturnType<Runtime["sandboxes"]["create"]>>;
/** What `SandboxInstance.create` sends to Runtime. */
export type RuntimeCreate = NonNullable<Parameters<Runtime["sandboxes"]["create"]>[0]>;

/** Runtime-only options, for code that has been through the switch. */
export interface WithRuntime {
  /** A Runtime client to use instead of one made from the key. */
  client?: Runtime;
  /** Fields sent as they are with the create, over the adapter's own: for
   * example `{ funding: "trial" }` or `{ vcpu: 4 }`. */
  create?: Partial<RuntimeCreate>;
}

/** Options every static call takes, for code that has been through the
 * switch: `SandboxInstance.get(name, { withruntime: { client } })`. */
export interface RuntimeOptions {
  withruntime?: WithRuntime;
}

/** Blaxel's `initialize` / `settings.setConfig` fields, as far as they mean
 * anything on Runtime. */
export interface Config {
  /** A Runtime key (`rtcloud_...`) is used; a Blaxel key is refused, never sent. */
  apikey?: string;
  apiKey?: string;
  workspace?: string;
  proxy?: string;
  clientCredentials?: string | { clientId: string; clientSecret: string };
  /** Blaxel's product token for an integration built on the SDK
   * (`<name>/<semver>`), which Blaxel appends to its User-Agent. Kept and
   * checked as Blaxel does; never sent, as Runtime does not attribute traffic
   * by it. */
  integration?: string;
  [key: string]: unknown;
}

const env = (name: string): string | undefined =>
  typeof process === "undefined" ? undefined : process.env[name];

const isRuntimeKey = (key: string) => key.startsWith("rtcloud_");

let configured: string | undefined;
let integration: string | undefined;
let warnedIntegration: string | undefined;

/** Blaxel's check of an integration token: `<name>/<semver>`, lowercase name. */
const INTEGRATION_TOKEN = /^[a-z0-9][a-z0-9._-]*\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Blaxel's `settings.integration`: the token given to `initialize` or set,
 * then BL_INTEGRATION; `""` when none, or when it is not `<name>/<semver>`
 * (warned once per value, as Blaxel does). */
export function integrationToken(): string {
  const value = integration ?? env("BL_INTEGRATION") ?? "";
  if (!value) return "";
  if (!INTEGRATION_TOKEN.test(value)) {
    if (warnedIntegration !== value) {
      warnedIntegration = value;
      console.warn(
        `Ignoring invalid Blaxel integration token ${JSON.stringify(value)}: expected <name>/<semver> with a lowercase name`,
      );
    }
    return "";
  }
  return value;
}

/** Sets Blaxel's `settings.integration`; undefined goes back to BL_INTEGRATION. */
export function setIntegrationToken(value: string | undefined): void {
  integration = value;
}

/** Blaxel's `initialize(config)`: a Runtime key given as `apikey` is used from
 * then on. A Blaxel key is refused while RUNTIME_API_KEY is not set, and never
 * sent. `workspace` means nothing on Runtime and is ignored. */
export function initialize(config: Config = {}): void {
  if (config.clientCredentials !== undefined)
    throw new NotSupportedError(
      "Blaxel client credentials (clientCredentials)",
      "Use a Runtime key: set RUNTIME_API_KEY, or run `npx withruntime login` once.",
    );
  if ("integration" in config) integration = config.integration;
  const key = config.apikey ?? config.apiKey;
  if (key === undefined || key === "") return;
  if (isRuntimeKey(key)) {
    configured = key;
    return;
  }
  if (!env("RUNTIME_API_KEY"))
    throw new CredentialsError(
      "The apikey passed is a Blaxel API key, and it was not sent. Set RUNTIME_API_KEY to a Runtime key " +
        "(https://withruntime.com/account/keys, or run `npx withruntime login`), or pass the Runtime key as apikey.",
    );
}

/** The key to use: one given to `initialize`, then RUNTIME_API_KEY, then
 * BL_API_KEY when it holds a Runtime key; undefined lets the Runtime SDK find
 * the key `npx withruntime login` saved. A Blaxel key in BL_API_KEY is never
 * sent anywhere. */
export function pickKey(): string | undefined {
  if (configured) return configured;
  const runtimeKey = env("RUNTIME_API_KEY");
  if (runtimeKey) return runtimeKey;
  const blaxel = env("BL_API_KEY");
  return blaxel && isRuntimeKey(blaxel) ? blaxel : undefined;
}

const clients = new Map<string, Runtime>();

/** The Runtime client for these options: an explicit client, else one per
 * key, made once and reused so its connections stay open. */
export function clientFor(options: RuntimeOptions = {}): Runtime {
  if (options.withruntime?.client) return options.withruntime.client;
  const key = pickKey();
  let client = clients.get(key ?? "");
  if (!client) {
    client = new Runtime(key ? { apiKey: key } : {});
    clients.set(key ?? "", client);
  }
  return client;
}

/** Test hook: forget the cached clients and any key from `initialize`. */
export function resetClients() {
  clients.clear();
  configured = undefined;
  integration = undefined;
  warnedIntegration = undefined;
}

/** Blaxel's default region, from BL_REGION. */
export function defaultRegion(): string | undefined {
  return env("BL_REGION") || undefined;
}
