/* The machine engine's client (CLOUD.md section 2, engines/machine/ENGINE.md):
   what every product that runs code shares, written once. A product is a
   setting of the engine, here the path the API serves it under, and its own
   class adds what only it does: `Sandbox` extends `Machine` with commands,
   files and processes, and `Sandboxes` extends `Machines`. Sandboxes are the
   only machine product today; a second one is a new subclass, not a copy.
   Nothing here is exported from the package: its public surface is the
   product classes. */
import { KEEP_ALIVE_MARGIN_SECONDS, WAIT_FOR_TIMEOUT_SECONDS } from "./api-defaults.js";
import { RuntimeError } from "./errors.js";
import { Page } from "./page.js";
import type { Snapshot, SnapshotOptions } from "./snapshots.js";
import type { Query, RequestOptions, Transport } from "./transport.js";
import type { KeepAliveOptions } from "./types.js";

/** How long snapshot() waits, pause and capture together, unless told. */
const SNAPSHOT_DEADLINE_MS = 10 * 60_000;
const enc = (id: string) => encodeURIComponent(id);

/** One machine product: the API serves it at /v1/<plural>, and its errors
 * call one of it by `noun`. */
export type MachineProduct = { readonly plural: string; readonly noun: string };

/** What every machine's record carries for the verbs shared here. */
export type MachineState =
  "starting" | "running" | "pausing" | "paused" | "resuming" | "stopping" | "stopped";
export type MachineInfo = {
  id: string;
  state: MachineState;
  expiresAt: string;
  endsAt?: string | null;
  start?: unknown;
};

/** Any other call's request options, as the caller gave them: `timeoutMs` is
 * the call's whole deadline, and 0 turns it off. */
export function requestOnly(options: RequestOptions): RequestOptions {
  return {
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

/** DELETE /v1/<plural>/{id}, for `machine.delete()` and the product's
 * `delete(id)`. */
export function deleteMachine<Deleted>(
  product: MachineProduct,
  t: Transport,
  id: string,
  options: RequestOptions = {},
): Promise<Deleted> {
  return t.json<Deleted>({
    method: "DELETE",
    path: `/v1/${product.plural}/${enc(id)}`,
    ...options,
  });
}

/** One page of a product's list, and the pages after it. */
export function machinePage<M, Info>(
  product: MachineProduct,
  t: Transport,
  wrap: (t: Transport, info: Info) => M,
  body: { data: Info[]; nextCursor: string | null },
  query: Record<string, unknown>,
  options: RequestOptions = {},
): Page<M> {
  return new Page(
    body.data.map((info) => wrap(t, info)),
    body.nextCursor,
    async (cursor) =>
      machinePage(
        product,
        t,
        wrap,
        await t.json({
          method: "GET",
          path: `/v1/${product.plural}`,
          query: Object.assign({}, query, { cursor }) as Query,
          ...options,
        }),
        query,
        options,
      ),
  );
}

/** One machine: its record and the verbs every machine product shares. */
export abstract class Machine<
  Info extends MachineInfo,
  Settings extends object,
  Deleted,
> implements AsyncDisposable {
  #info: Info;
  #keepAlive: (() => void) | undefined;
  readonly #t: Transport;
  readonly #product: MachineProduct;
  constructor(product: MachineProduct, transport: Transport, info: Info) {
    this.#product = product;
    this.#t = transport;
    this.#info = info;
  }
  get id(): string {
    return this.#info.id;
  }
  /** The API's latest answer. `start`, the report of an image's start
   * command, is the create's alone: the API keeps no record of it, so a
   * later read of this sandbox keeps it here. */
  #keep(info: Info): void {
    const start = this.#info?.start;
    this.#info = info.start === undefined && start !== undefined ? { ...info, start } : info;
  }
  #path(suffix = ""): string {
    return `/v1/${this.#product.plural}/${enc(this.id)}${suffix}`;
  }
  /** What the API last said about this sandbox. `refresh()` asks again. */
  get info(): Info {
    return this.#info;
  }
  get state(): Info["state"] {
    return this.#info.state;
  }
  async refresh(options: RequestOptions = {}): Promise<this> {
    this.#keep(
      await this.#t.json<Info>({
        method: "GET",
        path: this.#path(),
        ...options,
      }),
    );
    return this;
  }
  /** Waits (server-side, no polling) until the sandbox reaches `state`. */
  async waitFor(
    state: "running" | "paused" | "stopped",
    options: { timeoutSeconds?: number } & RequestOptions = {},
  ) {
    this.#keep(
      await this.#t.json<Info>({
        method: "GET",
        path: this.#path(),
        query: {
          waitFor: state,
          timeoutSeconds: options.timeoutSeconds ?? WAIT_FOR_TIMEOUT_SECONDS,
        },
        ...options,
      }),
    );
    return this;
  }
  async stop(options: RequestOptions & { wait?: boolean } = {}): Promise<this> {
    this.#keepAlive?.();
    return this.#lifecycle("stop", options);
  }
  async pause(options: RequestOptions & { wait?: boolean } = {}): Promise<this> {
    return this.#lifecycle("pause", options);
  }
  /** Deletes it for good: stops it if it runs or is paused, deletes its disk
   * and paused memory, revokes its previews and ports, and removes it from
   * lists. Its snapshots, usage and audit entries stay. Deleting it again
   * answers the same. */
  async delete(options: RequestOptions = {}): Promise<Deleted> {
    this.#keepAlive?.();
    return deleteMachine<Deleted>(this.#product, this.#t, this.id, options);
  }
  /** Carries on a paused sandbox; for one with a time limit,
   * `timeoutSeconds` is its new one. */
  async wake(
    options: RequestOptions & { wait?: boolean; timeoutSeconds?: number } = {},
  ): Promise<this> {
    const { timeoutSeconds, ...rest } = options;
    try {
      return await this.#lifecycle(
        "wake",
        rest,
        timeoutSeconds === undefined ? {} : { timeoutSeconds },
      );
    } catch (error) {
      // Waking one that is already awake is done, not a mistake. With a new
      // lease asked for, the refusal stands: it was not given.
      if (!(error instanceof RuntimeError) || error.code !== "not_paused" || timeoutSeconds)
        throw error;
      await this.refresh(requestOnly(rest));
      if (this.state !== "running" && this.state !== "starting") throw error;
      return this;
    }
  }
  /** More time before its time limit ends (at most an hour ahead of now). A
   * sandbox with no time limit needs none: the call answers at once and
   * changes nothing. */
  async extend(seconds: number, options: RequestOptions = {}): Promise<this> {
    return this.#lifecycle("extend", { ...options, wait: false }, { seconds });
  }
  /** Changes its name, labels, automatic wake, idle pause or persistence;
   * fields left out stay as they are. `persistent: true` keeps it running
   * while credit lasts (paid only). */
  async update(settings: Settings, options: RequestOptions = {}): Promise<this> {
    return this.#lifecycle("update", { ...options, wait: false }, { ...settings } as Record<
      string,
      unknown
    >);
  }
  /** Moves it to another image (id, name, name:tag or name@version), keeping
   * its id, /workspace (its home: dotfiles, pip --user and npm -g installs),
   * volumes, environment, name and previews. Its processes restart, and
   * everything else on its old disk (sudo installs, apt packages, /etc) is
   * lost; snapshot it first to keep everything. A running sandbox is paused
   * first. A switch that fails is undone (`switch_undone`), the sandbox on
   * its old image with nothing lost. Charged as a wake. `keep` is optional:
   * "workspace" is the only value, and it is sent either way, so an API from
   * before it was optional accepts the call too. */
  async switchImage(
    image: string,
    options: RequestOptions & { keep?: "workspace" } = {},
  ): Promise<this> {
    const { keep = "workspace", ...rest } = options;
    this.#keep(
      await this.#t.json<Info>({
        method: "POST",
        path: this.#path(":switch-image"),
        body: { image, keep },
        // A pause, two boots and the copy between them.
        wait: 120,
        ...requestOnly(rest),
      }),
    );
    return this;
  }
  /** Gives it more or fewer vCPUs or more or less memory by a restart: its id,
   * whole disk, volumes, environment, name and previews stay, and its
   * programs stop (snapshot it first to keep its memory too). A running sandbox is paused, or stopped if it is
   * persistent, and comes back running at the new size on the same server; a
   * paused or stopped one is started. Memory bills on the new size from then.
   * Refused, with nothing changed, when the server has no room
   * (`no_capacity`), above your quota or the 2 vCPU and 4 GiB without credit, or
   * while a snapshot or fork of it is being taken. `restart` is optional:
   * true is the only value, and it is sent either way, so an API from before
   * it was optional accepts the call too. */
  async resize(
    size: { vcpu?: number; memoryMiB?: number },
    options: RequestOptions & { restart?: true } = {},
  ): Promise<this> {
    const { restart = true, ...rest } = options;
    this.#keep(
      await this.#t.json<Info>({
        method: "POST",
        path: this.#path(":resize"),
        body: { ...size, restart },
        // A pause or stop and a cold boot.
        wait: 120,
        ...requestOnly(rest),
      }),
    );
    return this;
  }
  /** Keeps a sandbox with a time limit running past it, in the background,
   * until stop() or the returned function ends it: every `everySeconds` (60)
   * it extends the limit so that `marginSeconds` (600) remain, never more
   * than the hour ahead the API allows. A sandbox with no time limit
   * (`endsAt` null) needs none, and is only watched. Running time is billed
   * as it is used. A paused sandbox is left paused (a request wakes it,
   * unless autoWake is off); a stopped one ends the loop. It does not keep a
   * Node or Bun process alive by itself. */
  keepAlive(options: KeepAliveOptions = {}): () => void {
    this.#keepAlive?.();
    const every = Math.max(10, options.everySeconds ?? 60) * 1000;
    const margin = Math.min(3600, Math.max(60, options.marginSeconds ?? KEEP_ALIVE_MARGIN_SECONDS));
    let ended = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = () => {
      ended = true;
      if (timer) clearTimeout(timer);
      if (this.#keepAlive === end) this.#keepAlive = undefined;
    };
    const tick = async () => {
      if (ended) return;
      try {
        await this.refresh();
        if (this.state === "stopped" || this.state === "stopping") return end();
        // No time limit: nothing to extend (an older server sends no endsAt).
        if (this.state === "running" && this.info.endsAt !== null) {
          const left = (Date.parse(this.info.endsAt ?? this.info.expiresAt) - Date.now()) / 1000;
          const need = Math.ceil(margin - left);
          if (need >= 1) await this.extend(Math.min(3600, need));
        }
      } catch (error) {
        options.onError?.(error);
      }
      if (ended) return;
      timer = setTimeout(() => void tick(), every);
      (timer as { unref?: () => void }).unref?.();
    };
    this.#keepAlive = end;
    void tick();
    return end;
  }
  /** Days a paused sandbox is kept before deletion (1 to 365). */
  async setRetention(days: number, options: RequestOptions = {}): Promise<this> {
    return this.#lifecycle("retention", { ...options, wait: false }, { days });
  }
  /** Keeps this sandbox's whole machine (files, memory, running processes) as
   * a snapshot to start new sandboxes from. A running sandbox is paused for
   * the moment it takes, then woken; a paused one stays paused. Past
   * `timeoutMs` (ten minutes unless given) mid-capture, it stays paused and
   * the error names the snapshot. */
  async snapshot(options: SnapshotOptions & RequestOptions = {}): Promise<Snapshot> {
    const { idempotencyKey, signal, timeoutMs, ...body } = options;
    if (body.mode !== undefined && body.mode !== "memory" && body.mode !== "disk")
      throw new TypeError("Snapshot mode must be memory or disk.");
    signal?.throwIfAborted();
    // One minute, whatever `timeoutMs` said, was too short: pausing a busy
    // 16 vCPU, 32 GiB sandbox writes its memory out first (4 October 2026).
    const until =
      performance.now() + (timeoutMs && timeoutMs > 0 ? timeoutMs : SNAPSHOT_DEADLINE_MS);
    let running = false;
    /** The capture in progress, once the server has one. */
    let capturing: string | undefined;
    let late = false;
    const request = (): RequestOptions => {
      signal?.throwIfAborted();
      const left = Math.ceil(until - performance.now());
      if (left <= 0 && capturing) {
        late = true;
        throw new RuntimeError({
          code: "snapshot_timeout",
          status: 0,
          message: `Snapshot ${capturing} was still capturing at the deadline.${running ? ` The ${this.#product.noun.toLowerCase()} stays paused until it ends: waking it now would fail the capture.` : ""}`,
          hint: `Wait until runtime.snapshots.get("${capturing}") is ready${running ? `, then wake the ${this.#product.noun.toLowerCase()}` : ""}, or pass a longer timeoutMs.`,
          details: { snapshotId: capturing, sourceSandboxId: this.id },
        });
      }
      if (left <= 0)
        throw new RuntimeError({
          code: "snapshot_timeout",
          status: 0,
          message: "Snapshot capture ran past its deadline.",
        });
      return { ...(signal ? { signal } : {}), timeoutMs: left };
    };
    await this.refresh(request());
    // Straight after a fork or a wake the sandbox is still `resuming`, and
    // after a pause still `pausing`: wait for where it is going, or a
    // snapshot of it is refused as not paused (user lane, 23 September 2026).
    if (this.state === "resuming" || this.state === "starting")
      await this.waitFor("running", request());
    else if (this.state === "pausing") await this.waitFor("paused", request());
    running = this.state === "running";
    // Check before entering cleanup: an abort during refresh must not pause or wake.
    const pauseOptions = running ? request() : undefined;
    let captured: Snapshot | undefined;
    let primary: unknown;
    let failed = false;
    try {
      if (running) await this.pause(pauseOptions);
      let snapshot = await this.#t.json<Snapshot>({
        method: "POST",
        path: this.#path(":snapshot"),
        body,
        wait: 10,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...request(),
      });
      captured = snapshot;
      // Prefer: wait is bounded on the server. A capture still in progress
      // must keep its source paused, or the worker refuses it after we wake.
      while (snapshot.state === "capturing") {
        capturing = snapshot.id;
        request();
        await new Promise((resolve) => setTimeout(resolve, 200));
        snapshot = await this.#t.json<Snapshot>({
          method: "GET",
          path: `/v1/snapshots/${enc(snapshot.id)}`,
          ...request(),
        });
      }
      if (snapshot.state !== "ready")
        throw new RuntimeError({
          code: "snapshot_failed",
          status: 409,
          message: snapshot.error ?? `Snapshot capture ended in state ${snapshot.state}.`,
          details: { snapshotId: snapshot.id },
        });
      if (body.mode === "disk" && snapshot.mode !== "disk")
        throw new RuntimeError({
          code: "snapshot_mode_mismatch",
          status: 409,
          message: "The server did not confirm a disk-only snapshot.",
          details: { snapshotId: snapshot.id },
        });
      captured = snapshot;
    } catch (error) {
      failed = true;
      primary = error;
      // A request cut off by the deadline mid-capture is late all the same.
      if (capturing && performance.now() >= until) late = true;
    }
    // A capture still running needs its source paused: the worker fails one
    // whose source woke. The timeout says so and leaves the wake to the caller.
    if (running && !late) {
      try {
        await this.wake();
      } catch (wakeError) {
        const recovery = {
          ...(captured ? { snapshotId: captured.id } : {}),
          sourceSandboxId: this.id,
          sourceWakeError: {
            ...(wakeError instanceof RuntimeError ? { code: wakeError.code } : {}),
            message: wakeError instanceof Error ? wakeError.message : String(wakeError),
          },
        };
        const reported = failed ? primary : wakeError;
        if (reported instanceof Error && Object.isExtensible(reported)) {
          if (reported instanceof RuntimeError)
            Object.assign(reported, { details: { ...reported.details, ...recovery } });
          else Object.assign(reported, recovery);
        }
        if (!failed) throw wakeError;
      }
    }
    if (failed) throw primary;
    return captured!;
  }
  /** Starts a stopped persistent sandbox again from its disk (memory is not kept). */
  async restart(options: RequestOptions & { wait?: boolean } = {}): Promise<this> {
    return this.#lifecycle("restart", options);
  }
  async #lifecycle(
    verb: string,
    options: RequestOptions & { wait?: boolean },
    body: Record<string, unknown> = {},
  ): Promise<this> {
    this.#keep(
      await this.#t.json<Info>({
        method: "POST",
        path: this.#path(`:${verb}`),
        body,
        wait: options.wait === false ? 0 : 60,
        ...requestOnly(options),
      }),
    );
    return this;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    this.#keepAlive?.();
    if (this.#info.state === "stopped") return;
    await this.stop({ wait: false }).catch(() => undefined);
  }
  toJSON(): Info {
    return this.#info;
  }
}

/** How a product's `create` waits when every slot without credit, the account's quota
 * or the region is full. */
export type CreateOptions = RequestOptions & {
  /** How long to keep retrying a refusal that clears by itself. Default: the
   * client's, two minutes; 0 fails at once. */
  waitForCapacityMs?: number;
  /** Called before each wait, with the refusal and the milliseconds until the
   * next try: to tell a person why nothing has happened yet. */
  onCapacityWait?: (refusal: RuntimeError, waitMs: number) => void;
};

/** A machine product's collection: `runtime.<product>`. */
export abstract class Machines<
  M extends Machine<Info, object, Deleted>,
  Info extends MachineInfo,
  Create extends { name?: string; getOrCreate?: boolean },
  Deleted,
> {
  readonly #t: Transport;
  readonly #product: MachineProduct;
  readonly #wrap: (t: Transport, info: Info) => M;
  constructor(product: MachineProduct, t: Transport, wrap: (t: Transport, info: Info) => M) {
    this.#product = product;
    this.#t = t;
    this.#wrap = wrap;
  }
  /** Creates a sandbox and waits until it is running. Every field is optional:
   * with none you get the included usage while it lasts, the default region and a
   * 2 vCPU / 4 GiB machine from a warm template. `wait: false` returns at once.
   * When every slot without credit or the account's quota is taken, it waits for one to
   * free, up to `waitForCapacityMs` (the client's, two minutes by default). */
  async create(
    input: Create & { wait?: boolean } = {} as Create,
    options: CreateOptions = {},
  ): Promise<M> {
    const { wait, ...body } = input;
    const began = performance.now();
    // Time spent waiting for capacity is the room's, not the deadline's.
    let waited = 0;
    const info = await this.#t.json<Info>({
      method: "POST",
      path: `/v1/${this.#product.plural}`,
      body,
      wait: wait === false ? 0 : 60,
      ...options,
      waitForCapacityMs: options.waitForCapacityMs ?? this.#t.waitForCapacityMs,
      onCapacityWait: (refusal, waitMs) => {
        waited += waitMs;
        options.onCapacityWait?.(refusal, waitMs);
      },
    });
    const machine = this.#wrap(this.#t, info);
    if (wait !== false && info.state !== "running") {
      // One deadline for the whole create: the wait for running gets what the
      // create left of it (1 ms when nothing is left, so it ends as a timeout).
      const { timeoutMs } = options;
      await machine.waitFor("running", {
        timeoutSeconds: WAIT_FOR_TIMEOUT_SECONDS,
        signal: options.signal,
        timeoutMs: timeoutMs
          ? Math.max(1, Math.ceil(timeoutMs - (performance.now() - began - waited)))
          : timeoutMs,
        idempotencyKey: options.idempotencyKey,
      });
      if (machine.state !== "running")
        throw new RuntimeError({
          message: `${this.#product.noun} ${info.id} is ${machine.state}, not running.`,
          code: "start_failed",
          status: 0,
          hint: `Read it with runtime.${this.#product.plural}.get(id); stopReason says why.`,
        });
    }
    return machine;
  }
  /** The sandbox named `name` in this account, ready to use: running as it
   * is, woken if it is paused, restarted if it is stopped and persistent, or
   * created with `input` when no sandbox has the name. `sandbox.info.reused`
   * says which. The other fields apply only when it is created. */
  async getOrCreate(
    name: string,
    input: Omit<Create, "name" | "getOrCreate"> & { wait?: boolean } = {} as Omit<
      Create,
      "name" | "getOrCreate"
    >,
    options: CreateOptions = {},
  ): Promise<M> {
    return this.create(
      { ...input, name, getOrCreate: true } as Create & { wait?: boolean },
      options,
    );
  }
  async get(id: string, options: RequestOptions = {}): Promise<M> {
    return this.#wrap(
      this.#t,
      await this.#t.json<Info>({
        method: "GET",
        path: `/v1/${this.#product.plural}/${encodeURIComponent(id)}`,
        ...options,
      }),
    );
  }
  /** Deletes a sandbox for good, by id, without reading it first: see
   * `sandbox.delete()`. Deleting it again answers the same. */
  delete(id: string, options: RequestOptions = {}): Promise<Deleted> {
    return deleteMachine<Deleted>(this.#product, this.#t, id, options);
  }
  /** Live sandboxes, oldest first. Await for a page, or `for await` over all.
   * Request options apply to the initial request and every subsequent page. */
  async list(
    filter: {
      state?: Info["state"][];
      includeStopped?: boolean;
      /** Every label must match. */
      labels?: Record<string, string>;
      name?: string;
      limit?: number;
    } = {},
    options: RequestOptions = {},
  ): Promise<Page<M>> {
    const query = {
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.includeStopped ? { includeStopped: true } : {}),
      ...(filter.labels
        ? { label: Object.entries(filter.labels).map(([k, v]) => `${k}:${v}`) }
        : {}),
      ...(filter.name ? { name: filter.name } : {}),
      ...(filter.limit ? { limit: filter.limit } : {}),
    };
    return machinePage(
      this.#product,
      this.#t,
      this.#wrap,
      await this.#t.json({ method: "GET", path: `/v1/${this.#product.plural}`, query, ...options }),
      query,
      options,
    );
  }
  /** Stops every live sandbox whose labels all match, eight at a time, and
   * says which stopped and which failed; one failure does not stop the rest.
   * Needs at least one label, so stopping everything is never one call. */
  async stopAll(
    filter: { labels: Record<string, string> },
    options: RequestOptions = {},
  ): Promise<{ stopped: string[]; failed: { id: string; error: unknown }[] }> {
    if (!filter?.labels || Object.keys(filter.labels).length === 0) {
      const one = this.#product.noun.toLowerCase();
      throw new RuntimeError({
        message: "stopAll needs at least one label to match.",
        code: "invalid_request",
        status: 0,
        hint: `Stop one ${one} with ${one}.stop(), or label the ones to stop together.`,
      });
    }
    const live = await (
      await this.list({ labels: filter.labels, limit: 100 }, options)
    ).toArray(Infinity);
    // One key cannot name several stops: each stop makes its own.
    const { idempotencyKey: _one, ...each } = options;
    // In list order, oldest first, whichever finishes first.
    const errors: unknown[] = new Array(live.length);
    let next = 0;
    const worker = async () => {
      for (let at = next++; at < live.length; at = next++)
        await live[at]!.stop(each).catch((error: unknown) => (errors[at] = error ?? "failed"));
    };
    await Promise.all(Array.from({ length: Math.min(8, live.length) }, worker));
    return {
      stopped: live.filter((_, at) => errors[at] === undefined).map((m) => m.id),
      failed: live.flatMap((m, at) =>
        errors[at] === undefined ? [] : [{ id: m.id, error: errors[at] }],
      ),
    };
  }
}
