import type { Runtime } from "../client.js";
import type { Sandbox as NativeSandbox, Process } from "../sandbox.js";
import {
  all,
  client,
  CompatibilityError,
  create,
  destroy,
  execOptions,
  only,
  quote,
  ready,
  refuse,
  type ClientOptions,
  type Refused,
  type RefusedAsync,
} from "../compat/core.js";
import { GuestFiles } from "../compat/files.js";
import { ManagedTasks } from "./guest-service.js";

export { CompatibilityError };
export class VMTier {
  private constructor(
    readonly name: string,
    readonly cpuCores: number,
    readonly memoryGiB: number,
    readonly diskGB = 20,
  ) {}
  static readonly Pico = new VMTier("pico", 1, 2);
  static readonly Nano = new VMTier("nano", 2, 4);
  static readonly Micro = new VMTier("micro", 4, 8);
  static readonly Small = new VMTier("small", 8, 16);
  static readonly Medium = new VMTier("medium", 16, 32);
  static readonly Large = new VMTier("large", 32, 64);
  static readonly XLarge = new VMTier("xlarge", 64, 128);
  static readonly All = [
    VMTier.Pico,
    VMTier.Nano,
    VMTier.Micro,
    VMTier.Small,
    VMTier.Medium,
    VMTier.Large,
    VMTier.XLarge,
  ];
  static fromName(name: string) {
    const tier = this.All.find((t) => t.name === name);
    if (!tier) throw new TypeError(`Unknown VM tier: ${name}`);
    return tier;
  }
  static fromSpecs(specs: { cpu: number; memGiB: number; diskGB?: number }) {
    return this.All.find(
      (t) =>
        t.cpuCores >= specs.cpu && t.memoryGiB >= specs.memGiB && t.diskGB >= (specs.diskGB ?? 0),
    );
  }
}
export type StartSandboxOpts = {
  vmTier?: VMTier;
  hibernationTimeoutSeconds?: number;
  /** Runtime wakes a paused sandbox on any request, preview visit, command or
   * file call: both true or both false. */
  automaticWakeupConfig?: { http: boolean; websocket: boolean };
  ipcountry?: string;
};
export type CreateSandboxOpts = StartSandboxOpts & {
  id?: string;
  title?: string;
  description?: string;
  tags?: string[];
  privacy?: "private" | "public" | "public-hosts" | "unlisted";
};
export type SessionCreateOptions = {
  id?: string;
  env?: Record<string, string>;
  permission?: "read" | "write";
  git?: { provider: string; username?: string; accessToken?: string; email: string; name?: string };
  hostToken?: { token: string; sandboxId: string };
};
export type ShellRunOpts = {
  env?: Record<string, string>;
  cwd?: string;
  name?: string;
  dimensions?: { cols: number; rows: number };
  asGlobalSession?: boolean;
};
export class CodeSandbox {
  readonly sandboxes: Sandboxes;
  readonly hosts = new HostTokens();
  constructor(
    apiToken?: string,
    options: ClientOptions & { headers?: Record<string, string>; tracer?: unknown } = {},
  ) {
    const { headers, tracer, ...rest } = options;
    if (headers && Object.keys(headers).length)
      throw new CompatibilityError("CodeSandbox", "custom API headers");
    if (tracer)
      throw new CompatibilityError(
        "CodeSandbox",
        "an OpenTelemetry tracer; export Runtime's sandbox telemetry with runtime.observability",
      );
    this.sandboxes = new Sandboxes(client({ ...rest, apiKey: rest.apiKey ?? apiToken }));
  }
}
/** CodeSandbox's host tokens open private previews. Runtime's private
 * previews carry their own signed token: `sandbox.previews.create(port)`. */
export class HostTokens {
  declare readonly createToken: RefusedAsync;
  declare readonly listTokens: RefusedAsync;
  declare readonly revokeToken: RefusedAsync;
  declare readonly revokeAllTokens: RefusedAsync;
  declare readonly updateToken: RefusedAsync;
  declare readonly getUrl: Refused;
  declare readonly getHeaders: Refused;
  declare readonly getCookies: Refused;
}
const PREVIEW_TOKENS =
  "use Runtime's private previews, sandbox.previews.create(port), which carry a signed token";
refuse("CodeSandbox", "HostTokens", HostTokens, {
  createToken: PREVIEW_TOKENS,
  listTokens: PREVIEW_TOKENS,
  revokeToken: PREVIEW_TOKENS,
  revokeAllTokens: PREVIEW_TOKENS,
  updateToken: PREVIEW_TOKENS,
});
refuse(
  "CodeSandbox",
  "HostTokens",
  HostTokens,
  { getUrl: PREVIEW_TOKENS, getHeaders: PREVIEW_TOKENS, getCookies: PREVIEW_TOKENS },
  { sync: true },
);
/** Passing it to create() makes a fresh sandbox from Runtime's default image. */
const DEFAULT_TEMPLATE = "runtime-default";
function wakeup(config: StartSandboxOpts["automaticWakeupConfig"]): boolean | undefined {
  if (!config) return undefined;
  if (config.http !== config.websocket)
    throw new CompatibilityError(
      "CodeSandbox",
      "waking on HTTP but not WebSocket requests, or the reverse; Runtime wakes on both",
    );
  return config.http;
}
const metadata = (s: NativeSandbox) => ({
  id: s.id,
  createdAt: new Date(s.info.createdAt),
  updatedAt: new Date(s.info.createdAt),
  title: s.info.name ?? undefined,
  description: s.info.labels["cs.description"],
  privacy:
    s.info.labels["cs.privacy"] === "public"
      ? "unlisted"
      : s.info.labels["cs.privacy"] === "public-hosts"
        ? "private"
        : (s.info.labels["cs.privacy"] ?? "private"),
  tags: JSON.parse(s.info.labels["cs.tags"] ?? "[]") as string[],
});

function validateHibernationTimeout(seconds: number | undefined): void {
  if (seconds !== undefined && (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 86_400))
    throw new RangeError("hibernationTimeoutSeconds must be an integer from 0 to 86400.");
}

export class Sandboxes {
  constructor(private readonly runtime: Runtime) {}
  get defaultTemplateId(): string {
    return DEFAULT_TEMPLATE;
  }
  async create(options: CreateSandboxOpts = {}): Promise<Sandbox> {
    only("CodeSandbox create", options, [
      "id",
      "title",
      "description",
      "tags",
      "privacy",
      "vmTier",
      "hibernationTimeoutSeconds",
      "automaticWakeupConfig",
      "ipcountry",
    ]);
    if (options.ipcountry)
      throw new CompatibilityError("CodeSandbox", "ipcountry; Runtime's sandboxes run in us-east");
    validateHibernationTimeout(options.hibernationTimeoutSeconds);
    const autoWake = wakeup(options.automaticWakeupConfig);
    const labels = {
      "compat.provider": "codesandbox",
      "cs.tags": JSON.stringify([...new Set([...(options.tags ?? []), "sdk"])]),
      "cs.privacy": options.privacy ?? "public-hosts",
      "cs.description": options.description ?? "",
    };
    if (options.id && options.id !== DEFAULT_TEMPLATE) {
      const source = await this.runtime.sandboxes.get(options.id);
      const fork = await source.fork({ name: options.title, labels });
      if (options.hibernationTimeoutSeconds !== undefined || autoWake !== undefined)
        await fork.update({
          ...(options.hibernationTimeoutSeconds !== undefined
            ? { idlePauseSeconds: options.hibernationTimeoutSeconds }
            : {}),
          ...(autoWake !== undefined ? { autoWake } : {}),
        });
      const sandbox = new Sandbox(fork, "FORK");
      if (options.vmTier) await sandbox.updateTier(options.vmTier);
      return sandbox;
    }
    const tier = options.vmTier ?? VMTier.Pico;
    const sandbox = await create(
      this.runtime,
      "codesandbox",
      {
        name: options.title,
        labels,
        vcpu: tier.cpuCores,
        memoryMiB: tier.memoryGiB * 1024,
        diskMiB: Math.ceil((tier.diskGB * 1e9) / 1048576),
        idlePauseSeconds: options.hibernationTimeoutSeconds,
        persistent: true,
        ...(autoWake !== undefined ? { autoWake } : {}),
      },
      {},
      async (sandbox) => {
        await sandbox.exec(["sudo", "mkdir", "-p", "/project/sandbox"], { check: true });
        await sandbox.exec("sudo chown $(id -u):$(id -g) /project/sandbox", { check: true });
      },
    );
    return new Sandbox(sandbox, "CLEAN");
  }
  async resume(id: string) {
    const s = await this.runtime.sandboxes.get(id);
    const boot = s.state === "paused" ? "RESUME" : s.state === "stopped" ? "CLEAN" : "RUNNING";
    return new Sandbox(await ready(s), boot);
  }
  async hibernate(id: string): Promise<void> {
    await (await this.runtime.sandboxes.get(id)).pause();
  }
  async shutdown(id: string): Promise<void> {
    await (await this.runtime.sandboxes.get(id)).stop();
  }
  async delete(id: string): Promise<void> {
    await destroy(await this.runtime.sandboxes.get(id));
  }
  async restart(id: string, options: { hibernationTimeoutSeconds?: number } = {}) {
    only("CodeSandbox restart", options, ["hibernationTimeoutSeconds"]);
    validateHibernationTimeout(options.hibernationTimeoutSeconds);
    const s = await this.runtime.sandboxes.get(id);
    await s.stop();
    await s.restart();
    if (options.hibernationTimeoutSeconds !== undefined)
      await s.update({ idlePauseSeconds: options.hibernationTimeoutSeconds });
    return new Sandbox(s, "CLEAN");
  }
  fork(
    id: string,
    options: StartSandboxOpts &
      Pick<CreateSandboxOpts, "title" | "description" | "tags" | "privacy"> = {},
  ) {
    return this.create({ ...options, id });
  }
  /** The account's running CodeSandbox-adapter sandboxes. Runtime has no
   * per-account count of running machines, so the limit is null. */
  async listRunning() {
    const running = (await all(this.runtime, "codesandbox")).filter((s) => s.state === "running");
    return {
      concurrentVmCount: running.length,
      concurrentVmLimit: null as number | null,
      vms: running.map((s) => ({
        id: s.id,
        creditBasis: undefined as string | undefined,
        lastActiveAt: s.info.lastActiveAt ? new Date(s.info.lastActiveAt) : undefined,
        sessionStartedAt: s.info.readyAt ? new Date(s.info.readyAt) : undefined,
        specs: {
          cpu: s.info.vcpu,
          memory: s.info.memoryMiB / 1024,
          storage: s.info.diskMiB / 1024,
        },
      })),
    };
  }
  async get(id: string) {
    return metadata(await this.runtime.sandboxes.get(id));
  }
  async list(
    options: {
      tags?: string[];
      status?: "running";
      limit?: number;
      pagination?: { page?: number; pageSize?: number };
      direction?: "asc" | "desc";
      orderBy?: "inserted_at" | "updated_at";
    } = {},
  ) {
    only("CodeSandbox list", options, [
      "tags",
      "status",
      "limit",
      "pagination",
      "direction",
      "orderBy",
    ]);
    if (options.orderBy === "updated_at")
      throw new CompatibilityError("CodeSandbox", "sorting by updated_at");
    const limit = options.limit ?? 50;
    let currentPage = options.pagination?.page ?? 1;
    const pageSize = options.pagination?.pageSize ?? limit;
    for (const [name, value] of [
      ["limit", limit],
      ["page", currentPage],
      ["pageSize", pageSize],
    ] as const)
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError(`${name} must be a positive safe integer.`);
    const sandboxes = (await all(this.runtime, "codesandbox"))
      .filter(
        (s) =>
          (!options.status || s.state === "running") &&
          (options.tags ?? []).every((tag) => metadata(s).tags.includes(tag)),
      )
      .map(metadata);
    sandboxes.sort(
      (a, b) =>
        (a.createdAt.getTime() - b.createdAt.getTime()) * (options.direction === "desc" ? -1 : 1),
    );
    const totalCount = sandboxes.length;
    const selected: typeof sandboxes = [];
    let nextPage: number | null;
    for (;;) {
      const offset = (currentPage - 1) * pageSize;
      selected.push(...sandboxes.slice(offset, offset + pageSize));
      nextPage = offset + pageSize < totalCount ? currentPage + 1 : null;
      if (nextPage === null || selected.length >= limit) break;
      currentPage = nextPage;
    }
    return {
      sandboxes: selected,
      totalCount,
      hasMore: totalCount > selected.length,
      pagination: { currentPage, nextPage, pageSize },
    };
  }
}
export class Sandbox {
  constructor(
    readonly native: NativeSandbox,
    readonly bootupType: "RUNNING" | "CLEAN" | "RESUME" | "FORK",
  ) {}
  get id() {
    return this.native.id;
  }
  get cluster() {
    return this.native.info.region;
  }
  /** Runtime's guest agent is updated with the host: always current. */
  get isUpToDate() {
    return true;
  }
  /** Resizes to the tier's CPUs and memory; a running sandbox restarts, as CodeSandbox's does. */
  async updateTier(tier: VMTier): Promise<void> {
    await this.native.resize({ vcpu: tier.cpuCores, memoryMiB: tier.memoryGiB * 1024 });
  }
  declare readonly createSession: RefusedAsync;
  declare readonly createBrowserSession: RefusedAsync;
  async updateHibernationTimeout(timeoutSeconds: number): Promise<void> {
    await this.native.update({ idlePauseSeconds: timeoutSeconds });
  }
  async connect(options: SessionCreateOptions = {}) {
    only("CodeSandbox session", options, ["id", "env", "permission"]);
    if (options.permission === "read")
      throw new CompatibilityError("CodeSandbox", "read-only editor sessions");
    const client = new SandboxClient(this.native, options.env ?? {});
    await client.initialize();
    return client;
  }
}
refuse("CodeSandbox", "Sandbox", Sandbox, {
  createSession:
    "use sandbox.connect(); a browser reaches a Runtime sandbox with a session token from the native sandbox.sessions.create()",
  createBrowserSession:
    "make a session token with the native sandbox.sessions.create() and open it with Runtime's Sandbox.fromSession",
});
export class CommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly output: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}
function emitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    event: (listener: (value: T) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire: (value: T) => {
      for (const listener of listeners) listener(value);
    },
    clear: () => listeners.clear(),
  };
}
export type CommandStatus = "RUNNING" | "FINISHED" | "ERROR" | "KILLED" | "RESTARTING";
export class Command {
  readonly onOutput;
  readonly onStatusChange;
  private outputEvent = emitter<string>();
  private statusEvent = emitter<CommandStatus>();
  private output = "";
  private result: Promise<string>;
  private resolveResult!: (output: string) => void;
  private rejectResult!: (error: Error) => void;
  private generation = 0;
  private subscription = new AbortController();
  private transition: Promise<void> = Promise.resolve();
  private currentStatus: CommandStatus = "RUNNING";
  get status(): CommandStatus {
    return this.currentStatus;
  }
  set status(value: CommandStatus) {
    if (value === this.currentStatus) return;
    this.currentStatus = value;
    this.statusEvent.fire(value);
  }
  constructor(
    private process: Process,
    readonly command: string,
    readonly name?: string,
    private readonly startAgain?: () => Promise<Process>,
  ) {
    this.onOutput = this.outputEvent.event;
    this.onStatusChange = this.statusEvent.event;
    this.result = new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    this.result.catch(() => undefined);
    void this.follow(process, this.generation, this.subscription.signal);
  }
  private setStatus(status: CommandStatus) {
    this.status = status;
  }
  private async follow(process: Process, generation: number, signal: AbortSignal) {
    try {
      let ended = false;
      for await (const event of process.output({ signal })) {
        if (generation !== this.generation) return;
        if (event.type === "stdout" || event.type === "stderr") {
          this.output += event.data;
          this.outputEvent.fire(event.data);
        } else if (event.type === "truncated") {
          throw new Error("Command output was truncated by the host.");
        } else if (event.type === "exit") {
          ended = true;
          this.setStatus(event.exitCode === 0 ? "FINISHED" : "ERROR");
          if (event.exitCode !== 0)
            throw new CommandError(
              `Command failed with exit code ${event.exitCode ?? "unknown"}`,
              event.exitCode ?? 1,
              this.output,
            );
          this.resolveResult(this.output);
        }
      }
      if (!ended && generation === this.generation)
        throw new Error("Command output ended before its exit status arrived.");
    } catch (error) {
      if (generation !== this.generation) return;
      this.setStatus("ERROR");
      this.rejectResult(error instanceof Error ? error : new Error(String(error)));
    }
  }
  /** Detach this client's subscription without terminating the guest command. */
  detach() {
    this.generation++;
    this.subscription.abort();
    this.setStatus("ERROR");
    this.rejectResult(new Error("Sandbox client is disconnected."));
  }
  async open(dimensions?: { cols: number; rows: number }) {
    if (dimensions) await this.process.resize(dimensions.cols, dimensions.rows);
    return this.output;
  }
  /** Internal task bridge: read without yielding between log handoff and events. */
  get bufferedOutput() {
    return this.output;
  }
  waitUntilComplete() {
    return this.result;
  }
  private serial(work: () => Promise<void>) {
    const pending = this.transition.then(work);
    this.transition = pending.catch(() => undefined);
    return pending;
  }
  restart(): Promise<void> {
    return this.serial(async () => {
      if (this.status !== "RUNNING") throw new Error("Command is not running");
      if (!this.startAgain)
        throw new CompatibilityError("CodeSandbox", "restarting a command from a different client");
      // Fence the old subscription before killing: its delayed exit must not
      // complete a waiter or overwrite the replacement command's status.
      this.generation++;
      this.subscription.abort();
      try {
        await this.process.kill("SIGKILL");
        this.process = await this.startAgain();
        this.subscription = new AbortController();
        void this.follow(this.process, this.generation, this.subscription.signal);
      } catch (error) {
        this.setStatus("ERROR");
        const failure = error instanceof Error ? error : new Error(String(error));
        this.rejectResult(failure);
        throw failure;
      }
    });
  }
  kill(): Promise<void> {
    return this.serial(async () => {
      this.generation++;
      this.subscription.abort();
      try {
        await this.process.kill("SIGKILL");
        this.setStatus("KILLED");
        this.rejectResult(
          new CommandError("Command failed with exit code unknown", 1, this.output),
        );
      } catch (error) {
        this.setStatus("ERROR");
        const failure = error instanceof Error ? error : new Error(String(error));
        this.rejectResult(failure);
        throw failure;
      }
    });
  }
}
export class FileSystem {
  private readonly files: GuestFiles;
  constructor(private readonly native: NativeSandbox) {
    this.files = new GuestFiles(async () => native, "/project/sandbox");
  }
  async writeFile(
    path: string,
    content: Uint8Array,
    options: { create?: boolean; overwrite?: boolean } = {},
  ) {
    only("CodeSandbox file write", options, ["create", "overwrite"]);
    const exists = await this.files.exists(path);
    if (!exists && options.create === false) throw new Error(`File does not exist: ${path}`);
    if (exists && options.overwrite === false) throw new Error(`File already exists: ${path}`);
    await this.files.writeFile(path, content);
  }
  writeTextFile(
    path: string,
    content: string,
    options?: { create?: boolean; overwrite?: boolean },
  ) {
    return this.writeFile(path, new TextEncoder().encode(content), options);
  }
  async batchWrite(files: { path: string; content: string | Uint8Array }[]) {
    for (const f of files) await this.files.writeFile(f.path, f.content);
  }
  readFile(path: string) {
    return this.files.readFile(path);
  }
  readTextFile(path: string) {
    return this.files.readTextFile(path);
  }
  mkdir(path: string, recursive = false) {
    return this.files.mkdir(path, recursive);
  }
  remove(path: string, recursive = false) {
    return this.files.remove(path, recursive);
  }
  rename(from: string, to: string, overwrite = false) {
    return this.files.rename(from, to, overwrite);
  }
  copy(from: string, to: string, recursive = false, overwrite = false) {
    return this.files.copy(from, to, recursive, overwrite);
  }
  async readdir(path: string) {
    return (await this.files.readdir(path)).map((e) => ({
      name: e.name,
      type: e.type === "directory" ? "directory" : "file",
      isSymlink: e.type === "symlink",
    }));
  }
  /** Changes under a path, as CodeSandbox's add, change and remove events. */
  async watch(path: string, options: { recursive?: boolean; excludes?: readonly string[] } = {}) {
    only("CodeSandbox watch", options, ["recursive", "excludes"]);
    const events = emitter<{ paths: string[]; type: "add" | "change" | "remove" }>();
    const handle = await this.native.files.watch(
      this.files.path(path),
      (e) => {
        if (e.type === "rename") {
          if (e.oldPath) events.fire({ paths: [e.oldPath], type: "remove" });
          events.fire({ paths: [e.path], type: "add" });
        } else
          events.fire({
            paths: [e.path],
            type: e.type === "create" ? "add" : e.type === "remove" ? "remove" : "change",
          });
      },
      {
        recursive: options.recursive ?? false,
        ...(options.excludes?.length ? { exclude: [...options.excludes] } : {}),
        timeoutMs: 0,
      },
    );
    return {
      onEvent: events.event,
      dispose: () => {
        events.clear();
        void handle.stop().catch(() => undefined);
      },
    };
  }
  declare readonly download: RefusedAsync;
  async stat(path: string) {
    const e = await this.files.stat(path);
    const r = await this.native.exec(["stat", "-c", "%X %Y %Z", "--", this.files.path(path)], {
      check: true,
    });
    const [atime, mtime, ctime] = r.stdout.trim().split(" ").map(Number);
    return {
      type: e.type === "directory" ? "directory" : "file",
      isSymlink: e.type === "symlink",
      size: e.size,
      atime: atime! * 1000,
      mtime: mtime! * 1000,
      ctime: ctime! * 1000,
    };
  }
}
refuse("CodeSandbox", "FileSystem", FileSystem, {
  download:
    "read it with fs.readFile, or with the native sandbox.files.download(); Runtime has no signed download links",
});
type SavedCommand = {
  version: 1;
  /** A terminal from terminals.create; absent for a command. */
  kind?: "terminal";
  command: string;
  name?: string;
  options: Parameters<NativeSandbox["spawn"]>[1];
  taskId?: string;
};
const commandPath = (id: string) =>
  `/workspace/.runtime-compat/codesandbox/commands/${encodeURIComponent(id)}.json`;

type ShellSize = { cols: number; rows: number };
/** A shell CodeSandbox lists: a command's name is JSON whose type is "command". */
export function isCommandShell(shell: {
  shellId?: string;
  name: string;
  status?: string;
  exitCode?: number;
  shellType?: string;
  startCommand?: string;
  ownerUsername?: string;
  isSystemShell?: boolean;
}): boolean {
  try {
    return (JSON.parse(shell.name) as { type?: string }).type === "command";
  } catch {
    return false;
  }
}

/** What the client's commands, terminals and ports share with it. */
type Session = {
  native: NativeSandbox;
  env: Record<string, string>;
  workspacePath: string;
  assertConnected(): void;
  start(saved: SavedCommand): Promise<Process>;
  attach(process: Process, saved: SavedCommand): Command;
  previewURLs: Map<number, string>;
};

export class SandboxCommands {
  constructor(private readonly session: Session) {}
  async runBackground(command: string | string[], options: ShellRunOpts = {}) {
    only("CodeSandbox command", options, ["env", "cwd", "name", "dimensions", "asGlobalSession"]);
    if (options.asGlobalSession)
      throw new CompatibilityError("CodeSandbox", "global editor sessions");
    const { native, env, workspacePath } = this.session;
    this.session.assertConnected();
    const { stdin: _stdin, ...spawnOptions } = await execOptions(native, {
      env: { ...env, ...options.env },
      cwd: options.cwd ?? workspacePath,
    });
    // The published SDK treats arrays as sequential shell commands, not argv.
    const saved: SavedCommand = {
      version: 1,
      command: Array.isArray(command) ? command.join(" && ") : command,
      name: options.name,
      options: {
        ...spawnOptions,
        env: { ...spawnOptions.env },
        pty: { ...(options.dimensions ?? { cols: 128, rows: 24 }) },
      },
    };
    return this.session.attach(await this.session.start(saved), saved);
  }
  async run(command: string | string[], options?: ShellRunOpts) {
    return (await this.runBackground(command, options)).waitUntilComplete();
  }
  async getAll() {
    const { native } = this.session;
    this.session.assertConnected();
    const commands: Command[] = [];
    for (const saved of await savedShells(native))
      if (saved.taskId === undefined && saved.kind !== "terminal")
        commands.push(this.session.attach(await native.processes.get(saved.processId), saved));
    return commands;
  }
}
/** The running processes this adapter started, with what it saved about each. */
async function savedShells(native: NativeSandbox) {
  const shells: (SavedCommand & { processId: string })[] = [];
  for (const process of await native.processes.list()) {
    if (process.state !== "running" || !(await native.files.exists(commandPath(process.id))))
      continue;
    const saved = JSON.parse(await native.files.readText(commandPath(process.id))) as SavedCommand;
    if (saved.version !== 1 || typeof saved.command !== "string" || !saved.options)
      throw new Error(`Invalid saved CodeSandbox command: ${process.id}`);
    shells.push({ ...saved, processId: process.id });
  }
  return shells;
}

/** The ports listening in the sandbox, from the kernel's socket tables. */
const LISTENING = String.raw`import sys
ports=set()
for name in ("/proc/net/tcp","/proc/net/tcp6"):
 try:
  for line in open(name).readlines()[1:]:
   f=line.split()
   if f[3]=="0A": ports.add(int(f[1].rsplit(":",1)[1],16))
 except FileNotFoundError: pass
print(" ".join(str(p) for p in sorted(ports)))`;

export class Ports {
  private readonly opened = emitter<{ port: number; host: string }>();
  private readonly closed = emitter<number>();
  private watching?: ReturnType<typeof setInterval>;
  private known?: Set<number>;
  private polling = false;
  constructor(private readonly session: Session) {}
  /** A port's events start a watch of the sandbox's listening ports, once a second. */
  get onDidPortOpen() {
    return (listener: (port: { port: number; host: string }) => void) =>
      this.subscribe(this.opened.event(listener));
  }
  get onDidPortClose() {
    return (listener: (port: number) => void) => this.subscribe(this.closed.event(listener));
  }
  private subscribe(subscription: { dispose: () => boolean }) {
    this.watching ??= setInterval(() => void this.poll(), 1000);
    void this.poll();
    return {
      dispose: () => {
        subscription.dispose();
      },
    };
  }
  /** The ports listening now. */
  async listening(): Promise<number[]> {
    const r = await this.session.native.exec(["python3", "-c", LISTENING], { check: true });
    return r.stdout.trim() ? r.stdout.trim().split(" ").map(Number) : [];
  }
  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const now = new Set(await this.listening());
      const before = this.known;
      this.known = now;
      if (!before) return;
      for (const port of now) if (!before.has(port)) this.opened.fire(await this.get(port));
      for (const port of before) if (!now.has(port)) this.closed.fire(port);
    } catch {
      // A failed look is tried again at the next tick.
    } finally {
      this.polling = false;
    }
  }
  dispose() {
    clearInterval(this.watching);
    this.watching = undefined;
    this.opened.clear();
    this.closed.clear();
  }
  async get(port: number) {
    const { native, previewURLs } = this.session;
    this.session.assertConnected();
    if (native.info.labels["cs.privacy"] === "private")
      throw new CompatibilityError(
        "CodeSandbox",
        "private port host authentication; use Runtime signed preview URLs",
      );
    const p = await native.previews.create(port, { visibility: "public" });
    previewURLs.set(port, p.urlWithToken ?? p.url);
    return { port, host: new URL(p.urlWithToken ?? p.url).host };
  }
  async getAll() {
    this.session.assertConnected();
    return (await this.session.native.previews.list()).map((p) => {
      this.session.previewURLs.set(p.port, p.urlWithToken ?? p.url);
      return { port: p.port, host: new URL(p.url).host };
    });
  }
  async waitForPort(port: number, options: { timeoutMs?: number } = {}) {
    only("CodeSandbox waitForPort", options, ["timeoutMs"]);
    this.session.assertConnected();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("Invalid port");
    await this.session.native.exec(
      [
        "python3",
        "-c",
        'import socket,sys,time\nport=int(sys.argv[1]); end=time.monotonic()+float(sys.argv[2])/1000\nwhile True:\n try:\n  s=socket.create_connection(("127.0.0.1",port),timeout=0.25); s.close(); break\n except OSError:\n  if time.monotonic() >= end: raise TimeoutError("Port did not open")\n  time.sleep(0.1)',
        String(port),
        String(options.timeoutMs ?? 30000),
      ],
      { check: true, timeoutMs: (options.timeoutMs ?? 30000) + 1000 },
    );
    return this.get(port);
  }
}

/** URLs of the ports this client exposed with ports.get or listed with ports.getAll. */
export class Hosts {
  constructor(private readonly session: Session) {}
  getUrl(port: number, protocol = "https") {
    const url = this.session.previewURLs.get(port);
    if (!url) throw new Error(`Port ${port} has not been exposed; call ports.get(${port}) first`);
    const at = new URL(url);
    at.protocol = `${protocol}:`;
    return at.toString();
  }
  /** Public previews need no token: nothing to send. */
  getHeaders(): Record<string, string> {
    return {};
  }
  getCookies(): Record<string, string> {
    return {};
  }
}

/** Interactive shells, each a process with a terminal of its own. */
export class Terminals {
  constructor(private readonly session: Session) {}
  async create(
    command: "bash" | "zsh" | "fish" | "ksh" | "dash" = "bash",
    options: ShellRunOpts = {},
  ) {
    only("CodeSandbox terminal", options, ["env", "cwd", "name", "dimensions", "asGlobalSession"]);
    if (options.asGlobalSession)
      throw new CompatibilityError("CodeSandbox", "global editor sessions");
    if (!["bash", "zsh", "fish", "ksh", "dash"].includes(command))
      throw new TypeError(`Unknown shell: ${command}`);
    const { native, env, workspacePath } = this.session;
    this.session.assertConnected();
    const { stdin: _stdin, ...spawnOptions } = await execOptions(native, {
      env: { ...env, ...options.env },
      cwd: options.cwd ?? workspacePath,
    });
    const saved: SavedCommand = {
      version: 1,
      kind: "terminal",
      command,
      name: options.name,
      options: {
        ...spawnOptions,
        env: { ...spawnOptions.env },
        stdin: "pipe",
        pty: { ...(options.dimensions ?? { cols: 80, rows: 24 }) },
      },
    };
    const process = await this.session.start(saved);
    return new Terminal(process, options.name ?? command);
  }
  async get(shellId: string) {
    return (await this.getAll()).find((terminal) => terminal.id === shellId);
  }
  async getAll() {
    const { native } = this.session;
    this.session.assertConnected();
    const terminals: Terminal[] = [];
    for (const saved of await savedShells(native))
      if (saved.kind === "terminal")
        terminals.push(
          new Terminal(await native.processes.get(saved.processId), saved.name ?? saved.command),
        );
    return terminals;
  }
}
export class Terminal {
  private readonly outputEvent = emitter<string>();
  readonly onOutput = this.outputEvent.event;
  private output: string[] = [];
  private following?: AbortController;
  constructor(
    private readonly process: Process,
    readonly name: string,
  ) {}
  get id() {
    return this.process.id;
  }
  /** Its output so far, and what it prints from now on through onOutput. */
  async open(dimensions: ShellSize = { cols: 80, rows: 24 }) {
    await this.process.resize(dimensions.cols, dimensions.rows);
    if (!this.following) {
      const info = await this.process.refresh();
      const end = info.outputBytes;
      const signal = (this.following = new AbortController()).signal;
      let replayed = "";
      let caughtUp!: () => void;
      const ready = new Promise<void>((resolve) => (caughtUp = resolve));
      if (end <= info.firstOffset) caughtUp();
      void (async () => {
        try {
          for await (const e of this.process.output({ signal }))
            if (e.type === "stdout" || e.type === "stderr") {
              if (e.offset < end) replayed += e.data;
              else {
                this.output.push(e.data);
                this.outputEvent.fire(e.data);
              }
              if (e.offset + new TextEncoder().encode(e.data).length >= end) caughtUp();
            } else if (e.type === "exit") break;
        } catch {
          // The terminal ended, or this client let go of it.
        } finally {
          caughtUp();
        }
      })();
      await ready;
      this.output.unshift(replayed);
    }
    return this.output.join("");
  }
  async write(input: string, dimensions?: ShellSize) {
    if (dimensions) await this.process.resize(dimensions.cols, dimensions.rows);
    await this.process.write(input);
  }
  run(input: string, dimensions?: ShellSize) {
    return this.write(`${input}\n`, dimensions);
  }
  async kill() {
    this.following?.abort();
    await this.process.kill("SIGKILL");
  }
}

/** One-off JavaScript and Python snippets, run as CodeSandbox runs them: the
 * last line's value is printed. */
export class Interpreters {
  constructor(private readonly commands: SandboxCommands) {}
  javascript(code: string) {
    const body = code
      .split("\n")
      .map((line, i, lines) =>
        i === lines.length - 1 && !line.startsWith("return") ? `return ${line}` : line,
      )
      .join("\n");
    return this.commands.run(`node -p "$(cat <<'EOF'\n(() => {${body}})()\nEOF\n)"`, {
      env: { NO_COLOR: "true" },
    });
  }
  python(code: string) {
    const body = code
      .split("\n")
      .map((line, i, lines) =>
        i === lines.length - 1 && !line.startsWith("print") ? `print(${line})` : line,
      )
      .join("\n");
    return this.commands.run(`python3 <<'PYCODE'\n${body}\nPYCODE\n`);
  }
}

export class SandboxClient {
  readonly fs: FileSystem;
  readonly commands: SandboxCommands;
  readonly ports: Ports;
  readonly terminals: Terminals;
  readonly interpreters: Interpreters;
  readonly hosts: Hosts;
  readonly tasks: Tasks;
  readonly setup: Setup;
  readonly workspacePath = "/project/sandbox";
  declare static readonly create: RefusedAsync;
  private disconnected = false;
  private readonly attached = new Set<Command>();
  private readonly previewURLs = new Map<number, string>();
  private readonly stateEvent = emitter<"CONNECTED" | "DISCONNECTED">();
  private stopKeepAlive?: () => void;
  constructor(
    private readonly native: NativeSandbox,
    private readonly env: Record<string, string>,
  ) {
    this.fs = new FileSystem(native);
    this.tasks = new Tasks(this, native);
    this.setup = new Setup(this, native);
    const session: Session = {
      native,
      env,
      workspacePath: this.workspacePath,
      assertConnected: () => this.assertConnected(),
      start: (saved) => this.start(saved),
      attach: (process, saved) => this.attach(process, saved),
      previewURLs: this.previewURLs,
    };
    this.commands = new SandboxCommands(session);
    this.ports = new Ports(session);
    this.terminals = new Terminals(session);
    this.interpreters = new Interpreters(this.commands);
    this.hosts = new Hosts(session);
  }
  /** Runtime's guest agent is updated with the host: always current. */
  get isUpToDate() {
    return true;
  }
  /** The sandbox's page in Runtime's console. */
  get editorUrl() {
    return `https://withruntime.com/account/sandboxes/${encodeURIComponent(this.native.id)}`;
  }
  get onStateChange() {
    return this.stateEvent.event;
  }
  async initialize() {
    await this.tasks.getAll();
    await this.setup.initialize(true);
  }
  previewURL(port: number): string {
    const url = this.previewURLs.get(port);
    if (!url) throw new Error("Port has not been exposed");
    return url;
  }
  private assertConnected() {
    if (this.disconnected) throw new Error("Sandbox client is disconnected.");
  }
  private async start(saved: SavedCommand): Promise<Process> {
    this.assertConnected();
    const process = await this.native.spawn(saved.command, saved.options);
    try {
      // Arguments and environment may contain credentials. Keep them in the
      // guest's private file, never resource labels or public process metadata.
      await this.native.files.write(commandPath(process.id), JSON.stringify(saved), {
        mode: 0o600,
      });
      return process;
    } catch (error) {
      try {
        await process.kill("SIGKILL");
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Command metadata failed and cleanup could not be confirmed",
        );
      }
      throw error;
    }
  }
  private attach(process: Process, saved: SavedCommand) {
    const command = new Command(process, saved.command, saved.name, () => this.start(saved));
    this.attached.add(command);
    return command;
  }
  get id() {
    return this.native.id;
  }
  get state() {
    return this.disconnected ? "DISCONNECTED" : "CONNECTED";
  }
  async disconnect() {
    if (!this.disconnected) this.stateEvent.fire("DISCONNECTED");
    this.disconnected = true;
    this.ports.dispose();
    this.tasks.dispose();
    this.setup.dispose();
    for (const command of this.attached) command.detach();
    this.attached.clear();
    this.stopKeepAlive?.();
  }
  async reconnect() {
    await ready(await this.native.refresh());
    if (this.disconnected) this.stateEvent.fire("CONNECTED");
    this.disconnected = false;
    await this.tasks.reconnect();
    await this.setup.reconnect();
  }
  keepActiveWhileConnected(enabled: boolean) {
    this.stopKeepAlive?.();
    if (enabled) this.stopKeepAlive = this.native.keepAlive();
  }
  dispose() {
    if (!this.disconnected) this.stateEvent.fire("DISCONNECTED");
    this.disconnected = true;
    this.ports.dispose();
    this.tasks.dispose();
    this.setup.dispose();
    for (const command of this.attached) command.detach();
    this.attached.clear();
    this.stopKeepAlive?.();
    this.stateEvent.clear();
  }
}

refuse(
  "CodeSandbox",
  "SandboxClient",
  { prototype: SandboxClient },
  {
    create: "connect with sandbox.connect(); Runtime has no separate session handshake",
  },
);

export type TaskDefinition = {
  name: string;
  command: string;
  runAtStart?: boolean;
  preview?: {
    port?: number;
    prLink?: "direct" | "redirect" | "devtool";
    "pr-link"?: "direct" | "redirect" | "devtool";
  };
};
type TaskConfig = {
  tasks?: Record<string, TaskDefinition>;
  setupTasks?: (TaskDefinition | string)[];
  $schema?: string;
};

/** Configured tasks share durable native processes between client connections. */
export class Tasks {
  private cached?: Promise<Task[]>;
  private readonly managed: ManagedTasks;
  private loaded: Task[] = [];
  private cancelled = new AbortController();
  constructor(
    private readonly client: SandboxClient,
    private readonly native: NativeSandbox,
  ) {
    this.managed = new ManagedTasks(native);
  }
  getAll(): Promise<Task[]> {
    if (this.client.state !== "CONNECTED")
      return Promise.reject(new Error("Sandbox client is disconnected."));
    return (this.cached ??= this.load().catch((error: unknown) => {
      this.cached = undefined;
      throw error;
    }));
  }
  async get(id: string): Promise<Task | undefined> {
    return (await this.getAll()).find((task) => task.id === id);
  }
  async reconnect() {
    if (this.cached) for (const task of await this.cached) task.dispose();
    this.cached = undefined;
    this.cancelled = new AbortController();
    await this.getAll();
  }
  dispose() {
    this.cancelled.abort();
    for (const task of this.loaded) task.dispose();
  }
  private async load() {
    const path = `${this.client.workspacePath}/.codesandbox/tasks.json`;
    let config: TaskConfig;
    if (await this.native.files.exists(path)) {
      config = JSON.parse(await this.native.files.readText(path)) as TaskConfig;
      only("CodeSandbox tasks config", config, ["$schema", "tasks", "setupTasks"]);
    } else {
      const packagePath = `${this.client.workspacePath}/package.json`;
      if (!(await this.native.files.exists(packagePath))) return [];
      const pkg = JSON.parse(await this.native.files.readText(packagePath)) as {
        scripts?: Record<string, string>;
      };
      config = {
        tasks: Object.fromEntries(
          Object.keys(pkg.scripts ?? {}).map((name) => [
            name,
            { name, command: `npm run ${quote(name)}` },
          ]),
        ),
      };
    }
    const tasks: Task[] = [];
    for (const [id, definition] of Object.entries(config.tasks ?? {})) {
      only("CodeSandbox task", definition, ["name", "command", "runAtStart", "preview"]);
      if (typeof definition.name !== "string" || typeof definition.command !== "string")
        throw new TypeError(`Task ${id} requires a name and command`);
      if (definition.runAtStart !== undefined && typeof definition.runAtStart !== "boolean")
        throw new TypeError(`Task ${id} runAtStart must be a boolean`);
      if (definition.preview) {
        only("CodeSandbox task preview", definition.preview, ["port", "prLink", "pr-link"]);
        if (
          definition.preview.port !== undefined &&
          (!Number.isInteger(definition.preview.port) ||
            definition.preview.port < 1 ||
            definition.preview.port > 65535)
        )
          throw new TypeError(`Task ${id} has an invalid preview port`);
      }
      tasks.push(new Task(this.client, id, structuredClone(definition), this.managed));
    }
    if (tasks.length) {
      const steps = (config.setupTasks ?? []).map((step) =>
        typeof step === "string" ? { name: step, command: step } : step,
      );
      for (const step of steps) {
        only("CodeSandbox setup step", step, ["name", "command"]);
        if (typeof step.name !== "string" || typeof step.command !== "string")
          throw new TypeError("Setup steps require a name and command");
      }
      const { env } = await execOptions(this.native, {});
      await this.managed.install(config.tasks ?? {}, env ?? {}, { steps, source: setupRunner });
      for (const task of tasks) await task.reconnect();
    }
    this.loaded = tasks;
    if (tasks.length) this.monitor();
    return tasks;
  }
  private monitor() {
    const signal = this.cancelled.signal;
    void (async () => {
      while (!signal.aborted) {
        try {
          for (const run of await this.managed.list(signal)) {
            if (signal.aborted) return;
            this.loaded.find((task) => task.id === run.taskId)?.observe(run.process);
          }
        } catch (error) {
          if (signal.aborted) return;
          for (const task of this.loaded) task.unavailable(error);
        }
        await new Promise<void>((resolve) => {
          const stop = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", stop);
            resolve();
          };
          const timer = setTimeout(stop, 500);
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) stop();
        });
      }
    })();
  }
}
export class Task {
  private process?: Command;
  private processId?: string;
  private fault?: unknown;
  private disposed = false;
  private opened = false;
  private streamedLength = 0;
  private openedLength = 0;
  private readonly outputEvent = emitter<string>();
  private readonly statusEvent = emitter<"IDLE" | CommandStatus>();
  readonly onOutput = this.outputEvent.event;
  readonly onStatusChange = this.statusEvent.event;
  private subscriptions: { dispose(): unknown }[] = [];
  private transition: Promise<void> = Promise.resolve();
  private exposed: { port: number; url: string }[] = [];
  constructor(
    private readonly client: SandboxClient,
    readonly id: string,
    private readonly definition: TaskDefinition,
    private readonly managed: ManagedTasks,
  ) {}
  async reconnect() {
    const process = await this.managed.get(this.id);
    if (process) this.observe(process);
  }
  observe(process: Process) {
    if (this.disposed) return;
    this.fault = undefined;
    if (process.id === this.processId) return;
    this.process?.detach();
    this.processId = process.id;
    this.exposed = [];
    this.streamedLength = 0;
    this.openedLength = 0;
    const command = new Command(process, this.command, this.name, () =>
      this.managed.start(this.id),
    );
    if (process.info.state !== "running")
      command.status = process.info.exitCode === 0 ? "FINISHED" : "ERROR";
    this.attach(command);
    this.statusEvent.fire(this.status);
  }
  unavailable(error: unknown) {
    if (this.disposed) return;
    this.fault = error;
    this.statusEvent.fire("ERROR");
  }
  get name() {
    return this.definition.name;
  }
  get command() {
    return this.definition.command;
  }
  get runAtStart() {
    return Boolean(this.definition.runAtStart);
  }
  get status(): "IDLE" | CommandStatus {
    if (this.fault) return "ERROR";
    return this.process?.status ?? "IDLE";
  }
  get ports() {
    return this.exposed;
  }
  private attach(command: Command) {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.process = command;
    this.subscriptions = [
      command.onStatusChange((status) => this.statusEvent.fire(status)),
      command.onOutput((output) => {
        const start = this.streamedLength;
        this.streamedLength += output.length;
        if (this.opened && this.streamedLength > this.openedLength)
          this.outputEvent.fire(output.slice(Math.max(0, this.openedLength - start)));
      }),
    ];
  }
  async open(dimensions?: { cols: number; rows: number }) {
    if (!this.process) throw new Error("Task is not running");
    await this.process.open(dimensions);
    const output = await this.managed.output(this.processId!);
    const followed = this.process.bufferedOutput;
    this.openedLength = Math.max(output.length, followed.length);
    this.opened = true;
    if (followed.length > output.length) this.outputEvent.fire(followed.slice(output.length));
    return output;
  }
  private serial(work: () => Promise<void>) {
    const result = this.transition.then(work);
    this.transition = result.catch(() => undefined);
    return result;
  }
  run(): Promise<void> {
    return this.serial(async () => {
      if (this.client.state !== "CONNECTED") throw new Error("Sandbox client is disconnected.");
      this.observe(await this.managed.start(this.id));
    });
  }
  restart(): Promise<void> {
    return this.run();
  }
  stop(): Promise<void> {
    return this.serial(async () => {
      if (this.client.state !== "CONNECTED") throw new Error("Sandbox client is disconnected.");
      const current = await this.managed.stop(this.id);
      if (current) {
        this.observe(current);
        await this.process!.kill();
      }
    });
  }
  async waitForPort(timeout = 30000) {
    if (this.exposed.length) return this.exposed[0]!;
    const port = this.definition.preview?.port;
    if (!port)
      throw new CompatibilityError(
        "CodeSandbox",
        "automatic task-to-port discovery; configure task.preview.port",
      );
    try {
      const result = await this.client.ports.waitForPort(port, { timeoutMs: timeout });
      const opened = { port: result.port, url: this.client.previewURL(result.port) };
      this.exposed = [opened];
      return opened;
    } catch (error) {
      if ((error as { stderr?: string }).stderr?.includes("TimeoutError: Port did not open"))
        throw new Error("Timeout waiting for port", { cause: error });
      throw error;
    }
  }
  dispose() {
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
    this.process?.detach();
    this.outputEvent.clear();
    this.statusEvent.clear();
  }
}

type StepState = "IDLE" | "SUCCEEDED" | "FAILED" | "SKIPPED";
type SetupState = "IDLE" | "IN_PROGRESS" | "FINISHED" | "STOPPED";
type SetupProgress = {
  state: SetupState;
  currentStepIndex: number;
  runId?: string;
  config: string;
  steps: { name: string; command: string; status: StepState; log?: string; tty?: string }[];
};
const setupRoot = "/workspace/.runtime-compat/codesandbox/setup";
// The guest owns the sequence and lock; progress survives SDK disconnects.
const setupRunner = String.raw`import errno,fcntl,json,os,pty,select,signal,struct,subprocess,sys,termios,threading
with open(sys.argv[1]) as f: config=json.load(f)
root=os.path.dirname(sys.argv[1])
os.umask(0o077)
lock=open(os.path.join(root,'lock'),'a')
try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: sys.exit(0)
state={'state':'IN_PROGRESS','currentStepIndex':0,'runId':config['runId'],'config':config['config'],'steps':[dict(x,status='IDLE',log=os.path.join(root,config['runId']+'-'+str(i)+'.log')) for i,x in enumerate(config['steps'])]}
def save():
 temp=os.path.join(root,'progress-'+config['runId']+'.tmp')
 with open(temp,'w') as f: json.dump(state,f)
 os.replace(temp,os.path.join(root,'progress.json'))
child=None
def stop(signum,frame):
 if child is not None and child.poll() is None:
  try: os.killpg(child.pid,signal.SIGTERM)
  except ProcessLookupError: pass
  try: child.wait(timeout=2)
  except subprocess.TimeoutExpired:
   try: os.killpg(child.pid,signal.SIGKILL)
   except ProcessLookupError: pass
   child.wait()
 state['state']='STOPPED'
 save()
 sys.exit(128+signum)
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
save()
try:
 for i,step in enumerate(state['steps']):
  state['currentStepIndex']=i
  master,slave=pty.openpty()
  fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,128,0,0))
  step['tty']=os.ttyname(slave)
  save()
  with open(step['log'],'wb',buffering=0) as output:
   finished=threading.Event()
   errors=[]
   def collect():
    try:
     while True:
      ready,_,_=select.select([master],[],[],0.05)
      if not ready:
       if finished.is_set(): break
       continue
      try: data=os.read(master,65536)
      except OSError as e:
       if e.errno==errno.EIO: break
       raise
      if not data: break
      output.write(data)
    except BaseException as e:
     errors.append(str(e))
     try: os.killpg(child.pid,signal.SIGKILL)
     except ProcessLookupError: pass
    finally: os.close(master)
   try: child=subprocess.Popen(['bash','-c',step['command']],cwd=config['cwd'],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
   finally: os.close(slave)
   collector=threading.Thread(target=collect,daemon=True)
   collector.start()
   code=child.wait()
   finished.set()
   collector.join()
   if errors: code=125
  step['status']='SUCCEEDED' if code==0 else 'FAILED'
  if code!=0:
   state['state']='STOPPED'
   save()
   sys.exit(code)
  save()
 state['state']='FINISHED'
 save()
except BaseException:
 if state['state']=='IN_PROGRESS':
  state['state']='STOPPED'
  save()
 raise
`;
// The cached progress can be stale: the step may have ended and its terminal
// closed, or on Linux its /dev/pts number been reused. Resize only while the
// guest's own progress still names this run's running step and terminal; a
// terminal that has gone needs no resize. O_NOCTTY keeps it from becoming the
// helper's controlling terminal.
const resizeStep = String.raw`import errno,fcntl,json,os,struct,sys,termios
progress,run,index,tty,rows,cols=sys.argv[1:7]
try:
 with open(progress) as f: state=json.load(f)
except FileNotFoundError: sys.exit(0)
steps=state.get('steps') or []
i=int(index)
if state.get('runId')!=run or i>=len(steps) or steps[i].get('status')!='IDLE' or steps[i].get('tty')!=tty: sys.exit(0)
try: fd=os.open(tty,os.O_RDWR|os.O_NOCTTY)
except OSError as e:
 if e.errno in (errno.ENOENT,errno.ENXIO,errno.EIO): sys.exit(0)
 raise
try: fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',int(rows),int(cols),0,0))
finally: os.close(fd)
`;
export class Setup {
  private progress: SetupProgress = { state: "IDLE", currentStepIndex: 0, config: "", steps: [] };
  private steps: Step[] = [];
  private loaded?: Promise<void>;
  private active?: Promise<void>;
  private starting?: Promise<void>;
  private failure?: Error;
  private ignoredRunId?: string;
  private managedBoot = false;
  private cancelled = new AbortController();
  private readonly changed = emitter<void>();
  readonly onSetupProgressChange = this.changed.event;
  constructor(
    private readonly client: SandboxClient,
    private readonly native: NativeSandbox,
  ) {}
  get status() {
    return this.progress.state;
  }
  get currentStepIndex() {
    return this.progress.currentStepIndex;
  }
  getSteps() {
    return this.steps;
  }
  async initialize(automatic = false) {
    await (this.loaded ??= this.load());
    if (automatic && this.status === "IDLE") await this.run();
    if (this.status === "IN_PROGRESS") this.monitor();
  }
  async reconnect() {
    await this.active;
    this.cancelled = new AbortController();
    this.failure = undefined;
    this.ignoredRunId = undefined;
    this.loaded = undefined;
    await this.initialize(true);
  }
  private async load() {
    const path = `${this.client.workspacePath}/.codesandbox/tasks.json`;
    const config = (await this.native.files.exists(path))
      ? (JSON.parse(await this.native.files.readText(path)) as TaskConfig)
      : {};
    const definitions = (config.setupTasks ?? []).map((step) =>
      typeof step === "string" ? { name: step, command: step } : step,
    );
    for (const definition of definitions) {
      only("CodeSandbox setup step", definition, ["name", "command"]);
      if (typeof definition.name !== "string" || typeof definition.command !== "string")
        throw new TypeError("Setup steps require a name and command");
    }
    const identity = JSON.stringify(definitions);
    this.progress = {
      state: definitions.length ? "IDLE" : "FINISHED",
      currentStepIndex: 0,
      config: identity,
      steps: definitions.map((step) => ({ ...step, status: "IDLE" })),
    };
    if (await this.native.files.exists(`${setupRoot}/progress.json`)) {
      const stored = JSON.parse(
        await this.native.files.readText(`${setupRoot}/progress.json`),
      ) as SetupProgress;
      if (stored.config === identity) this.progress = stored;
    }
    this.steps = definitions.map((definition, index) => new Step(this, index, definition));
    const boot = await new ManagedTasks(this.native).boot();
    this.managedBoot = Boolean(boot && boot.config === identity && boot.state !== "ready");
    if (this.managedBoot) {
      if (boot!.state === "failed") {
        this.progress.state = "STOPPED";
        this.failure = new Error(boot!.error);
      } else if (this.status === "IDLE") this.progress.state = "IN_PROGRESS";
    }
  }
  run(): Promise<void> {
    return (this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    }));
  }
  private async start() {
    await this.initialize();
    if (this.client.state !== "CONNECTED") throw new Error("Sandbox client is disconnected.");
    if (this.status === "IN_PROGRESS" || !this.steps.length) return;
    this.managedBoot = false;
    await this.active;
    this.ignoredRunId = this.progress.runId;
    const runId = crypto.randomUUID();
    const input = `${setupRoot}/${runId}.json`;
    const config = {
      runId,
      config: this.progress.config,
      cwd: this.client.workspacePath,
      steps: this.steps.map((step) => ({ name: step.name, command: step.command })),
    };
    await this.native.files.write(input, JSON.stringify(config), { mode: 0o600 });
    const { stdin: _stdin, ...options } = await execOptions(this.native, {
      cwd: this.client.workspacePath,
    });
    const process = await this.native.spawn(["python3", "-c", setupRunner, input], options);
    try {
      await this.native.files.write(
        `${setupRoot}/${runId}.process.json`,
        JSON.stringify({ id: process.id }),
        { mode: 0o600 },
      );
      // Do not return a connection before the guest has published ownership.
      // A second connection can otherwise launch a duplicate supervisor while
      // the first Python interpreter is still starting.
      const until = Date.now() + 5000;
      for (;;) {
        if (await this.native.files.exists(`${setupRoot}/progress.json`)) {
          const accepted = JSON.parse(
            await this.native.files.readText(`${setupRoot}/progress.json`),
          ) as SetupProgress;
          if (accepted.config === config.config && accepted.runId !== this.ignoredRunId) break;
        }
        if (Date.now() >= until) throw new Error("Setup supervisor did not acknowledge startup");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } catch (error) {
      try {
        await process.kill("SIGKILL");
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Setup tracking failed and process cleanup could not be confirmed",
        );
      }
      throw error;
    }
    this.failure = undefined;
    this.progress = {
      ...this.progress,
      state: "IN_PROGRESS",
      runId,
      currentStepIndex: 0,
      steps: config.steps.map((step) => ({ ...step, status: "IDLE" })),
    };
    this.changed.fire();
    // Native process failure is observed independently of progress-file polling.
    void process
      .wait({ signal: this.cancelled.signal })
      .then(async (result) => {
        if (this.progress.runId !== runId || this.cancelled.signal.aborted) return;
        if (result.exitCode !== 0) {
          if (await this.native.files.exists(`${setupRoot}/progress.json`)) {
            const stored = JSON.parse(
              await this.native.files.readText(`${setupRoot}/progress.json`),
            ) as SetupProgress;
            if (stored.runId === runId) {
              this.progress = stored;
              for (const step of this.steps) await step.refresh();
            }
          }
          this.failure = new Error("Setup Failed");
          this.progress.state = "STOPPED";
          this.changed.fire();
        }
      })
      .catch((error: unknown) => {
        if (this.cancelled.signal.aborted) return;
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.progress.state = "STOPPED";
        this.changed.fire();
      });
    this.monitor();
  }
  private monitor() {
    if (this.active) return;
    const signal = this.cancelled.signal;
    this.active = (async () => {
      while (this.status === "IN_PROGRESS") {
        signal.throwIfAborted();
        if (this.managedBoot) {
          const boot = await new ManagedTasks(this.native).boot(signal);
          if (boot?.state === "failed") throw new Error(boot.error);
        }
        if (await this.native.files.exists(`${setupRoot}/progress.json`, { signal })) {
          const next = JSON.parse(
            await this.native.files.readText(`${setupRoot}/progress.json`, { signal }),
          ) as SetupProgress;
          if (next.config === this.progress.config && next.runId !== this.ignoredRunId) {
            this.progress = next;
            for (const step of this.steps) await step.refresh();
            if (this.status === "IN_PROGRESS" && next.runId) {
              const tracking = `${setupRoot}/${next.runId}.process.json`;
              if (await this.native.files.exists(tracking, { signal })) {
                const { id } = JSON.parse(
                  await this.native.files.readText(tracking, { signal }),
                ) as { id: string };
                const process = await this.native.processes.get(id);
                if (process.info.state !== "running") {
                  // Read again after observing exit: the supervisor writes its
                  // final progress before it exits; the earlier read can race.
                  this.progress = JSON.parse(
                    await this.native.files.readText(`${setupRoot}/progress.json`, { signal }),
                  ) as SetupProgress;
                  if (this.progress.state === "IN_PROGRESS") this.progress.state = "STOPPED";
                  for (const step of this.steps) await step.refresh();
                }
              }
            }
            this.changed.fire();
          }
        }
        if (this.status !== "IN_PROGRESS") break;
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error("Setup subscription cancelled"),
            );
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, 100);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    })()
      .catch((error: unknown) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.progress.state = "STOPPED";
        this.changed.fire();
      })
      .finally(() => {
        this.active = undefined;
      });
  }
  async waitUntilComplete(): Promise<void> {
    await this.initialize();
    if (this.failure) throw this.failure;
    if (this.status === "STOPPED") throw new Error("Setup Failed");
    if (this.status === "FINISHED") return;
    await new Promise<void>((resolve, reject) => {
      const listener = this.onSetupProgressChange(() => {
        if (this.status === "FINISHED" || this.status === "STOPPED") {
          listener.dispose();
          if (this.status === "FINISHED") resolve();
          else reject(this.failure ?? new Error("Setup Failed"));
        }
      });
    });
  }
  step(index: number) {
    return this.progress.steps[index]!;
  }
  async output(index: number) {
    const log = this.step(index).log;
    if (!log || !(await this.native.files.exists(log))) return "";
    return this.native.files.readText(log);
  }
  async open(index: number, dimensions?: { cols: number; rows: number }) {
    if (
      dimensions &&
      (!Number.isInteger(dimensions.cols) ||
        !Number.isInteger(dimensions.rows) ||
        dimensions.cols < 1 ||
        dimensions.rows < 1 ||
        dimensions.cols > 65535 ||
        dimensions.rows > 65535)
    )
      throw new TypeError("Invalid terminal dimensions");
    const available = () => this.step(index).tty || this.step(index).status !== "IDLE";
    if (!available())
      await new Promise<void>((resolve, reject) => {
        const changed = () => {
          if (available()) {
            listener.dispose();
            resolve();
          } else if (this.status === "STOPPED") {
            listener.dispose();
            reject(new Error("Step Failed"));
          }
        };
        const listener = this.onSetupProgressChange(changed);
        changed();
      });
    const step = this.step(index);
    if (dimensions && step.tty && step.status === "IDLE")
      await this.native.exec(
        [
          "python3",
          "-c",
          resizeStep,
          `${setupRoot}/progress.json`,
          this.progress.runId ?? "",
          String(index),
          step.tty,
          String(dimensions.rows),
          String(dimensions.cols),
        ],
        { check: true },
      );
  }
  dispose() {
    const error = new Error("Sandbox client is disconnected.");
    this.cancelled.abort(error);
    if (this.status === "IDLE" || this.status === "IN_PROGRESS") {
      this.failure = error;
      this.progress.state = "STOPPED";
      this.changed.fire();
    }
  }
}
export class Step {
  private output = "";
  private previousStatus: StepState = "IDLE";
  private readonly outputEvent = emitter<string>();
  private readonly statusEvent = emitter<StepState>();
  readonly onOutput = this.outputEvent.event;
  readonly onStatusChange = this.statusEvent.event;
  constructor(
    private readonly setup: Setup,
    private readonly index: number,
    private readonly definition: { name: string; command: string },
  ) {}
  get name() {
    return this.definition.name;
  }
  get command() {
    return this.definition.command;
  }
  get status(): StepState {
    return this.setup.step(this.index).status;
  }
  async refresh() {
    const next = await this.setup.output(this.index);
    if (next.length > this.output.length) this.outputEvent.fire(next.slice(this.output.length));
    this.output = next;
    if (this.status !== this.previousStatus) {
      this.previousStatus = this.status;
      this.statusEvent.fire(this.status);
    }
  }
  async open(dimensions?: { cols: number; rows: number }): Promise<string> {
    await this.setup.open(this.index, dimensions);
    await this.refresh();
    return this.output;
  }
  async waitUntilComplete(): Promise<void> {
    if (this.status === "FAILED" || this.setup.status === "STOPPED") throw new Error("Step Failed");
    if (this.status === "SUCCEEDED" || this.status === "SKIPPED") return;
    await new Promise<void>((resolve, reject) => {
      const listener = this.setup.onSetupProgressChange(() => {
        if (this.status === "SUCCEEDED" || this.status === "SKIPPED") {
          listener.dispose();
          resolve();
        } else if (this.status === "FAILED" || this.setup.status === "STOPPED") {
          listener.dispose();
          reject(new Error("Step Failed"));
        }
      });
    });
  }
}
