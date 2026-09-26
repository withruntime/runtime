/** Code written for E2B's SDK, on Runtime Cloud. Change the import:
 *
 *   import { Sandbox } from "withruntime/e2b"; // was: from "e2b"
 *
 * and set RUNTIME_API_KEY (or put a Runtime key in E2B_API_KEY). What Runtime
 * cannot do the way E2B does throws NotSupportedError, naming what to use. */
import type { Runtime } from "../client.js";
import { clientFor, type ConnectionOpts } from "./client.js";
import { Sandbox } from "./sandbox.js";

export {
  Sandbox,
  SandboxPaginator,
  DEFAULT_SHAPE,
  DEFAULT_TIMEOUT_MS,
  type SandboxOpts,
  type SandboxConnectOpts,
  type SandboxApiOpts,
  type SandboxInfo,
  type SandboxListOpts,
  type SandboxState,
  type SandboxLifecycle,
  type SandboxOnTimeout,
  type SnapshotInfo,
} from "./sandbox.js";
export {
  Commands,
  CommandHandle,
  pidOf,
  type CommandStartOpts,
  type CommandConnectOpts,
  type CommandRequestOpts,
  type ProcessInfo,
  type Username,
} from "./commands.js";
export {
  Filesystem,
  FileType,
  type EntryInfo,
  type WriteInfo,
  type WriteEntry,
  type FilesystemRequestOpts,
  type FilesystemReadOpts,
  type FilesystemWriteOpts,
  type FilesystemListOpts,
  FilesystemEventType,
  type FilesystemEvent,
  type WatchOpts,
  type E2BWatchHandle as WatchHandle,
} from "./filesystem.js";
export {
  SandboxError,
  TimeoutError,
  InvalidArgumentError,
  NotEnoughSpaceError,
  NotFoundError,
  FileNotFoundError,
  SandboxNotFoundError,
  TemplateError,
  RateLimitError,
  AuthenticationError,
  ServiceBusyError,
  CommandExitError,
  NotSupportedError,
  type CommandResult,
} from "./errors.js";
export type { ConnectionOpts, RuntimeOpts } from "./client.js";
export {
  Template,
  TemplateBase,
  Volume,
  Secret,
  waitForPort,
  waitForURL,
  waitForProcess,
  waitForFile,
  waitForTimeout,
} from "./unsupported.js";
export default Sandbox;

/** E2B's client with bound options: `new E2B({ apiKey }).Sandbox.create()`. */
export class E2B {
  readonly Sandbox: typeof Sandbox;
  constructor(opts: Omit<ConnectionOpts, "signal"> & { client?: Runtime } = {}) {
    this.Sandbox = bind(Sandbox, opts);
  }
}

/** A subclass whose static calls use `opts`'s key or client unless a call
 * names its own. */
export function bind<S extends typeof Sandbox>(
  Base: S,
  opts: Omit<ConnectionOpts, "signal"> & { client?: Runtime },
): S {
  const client = clientFor({
    ...opts,
    ...(opts.client ? { runtime: { client: opts.client } } : {}),
  });
  type WithRuntime = { runtime?: { client?: Runtime } } | undefined;
  const withClient = (given: WithRuntime) => ({
    ...given,
    runtime: { ...given?.runtime, client: given?.runtime?.client ?? client },
  });
  const Bound = class extends (Base as typeof Sandbox) {};
  type Static = (this: unknown, ...args: unknown[]) => unknown;
  const create = Reflect.get(Base, "create") as Static;
  const statics: Record<string, Static> = {
    create(this: unknown, first?: unknown, second?: unknown) {
      return typeof first === "string"
        ? create.call(this, first, withClient(second as WithRuntime))
        : create.call(this, withClient(first as WithRuntime));
    },
  };
  // The calls that take (id, opts) or (id, x, opts): the options come last.
  for (const name of [
    "connect",
    "list",
    "kill",
    "getInfo",
    "setTimeout",
    "pause",
    "betaPause",
    "fork",
    "createSnapshot",
    "deleteSnapshot",
  ] as const) {
    const original = Reflect.get(Base, name) as Static;
    const arity = name === "list" ? 1 : name === "setTimeout" ? 3 : 2;
    statics[name] = function (this: unknown, ...args: unknown[]) {
      const padded = [...args];
      padded[arity - 1] = withClient(padded[arity - 1] as WithRuntime);
      return original.apply(this, padded);
    };
  }
  for (const [name, value] of Object.entries(statics))
    Object.defineProperty(Bound, name, { value, writable: true, configurable: true });
  return Bound as unknown as S;
}
