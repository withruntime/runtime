import type { Runtime } from "../client.js";
import { LeaseKeeper } from "../compat/lease.js";
import type { RuntimeSandbox } from "./client.js";
import { ComputerUse } from "./computer-use.js";
import { HOME, HOME_LINK, type SandboxContext } from "./context.js";
import { DaytonaError, DaytonaNotFoundError, guard, NotSupportedError } from "./errors.js";
import { FileSystem } from "./filesystem.js";
import { Git } from "./git.js";
import { Process } from "./process.js";

/* Daytona's Sandbox over Runtime's. Every call is one or a few calls of the
   withruntime SDK; nothing here speaks HTTP. What Runtime cannot do the same
   way throws NotSupportedError before anything happens. */

/** How the sandbox's lease follows Daytona's lifecycle settings. */
export interface Lifecycle {
  /** The lease each call renews, 60 to 3600 seconds: Runtime's longest
   * lease is an hour. */
  windowSeconds: number;
  /** Seconds without a call from this client before the sandbox pauses
   * (Daytona's autoStopInterval); Infinity for 0, never. Past an hour the
   * lease is renewed an hour at a time while this object lives. When
   * absent, windowSeconds. */
  idleSeconds?: number;
  /** Epoch ms past which the lease is never extended (ttlMinutes). */
  deadline?: number;
  /** stop() ends the sandbox instead of pausing it (ephemeral, or
   * autoDeleteInterval 0). */
  ephemeral: boolean;
  autoStopInterval: number;
  autoArchiveInterval: number;
  autoDeleteInterval: number;
}

export interface SandboxOptions {
  env: Record<string, string>;
  language: string;
  public: boolean;
  lifecycle: Lifecycle;
  snapshot?: string;
  /** create's `user`, when not the sandbox owner. */
  user?: string;
}

export type SandboxState =
  "started" | "starting" | "stopping" | "stopped" | "paused" | "destroying" | "destroyed";

export interface PortPreviewUrl {
  sandboxId: string;
  port: number;
  url: string;
  /** Private previews: send it as the `x-runtime-preview-token` header
   * (Daytona's header is x-daytona-preview-token). "" when public. */
  token: string;
}

export interface InterpreterContext {
  id: string;
  cwd: string;
  language: string;
  active: boolean;
}
export interface OutputMessage {
  output: string;
}
export interface ExecutionError {
  name: string;
  value: string;
  traceback?: string;
}
export interface ExecutionResult {
  stdout: string;
  stderr: string;
  error?: ExecutionError;
}

function refusal(feature: string, alternative: string): Promise<never> {
  return Promise.reject(new NotSupportedError(feature, alternative));
}

/** `sandbox.codeInterpreter`: Daytona's stateful Python over Runtime's
 * interpreter. */
export class CodeInterpreter {
  readonly #sandbox: () => Promise<RuntimeSandbox>;
  readonly #env: () => Record<string, string>;
  #envContext: Promise<string> | undefined;
  constructor(sandbox: () => Promise<RuntimeSandbox>, env: () => Record<string, string>) {
    this.#sandbox = sandbox;
    this.#env = env;
  }

  /** The sandbox's envVars reach code through one context made for them. */
  async #defaultContext(): Promise<string> {
    const env = this.#env();
    if (!Object.keys(env).length) return "python";
    if (!this.#envContext) {
      const pending = (async () => {
        const runtime = await this.#sandbox();
        const made = await guard("sandbox", () =>
          runtime.interpreter.contexts.create({ language: "python", cwd: HOME, env }),
        );
        return made.id;
      })();
      this.#envContext = pending;
      pending.catch(() => {
        if (this.#envContext === pending) this.#envContext = undefined;
      });
    }
    return this.#envContext;
  }

  async runCode(
    code: string,
    options: {
      context?: InterpreterContext;
      envs?: Record<string, string>;
      timeout?: number;
      onStdout?: (message: OutputMessage) => unknown;
      onStderr?: (message: OutputMessage) => unknown;
      onError?: (error: ExecutionError) => unknown;
    } = {},
  ): Promise<ExecutionResult> {
    if (options.envs && Object.keys(options.envs).length)
      throw new NotSupportedError(
        "Per-run environment variables (runCode envs)",
        "Pass envVars when creating the sandbox, or set os.environ in the code.",
      );
    const runtime = await this.#sandbox();
    const context = options.context?.id ?? (await this.#defaultContext());
    const execution = await guard("sandbox", () =>
      runtime.interpreter.run(code, {
        language: "python",
        context,
        ...(options.timeout ? { timeoutMs: options.timeout * 1000 } : {}),
        ...(options.onStdout
          ? { onStdout: (output: string) => void options.onStdout!({ output }) }
          : {}),
        ...(options.onStderr
          ? { onStderr: (output: string) => void options.onStderr!({ output }) }
          : {}),
        ...(options.onError
          ? { onError: (error: ExecutionError) => void options.onError!(error) }
          : {}),
      }),
    );
    return {
      stdout: execution.stdout,
      stderr: execution.stderr,
      ...(execution.error ? { error: execution.error } : {}),
    };
  }

  async createContext(cwd?: string): Promise<InterpreterContext> {
    const runtime = await this.#sandbox();
    const env = this.#env();
    const made = await guard("sandbox", () =>
      runtime.interpreter.contexts.create({
        language: "python",
        cwd: cwd ?? HOME,
        ...(Object.keys(env).length ? { env } : {}),
      }),
    );
    return { id: made.id, cwd: made.cwd, language: made.language, active: true };
  }

  async listContexts(): Promise<InterpreterContext[]> {
    const runtime = await this.#sandbox();
    const all = await guard("sandbox", () => runtime.interpreter.contexts.list());
    return all.map((one) => ({ id: one.id, cwd: one.cwd, language: one.language, active: true }));
  }

  async deleteContext(context: InterpreterContext): Promise<void> {
    const runtime = await this.#sandbox();
    await guard("sandbox", () => runtime.interpreter.contexts.remove(context.id));
  }
}

/** A sandbox, with Daytona's fields and methods. `sandbox.withruntime` is the
 * Runtime sandbox underneath, for anything Daytona has no name for. */
export class Sandbox {
  readonly fs: FileSystem;
  readonly process: Process;
  readonly git: Git;
  readonly codeInterpreter: CodeInterpreter;
  env: Record<string, string>;
  readonly public: boolean;
  readonly snapshot: string | undefined;
  #rt: RuntimeSandbox;
  readonly #client: Runtime;
  readonly #options: SandboxOptions;
  #home: Promise<void> | undefined;
  #pausedByPause = false;
  #computerUse: ComputerUse | undefined;
  /** When this client last made a call: autoStopInterval counts from it. */
  #lastActive = Date.now();
  readonly #keeper: LeaseKeeper;

  /** Use daytona.create or daytona.get. */
  constructor(runtime: RuntimeSandbox, client: Runtime, options: SandboxOptions) {
    this.#rt = runtime;
    this.#client = client;
    this.#options = options;
    this.env = { ...options.env };
    this.public = options.public;
    this.snapshot = options.snapshot;
    this.#keeper = new LeaseKeeper({
      sandbox: () => this.#rt,
      until: () => {
        const lifecycle = this.#options.lifecycle;
        return Math.min(
          this.#lastActive + (lifecycle.idleSeconds ?? lifecycle.windowSeconds) * 1000,
          lifecycle.deadline ?? Infinity,
        );
      },
      // Renewed when less than half the window is left, so a run of calls
      // costs one extend per half window.
      marginMs: () => this.#options.lifecycle.windowSeconds * 500,
    });
    const ctx = {
      live: () => this.#live(),
      language: options.language,
      ...(options.user ? { user: options.user } : {}),
      ensureHome: (text: string | undefined) => this.#ensureHome(text),
    } as unknown as SandboxContext;
    // A getter, so the modules see the environment updateEnv sets.
    Object.defineProperty(ctx, "env", { get: () => this.env });
    this.fs = new FileSystem(ctx);
    this.process = new Process(ctx);
    this.git = new Git(ctx);
    this.codeInterpreter = new CodeInterpreter(
      () => this.#live(),
      () => this.env,
    );
  }

  /** The Runtime sandbox underneath: previews, network, snapshots, desktop,
   * terminal and the rest of Runtime's SDK. */
  get withruntime(): RuntimeSandbox {
    return this.#rt;
  }
  get id(): string {
    return this.#rt.id;
  }
  get name(): string {
    return this.#rt.info.name ?? this.#rt.id;
  }
  get organizationId(): string {
    return "";
  }
  /** Daytona's user name, so `/home/${sandbox.user}` leads to the working
   * directory, and commands run as Runtime's sandbox owner, with passwordless
   * sudo; or the user given at create, whose commands run through sudo. */
  get user(): string {
    return this.#options.user ?? "daytona";
  }
  get labels(): Record<string, string> {
    return { ...this.#rt.info.labels };
  }
  get target(): string {
    return "us";
  }
  get cpu(): number {
    return this.#rt.info.vcpu;
  }
  get gpu(): number {
    return 0;
  }
  /** GiB. */
  get memory(): number {
    return this.#rt.info.memoryMiB / 1024;
  }
  /** GiB. */
  get disk(): number {
    return this.#rt.info.diskMiB / 1024;
  }
  get state(): SandboxState {
    switch (this.#rt.state) {
      case "running":
        return "started";
      case "starting":
      case "resuming":
        return "starting";
      case "pausing":
        return "stopping";
      case "paused":
        return this.#pausedByPause ? "paused" : "stopped";
      case "stopping":
        return "destroying";
      default:
        return "destroyed";
    }
  }
  get errorReason(): string | undefined {
    return this.#rt.info.stopReason ?? undefined;
  }
  get recoverable(): boolean {
    return false;
  }
  get autoStopInterval(): number {
    return this.#options.lifecycle.autoStopInterval;
  }
  get autoArchiveInterval(): number {
    return this.#options.lifecycle.autoArchiveInterval;
  }
  get autoDeleteInterval(): number {
    return this.#options.lifecycle.autoDeleteInterval;
  }
  get createdAt(): string {
    return this.#rt.info.createdAt;
  }
  get updatedAt(): string {
    return this.#rt.info.pausedAt ?? this.#rt.info.readyAt ?? this.#rt.info.createdAt;
  }

  /** The sandbox, its lease moved on when less than half of the autoStop
   * window is left: every call through this object counts as activity, as
   * Daytona's API calls do. An autoStopInterval past an hour, or 0, is kept
   * by renewing the lease while this object lives. */
  async #live(force = false): Promise<RuntimeSandbox> {
    if (this.#rt.state !== "running") return this.#rt;
    this.#lastActive = Date.now();
    await this.#keeper.check(force);
    return this.#rt;
  }

  #ensureHome(text: string | undefined): Promise<void> {
    if (this.#home || !text?.includes("/home/daytona")) return this.#home ?? Promise.resolve();
    this.#home = (async () => {
      const runtime = await this.#live();
      await guard("sandbox", () => runtime.exec(HOME_LINK)).catch(() => undefined);
    })();
    return this.#home;
  }

  // ---- lifecycle ----------------------------------------------------------

  /** Wakes a stopped (paused) sandbox, keeping its files and memory. */
  async start(_timeout?: number): Promise<void> {
    await guard("sandbox", () => this.#rt.refresh());
    const state = this.#rt.state;
    if (state === "stopped" || state === "stopping")
      throw new DaytonaError(`Sandbox ${this.id} was deleted and cannot start.`, 410);
    if (state === "paused" || state === "pausing")
      await guard("sandbox", () =>
        this.#rt.wake({ timeoutSeconds: this.#options.lifecycle.windowSeconds }),
      );
    this.#pausedByPause = false;
  }

  /** Stops the sandbox: Runtime pauses it, keeping its files and memory, so
   * start() carries on. An ephemeral sandbox ends instead. */
  async stop(_timeout?: number, _force?: boolean): Promise<void> {
    await guard("sandbox", () => this.#rt.refresh());
    const state = this.#rt.state;
    if (state === "stopped" || state === "stopping") return;
    if (this.#options.lifecycle.ephemeral) {
      this.#keeper.end();
      await guard("sandbox", () => this.#rt.stop());
      return;
    }
    if (state !== "paused") await guard("sandbox", () => this.#rt.pause());
    this.#pausedByPause = false;
  }

  /** Pauses the sandbox with its memory. */
  async pause(_timeout?: number): Promise<void> {
    await guard("sandbox", () => this.#rt.refresh());
    if (this.#rt.state === "running") await guard("sandbox", () => this.#rt.pause());
    this.#pausedByPause = true;
  }

  /** Runtime has no archive tier: a stopped sandbox stays paused, kept for
   * its retention (30 days paid, 7 on the trial, or autoDeleteInterval). */
  async archive(): Promise<void> {
    await this.stop();
  }

  /** Ends the sandbox for good. */
  async delete(_timeout?: number): Promise<void> {
    this.#keeper.end();
    await guard("sandbox", () => this.#rt.refresh());
    if (this.#rt.state !== "stopped") await guard("sandbox", () => this.#rt.stop({ wait: false }));
  }

  async waitUntilStarted(timeout = 60): Promise<void> {
    await guard("sandbox", () => this.#rt.waitFor("running", { timeoutSeconds: timeout || 60 }));
    if (this.#rt.state !== "running")
      throw new DaytonaError(`Sandbox ${this.id} is ${this.state}, not started.`);
  }

  async waitUntilStopped(timeout = 60): Promise<void> {
    await guard("sandbox", () => this.#rt.waitFor("paused", { timeoutSeconds: timeout || 60 }));
  }

  async refreshData(): Promise<void> {
    await guard("sandbox", () => this.#rt.refresh());
  }

  /** Counts as activity: moves the lease a full autoStop window on. */
  async refreshActivity(): Promise<void> {
    await guard("sandbox", () => this.#live(true));
  }

  /** The sandbox pauses after `interval` minutes without a call from this
   * client; 0 never. Past an hour, while this object lives. */
  async setAutostopInterval(interval: number): Promise<void> {
    const lifecycle = this.#options.lifecycle;
    lifecycle.autoStopInterval = interval;
    lifecycle.windowSeconds = windowSeconds(interval);
    lifecycle.idleSeconds = idleSeconds(interval);
    await guard("sandbox", () => this.#live());
  }
  setAutoPauseInterval(interval: number): Promise<void> {
    return this.setAutostopInterval(interval);
  }
  /** Runtime has no archive tier; recorded only. */
  async setAutoArchiveInterval(interval: number): Promise<void> {
    this.#options.lifecycle.autoArchiveInterval = interval;
  }
  /** 0: stop() ends the sandbox. More: a stopped sandbox is kept that many
   * minutes, rounded up to whole days (Runtime's retention). */
  async setAutoDeleteInterval(interval: number): Promise<void> {
    const lifecycle = this.#options.lifecycle;
    lifecycle.autoDeleteInterval = interval;
    lifecycle.ephemeral = interval === 0;
    if (interval > 0) await guard("sandbox", () => this.#rt.setRetention(retentionDays(interval)));
  }
  async setTtl(ttlMinutes: number): Promise<void> {
    if (ttlMinutes === 0) {
      delete this.#options.lifecycle.deadline;
      return;
    }
    const deadline = Date.parse(this.#rt.info.createdAt) + ttlMinutes * 60_000;
    if (Date.parse(this.#rt.info.expiresAt) > deadline)
      throw new NotSupportedError(
        "A time to live shorter than the current lease",
        "Runtime leases only move later; call stop() or delete() when the work is done.",
      );
    this.#options.lifecycle.deadline = deadline;
  }

  // ---- settings -----------------------------------------------------------

  /** Changes the environment later commands get from this object. */
  async updateEnv(env: Record<string, string>, options: { unset?: string[] } = {}): Promise<void> {
    this.env = { ...this.env, ...env };
    for (const name of options.unset ?? []) delete this.env[name];
  }

  async updateNetworkSettings(settings: {
    networkBlockAll?: boolean;
    networkAllowList?: string;
    domainAllowList?: string;
  }): Promise<void> {
    const rules = networkRules(settings);
    const runtime = await this.#live();
    await guard("sandbox", () => runtime.network.set(rules ?? { internet: true }));
  }

  /** A preview address for `port`: public when the sandbox was created with
   * `public: true`, else private with a token. */
  async getPreviewLink(port: number): Promise<PortPreviewUrl> {
    const runtime = await this.#live();
    const preview = await guard("sandbox", () =>
      runtime.previews.create(port, { visibility: this.public ? "public" : "private" }),
    );
    return {
      sandboxId: this.id,
      port,
      url: preview.url.replace(/\/$/, ""),
      token: preview.token ?? "",
    };
  }

  getUserHomeDir(): Promise<string> {
    return Promise.resolve(HOME);
  }
  getUserRootDir(): Promise<string> {
    return Promise.resolve(HOME);
  }
  getWorkDir(): Promise<string> {
    return Promise.resolve(HOME);
  }

  // ---- forks and snapshots --------------------------------------------------

  /** A copy of this sandbox with its files, memory and running processes. */
  async fork(params: { name?: string } = {}, _timeout?: number): Promise<Sandbox> {
    const copy = await guard("sandbox", () =>
      this.#rt.fork({ ...(params.name ? { name: params.name } : {}) }),
    );
    return new Sandbox(copy, this.#client, {
      ...this.#options,
      env: this.env,
      lifecycle: { ...this.#options.lifecycle },
    });
  }
  _experimental_fork(params: { name?: string } = {}, timeout?: number): Promise<Sandbox> {
    return this.fork(params, timeout);
  }

  /** Keeps this sandbox (files, memory, processes) as a Runtime snapshot
   * named `name`; `daytona.create({ snapshot: name })` starts from it. */
  async createSnapshot(name: string, _timeout?: number): Promise<void> {
    await guard("sandbox", () => this.#rt.snapshot({ name }));
  }
  _experimental_createSnapshot(name: string, timeout?: number): Promise<void> {
    return this.createSnapshot(name, timeout);
  }

  // ---- what Runtime does differently -----------------------------------------

  /** Daytona's computer use over Runtime's desktop: `await
   * sandbox.computerUse.start()`, then the mouse, keyboard and screenshots. */
  get computerUse(): ComputerUse {
    this.#computerUse ??= new ComputerUse(() => this.#live());
    return this.#computerUse;
  }
  async setLabels(labels: Record<string, string>): Promise<Record<string, string>> {
    const internal = Object.fromEntries(
      Object.entries(this.#rt.info.labels).filter(
        ([key]) => key === "code-toolbox-language" || key.startsWith("compat."),
      ),
    );
    await guard("sandbox", () => this.#rt.update({ labels: { ...labels, ...internal } }));
    return this.labels;
  }
  recover(): Promise<never> {
    return refusal(
      "Recovering a failed sandbox",
      "Create a new sandbox, or start one from a snapshot.",
    );
  }
  resize(): Promise<never> {
    return refusal(
      "Resizing a sandbox",
      "Create a new one with the resources you need; fork() or createSnapshot() carries the state.",
    );
  }
  waitForResizeComplete(): Promise<never> {
    return this.resize();
  }
  getMetrics(): Promise<never> {
    return refusal(
      "Sandbox metrics",
      'Use `await sandbox.withruntime.metrics({ range: "1h" })` for its CPU and memory over time; runtime.otel exports them to your own tools.',
    );
  }
  getMetricsLatest(): Promise<never> {
    return this.getMetrics();
  }
  createLspServer(): never {
    throw new NotSupportedError(
      "Daytona's language servers",
      "Start one in a session: process.executeSessionCommand(id, { command: 'pyright-langserver --stdio', runAsync: true }).",
    );
  }
  updateSecrets(): Promise<never> {
    return refusal(
      "Daytona secrets",
      "Use a Runtime secret: `npx withruntime secrets set NAME --host api.example.com`. The sandbox sees a placeholder, and the egress proxy adds the value on HTTPS to that host.",
    );
  }
  getSignedPreviewUrl(): Promise<never> {
    return refusal(
      "Signed preview URLs",
      "Use getPreviewLink(port) and send its token as the x-runtime-preview-token header, or create the sandbox with public: true.",
    );
  }
  expireSignedPreviewUrl(): Promise<never> {
    return this.getSignedPreviewUrl();
  }
  rotateSigningKey(): Promise<never> {
    return refusal(
      "Rotating the preview signing key",
      "Use `await sandbox.withruntime.previews.rotate(port)`, which refuses every token issued for that port.",
    );
  }
  uploadUrl(): Promise<never> {
    return refusal("Signed upload URLs", "Use sandbox.fs.uploadFile(data, path).");
  }
  downloadUrl(): Promise<never> {
    return refusal("Signed download URLs", "Use sandbox.fs.downloadFile(path).");
  }
  createSshAccess(): Promise<never> {
    return refusal(
      "SSH access",
      "Use `npx withruntime sandbox ssh <id>` (also VS Code and JetBrains) or sandbox.withruntime.terminal().",
    );
  }
  revokeSshAccess(): Promise<never> {
    return this.createSshAccess();
  }
  validateSshAccess(): Promise<never> {
    return this.createSshAccess();
  }
}

/** Daytona's autoStopInterval (minutes; 0 is off) as the lease window. */
export function windowSeconds(autoStopMinutes: number): number {
  if (autoStopMinutes <= 0) return 3600;
  return Math.min(3600, Math.max(60, Math.round(autoStopMinutes * 60)));
}

/** Daytona's autoStopInterval (minutes; 0 is never) as seconds without a
 * call before the sandbox pauses. */
export function idleSeconds(autoStopMinutes: number): number {
  if (autoStopMinutes <= 0) return Infinity;
  return Math.max(60, Math.round(autoStopMinutes * 60));
}

/** Minutes as Runtime's retention: whole days, 1 to 365. */
export function retentionDays(minutes: number): number {
  return Math.min(365, Math.max(1, Math.ceil(minutes / 1440)));
}

/** Daytona's network settings as Runtime's rules, or undefined for the
 * default (the public web). */
export function networkRules(settings: {
  networkBlockAll?: boolean;
  networkAllowList?: string;
  domainAllowList?: string;
}): { internet: boolean; allow?: string[] } | undefined {
  if (settings.networkBlockAll) return { internet: false };
  const allow = [settings.networkAllowList, settings.domainAllowList]
    .flatMap((list) => (list ?? "").split(","))
    .map((one) => one.trim())
    .filter(Boolean);
  return allow.length ? { internet: true, allow } : undefined;
}

export function notFound(what: string) {
  return new DaytonaNotFoundError(`${what} was not found.`, 404);
}
