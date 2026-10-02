import { expect, test } from "bun:test";
import type { Runtime } from "../../src/client.js";
import { CompatibilityError, Vm, VmsNamespace } from "../../src/freestyle/index.js";

test("Freestyle unsupported snapshot retention refuses before pausing or reading the VM", async () => {
  const calls: string[] = [];
  const runtime = {
    sandboxes: {
      async get() {
        calls.push("get");
        throw new Error("VM must not be touched");
      },
    },
  } as unknown as Runtime;
  const vm = new Vm(runtime, "00000000-0000-0000-0000-000000000001");
  for (const ttlSeconds of [0, -86400, 43200, 366 * 86400, Infinity, NaN])
    await expect(vm.snapshot({ ttlSeconds })).rejects.toBeInstanceOf(CompatibilityError);
  expect(calls).toEqual([]);
});

test("Freestyle snapshot retention boundaries preserve exact whole-day values", async () => {
  const days: (number | undefined)[] = [];
  const runtime = {
    sandboxes: {
      async get() {
        return {
          async snapshot(options: { retentionDays?: number }) {
            days.push(options.retentionDays);
            return {
              id: "snapshot",
              sourceSandboxId: "source",
              retentionDays: options.retentionDays,
            };
          },
        };
      },
    },
  } as unknown as Runtime;
  const vm = new Vm(runtime, "00000000-0000-0000-0000-000000000001");
  await vm.snapshot();
  await vm.snapshot({ ttlSeconds: 86400 });
  await vm.snapshot({ ttlSeconds: 365 * 86400 });
  expect(days).toEqual([undefined, 1, 365]);
});

test("Freestyle snapshot listing preserves source filters, pagination and totalCount", async () => {
  const filters: unknown[] = [];
  const snapshots = [
    { id: "a1", sourceSandboxId: "vm-a", name: "first", labels: {}, retentionDays: 7 },
    { id: "b1", sourceSandboxId: "vm-b", name: "other", labels: {}, retentionDays: 7 },
    { id: "a2", sourceSandboxId: "vm-a", name: "second", labels: {}, retentionDays: 7 },
  ];
  const runtime = {
    snapshots: {
      async list(filter: unknown) {
        filters.push(filter);
        return {
          async toArray() {
            return snapshots;
          },
          async *[Symbol.asyncIterator]() {
            yield* snapshots;
          },
        };
      },
    },
  } as unknown as Runtime;
  // freestyle 0.2.16 ListSnapshotsOptions and ListSnapshotsResult expose all
  // three options and the filtered totalCount, independently of the page.
  const result = await new VmsNamespace(runtime).snapshots.list({
    sourceVmId: "vm-a",
    offset: 1,
    limit: 1,
  });
  expect(filters).toEqual([{ sandboxId: "vm-a" }]);
  expect(result.snapshots.map((snapshot) => snapshot.id)).toEqual(["a2"]);
  expect(result.totalCount).toBe(2);
});

test("Freestyle invalid snapshot pagination refuses before reading its catalog", async () => {
  const calls: string[] = [];
  const runtime = {
    snapshots: {
      async list() {
        calls.push("list");
        throw new Error("Catalog must not be read");
      },
    },
  } as unknown as Runtime;
  const catalog = new VmsNamespace(runtime).snapshots;
  for (const options of [
    { limit: 0 },
    { limit: -1 },
    { limit: Infinity },
    { offset: -1 },
    { offset: 0.5 },
  ])
    await expect(catalog.list(options)).rejects.toBeInstanceOf(TypeError);
  expect(calls).toEqual([]);
});

test("Freestyle snapshot display names survive create, get and list DTOs", async () => {
  const id = "00000000-0000-0000-0000-000000000002";
  const snapshot = {
    id,
    sourceSandboxId: "source",
    name: "build",
    retentionDays: 7,
    labels: {} as Record<string, string>,
  };
  const runtime = {
    sandboxes: {
      async get() {
        return {
          async snapshot(options: { labels?: Record<string, string> }) {
            snapshot.labels = options.labels ?? {};
            return snapshot;
          },
        };
      },
    },
    snapshots: {
      async get() {
        return snapshot;
      },
      async list() {
        return {
          async toArray() {
            return [snapshot];
          },
          async *[Symbol.asyncIterator]() {
            yield snapshot;
          },
        };
      },
    },
  } as unknown as Runtime;
  const created = await new Vm(runtime, "00000000-0000-0000-0000-000000000001").snapshot({
    displayName: "build-a",
  });
  expect(created.snapshot.displayName).toBe("build-a");
  const catalog = new VmsNamespace(runtime).snapshots;
  expect((await catalog.get(id)).displayName).toBe("build-a");
  expect((await catalog.list()).snapshots[0]!.displayName).toBe("build-a");
});

test.each(["compat.provider", "fs.displayName"])(
  "Freestyle metadata key %s cannot overwrite the adapter namespace",
  async (key) => {
    const calls: string[] = [];
    const runtime = {
      sandboxes: {
        async get() {
          calls.push("get");
          throw new Error("VM must not be read");
        },
        async create() {
          calls.push("create");
          throw new Error("VM must not be allocated");
        },
      },
    } as unknown as Runtime;
    await expect(
      new VmsNamespace(runtime).create({
        firewall: { rules: [] },
        metadata: { [key]: "user-value" },
      }),
    ).rejects.toBeInstanceOf(CompatibilityError);
    await expect(
      new Vm(runtime, "00000000-0000-0000-0000-000000000001").update({
        metadata: { [key]: "user-value" },
      }),
    ).rejects.toBeInstanceOf(CompatibilityError);
    expect(calls).toEqual([]);
  },
);

test("Freestyle updates preserve ordinary legacy metadata and internal identity", async () => {
  const info = {
    labels: {
      "compat.provider": "freestyle",
      "fs.displayName": "before",
      ordinary: "old",
    } as Record<string, string>,
  };
  const runtime = {
    sandboxes: {
      async get() {
        return {
          id: "00000000-0000-0000-0000-000000000001",
          state: "running",
          info,
          async update(options: { labels: Record<string, string> }) {
            info.labels = options.labels;
          },
        };
      },
    },
  } as unknown as Runtime;
  const updated = await new Vm(runtime, "00000000-0000-0000-0000-000000000001").update({
    metadata: { additional: "new" },
    displayName: "after",
  });
  expect(updated.metadata).toEqual({ ordinary: "old", additional: "new" });
  expect(updated.displayName).toBe("after");
  expect(info.labels["compat.provider"]).toBe("freestyle");
});
