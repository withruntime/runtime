/** Runtime Cloud sandboxes for the Vercel AI SDK's harnesses (`@ai-sdk/harness`).
 *
 * `createRuntimeSandbox()` is a `HarnessV1SandboxProvider`, like
 * `@ai-sdk/sandbox-vercel`'s `createVercelSandbox()`: a `HarnessAgent` runs its
 * harness (Claude Code, Codex, OpenCode, Pi, ...) in a Runtime microVM, and
 * the agent definition does not change:
 *
 *   import { HarnessAgent } from "@ai-sdk/harness/agent";
 *   import { claudeCode } from "@ai-sdk/harness-claude-code";
 *   import { createRuntimeSandbox } from "withruntime/ai-harness";
 *
 *   const agent = new HarnessAgent({
 *     harness: claudeCode,
 *     sandbox: createRuntimeSandbox({ ports: [4000], create: { funding: "trial" } }),
 *   });
 *
 * Commands run under `bash -c` as the sandbox user, streamed. Exposed ports
 * are Runtime previews, private by default: the endpoint carries the preview
 * token. The key comes from RUNTIME_API_KEY or this machine's `runtime login`.
 * Needs `@ai-sdk/harness` 1.x beside this package. */
import {
  HarnessCapabilityUnsupportedError,
  HarnessSandboxAuthenticationError,
  type HarnessV1NetworkPolicy,
  type HarnessV1NetworkSandboxSession,
  type HarnessV1PortEndpoint,
  type HarnessV1SandboxProvider,
} from "@ai-sdk/harness";
import { AI_HARNESS_COMMAND_TIMEOUT_MS } from "../api-defaults.js";
import { Runtime } from "../client.js";
import {
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  RuntimeError,
} from "../errors.js";
import type { NetworkRules } from "../products/network.js";
import type { Preview } from "../products/previews.js";
import type { Process, Sandbox } from "../sandbox.js";
import type { CreateSandbox, OutputEvent } from "../types.js";

/** The AI SDK's plain sandbox session (files, `run`, `spawn`), as the harness
 * package declares it. */
export type SandboxSession = ReturnType<HarnessV1NetworkSandboxSession["restricted"]>;
export type SandboxProcess = Awaited<ReturnType<SandboxSession["spawn"]>>;
type ProcessOptions = Parameters<SandboxSession["run"]>[0];

/** What `run` and `spawn` take beyond the AI SDK's options. The harness never
 * passes these; code that holds the session may. */
export type RuntimeProcessOptions = ProcessOptions & {
  /** Given to standard input, then closed. `spawn` takes text only. */
  stdin?: string | Uint8Array;
  /** The longest the command may run; this session's `commandTimeoutMs` when left out. */
  timeoutMs?: number;
};

export const PROVIDER_ID = "runtime-sandbox";
/** The preview token's header. The edge also takes it as `runtime_preview_token` in the query. */
export const PREVIEW_TOKEN_HEADER = "x-runtime-preview-token";
const TOKEN_QUERY = "runtime_preview_token";
const SESSION_NAME_PREFIX = "ai-harness-";
const MAX_COMMAND_MS = 86_400_000;
/** Exit codes for a command that ended without one, as coreutils `timeout` and SIGKILL give. */
const TIMED_OUT_EXIT = 124;
const KILLED_EXIT = 137;

/** The exit code a shell would report, which harnesses expect. Runtime's API
 * gives a command killed by a signal as the negative signal number (a command
 * past its limit is killed with SIGKILL and reads -9); a shell says 128 plus
 * the signal, so -15 is 143. A command past its limit exits 124, whatever
 * killed it, as `timeout(1)` does. */
function shellExitCode(exit: { exitCode: number | null; timedOut: boolean } | undefined): number {
  if (exit?.timedOut) return TIMED_OUT_EXIT;
  const code = exit?.exitCode;
  if (code === undefined || code === null) return KILLED_EXIT;
  return code < 0 ? 128 - code : code;
}

export type RuntimeSandboxSettings = {
  /** The client to use. Default: one from RUNTIME_API_KEY or this machine's `runtime login`. */
  runtime?: Runtime;
  /** Wrap a sandbox you created. You own it: the session's `stop()` and
   * `destroy()` leave it running, and `create` is not used. */
  sandbox?: Sandbox;
  /** How to create each session's sandbox: `funding`, `image`, `snapshot`,
   * `region`, `vcpu`, `memoryMiB`, `timeoutSeconds`, `network`, `labels`, ...
   * With a harness session id the sandbox is named after it (for
   * `resumeSession`), and that name wins over `create.name`. */
  create?: CreateSandbox;
  /** Set for every command, under the command's own `env`. Runtime's create
   * takes no environment, so the provider holds it. */
  env?: Record<string, string>;
  /** Ports to share as previews. Bridge harnesses (Claude Code, Codex,
   * OpenCode, Deep Agents) use the first one. */
  ports?: number[];
  /** `private` (default): the endpoint carries a preview token. `public`:
   * anyone with the address; a browser sees a one-time warning page. */
  previewVisibility?: "private" | "public";
  /** How long each endpoint's token lasts, 60 s to 7 days. Default: the API's (1 day). */
  previewTtlSeconds?: number;
  /** The longest a `run` command may take. Default one hour; 24 hours at most. */
  commandTimeoutMs?: number;
  /** `stop()` pauses the sandbox instead of stopping it, so `resumeSession`
   * wakes the same machine with its files, memory and processes. A paused
   * sandbox is billed as paused storage until it is woken or stopped.
   * Default false. `destroy()` always stops. */
  pauseOnStop?: boolean;
};

/** A harness sandbox provider backed by Runtime Cloud. Construct it once, at
 * module scope; nothing is created until a session is. */
export function createRuntimeSandbox(
  settings: RuntimeSandboxSettings = {},
): RuntimeSandboxProvider {
  return new RuntimeSandboxProvider(settings);
}

/** The sandbox name a harness session id maps to: `ai-harness-<id>`, or a
 * digest of the id when it would not make a valid name. */
export async function sessionSandboxName(sessionId: string): Promise<string> {
  const name = `${SESSION_NAME_PREFIX}${sessionId}`;
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) return name;
  const { createHash } = await import("node:crypto");
  return `${SESSION_NAME_PREFIX}${createHash("sha256").update(sessionId).digest("hex").slice(0, 40)}`;
}

export class RuntimeSandboxProvider implements HarnessV1SandboxProvider {
  readonly specificationVersion = "harness-sandbox-v1" as const;
  readonly providerId = PROVIDER_ID;
  #runtime: Runtime | undefined;

  constructor(private readonly settings: RuntimeSandboxSettings = {}) {
    this.#runtime = settings.runtime;
  }

  get runtime(): Runtime {
    this.#runtime ??= new Runtime();
    return this.#runtime;
  }

  /** A new sandbox (named after `sessionId` when given), or the wrapped one.
   * `onFirstCreate` runs on a new sandbox before this returns; Runtime keeps
   * no template for `identity`, so it runs for every new sandbox. */
  createSession = async (
    options: {
      sessionId?: string;
      abortSignal?: AbortSignal;
      identity?: string;
      onFirstCreate?: (
        session: SandboxSession,
        opts: { abortSignal?: AbortSignal },
      ) => Promise<void>;
    } = {},
  ): Promise<RuntimeNetworkSandboxSession> => {
    options.abortSignal?.throwIfAborted();
    if (this.settings.sandbox)
      return this.#session(this.settings.sandbox, false, options.abortSignal);
    const name = options.sessionId ? await sessionSandboxName(options.sessionId) : undefined;
    const sandbox = await authenticated(() =>
      this.runtime.sandboxes.create(
        { ...this.settings.create, ...(name ? { name } : {}) },
        options.abortSignal ? { signal: options.abortSignal } : {},
      ),
    );
    try {
      const session = await this.#session(sandbox, true, options.abortSignal);
      await options.onFirstCreate?.(session.restricted(), {
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
      return session;
    } catch (error) {
      // A sandbox nobody holds would run until its lease ends.
      await sandbox.stop({ wait: false }).catch(() => undefined);
      throw error;
    }
  };

  /** The sandbox `createSession` made for `sessionId`, woken if it is paused.
   * A stopped one cannot be resumed: its memory and disk are gone. */
  resumeSession = async (options: {
    sessionId: string;
    abortSignal?: AbortSignal;
  }): Promise<RuntimeNetworkSandboxSession> => {
    options.abortSignal?.throwIfAborted();
    if (this.settings.sandbox)
      return this.#session(this.settings.sandbox, false, options.abortSignal);
    const name = await sessionSandboxName(options.sessionId);
    const found = await authenticated(async () => {
      const page = await this.runtime.sandboxes.list({ name, limit: 1 });
      return page.data[0];
    });
    if (!found)
      throw new NotFoundError({
        message: `No live Runtime sandbox is named ${name}, so harness session ${options.sessionId} cannot be resumed.`,
        code: "not_found",
        status: 404,
        hint: "A stopped sandbox cannot be resumed. Set pauseOnStop: true so session.stop() pauses it instead.",
      });
    const request = options.abortSignal ? { signal: options.abortSignal } : {};
    if (found.state === "paused" || found.state === "pausing") await found.wake(request);
    else if (found.state !== "running") await found.waitFor("running", request);
    return this.#session(found, true, options.abortSignal);
  };

  async #session(
    sandbox: Sandbox,
    ownsLifecycle: boolean,
    abortSignal: AbortSignal | undefined,
  ): Promise<RuntimeNetworkSandboxSession> {
    const session = new RuntimeNetworkSandboxSession(sandbox, this.settings, ownsLifecycle);
    // The harness composes each session's directory under the sandbox's own
    // working directory, read from the sandbox rather than assumed.
    const pwd = await session.run({ command: "pwd", ...(abortSignal ? { abortSignal } : {}) });
    const cwd = pwd.stdout.trim();
    if (pwd.exitCode === 0 && cwd.startsWith("/")) session.defaultWorkingDirectory = cwd;
    if (this.settings.ports?.length)
      await session.setPorts(this.settings.ports, abortSignal ? { abortSignal } : {});
    return session;
  }
}

/** Files and processes in one Runtime sandbox: what `restricted()` hands to
 * tools, with nothing that stops the sandbox or changes its network. */
export class RuntimeSandboxSession implements SandboxSession {
  /** Where relative paths and commands without a `workingDirectory` start. */
  defaultWorkingDirectory = "/workspace";

  constructor(
    readonly sandbox: Sandbox,
    protected readonly settings: Pick<RuntimeSandboxSettings, "env" | "commandTimeoutMs"> = {},
  ) {}

  get description(): string {
    return [
      `Runtime Cloud sandbox ${this.sandbox.id}: a Firecracker microVM with its own Linux kernel.`,
      `Commands run under bash as the user "runtime", with passwordless sudo. HOME and the default working directory are ${this.defaultWorkingDirectory}.`,
      "Files persist for the life of the sandbox.",
    ].join("\n");
  }

  #path(path: string): string {
    return resolvePosix(this.defaultWorkingDirectory, path);
  }

  #commandOptions(options: RuntimeProcessOptions) {
    const env = { ...this.settings.env, ...options.env };
    return {
      // Without one, the sandbox's own working directory, which is what
      // defaultWorkingDirectory was read from.
      ...(options.workingDirectory === undefined
        ? {}
        : { cwd: this.#path(options.workingDirectory) }),
      ...(Object.keys(env).length ? { env } : {}),
      timeoutMs: Math.min(
        MAX_COMMAND_MS,
        options.timeoutMs ?? this.settings.commandTimeoutMs ?? AI_HARNESS_COMMAND_TIMEOUT_MS,
      ),
    };
  }

  /** Runs `command` under `bash -c` and returns once it exits, with all of
   * its output. A timeout exits 124, with a note on standard error. */
  run = async (
    options: RuntimeProcessOptions,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const { abortSignal } = options;
    abortSignal?.throwIfAborted();
    const out = { stdout: "", stderr: "" };
    let exit: Extract<OutputEvent, { type: "exit" }> | undefined;
    let processId: string | undefined;
    try {
      // Streamed, so no output is cut at the size a single answer holds.
      for await (const event of this.sandbox.execStream(options.command, {
        ...this.#commandOptions(options),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(abortSignal ? { signal: abortSignal } : {}),
      })) {
        if (event.type === "start") processId = event.processId;
        else if (event.type === "stdout" || event.type === "stderr") out[event.type] += event.data;
        else if (event.type === "exit") exit = event;
      }
    } catch (error) {
      if (abortSignal?.aborted) {
        // Aborting the request does not end the command; end it too.
        if (processId) await this.#kill(processId);
        throw abortSignal.reason ?? error;
      }
      throw error;
    }
    if (abortSignal?.aborted) throw abortSignal.reason;
    const timedOut = exit?.timedOut ?? false;
    return {
      exitCode: shellExitCode(exit),
      stdout: out.stdout,
      stderr: timedOut
        ? `${out.stderr}${out.stderr && !out.stderr.endsWith("\n") ? "\n" : ""}Timed out: the command ran past its limit and was ended.\n`
        : out.stderr,
    };
  };

  /** Starts `command` and returns at once, with its output as streams. */
  spawn = async (options: RuntimeProcessOptions): Promise<SandboxProcess> => {
    const { abortSignal } = options;
    abortSignal?.throwIfAborted();
    if (options.stdin instanceof Uint8Array)
      throw new RuntimeError({
        message: "spawn takes standard input as text; use run for bytes.",
        code: "invalid_request",
        status: 0,
      });
    const { timeoutMs, ...command } = this.#commandOptions(options);
    const process = await this.sandbox.spawn(options.command, {
      ...command,
      // A spawned process is often a server: it runs until killed unless a limit is asked for.
      ...(options.timeoutMs === undefined ? {} : { timeoutMs }),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
    return this.#process(process, abortSignal);
  };

  #process(process: Process, abortSignal: AbortSignal | undefined): SandboxProcess {
    const encoder = new TextEncoder();
    const streams = {} as Record<"stdout" | "stderr", ReadableStreamDefaultController<Uint8Array>>;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (streams.stdout = c) });
    const stderr = new ReadableStream<Uint8Array>({ start: (c) => void (streams.stderr = c) });
    const stopReading = new AbortController();
    const onAbort = () => {
      stopReading.abort();
      void this.#kill(process.id);
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    const drained = (async () => {
      let exit: Extract<OutputEvent, { type: "exit" }> | undefined;
      try {
        for await (const event of process.output({ signal: stopReading.signal })) {
          if (event.type === "stdout" || event.type === "stderr")
            streams[event.type].enqueue(encoder.encode(event.data));
          else if (event.type === "exit") exit = event;
        }
        streams.stdout.close();
        streams.stderr.close();
      } catch (error) {
        streams.stdout.error(error);
        streams.stderr.error(error);
        throw error;
      } finally {
        abortSignal?.removeEventListener("abort", onAbort);
      }
      return exit;
    })();
    // Read or not, a failure is reported by wait(), never as an unhandled rejection.
    drained.catch(() => undefined);
    let killed = false;
    return {
      stdout,
      stderr,
      wait: async () => {
        let exit: Extract<OutputEvent, { type: "exit" }> | undefined;
        try {
          exit = await drained;
        } catch (error) {
          if (abortSignal?.aborted) throw abortSignal.reason ?? error;
          throw error;
        }
        if (abortSignal?.aborted) throw abortSignal.reason;
        return {
          exitCode: shellExitCode(exit),
        };
      },
      kill: async () => {
        if (killed) return;
        killed = true;
        await this.#kill(process.id);
      },
    };
  }

  /** Ends a process; one that has already exited is not an error. */
  async #kill(processId: string): Promise<void> {
    try {
      const process = await this.sandbox.processes.get(processId);
      if (process.info.state === "running") await process.kill("SIGKILL");
    } catch {
      // Gone already, or the sandbox is: nothing is left to end.
    }
  }

  readBinaryFile = async (options: {
    path: string;
    abortSignal?: AbortSignal;
  }): Promise<Uint8Array | null> => {
    options.abortSignal?.throwIfAborted();
    try {
      return await this.sandbox.files.read(
        this.#path(options.path),
        options.abortSignal ? { signal: options.abortSignal } : {},
      );
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  };

  readFile = async (options: {
    path: string;
    abortSignal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array> | null> => {
    const bytes = await this.readBinaryFile(options);
    if (!bytes) return null;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  };

  readTextFile = async (options: {
    path: string;
    encoding?: string;
    startLine?: number;
    endLine?: number;
    abortSignal?: AbortSignal;
  }): Promise<string | null> => {
    const bytes = await this.readBinaryFile(options);
    if (!bytes) return null;
    const text = new TextDecoder(options.encoding ?? "utf-8").decode(bytes);
    return lines(text, options.startLine, options.endLine);
  };

  /** Writes atomically, making parent directories. Past 1 MiB a file must be under /workspace. */
  writeBinaryFile = async (options: {
    path: string;
    content: Uint8Array;
    abortSignal?: AbortSignal;
  }): Promise<void> => {
    options.abortSignal?.throwIfAborted();
    await this.sandbox.files.write(
      this.#path(options.path),
      options.content,
      options.abortSignal ? { signal: options.abortSignal } : {},
    );
  };

  writeFile = async (options: {
    path: string;
    content: ReadableStream<Uint8Array>;
    abortSignal?: AbortSignal;
  }): Promise<void> => {
    const content = new Uint8Array(await new Response(options.content).arrayBuffer());
    await this.writeBinaryFile({ ...options, content });
  };

  writeTextFile = async (options: {
    path: string;
    content: string;
    encoding?: string;
    abortSignal?: AbortSignal;
  }): Promise<void> => {
    const encoding = (options.encoding ?? "utf-8") as BufferEncoding;
    await this.writeBinaryFile({
      ...options,
      content: new Uint8Array(Buffer.from(options.content, encoding)),
    });
  };
}

/** The session a harness keeps: files and processes, plus ports as previews,
 * network rules, and stopping. */
export class RuntimeNetworkSandboxSession
  extends RuntimeSandboxSession
  implements HarnessV1NetworkSandboxSession
{
  #ports: number[] = [];

  constructor(
    sandbox: Sandbox,
    protected override readonly settings: RuntimeSandboxSettings,
    readonly ownsLifecycle: boolean,
  ) {
    super(sandbox, settings);
  }

  /** The sandbox's id: `resumeSession` finds it again by the name it was given. */
  get id(): string {
    return this.sandbox.id;
  }

  get ports(): ReadonlyArray<number> {
    return this.#ports;
  }

  override get description(): string {
    const ports = this.#ports.length
      ? `\nPorts ${this.#ports.join(", ")} are shared at HTTPS preview addresses; listen on 0.0.0.0 or localhost.`
      : "";
    return `${super.description}${ports}`;
  }

  restricted = (): SandboxSession => {
    const session = new RuntimeSandboxSession(this.sandbox, this.settings);
    session.defaultWorkingDirectory = this.defaultWorkingDirectory;
    return session;
  };

  /** Where to reach `port`. A private preview's token is in the URL's query and
   * in `headers`. For `ws` the URL has no token: the preview edge answers a GET
   * whose query carries one with a redirect that sets a cookie, which a
   * WebSocket client does not follow, so the header carries it. */
  getPortEndpoint = async (options: {
    port: number;
    protocol?: "http" | "https" | "ws";
  }): Promise<HarnessV1PortEndpoint> => {
    if (!this.#ports.includes(options.port))
      throw new HarnessCapabilityUnsupportedError({
        harnessId: PROVIDER_ID,
        message: `Port ${options.port} is not exposed on this sandbox. Exposed ports: [${this.#ports.join(", ")}]. Pass it in createRuntimeSandbox({ ports }).`,
      });
    const preview = await this.#share(options.port);
    const protocol = options.protocol ?? "https";
    const url = new URL(preview.url);
    url.protocol = protocol === "ws" ? "wss:" : "https:";
    if (!preview.token) return { url: url.toString() };
    if (protocol !== "ws") url.searchParams.set(TOKEN_QUERY, preview.token);
    return { url: url.toString(), headers: { [PREVIEW_TOKEN_HEADER]: preview.token } };
  };

  /** @deprecated As the AI SDK's: use `getPortEndpoint`. The URL carries the token in its query. */
  getPortUrl = async (options: {
    port: number;
    protocol?: "http" | "https" | "ws";
  }): Promise<string> => {
    const endpoint = await this.getPortEndpoint({ ...options, protocol: "https" });
    const url = new URL(endpoint.url);
    if (options.protocol === "ws") url.protocol = "wss:";
    return url.toString();
  };

  /** Shares exactly `ports`: new ones become previews, dropped ones stop being shared. */
  setPorts = async (
    ports: ReadonlyArray<number>,
    options: { abortSignal?: AbortSignal } = {},
  ): Promise<void> => {
    const wanted = [...new Set(ports)];
    const request = options.abortSignal ? { signal: options.abortSignal } : {};
    for (const port of this.#ports.filter((port) => !wanted.includes(port)))
      await this.sandbox.previews.delete(port, request).catch((error: unknown) => {
        if (!(error instanceof NotFoundError)) throw error;
      });
    for (const port of wanted.filter((port) => !this.#ports.includes(port)))
      await this.#share(port, request);
    this.#ports = wanted;
  };

  /** Creates the preview, or answers the existing one with a fresh token. */
  #share(port: number, request: { signal?: AbortSignal } = {}): Promise<Preview> {
    return this.sandbox.previews.create(
      port,
      {
        visibility: this.settings.previewVisibility ?? "private",
        ...(this.settings.previewTtlSeconds ? { ttlSeconds: this.settings.previewTtlSeconds } : {}),
      },
      request,
    );
  }

  /** Outbound rules: `allow-all` is the public web, `deny-all` nothing, and
   * `custom` only the listed hosts and ranges, with `deniedCIDRs` refused. */
  setNetworkPolicy = async (policy: HarnessV1NetworkPolicy): Promise<void> => {
    await this.sandbox.network.set(networkRules(policy));
  };

  /** Stops the sandbox (or pauses it, with `pauseOnStop`). A wrapped sandbox is left alone. */
  stop = async (): Promise<void> => {
    if (!this.ownsLifecycle) return;
    if (this.settings.pauseOnStop) {
      try {
        await this.sandbox.pause();
        return;
      } catch {
        // Stop it rather than leave it running.
      }
    }
    await this.#stop();
  };

  /** Stops the sandbox, whatever `pauseOnStop` says: its files and memory are gone. */
  destroy = async (): Promise<void> => {
    if (!this.ownsLifecycle) return;
    await this.#stop();
  };

  async #stop(): Promise<void> {
    try {
      await this.sandbox.stop();
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
}

/** The harness's network policy as a Runtime sandbox's network rules. */
export function networkRules(policy: HarnessV1NetworkPolicy): NetworkRules {
  if (policy.mode === "allow-all") return { internet: true };
  if (policy.mode === "deny-all") return { internet: false };
  const allow = [...(policy.allowedHosts ?? []), ...(policy.allowedCIDRs ?? [])];
  // `custom` is an allow list; one that allows nothing is `deny-all` in the
  // harness's own terms. Runtime reads an empty allow as no allow list at all,
  // which would open the whole internet.
  if (!allow.length) return { internet: false };
  const deny = [...(policy.deniedCIDRs ?? [])];
  return { internet: true, allow, ...(deny.length ? { deny } : {}) };
}

/** A missing or refused key as the harness's own error, so a framework can
 * tell configuration from an outage. */
async function authenticated<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof AuthenticationError ||
      error instanceof PermissionDeniedError ||
      (error instanceof RuntimeError && error.code === "missing_api_key")
    )
      throw new HarnessSandboxAuthenticationError({
        message: `Runtime authentication failed: ${error.message} Set RUNTIME_API_KEY, run \`npx -y withruntime login\`, or pass createRuntimeSandbox({ runtime: new Runtime({ apiKey }) }).`,
        sandboxProviderId: PROVIDER_ID,
        cause: error,
      });
    throw error;
  }
}

/** Lines `start` to `end` (1-based, inclusive) of `text`; past the end is the
 * end. The file's own line ending is kept, as the AI SDK's `extractLines`. */
function lines(text: string, start?: number, end?: number): string {
  if (start === undefined && end === undefined) return text;
  const eol = text.includes("\r\n")
    ? "\r\n"
    : !text.includes("\n") && text.includes("\r")
      ? "\r"
      : "\n";
  const all = text.split(eol);
  const from = Math.max(1, start ?? 1) - 1;
  const to = Math.min(all.length, end ?? all.length);
  return all.slice(from, to).join(eol);
}

function resolvePosix(base: string, path: string): string {
  const parts: string[] = [];
  for (const part of `${path.startsWith("/") ? "" : `${base}/`}${path}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
