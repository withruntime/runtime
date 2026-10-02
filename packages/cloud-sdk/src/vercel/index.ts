/** Code written for Vercel Sandbox's SDK, on Runtime Cloud. Change the import:
 *
 *   import { Sandbox } from "withruntime/vercel"; // was: from "@vercel/sandbox"
 *
 * and set RUNTIME_API_KEY, or run `npx withruntime login` once. A Vercel token
 * is never sent anywhere. What Runtime cannot do the way Vercel does throws
 * NotSupportedError, naming what to use. */
import { NotSupportedError } from "./errors.js";

export {
  Sandbox,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VCPUS,
  MEMORY_MIB_PER_VCPU,
  networkRules,
  toRuntimePath,
  type CreateSandboxParams,
  type RunCommandParams,
  type NetworkPolicy,
  type SandboxRoute,
} from "./sandbox.js";
export {
  Command,
  CommandFinished,
  type CommandOutput,
  type LogOutputLine,
  type Signal,
} from "./command.js";
export { FileSystem, Stats, Dirent } from "./filesystem.js";
export { SandboxUser, SandboxUserAlreadyExistsError } from "./sandbox-user.js";
export { Snapshot } from "./snapshot.js";
export { APIError, StreamError, AuthenticationError, NotSupportedError } from "./errors.js";
export type { Credentials, WithRuntime } from "./client.js";

/** Vercel's default region; Runtime runs in one US region. */
export const DEFAULT_SANDBOX_REGION = "iad1";

/** A stand-in for a Vercel export Runtime has no counterpart for. Importing it
 * works, so a module that only mentions it still loads; calling it, building it
 * or reading anything from it throws NotSupportedError naming the alternative. */
function unsupportedExport(name: string, alternative: string) {
  const fail = (): never => {
    throw new NotSupportedError(`Vercel's ${name}`, alternative);
  };
  return new Proxy(function unsupported() {}, {
    apply: fail,
    construct: fail,
    get: (_target, property) => {
      if (typeof property === "symbol" || property === "then" || property === "prototype")
        return undefined;
      return fail();
    },
  }) as unknown as {
    (...args: unknown[]): never;
    new (...args: unknown[]): never;
    readonly [key: string]: (...args: unknown[]) => never;
  };
}

export const Drive = unsupportedExport(
  "Drive",
  "Use a Runtime volume (runtime.volumes) and mount it with withruntime: { create: { volumes: [{ volumeId, path }] } }.",
);
export const Session = unsupportedExport(
  "Session",
  "A Runtime sandbox is its own session: call the methods on the sandbox.",
);
export const defineSandboxProxy = unsupportedExport(
  "sandbox proxy (defineSandboxProxy)",
  "Share a port with sandbox.withruntime.previews.create(port) instead.",
);
