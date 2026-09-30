import { Runtime, type RuntimeOptions } from "../client.js";
import { RuntimeError, NotFoundError } from "../errors.js";
import type { Sandbox } from "../sandbox.js";
import type { CreateSandbox, ExecOptions } from "../types.js";
import { SHELL_BROKER } from "./shell.js";

export type ClientOptions = RuntimeOptions & { client?: Runtime };
export const client = ({ client: supplied, ...options }: ClientOptions = {}) => {
  if (supplied) return supplied;
  if (options.baseUrl && !options.fetch) {
    const host = new URL(options.baseUrl).hostname;
    if (
      host !== "withruntime.com" &&
      !host.endsWith(".withruntime.com") &&
      !["localhost", "127.0.0.1", "[::1]"].includes(host)
    )
      throw new CompatibilityError(
        "Runtime",
        "a competitor API endpoint; configure the Runtime endpoint or inject a native Runtime client",
      );
  }
  // Vendor credentials must never leave the caller's machine for Runtime.
  const apiKey = options.apiKey?.startsWith("rtcloud_") ? options.apiKey : undefined;
  return new Runtime({ ...options, apiKey });
};

/** Reject before allocation: accepting an option that does nothing is not compatibility. */
export class CompatibilityError extends Error {
  readonly code = "unsupported_compatibility_option";
  constructor(
    public readonly provider: string,
    public readonly feature: string,
  ) {
    super(`${provider}: ${feature} is not supported by this Runtime compatibility adapter.`);
    this.name = "CompatibilityError";
  }
}
export function only(provider: string, value: object, keys: readonly string[]): void {
  for (const [key, item] of Object.entries(value))
    if (item !== undefined && item !== null && !keys.includes(key))
      throw new CompatibilityError(provider, key);
}
export function region(provider: string, value?: string | null): string | undefined {
  if (value && value !== "us-east")
    throw new CompatibilityError(provider, `region ${value}; select Runtime's us-east region`);
  return value ?? undefined;
}
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const pathAt = (path: string, cwd = "/workspace") =>
  path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`;
const ENV_PATH = "/workspace/.runtime-compat/environment.json";
export async function environment(sandbox: Sandbox): Promise<Record<string, string>> {
  try {
    return JSON.parse(await sandbox.files.readText(ENV_PATH)) as Record<string, string>;
  } catch (error) {
    if (error instanceof NotFoundError) return {};
    throw error;
  }
}
export async function saveEnvironment(
  sandbox: Sandbox,
  env: Record<string, string>,
): Promise<void> {
  validateEnvironment(env);
  await sandbox.files.write(ENV_PATH, JSON.stringify(env), { mode: 0o600 });
}
export function validateEnvironment(env: Record<string, string>): void {
  for (const key of Object.keys(env))
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new TypeError(`Invalid environment variable: ${key}`);
  for (const value of Object.values(env))
    if (typeof value !== "string" || value.includes("\0"))
      throw new TypeError("Environment values must be strings without NUL bytes");
}
export async function execOptions(
  sandbox: Sandbox,
  options: ExecOptions = {},
): Promise<ExecOptions> {
  return { ...options, env: { ...(await environment(sandbox)), ...options.env } };
}
export async function create(
  runtime: Runtime,
  provider: string,
  input: CreateSandbox,
  env: Record<string, string> | undefined = undefined,
  setup?: (sandbox: Sandbox) => Promise<void>,
): Promise<Sandbox> {
  if (env !== undefined) validateEnvironment(env);
  const sandbox = await runtime.sandboxes.create({
    ...input,
    labels: { ...input.labels, "compat.provider": provider },
  });
  try {
    if (env !== undefined || !input.snapshot) await saveEnvironment(sandbox, env ?? {});
    await setup?.(sandbox);
    return sandbox;
  } catch (error) {
    try {
      await destroy(sandbox);
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        `Initialization failed and sandbox ${sandbox.id} could not be cleaned up.`,
      );
    }
    throw error;
  }
}
export async function destroy(sandbox: Sandbox): Promise<void> {
  // Stop before releasing persistence: a paused sandbox cannot change its disk
  // meter, and must never be woken solely to delete it. The stopped update queues
  // disk destruction; see ARCHITECTURE.md section 10 and migration 0181.
  await sandbox.stop();
  if (sandbox.info.persistent) await sandbox.update({ persistent: false });
}
export async function ready(sandbox: Sandbox): Promise<Sandbox> {
  if (sandbox.state === "paused") await sandbox.wake();
  else if (sandbox.state === "stopped") await sandbox.restart();
  else if (sandbox.state !== "running") await sandbox.waitFor("running");
  return sandbox;
}
export async function lookup(runtime: Runtime, id: string): Promise<Sandbox> {
  if (/^[a-f0-9-]{36}$/i.test(id)) return runtime.sandboxes.get(id);
  const page = await runtime.sandboxes.list({ name: id, includeStopped: true });
  for await (const sandbox of page) if (sandbox.info.name === id) return sandbox;
  // IDs are not necessarily UUIDs in local or self-hosted servers.
  return runtime.sandboxes.get(id);
}
export async function all(runtime: Runtime, provider: string): Promise<Sandbox[]> {
  const result: Sandbox[] = [];
  for await (const sandbox of await runtime.sandboxes.list({
    labels: { "compat.provider": provider },
    includeStopped: true,
  }))
    result.push(sandbox);
  return result;
}
export async function image(runtime: Runtime, ref: string): Promise<string> {
  if (ref.startsWith("runtime:")) return (await runtime.images.resolve(ref.slice(8))).id;
  return (await runtime.images.build({ image: ref })).id;
}
export async function checked(
  sandbox: Sandbox,
  argv: string[],
  options: ExecOptions = {},
): Promise<void> {
  await sandbox.exec(argv, { ...options, check: true });
}
export function missing(path: string): never {
  throw new RuntimeError({
    message: `${path} does not exist`,
    code: "file_not_found",
    status: 404,
  });
}

/** Foreground commands share a resident Bash process. Background commands start
 * from the last completed exported environment/cwd snapshot without blocking it. */
export async function shellCommand(
  sandbox: Sandbox,
  command: string,
  name?: string | null,
  overrides: { env?: Record<string, string>; cwd?: string; persist?: boolean } = {},
): Promise<string | string[]> {
  if (!name) return command;
  const root = await shellRoot(name);
  await sandbox.files.mkdir(root, { parents: true });
  if (overrides.persist !== false) {
    const script = "/workspace/.runtime-compat/shell.py";
    await sandbox.files.write(script, SHELL_BROKER, { mode: 0o600 });
    return [
      "python3",
      script,
      "client",
      root,
      JSON.stringify({
        command,
        env: overrides.env ?? {},
        cwd: overrides.cwd,
        baseEnv: await environment(sandbox),
      }),
    ];
  }
  return [
    ...(overrides.persist === false ? [] : ["flock", `${root}/lock`]),
    "bash",
    "-c",
    'readonly __runtime_state="$1" __runtime_command="$2" __runtime_cwd="$3" __runtime_persist="$4"; shift 4; __runtime_env=(); for __runtime_key in "$@"; do __runtime_env+=("$__runtime_key=${!__runtime_key}"); done; if [ -f "$__runtime_state" ]; then source "$__runtime_state"; fi; for __runtime_entry in "${__runtime_env[@]}"; do export "$__runtime_entry"; done; if [ -n "$__runtime_cwd" ]; then cd -- "$__runtime_cwd" || exit; fi; if [ "$__runtime_persist" = yes ]; then trap \'__runtime_status=$?; (umask 077; export -p | sed "/^declare -x __runtime_/d" > "$__runtime_state.next"; printf "cd -- %q\\n" "$PWD" >> "$__runtime_state.next"; mv -- "$__runtime_state.next" "$__runtime_state"); exit "$__runtime_status"\' EXIT; fi; eval "$__runtime_command"',
    "bash",
    `${root}/state`,
    command,
    overrides.cwd ?? "",
    overrides.persist === false ? "no" : "yes",
    ...Object.keys(overrides.env ?? {}),
  ];
}

export async function closeShell(sandbox: Sandbox, name: string): Promise<void> {
  const root = await shellRoot(name);
  const script = "/workspace/.runtime-compat/shell.py";
  if (await sandbox.files.exists(script)) {
    const result = await sandbox.exec([
      "python3",
      script,
      "client",
      root,
      JSON.stringify({ action: "destroy" }),
    ]);
    if (result.exitCode !== 0) throw new Error(`Could not close named shell: ${result.stderr}`);
  }
  if (await sandbox.files.exists(root)) await sandbox.files.remove(root, { recursive: true });
}
export async function shellRoot(name: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name));
  const key = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `/workspace/.runtime-compat/shells/${key}`;
}
