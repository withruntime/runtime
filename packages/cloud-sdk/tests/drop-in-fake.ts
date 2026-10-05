/* eslint-disable @typescript-eslint/no-this-alias -- the fake's modules close over their world. */
import type { Runtime } from "../src/index";
import { FakeSandbox, FakeWorld, notFound } from "./e2b/fake";

/* The E2B tests' fake of the withruntime SDK, with what the Daytona and
   Vercel adapters also call: network rules, retention, previews by
   visibility, image builds, snapshots and volumes by name, and pages that
   iterate. It adds to the fake; nothing the E2B tests rely on changes. */

type Page<T> = {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  next(): Promise<Page<T> | null>;
  pages(): AsyncGenerator<Page<T>>;
  toArray(): Promise<T[]>;
  [Symbol.asyncIterator](): AsyncGenerator<T>;
};

export function page<T>(items: T[], size = 50, from = 0): Page<T> {
  const data = items.slice(from, from + size);
  const more = from + size < items.length;
  const self: Page<T> = {
    data,
    nextCursor: more ? String(from + size) : null,
    hasMore: more,
    next: async () => (more ? page(items, size, from + size) : null),
    async *pages() {
      let current: Page<T> | null = self;
      while (current) {
        yield current;
        current = await current.next();
      }
    },
    toArray: async () => items.slice(from),
    async *[Symbol.asyncIterator]() {
      yield* items.slice(from);
    },
  };
  return self;
}

const extra = FakeSandbox.prototype as unknown as Record<string, unknown>;
Object.defineProperty(FakeSandbox.prototype, "network", {
  configurable: true,
  get(this: FakeSandbox) {
    const world = (this as unknown as { world: FakeWorld }).world;
    const id = this.id;
    return {
      async set(rules: unknown) {
        world.record("network.set", id, rules);
        return rules;
      },
    };
  },
});
// eslint-disable-next-line @typescript-eslint/unbound-method -- called with its sandbox below
const previews = Object.getOwnPropertyDescriptor(FakeSandbox.prototype, "previews")!.get!;
Object.defineProperty(FakeSandbox.prototype, "previews", {
  configurable: true,
  get(this: FakeSandbox) {
    const world = (this as unknown as { world: FakeWorld }).world;
    return {
      ...(previews.call(this) as object),
      async delete(port: number) {
        world.record("previews.delete", port);
        return { deleted: true };
      },
    };
  },
});
extra.setRetention = async function (this: FakeSandbox, days: number) {
  (this as unknown as { world: FakeWorld }).world.record("sandbox.retention", this.id, days);
  return this;
};
extra.waitFor = async function (this: FakeSandbox, state: string) {
  (this as unknown as { world: FakeWorld }).world.record("sandbox.waitFor", this.id, state);
  return this;
};

/** The fake world, plus images that build, snapshots and volumes by name, and
 * sandboxes by name. */
export class DropInWorld extends FakeWorld {
  readonly namedSnapshots: Array<{ id: string; name: string; state: string }> = [];
  readonly volumes: Array<{ id: string; name: string; state: string }> = [];

  override client(): Runtime {
    const base = super.client() as unknown as Record<string, Record<string, unknown>>;
    const world = this;
    const sandboxes = base.sandboxes!;
    const images = base.images!;
    const snapshots = base.snapshots!;
    const create = sandboxes.create as (
      input: Record<string, unknown>,
      options: unknown,
    ) => Promise<FakeSandbox>;
    sandboxes.create = async (input: Record<string, unknown>, options: unknown) => {
      const made = await create(input, options);
      made.info.name = input.name ?? null;
      made.info.diskMiB = input.diskMiB ?? 4096;
      return made;
    };
    sandboxes.list = async (
      filter: {
        state?: string[];
        labels?: Record<string, string>;
        name?: string;
        limit?: number;
      } = {},
    ) => {
      world.record("sandboxes.list", filter);
      const all = [...world.sandboxes.values()].filter(
        (one) =>
          (!filter.state || filter.state.includes(one.state)) &&
          (filter.name === undefined || one.info.name === filter.name) &&
          Object.entries(filter.labels ?? {}).every(([k, v]) => one.info.labels[k] === v),
      );
      return page(all, filter.limit ?? 50);
    };
    images.list = async (query: { name?: string; state?: string } = {}) => {
      world.record("images.list", query);
      return page(
        world.images.filter(
          (one) =>
            (!query.name || one.name === query.name) && (!query.state || one.state === query.state),
        ),
      );
    };
    images.build = async (input: Record<string, unknown>) => {
      world.record("images.build", input);
      const image = { id: world.id(), name: (input.name as string) ?? null, state: "ready" };
      world.images.push(image);
      return image;
    };
    images.delete = async (id: string) => {
      world.record("images.delete", id);
      return {};
    };
    snapshots.get = async (id: string) => {
      world.record("snapshots.get", id);
      if (!world.snapshots.has(id)) throw notFound("not_found", "No such snapshot.");
      return snapshotInfo(id);
    };
    snapshots.list = async (filter: { name?: string; sandboxId?: string } = {}) => {
      world.record("snapshots.list", filter);
      if (filter.name !== undefined)
        return page(world.namedSnapshots.filter((one) => one.name === filter.name));
      return page([...world.snapshots].map(snapshotInfo));
    };
    const volumes = {
      async list(query: { name?: string } = {}) {
        world.record("volumes.list", query);
        return page(
          world.volumes.filter((one) => query.name === undefined || one.name === query.name),
        );
      },
      async delete(id: string) {
        world.record("volumes.delete", id);
        return {};
      },
    };
    return { ...base, volumes } as unknown as Runtime;
  }
}

function snapshotInfo(id: string) {
  return {
    id,
    kind: "snapshot",
    state: "ready",
    name: null,
    sourceSandboxId: "source",
    storedBytes: 1024,
    createdAt: "2026-09-23T00:00:00.000Z",
    readyAt: "2026-09-23T00:00:01.000Z",
    expiresAt: "2026-09-30T00:00:00.000Z",
  };
}

// Runtime's fork answers one sandbox without `count` and a list with it; the
// E2B fake always answers a list, since the E2B adapter always passes count.
// eslint-disable-next-line @typescript-eslint/unbound-method -- called with its sandbox below
const fork = FakeSandbox.prototype.fork;
extra.fork = async function (this: FakeSandbox, options: { count?: number } = {}) {
  const copies = await fork.call(this, options);
  return options.count === undefined ? copies[0] : copies;
};
