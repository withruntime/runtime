import { expect, test } from "bun:test";
import { Sandbox, NotSupportedError, type CreateSandboxParams } from "../../src/vercel/index.js";
import { retentionDays } from "../../src/vercel/sandbox.js";
import { DropInWorld } from "../drop-in-fake.js";

async function fixture(paused = false) {
  const world = new DropInWorld();
  const client = world.client();
  const box = await Sandbox.create({ name: "preflight", withruntime: { client } });
  if (paused) await box.stop();
  const checkpoint = world.calls.length;
  return { world, box, client, checkpoint };
}

test("invalid Vercel network rules cannot extend or wake before refusal", async () => {
  for (const paused of [false, true]) {
    const f = await fixture(paused);
    await expect(
      f.box.update({
        timeout: 600_000,
        networkPolicy: { allow: { "example.com": [{ headers: { authorization: "secret" } }] } },
      }),
    ).rejects.toBeInstanceOf(NotSupportedError);
    expect(f.world.calls.slice(f.checkpoint)).toEqual([]);
  }
});

test("invalid Vercel retention cannot change any other supported field", async () => {
  for (const expiration of [NaN, Infinity, -Infinity, -1]) {
    const f = await fixture(true);
    await expect(
      f.box.update({
        timeout: 600_000,
        networkPolicy: "deny-all",
        snapshotExpiration: expiration,
        ports: [8080],
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(f.world.calls.slice(f.checkpoint)).toEqual([]);
  }
});

test("valid Vercel updates preserve timeout, network and retention behavior", async () => {
  const f = await fixture();
  await f.box.update({ timeout: 600_000, networkPolicy: "deny-all", snapshotExpiration: 0 });
  expect(f.world.called("sandbox.extend").at(-1)).toEqual([f.box.withruntime.id, 300]);
  expect(f.world.called("network.set").at(-1)).toEqual([f.box.withruntime.id, { internet: false }]);
  expect(f.world.called("sandbox.retention").at(-1)).toEqual([f.box.withruntime.id, 365]);
});

const unsupportedForks: Partial<CreateSandboxParams>[] = [
  { persistent: false },
  { persistent: true },
  { snapshotExpiration: 0 },
  { snapshotExpiration: 86_400_000 },
  { keepLastSnapshots: { count: 1 } },
  {
    onResume: async () => {
      throw new Error("Callback must not run");
    },
  },
  { runtime: "node22" },
];

for (const [index, override] of unsupportedForks.entries())
  test(`Vercel fork refuses ${Object.keys(override)[0]} case ${index} before source lookup or waking`, async () => {
    const f = await fixture(true);
    await expect(
      Sandbox.fork({
        sourceSandbox: f.box.withruntime.id,
        ...override,
        withruntime: { client: f.client },
      }),
    ).rejects.toBeInstanceOf(NotSupportedError);
    expect(f.world.calls.slice(f.checkpoint)).toEqual([]);
  });

test("Vercel retention rejects invalid values before create or snapshot effects", async () => {
  for (const expiration of [NaN, Infinity, -Infinity, -1]) {
    const world = new DropInWorld();
    await expect(
      Sandbox.create({ snapshotExpiration: expiration, withruntime: { client: world.client() } }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(world.calls).toEqual([]);
    const f = await fixture(true);
    await expect(f.box.snapshot({ expiration })).rejects.toBeInstanceOf(RangeError);
    expect(f.world.calls.slice(f.checkpoint)).toEqual([]);
  }
});

test("Vercel retention preserves documented rounding and no-expiration values", () => {
  expect(retentionDays(0)).toBe(365);
  expect(retentionDays(1)).toBe(1);
  expect(retentionDays(86_400_000)).toBe(1);
  expect(retentionDays(86_400_001)).toBe(2);
  expect(retentionDays(366 * 86_400_000)).toBe(365);
});

test("Vercel validates every port before any update effect", async () => {
  for (const port of [0, -1, 65_536, 1.5, NaN, Infinity]) {
    const f = await fixture(true);
    await expect(
      f.box.update({
        timeout: 600_000,
        networkPolicy: "deny-all",
        snapshotExpiration: 86_400_000,
        ports: [8080, port],
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(f.world.calls.slice(f.checkpoint)).toEqual([]);
  }
});

test("Vercel validates all create ports before allocation", async () => {
  for (const port of [0, -1, 65_536, 1.5, NaN, Infinity]) {
    const world = new DropInWorld();
    await expect(
      Sandbox.create({ ports: [8080, port], withruntime: { client: world.client() } }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(world.calls).toEqual([]);
  }
});

test("Vercel keeps valid preview ports including boundaries and port 3000", async () => {
  const f = await fixture();
  await f.box.update({ ports: [1, 3000, 65_535] });
  expect(f.box.routes.map(({ port }) => port)).toEqual([1, 3000, 65_535]);
});

test("Vercel snapshot-count policies refuse before creating anything", async () => {
  for (const keepLastSnapshots of [
    { count: 1 },
    { count: 5, expiration: 0, deleteEvicted: true },
  ]) {
    const world = new DropInWorld();
    await expect(
      Sandbox.create({ keepLastSnapshots, withruntime: { client: world.client() } }),
    ).rejects.toBeInstanceOf(NotSupportedError);
    expect(world.calls).toEqual([]);
  }
});
