/* eslint-disable @typescript-eslint/no-this-alias -- the fake's modules close over their sandbox. */
import {
  NotFoundError,
  RuntimeError,
  ServiceUnavailableError,
  type Runtime,
} from "../../src/index";

/* A fake of the withruntime SDK: the calls the adapter makes, recorded, with
   answers the tests choose. It stands in for the SDK, not for the API: what
   the SDK does over HTTP is the SDK's own tests' business. */

export type Call = [method: string, ...args: unknown[]];
/** The most of each stream an exec result holds when it is not streamed. */
export const EXEC_RESULT_BYTES = 65_536;
type ExecAnswer = {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  /** Output the stream dropped before it was read. */
  lost?: boolean;
};
type OutputEvent =
  | { type: "stdout" | "stderr"; data: string; offset: number }
  | { type: "truncated"; droppedBytes: number; resumeAt: number }
  | { type: "exit"; exitCode: number | null; state: string; timedOut: boolean };

export class FakeWorld {
  readonly calls: Call[] = [];
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly images: Array<{ id: string; name: string | null; state: string }> = [];
  readonly snapshots = new Set<string>();
  forksEnabled = true;
  /** How exec and spawn answer; the default says what it ran. */
  exec: (command: string, options: Record<string, unknown>) => ExecAnswer = (command) => ({
    exitCode: 0,
    stdout: `ran ${command}\n`,
  });
  /** The events a spawned process produces. */
  output: (command: string, options?: Record<string, unknown>) => OutputEvent[] = (
    command,
    options = {},
  ) => {
    const answer = this.exec(command, options);
    let offset = 0;
    const events: OutputEvent[] = [];
    if (answer.lost) events.push({ type: "truncated", droppedBytes: 10, resumeAt: 10 });
    for (const channel of ["stdout", "stderr"] as const) {
      const data = answer[channel] ?? "";
      if (data) events.push({ type: channel, data, offset });
      offset += Buffer.byteLength(data);
    }
    events.push({
      type: "exit",
      exitCode: answer.exitCode ?? null,
      state: "exited",
      timedOut: answer.timedOut ?? false,
    });
    return events;
  };
  interpreter: (code: string, options: Record<string, unknown>) => Record<string, unknown> = (
    code,
  ) => ({
    id: "e1",
    contextId: "python",
    language: "python",
    executionCount: 1,
    status: "ok",
    stdout: `out ${code}\n`,
    stderr: "",
    results: [{ main: true, data: { "text/plain": "2" }, refs: {} }],
    error: null,
    overflow: [],
    durationMs: 1,
    contextStarted: false,
    lostBytes: 0,
  });
  #next = 1;

  record(...call: Call) {
    this.calls.push(call);
  }
  called(method: string): unknown[][] {
    return this.calls.filter(([name]) => name === method).map(([, ...args]) => args);
  }
  id() {
    const n = this.#next++;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  }

  client(): Runtime {
    const world = this;
    const sandboxes = {
      async create(input: Record<string, unknown>, options: unknown) {
        world.record("sandboxes.create", input, options);
        if (input.snapshot && !world.forksEnabled) throw unavailable();
        const sandbox = new FakeSandbox(world, world.id(), input);
        world.sandboxes.set(sandbox.id, sandbox);
        return sandbox;
      },
      async get(id: string) {
        world.record("sandboxes.get", id);
        const sandbox = world.sandboxes.get(id);
        if (!sandbox) throw notFound("not_found", `Sandbox ${id} was not found.`);
        return sandbox;
      },
      async list(filter: { state?: string[]; labels?: Record<string, string>; limit?: number }) {
        world.record("sandboxes.list", filter);
        const all = [...world.sandboxes.values()].filter(
          (one) =>
            (!filter.state || filter.state.includes(one.state)) &&
            Object.entries(filter.labels ?? {}).every(([k, v]) => one.info.labels[k] === v),
        );
        return page(all, filter.limit ?? 50);
      },
    };
    const images = {
      async get(id: string) {
        world.record("images.get", id);
        const image = world.images.find((one) => one.id === id);
        if (!image) throw notFound("not_found", `Image ${id} was not found.`);
        return image;
      },
      async list(query: { name?: string; state?: string }) {
        world.record("images.list", query);
        return page(
          world.images.filter(
            (one) =>
              (!query.name || one.name === query.name) &&
              (!query.state || one.state === query.state),
          ),
          50,
        );
      },
    };
    const snapshots = {
      async delete(id: string) {
        world.record("snapshots.delete", id);
        if (!world.snapshots.delete(id)) throw notFound("not_found", "No such snapshot.");
      },
    };
    return { sandboxes, images, snapshots } as unknown as Runtime;
  }
}

function page<T>(items: T[], size: number) {
  const make = (
    from: number,
  ): {
    data: T[];
    nextCursor: string | null;
    hasMore: boolean;
    next(): Promise<unknown>;
  } => {
    const data = items.slice(from, from + size);
    const more = from + size < items.length;
    return {
      data,
      nextCursor: more ? String(from + size) : null,
      hasMore: more,
      next: async () => (more ? make(from + size) : null),
    };
  };
  return make(0);
}

export function notFound(code: string, message: string) {
  return new NotFoundError({
    message,
    code,
    status: 404,
    requestId: "req_1",
    hint: "Check the id.",
  });
}
function unavailable() {
  return new ServiceUnavailableError({
    message: "Forks are paused while we fix an issue; your sandbox is unaffected.",
    code: "fork_unavailable",
    status: 503,
    hint: "Build a custom image (runtime image build) and create each sandbox from it.",
  });
}

export class FakeProcess {
  readonly info: Record<string, unknown> & { stdinOpen: boolean; outputBytes: number };
  readonly written: string[] = [];
  killed: string | undefined;
  constructor(
    private readonly world: FakeWorld,
    readonly id: string,
    readonly command: string,
    stdinOpen: boolean,
    private readonly events: OutputEvent[],
  ) {
    this.info = {
      id,
      kind: "process",
      state: "running",
      exitCode: null,
      command,
      cwd: "/workspace",
      pty: false,
      stdinOpen,
      stdinOffset: 0,
      outputBytes: 0,
    };
  }
  async *output(options: { cursor?: number; signal?: AbortSignal } = {}) {
    this.world.record("process.output", this.id, options.cursor ?? 0);
    for (const event of this.events) {
      await Promise.resolve();
      if (options.signal?.aborted) return;
      yield event;
      if (event.type === "exit") this.info.state = "exited";
    }
  }
  async write(data: string | Uint8Array, options: { eof?: boolean } = {}) {
    this.world.record("process.write", this.id, data, options);
    this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
  }
  async kill(signal: string) {
    this.world.record("process.kill", this.id, signal);
    this.killed = signal;
    this.info.state = "killed";
  }
}

export class FakeSandbox {
  readonly id: string;
  info: Record<string, unknown> & {
    id: string;
    state: string;
    labels: Record<string, string>;
    expiresAt: string;
  };
  readonly fileMap = new Map<string, Uint8Array>();
  watchEvents: { type: string; path: string; isDir: boolean }[] = [];
  readonly processList: FakeProcess[] = [];
  readonly contexts = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly world: FakeWorld,
    id: string,
    input: Record<string, unknown>,
  ) {
    this.id = id;
    this.info = {
      id,
      kind: "sandbox",
      name: null,
      labels: (input.labels as Record<string, string>) ?? {},
      state: "running",
      funding: "trial",
      vcpu: input.vcpu ?? 2,
      memoryMiB: input.memoryMiB ?? 4096,
      onLeaseEnd: input.onLeaseEnd ?? "pause",
      createdAt: new Date(1_800_000_000_000).toISOString(),
      expiresAt: new Date(
        Date.now() + ((input.timeoutSeconds as number) ?? 1800) * 1000,
      ).toISOString(),
      ...(input.image ? { image: input.image } : {}),
      ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    };
  }
  get state() {
    return this.info.state;
  }
  get files() {
    const sandbox = this;
    const world = this.world;
    const missing = (path: string) => notFound("file_not_found", `${path} does not exist.`);
    return {
      async read(path: string) {
        world.record("files.read", path);
        const bytes = sandbox.fileMap.get(path);
        if (!bytes) throw missing(path);
        return bytes;
      },
      async readStream(path: string) {
        world.record("files.readStream", path);
        const bytes = sandbox.fileMap.get(path);
        if (!bytes) throw missing(path);
        return new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();
      },
      async download(path: string, localPath: string) {
        world.record("files.download", path, localPath);
        const bytes = sandbox.fileMap.get(path);
        if (!bytes) throw missing(path);
        const fs = await import("node:fs/promises");
        const paths = await import("node:path");
        await fs.mkdir(paths.dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, bytes);
      },
      async write(path: string, data: string | Uint8Array) {
        world.record("files.write", path);
        sandbox.fileMap.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
        return { path, size: data.length };
      },
      async list(path: string, options: Record<string, unknown>) {
        world.record("files.list", path, options);
        return [...sandbox.fileMap.entries()]
          .filter(([file]) => file.startsWith(`${path}/`))
          .map(([file, bytes]) => ({
            name: file.slice(path.length + 1),
            path: file,
            type: "file",
            size: bytes.length,
            mode: "0644",
            modifiedAt: "2026-09-23T00:00:00.000Z",
          }));
      },
      async stat(path: string) {
        world.record("files.stat", path);
        const bytes = sandbox.fileMap.get(path);
        if (bytes)
          return {
            exists: true,
            name: path.split("/").pop(),
            path,
            type: "file",
            size: bytes.length,
            mode: "0755",
            modifiedAt: "2026-09-23T00:00:00.000Z",
          };
        const dir = [...sandbox.fileMap.keys()].some((file) => file.startsWith(`${path}/`));
        return dir
          ? {
              exists: true,
              name: path.split("/").pop(),
              path,
              type: "directory",
              size: 0,
              mode: "0755",
              modifiedAt: "2026-09-23T00:00:00.000Z",
            }
          : { exists: false, path };
      },
      async exists(path: string) {
        world.record("files.exists", path);
        return (
          sandbox.fileMap.has(path) ||
          [...sandbox.fileMap.keys()].some((file) => file.startsWith(`${path}/`))
        );
      },
      async mkdir(path: string, options: unknown) {
        world.record("files.mkdir", path, options);
        sandbox.fileMap.set(`${path}/.keep`, new Uint8Array());
      },
      async remove(path: string, options: unknown) {
        world.record("files.remove", path, options);
        let removed = false;
        for (const file of [...sandbox.fileMap.keys()])
          if (file === path || file.startsWith(`${path}/`)) {
            sandbox.fileMap.delete(file);
            removed = true;
          }
        return removed;
      },
      async rename(from: string, to: string, options: unknown) {
        world.record("files.rename", from, to, options);
        const bytes = sandbox.fileMap.get(from);
        if (!bytes) throw missing(from);
        sandbox.fileMap.delete(from);
        sandbox.fileMap.set(to, bytes);
      },
      /** Delivers the events the test put in `watchEvents`, then waits for stop. */
      async watch(
        path: string,
        onEvent: (event: { type: string; path: string; isDir: boolean }) => void,
        options: { onExit?: (reason: string) => void } & Record<string, unknown>,
      ) {
        world.record("files.watch", path, { ...options, onExit: undefined });
        for (const event of sandbox.watchEvents) onEvent(event);
        return {
          stop: async () => {
            world.record("files.watch.stop", path);
          },
        };
      },
    };
  }
  get processes() {
    const sandbox = this;
    const world = this.world;
    return {
      async list() {
        world.record("processes.list");
        return sandbox.processList.map((one) => one.info);
      },
      async get(id: string) {
        world.record("processes.get", id);
        const found = sandbox.processList.find((one) => one.id === id);
        if (!found) throw notFound("not_found", "No such process.");
        return found;
      },
    };
  }
  get previews() {
    const world = this.world;
    const id = this.id;
    return {
      async create(port: number, input: unknown) {
        world.record("previews.create", port, input);
        // As the API names it: the id without dashes.
        return { url: `https://${port}-${id.replaceAll("-", "")}.runtimehost.com/`, token: null };
      },
    };
  }
  get interpreter() {
    const sandbox = this;
    const world = this.world;
    return {
      async run(code: string, options: Record<string, unknown>) {
        world.record("interpreter.run", code, options);
        const execution = world.interpreter(code, options);
        if (typeof options.onStdout === "function")
          await (options.onStdout as (text: string) => unknown)(execution.stdout as string);
        if (typeof options.onResult === "function")
          for (const result of execution.results as unknown[]) await options.onResult(result);
        return execution;
      },
      async result(ref: { path: string }) {
        world.record("interpreter.result", ref.path);
        return new TextEncoder().encode(`bytes of ${ref.path}`);
      },
      contexts: {
        async create(input: Record<string, unknown>) {
          world.record("contexts.create", input);
          const id = (input.id as string) ?? `ctx-${sandbox.contexts.size + 1}`;
          if (sandbox.contexts.has(id))
            throw new RuntimeError({ message: "exists", code: "conflict", status: 409 });
          const made = {
            id,
            language: input.language ?? "python",
            cwd: input.cwd ?? "/workspace",
            processId: "p",
            state: "idle",
            startedAt: 0,
          };
          sandbox.contexts.set(id, made);
          return made;
        },
        async list() {
          world.record("contexts.list");
          return [...sandbox.contexts.values()];
        },
        async remove(id: string) {
          world.record("contexts.remove", id);
          return { deleted: sandbox.contexts.delete(id) };
        },
        async restart(id: string) {
          world.record("contexts.restart", id);
          return sandbox.contexts.get(id);
        },
      },
    };
  }
  async refresh() {
    this.world.record("sandbox.refresh", this.id);
    return this;
  }
  async exec(command: string, options: Record<string, unknown> = {}) {
    this.world.record("sandbox.exec", command, options);
    const answer = this.world.exec(command, options);
    /* As the SDK's exec: without an output callback, and at most a minute
       long, it is one request whose result holds at most 64 KiB of each
       stream; otherwise it streams and holds all of it. */
    const streamed =
      typeof options.onStdout === "function" ||
      typeof options.onStderr === "function" ||
      Number(options.timeoutMs ?? 0) > 60_000;
    const capped = (text: string) => (streamed ? text : text.slice(0, EXEC_RESULT_BYTES));
    const result = {
      exitCode: answer.exitCode,
      stdout: capped(answer.stdout ?? ""),
      stderr: capped(answer.stderr ?? ""),
      timedOut: answer.timedOut ?? false,
      stdoutTruncated:
        (streamed && answer.lost === true) ||
        (!streamed && (answer.stdout ?? "").length > EXEC_RESULT_BYTES),
      stderrTruncated:
        (streamed && answer.lost === true) ||
        (!streamed && (answer.stderr ?? "").length > EXEC_RESULT_BYTES),
    };
    if (typeof options.onStdout === "function" && result.stdout)
      (options.onStdout as (text: string) => void)(result.stdout);
    if (typeof options.onStderr === "function" && result.stderr)
      (options.onStderr as (text: string) => void)(result.stderr);
    return result;
  }
  async spawn(command: string, options: Record<string, unknown>) {
    this.world.record("sandbox.spawn", command, options);
    const process = new FakeProcess(
      this.world,
      `proc-${this.processList.length + 1}`,
      command,
      options.stdin === "pipe",
      this.world.output(command, options),
    );
    this.processList.push(process);
    return process;
  }
  async stop(options: unknown) {
    this.world.record("sandbox.stop", this.id, options);
    this.info.state = "stopped";
    return this;
  }
  async pause(options: unknown) {
    this.world.record("sandbox.pause", this.id, options);
    this.info.state = "paused";
    return this;
  }
  async wake(options: unknown) {
    this.world.record("sandbox.wake", this.id, options);
    this.info.state = "running";
    return this;
  }
  async extend(seconds: number) {
    this.world.record("sandbox.extend", this.id, seconds);
    this.info.expiresAt = new Date(Date.parse(this.info.expiresAt) + seconds * 1000).toISOString();
    return this;
  }
  async fork(options: { count?: number }) {
    this.world.record("sandbox.fork", this.id, options);
    if (!this.world.forksEnabled) throw unavailable();
    return Array.from({ length: options.count ?? 1 }, () => {
      const copy = new FakeSandbox(this.world, this.world.id(), {});
      this.world.sandboxes.set(copy.id, copy);
      return copy;
    });
  }
  async snapshot(options: { name?: string }) {
    this.world.record("sandbox.snapshot", this.id, options);
    if (!this.world.forksEnabled) throw unavailable();
    const id = this.world.id();
    this.world.snapshots.add(id);
    return { id, name: options.name ?? null };
  }
}
