/* eslint-disable @typescript-eslint/no-this-alias -- the fake's modules close over their world. */
/* eslint-disable @typescript-eslint/unbound-method -- getters are taken off the prototype and called with their sandbox. */
import { ConflictError, RuntimeError, type Runtime } from "../../src/index";
import { DropInWorld, page } from "../drop-in-fake";
import { FakeProcess, FakeSandbox, notFound } from "../e2b/fake";

/* The drop-in fake, plus what the Blaxel adapter also calls: sandbox
   settings (update), streamed exec, following a process's output, previews by
   port with tokens, snapshots by sandbox and name, getOrCreate by name, and
   funding. Every change applies only to a sandbox of a BlaxelWorld: any other
   sandbox gets the drop-in fake's own behaviour, so nothing the other
   adapters' tests rely on changes, even in one process. */

const proto = FakeSandbox.prototype as unknown as Record<string, unknown>;
const worldOf = (sandbox: FakeSandbox) => (sandbox as unknown as { world: BlaxelWorld }).world;
const ours = (sandbox: FakeSandbox) => worldOf(sandbox) instanceof BlaxelWorld;
const original = {
  waitFor: proto.waitFor as (this: FakeSandbox, ...args: unknown[]) => Promise<unknown>,
  fork: proto.fork as (this: FakeSandbox, ...args: unknown[]) => Promise<unknown>,
};
type Event = { type: string; [key: string]: unknown };

/** A process as Runtime lists it. One whose events end in an exit, in a
 * world without delays, has ended by the time anyone reads it. */
function stamp(process: FakeProcess, command: string, world: BlaxelWorld) {
  const events = (process as unknown as { events: Event[] }).events;
  const last = events.at(-1);
  const done = world.delayMs === 0 && last?.type === "exit";
  Object.assign(process.info, {
    startedAt: new Date().toISOString(),
    endedAt: null,
    outputBytes: events
      .filter((event) => event.type === "stdout" || event.type === "stderr")
      .reduce((sum, event) => sum + Buffer.byteLength(event.data as string), 0),
    firstOffset: 0,
    timeoutMs: null,
    command,
  });
  // It runs as soon as it starts: the spawn answers it running, a later read ended.
  if (done)
    setTimeout(() => {
      if (process.info.state === "running")
        Object.assign(process.info, {
          state: last.state,
          exitCode: last.exitCode,
          endedAt: new Date().toISOString(),
        });
    }, 0);
}

proto.waitFor = async function (this: FakeSandbox, state: string) {
  if (!ours(this)) return original.waitFor.call(this, state);
  worldOf(this).record("sandbox.waitFor", this.id, state);
  this.info.state = state;
  return this;
};

// A signal ends a process as Runtime records it: SIGTERM exits -15, SIGKILL
// is killed -9.
const processProto = FakeProcess.prototype as unknown as Record<string, unknown>;
const kill = processProto.kill as (this: FakeProcess, signal: string) => Promise<void>;
processProto.kill = async function (this: FakeProcess, signal: string) {
  await kill.call(this, signal);
  if (!((this as unknown as { world: unknown }).world instanceof BlaxelWorld)) return;
  const code = signal === "SIGKILL" ? -9 : -15;
  Object.assign(this.info, {
    state: signal === "SIGKILL" ? "killed" : "exited",
    exitCode: code,
    endedAt: new Date().toISOString(),
  });
  const events = (this as unknown as { events: Event[] }).events;
  events.splice(0, events.length, {
    type: "exit",
    exitCode: code,
    state: this.info.state,
    timedOut: false,
  });
};

proto.update = async function (this: FakeSandbox, settings: Record<string, unknown>) {
  worldOf(this).record("sandbox.update", this.id, settings);
  Object.assign(this.info, settings);
  return this;
};

proto.execStream = async function* (
  this: FakeSandbox,
  command: string,
  options: Record<string, unknown> = {},
) {
  const world = worldOf(this);
  world.record("sandbox.execStream", command, { ...options, signal: undefined });
  if (world.refuse) {
    const error = world.refuse;
    world.refuse = undefined;
    throw error;
  }
  const events = world.output(command) as Event[];
  const process = new FakeProcess(
    world,
    `proc-${this.processList.length + 1}`,
    command,
    false,
    events as never,
  );
  Object.assign(process.info, {
    startedAt: new Date().toISOString(),
    endedAt: null,
    outputBytes: 0,
    firstOffset: 0,
    command,
  });
  this.processList.push(process);
  yield { type: "start", processId: process.id };
  let offset = 0;
  for (const event of events) {
    await new Promise((resolve) => setTimeout(resolve, world.delayMs));
    if ((options.signal as AbortSignal | undefined)?.aborted)
      throw new DOMException("aborted", "AbortError");
    if (event.type === "stdout" || event.type === "stderr") {
      yield { ...event, offset };
      offset += Buffer.byteLength(event.data as string);
      process.info.outputBytes = offset;
    } else {
      if (event.type === "exit") {
        process.info.state = event.state;
        process.info.exitCode = event.exitCode;
        process.info.endedAt = new Date().toISOString();
      }
      yield event;
    }
  }
};

const spawn = proto.spawn as (
  this: FakeSandbox,
  command: string,
  options: Record<string, unknown>,
) => Promise<FakeProcess>;
proto.spawn = async function (
  this: FakeSandbox,
  command: string,
  options: Record<string, unknown>,
) {
  const world = worldOf(this);
  if (!ours(this)) return spawn.call(this, command, options);
  if (world.refuse) {
    const error = world.refuse;
    world.refuse = undefined;
    world.record("sandbox.spawn.refused", command);
    throw error;
  }
  const process = await spawn.call(this, command, options);
  stamp(process, command, world);
  return process;
};

const processes = Object.getOwnPropertyDescriptor(FakeSandbox.prototype, "processes")!.get!;
Object.defineProperty(FakeSandbox.prototype, "processes", {
  configurable: true,
  get(this: FakeSandbox) {
    if (!ours(this)) return processes.call(this);
    const world = worldOf(this);
    const sandbox = this;
    const base = processes.call(this) as Record<string, unknown>;
    return {
      ...base,
      async *follow(id: string, options: { cursor?: number; signal?: AbortSignal } = {}) {
        world.record("processes.follow", id, options.cursor ?? 0);
        const found = sandbox.processList.find((one) => one.id === id);
        if (!found) throw notFound("not_found", "No such process.");
        const events = (found as unknown as { events: Event[] }).events;
        let offset = 0;
        for (const event of events) {
          await new Promise((resolve) => setTimeout(resolve, world.delayMs));
          if (options.signal?.aborted) return;
          if (event.type === "stdout" || event.type === "stderr") {
            yield { ...event, offset };
            offset += Buffer.byteLength(event.data as string);
          } else {
            if (event.type === "exit") {
              found.info.state = event.state;
              found.info.exitCode = event.exitCode;
              found.info.endedAt ??= new Date().toISOString();
            }
            yield event;
          }
        }
      },
    };
  },
});

const previews = Object.getOwnPropertyDescriptor(FakeSandbox.prototype, "previews")!.get!;
Object.defineProperty(FakeSandbox.prototype, "previews", {
  configurable: true,
  get(this: FakeSandbox) {
    if (!ours(this)) return previews.call(this);
    const world = worldOf(this);
    const shared = world.previewsOf(this.id);
    const id = this.id;
    const view = (port: number, visibility: string, ttl?: number) => ({
      id: `pv-${port}`,
      sandboxId: id,
      port,
      visibility,
      url: `https://${port}-${id.replaceAll("-", "")}.runtimehost.com/`,
      token: visibility === "private" ? `tok-${port}-${ttl ?? 86400}` : null,
      tokenExpiresAt:
        visibility === "private"
          ? new Date(Date.now() + (ttl ?? 86400) * 1000).toISOString()
          : null,
      urlWithToken: null,
      disabled: false,
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    return {
      ...(previews.call(this) as object),
      async create(port: number, input: { visibility?: string; ttlSeconds?: number } = {}) {
        world.record("previews.create", port, input);
        const visibility = input.visibility ?? "private";
        shared.set(port, visibility);
        return view(port, visibility, input.ttlSeconds);
      },
      async list() {
        world.record("previews.list");
        return [...shared].map(([port, visibility]) => view(port, visibility));
      },
      async get(port: number, ttlSeconds?: number) {
        world.record("previews.get", port, ttlSeconds);
        const visibility = shared.get(port);
        if (!visibility) throw notFound("not_found", "Not shared.");
        return view(port, visibility, ttlSeconds);
      },
      async rotate(port: number) {
        world.record("previews.rotate", port);
        return view(port, shared.get(port) ?? "private");
      },
      async delete(port: number) {
        world.record("previews.delete", port);
        shared.delete(port);
        return { deleted: true };
      },
    };
  },
});

const snapshot = proto.snapshot as (
  this: FakeSandbox,
  options: Record<string, unknown>,
) => Promise<{ id: string }>;
proto.snapshot = async function (this: FakeSandbox, options: Record<string, unknown> = {}) {
  const taken = await snapshot.call(this, options);
  if (!ours(this)) return taken;
  const world = worldOf(this);
  const made = {
    id: taken.id,
    kind: "snapshot",
    state: "ready",
    name: (options.name as string) ?? null,
    sourceSandboxId: this.id,
    labels: options.labels,
    shape: { vcpu: 2, memoryMiB: 4096, diskMiB: 4096, memoryGuarantee: "full" },
    createdAt: "2026-09-27T00:00:00.000Z",
    readyAt: "2026-09-27T00:00:01.000Z",
    expiresAt: "2027-09-27T00:00:00.000Z",
  };
  world.snapshotList.push(made);
  return made;
};

proto.fork = async function (this: FakeSandbox, options: Record<string, unknown> = {}) {
  if (!ours(this)) return original.fork.call(this, options);
  const world = worldOf(this);
  world.record("sandbox.fork", this.id, options);
  const copy = new FakeSandbox(world, world.id(), { labels: options.labels ?? this.info.labels });
  copy.info.name = options.name ?? null;
  copy.info.funding = this.info.funding;
  world.sandboxes.set(copy.id, copy);
  return copy;
};

const files = Object.getOwnPropertyDescriptor(FakeSandbox.prototype, "files")!.get!;
Object.defineProperty(FakeSandbox.prototype, "files", {
  configurable: true,
  get(this: FakeSandbox) {
    if (!ours(this)) return files.call(this);
    const base = files.call(this) as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const world = worldOf(this);
    return {
      ...base,
      async read(path: string) {
        if (world.unreadable.some((prefix) => path.startsWith(prefix))) {
          world.record("files.read.denied", path);
          throw new RuntimeError({ message: "denied", code: "permission_denied", status: 403 });
        }
        return base.read!(path);
      },
      async readText(path: string) {
        return new TextDecoder().decode((await base.read!(path)) as Uint8Array);
      },
      async write(path: string, data: string | Uint8Array) {
        if (world.noParent.some((prefix) => path.startsWith(prefix))) {
          world.record("files.write.missing", path);
          throw notFound("file_not_found", `No such file or directory. Path: ${path}.`);
        }
        if (world.readOnly.some((prefix) => path.startsWith(prefix))) {
          world.record("files.write.denied", path);
          throw new RuntimeError({ message: "denied", code: "permission_denied", status: 403 });
        }
        return base.write!(path, data);
      },
    };
  },
});

/** The drop-in world, with what the Blaxel adapter needs. */
export class BlaxelWorld extends DropInWorld {
  readonly snapshotList: Array<
    Record<string, unknown> & { id: string; sourceSandboxId: string; name: string | null }
  > = [];
  readonly shared = new Map<string, Map<number, string>>();
  /** Paths under which files.write is refused, as outside /workspace. */
  readOnly: string[] = [];
  /** Paths files.read refuses, as a file only root may read. */
  unreadable: string[] = [];
  /** Paths under which files.write finds no parent directory, as outside /workspace. */
  noParent: string[] = [];
  /** Delay between a stream's events, so tests can cut one off. */
  delayMs = 0;
  /** A refusal the next exec stream or spawn meets (then cleared). */
  refuse: RuntimeError | undefined;

  previewsOf(sandboxId: string) {
    let map = this.shared.get(sandboxId);
    if (!map) this.shared.set(sandboxId, (map = new Map()));
    return map;
  }

  override client(): Runtime {
    const base = super.client() as unknown as Record<string, Record<string, unknown>>;
    const world = this;
    const sandboxes = base.sandboxes!;
    const create = sandboxes.create as (
      input: Record<string, unknown>,
      options: unknown,
    ) => Promise<FakeSandbox>;
    // Runtime settles a name atomically: a create that names a name being
    // created waits for that create, as the server's row lock does.
    const creating = new Map<string, Promise<unknown>>();
    sandboxes.create = async (input: Record<string, unknown>, options: unknown) => {
      const name = input.name as string | undefined;
      while (name !== undefined && creating.has(name))
        await creating.get(name)!.catch(() => undefined);
      const work = createOne(input, options);
      if (name !== undefined) creating.set(name, work);
      try {
        return await work;
      } finally {
        if (name !== undefined && creating.get(name) === work) creating.delete(name);
      }
    };
    const createOne = async (input: Record<string, unknown>, options: unknown) => {
      const holder =
        input.name === undefined
          ? undefined
          : [...world.sandboxes.values()].find(
              (one) => one.info.name === input.name && one.state !== "stopped",
            );
      if (holder && input.getOrCreate) {
        world.record("sandboxes.create", input, options);
        holder.info.reused = true;
        return holder;
      }
      if (holder)
        throw new ConflictError({
          message: `The name ${String(input.name)} is taken.`,
          code: "name_taken",
          status: 409,
          details: { field: "name", sandboxId: holder.id, state: holder.state },
        });
      const made = await create(input, options);
      made.info.funding = input.funding ?? "trial";
      made.info.idlePauseSeconds = input.idlePauseSeconds;
      made.info.autoWake = input.autoWake;
      made.info.reused = false;
      return made;
    };
    const snapshots = base.snapshots!;
    snapshots.list = async (filter: { sandboxId?: string; name?: string; limit?: number } = {}) => {
      world.record("snapshots.list", filter);
      return page(
        world.snapshotList.filter(
          (one) =>
            (filter.sandboxId === undefined || one.sourceSandboxId === filter.sandboxId) &&
            (filter.name === undefined || one.name === filter.name),
        ),
        filter.limit ?? 50,
      );
    };
    snapshots.get = async (id: string) => {
      world.record("snapshots.get", id);
      const found = world.snapshotList.find((one) => one.id === id);
      if (!found) throw notFound("not_found", "No such snapshot.");
      return found;
    };
    snapshots.delete = async (id: string) => {
      world.record("snapshots.delete", id);
      const at = world.snapshotList.findIndex((one) => one.id === id);
      if (at < 0) throw notFound("not_found", "No such snapshot.");
      world.snapshotList.splice(at, 1);
    };
    return base as unknown as Runtime;
  }
}

/** Calls to Runtime that one adapter call made, by method. */
export function requests(world: BlaxelWorld, from: number): string[] {
  return world.calls.slice(from).map(([method]) => method);
}
