import { expect, test } from "bun:test";
import type { Runtime } from "../../src/client.js";
import { Sandboxes } from "../../src/codesandbox/index.js";

function fixture(count = 240) {
  const calls: string[] = [];
  const sandboxes = Array.from({ length: count }, (_, index) => ({
    id: `box-${index}`,
    state: "running",
    info: {
      createdAt: new Date(Date.UTC(2026, 8, 30, 0, 0, index)).toISOString(),
      labels: { "compat.provider": "codesandbox", "cs.tags": "[]" },
    },
  }));
  const runtime = {
    sandboxes: {
      async list() {
        calls.push("list");
        return {
          async *[Symbol.asyncIterator]() {
            yield* sandboxes;
          },
        };
      },
      async get() {
        calls.push("get");
        throw new Error("Must refuse before lookup");
      },
      async create() {
        calls.push("create");
        throw new Error("Must refuse before allocation");
      },
    },
  } as unknown as Runtime;
  return { calls, api: new Sandboxes(runtime) };
}

test("CodeSandbox explicit list limit consumes four pages and exposes the last page", async () => {
  const f = fixture();
  const result = await f.api.list({
    limit: 200,
    pagination: { page: 1, pageSize: 50 },
    direction: "asc",
  });
  expect(result.sandboxes).toHaveLength(200);
  expect(result.sandboxes.at(0)?.id).toBe("box-0");
  expect(result.sandboxes.at(-1)?.id).toBe("box-199");
  expect(result.totalCount).toBe(240);
  expect(result.hasMore).toBe(true);
  expect(result.pagination).toEqual({ currentPage: 4, nextPage: 5, pageSize: 50 });
});

test("CodeSandbox list retains whole-page official limit behavior and manual page offsets", async () => {
  const f = fixture(120);
  const nonMultiple = await f.api.list({ limit: 51, pagination: { pageSize: 50 } });
  expect(nonMultiple.sandboxes).toHaveLength(100);
  expect(nonMultiple.pagination).toEqual({ currentPage: 2, nextPage: 3, pageSize: 50 });
  const manual = await f.api.list({ pagination: { page: 3, pageSize: 50 } });
  expect(manual.sandboxes).toHaveLength(20);
  expect(manual.sandboxes[0]?.id).toBe("box-100");
  expect(manual.pagination).toEqual({ currentPage: 3, nextPage: null, pageSize: 50 });
  expect(manual.hasMore).toBe(true);
});

test("CodeSandbox invalid hibernation refuses before create, fork or restart effects", async () => {
  for (const hibernationTimeoutSeconds of [-1, NaN, Infinity, 0.5, 86_401]) {
    const f = fixture();
    await expect(f.api.create({ hibernationTimeoutSeconds })).rejects.toBeInstanceOf(RangeError);
    await expect(f.api.create({ id: "source", hibernationTimeoutSeconds })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(f.api.restart("source", { hibernationTimeoutSeconds })).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(f.calls).toEqual([]);
  }
});

test("CodeSandbox supported hibernation values retain their lookup path", async () => {
  for (const hibernationTimeoutSeconds of [undefined, 0, 1, 86_400]) {
    const f = fixture();
    await expect(f.api.restart("source", { hibernationTimeoutSeconds })).rejects.toThrow(
      "Must refuse before lookup",
    );
    expect(f.calls).toEqual(["get"]);
  }
});

test("CodeSandbox invalid list sizes refuse before fetching the catalog", async () => {
  for (const options of [
    { limit: -1 },
    { pagination: { page: 0 } },
    { pagination: { pageSize: Infinity } },
  ]) {
    const f = fixture();
    await expect(f.api.list(options)).rejects.toBeInstanceOf(RangeError);
    expect(f.calls).toEqual([]);
  }
});
