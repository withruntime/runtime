import type { Runtime } from "../client.js";
import type { Snapshot as RuntimeSnapshot } from "../snapshots.js";
import { clientFor, signalOf, type Credentials, type WithRuntime } from "./client.js";
import { APIError, guard, NotSupportedError } from "./errors.js";

type Status = "created" | "failed" | "deleted";

function statusOf(state: RuntimeSnapshot["state"]): Status {
  if (state === "failed") return "failed";
  if (state === "deleting" || state === "deleted") return "deleted";
  return "created";
}

function metadataOf(snapshot: RuntimeSnapshot) {
  return {
    id: snapshot.id,
    sourceSessionId: snapshot.sourceSandboxId,
    region: "iad1",
    regions: ["iad1"],
    status: statusOf(snapshot.state),
    sizeBytes: snapshot.storedBytes ?? 0,
    createdAt: Date.parse(snapshot.createdAt),
    updatedAt: Date.parse(snapshot.readyAt ?? snapshot.createdAt),
    expiresAt: Date.parse(snapshot.expiresAt),
  };
}

/** A saved filesystem, as Vercel's Snapshot, over a Runtime disk snapshot.
 * Restoring it starts fresh processes. `sourceSessionId` is the Runtime id of the
 * sandbox it came from. */
export class Snapshot {
  readonly #snapshot: RuntimeSnapshot;
  readonly #client: Runtime;
  constructor(snapshot: RuntimeSnapshot, client: Runtime) {
    this.#snapshot = snapshot;
    this.#client = client;
  }
  get snapshotId(): string {
    return this.#snapshot.id;
  }
  get sourceSessionId(): string {
    return this.#snapshot.sourceSandboxId;
  }
  get regions(): string[] {
    return ["iad1"];
  }
  get status(): Status {
    return statusOf(this.#snapshot.state);
  }
  get sizeBytes(): number {
    return this.#snapshot.storedBytes ?? 0;
  }
  get createdAt(): Date {
    return new Date(this.#snapshot.createdAt);
  }
  get updatedAt(): Date {
    return new Date(this.#snapshot.readyAt ?? this.#snapshot.createdAt);
  }
  get expiresAt(): Date {
    return new Date(this.#snapshot.expiresAt);
  }

  static async get(
    params: { snapshotId: string; signal?: AbortSignal } & Credentials & {
        withruntime?: WithRuntime;
      },
  ): Promise<Snapshot> {
    const client = clientFor(params);
    return new Snapshot(
      await guard(() => client.snapshots.get(params.snapshotId, signalOf(params))),
      client,
    );
  }

  /** Snapshots, oldest first; `name` narrows to one sandbox's. */
  static async list(
    params: { name?: string; limit?: number; signal?: AbortSignal } & Credentials & {
        withruntime?: WithRuntime;
      } & Record<string, unknown> = {},
  ) {
    params.signal?.throwIfAborted();
    for (const field of ["since", "until", "cursor", "sortOrder"])
      if (params[field] !== undefined)
        throw new NotSupportedError(
          `Listing snapshots by ${field}`,
          "List them all and filter the result yourself.",
        );
    const client = clientFor(params);
    let sandboxId: string | undefined;
    if (params.name !== undefined) {
      const found = (
        await guard(() =>
          client.sandboxes.list({ name: params.name!, includeStopped: true }, signalOf(params)),
        )
      ).data[0];
      if (!found) return paginate([], null);
      sandboxId = found.id;
    }
    const page = await guard(() =>
      client.snapshots.list(
        {
          ...(sandboxId ? { sandboxId } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
        },
        signalOf(params),
      ),
    );
    return paginate(page.data, page.nextCursor, page);
  }

  static tree(): Promise<never> {
    return Promise.reject(
      new NotSupportedError(
        "Snapshot ancestry (Snapshot.tree)",
        "Use Snapshot.list and sourceSessionId.",
      ),
    );
  }

  async delete(opts: { signal?: AbortSignal } = {}): Promise<void> {
    try {
      await guard(() => this.#client.snapshots.delete(this.#snapshot.id, signalOf(opts)));
      Object.assign(
        this.#snapshot,
        await guard(() => this.#client.snapshots.get(this.#snapshot.id, signalOf(opts))),
      );
    } catch (error) {
      if (error instanceof APIError && error.response.status === 404) {
        this.#snapshot.state = "deleted";
        return;
      }
      throw error;
    }
  }
}

function paginate(
  data: RuntimeSnapshot[],
  next: string | null,
  page?: { pages(): AsyncGenerator<{ data: RuntimeSnapshot[]; nextCursor: string | null }> },
) {
  const toPage = (items: RuntimeSnapshot[], cursor: string | null) => ({
    snapshots: items.map(metadataOf),
    pagination: { count: items.length, next: cursor },
  });
  return Object.assign(toPage(data, next), {
    async *pages() {
      if (!page) {
        yield toPage(data, next);
        return;
      }
      for await (const one of page.pages()) yield toPage(one.data, one.nextCursor);
    },
    async *[Symbol.asyncIterator]() {
      if (!page) return;
      for await (const one of page.pages()) yield* one.data.map(metadataOf);
    },
    async toArray() {
      const all: ReturnType<typeof metadataOf>[] = [];
      if (!page) return all;
      for await (const one of page.pages()) all.push(...one.data.map(metadataOf));
      return all;
    },
  });
}
