import { beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPaginatedList, paginate } from "../../src/blaxel/pagination.js";
import { Page } from "../../src/page.js";
import { prepare } from "../../scripts/prepare-compatibility.js";
import type { CompatibilityLock } from "../../scripts/check-upstream.js";

let official: typeof createPaginatedList;
beforeAll(async () => {
  const lock = JSON.parse(
    await readFile(new URL("../../compatibility-lock.json", import.meta.url), "utf8"),
  ) as CompatibilityLock;
  const pin = lock.providers
    .find((provider) => provider.id === "blaxel")
    ?.upstreams.find((upstream) => upstream.registry === "npm" && upstream.name === "@blaxel/core");
  if (!pin) throw new Error("Missing pinned Blaxel oracle");
  const cacheRoot = process.env.RUNTIME_COMPAT_CACHE ?? "/tmp/runtime-compat-upstreams";
  // The test must never turn an absent fixture into a registry request.
  await readFile(
    resolve(
      cacheRoot,
      "npm",
      `${encodeURIComponent(pin.name)}@${pin.version}`,
      ".runtime-contract-pin.json",
    ),
    "utf8",
  );
  const directory = await prepare(pin, cacheRoot);
  const module = (await import(
    pathToFileURL(resolve(directory, "package", "dist/esm/common/pagination.js")).href
  )) as { createPaginatedList: typeof createPaginatedList };
  official = module.createPaginatedList;
});

async function consumer(make: typeof createPaginatedList) {
  let fetched = 0;
  const meta = { hasMore: true, nextCursor: "again", total: 7, totalIsPartial: true };
  const page = await make({
    response: { data: [{ id: 1 }], meta },
    fetchPage: async () => {
      fetched++;
      return { data: [{ id: 2 }], meta };
    },
    mapItem: (item) => item.id,
  });
  const next = await page.nextPage();
  let repeated = "";
  try {
    await next?.nextPage();
  } catch (error) {
    repeated = error instanceof Error ? error.message : String(error);
  }
  return {
    meta: page.meta,
    sameMeta: page.meta === meta,
    data: page.data,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    nextData: next?.data,
    repeated,
    fetched,
  };
}

test("unchanged pinned Blaxel consumer retains metadata and bounds repeated cursors", async () => {
  const observed = await consumer(createPaginatedList);
  expect(observed).toEqual(await consumer(official));
  expect(observed).toMatchObject({
    sameMeta: true,
    meta: { total: 7, totalIsPartial: true },
    repeated: "Pagination returned a repeated cursor",
    fetched: 1,
  });
});

test("pinned initial cursor and supplied cursor history refuse before fetching", async () => {
  for (const make of [official, createPaginatedList]) {
    let calls = 0;
    const page = await make({
      response: { data: [1], meta: { nextCursor: "known" } },
      mapItem: (n) => n,
      query: { cursor: "known" },
      seenCursors: new Set(["older"]),
      fetchPage: async () => {
        calls++;
        return [];
      },
    });
    await expect(page.nextPage()).rejects.toThrow("Pagination returned a repeated cursor");
    expect(calls).toBe(0);
  }
});

test("pinned empty response forms and early callback termination match", async () => {
  for (const response of [undefined, null, [], { data: null, meta: null }]) {
    const make = async (factory: typeof createPaginatedList) => {
      const page = await factory({
        response,
        mapItem: (n: number) => n,
        fetchPage: async () => [],
      });
      return {
        data: page.data,
        meta: page.meta,
        hasMore: page.hasMore,
        next: await page.nextPage(),
      };
    };
    expect(await make(createPaginatedList)).toEqual(await make(official));
  }
  for (const make of [official, createPaginatedList]) {
    let calls = 0;
    const page = await make({
      response: { data: [1, 2], meta: { nextCursor: "next" } },
      mapItem: (n) => n,
      fetchPage: async () => {
        calls++;
        return [3];
      },
    });
    const read: number[] = [];
    await page.autoPagingEach((item) => {
      read.push(item);
      return false;
    });
    expect(read).toEqual([1]);
    expect(calls).toBe(0);
  }
});

test("native Blaxel pagination refuses a repeated cursor before another request", async () => {
  let calls = 0;
  const native = (): Page<number> =>
    new Page([1], "same", async () => {
      calls++;
      return native();
    });
  const page = paginate(native(), (n) => n);
  const next = await page.nextPage();
  await expect(next!.nextPage()).rejects.toThrow("Pagination returned a repeated cursor");
  expect(calls).toBe(1);
});

test("pinned metadata remains authoritative when the consumer changes its cursor", async () => {
  for (const make of [official, createPaginatedList]) {
    const meta = { hasMore: true, nextCursor: "first" };
    const fetched: string[] = [];
    const page = await make({
      response: { data: [1], meta },
      mapItem: (n) => n,
      fetchPage: async (query) => {
        fetched.push(query?.cursor ?? "");
        return [];
      },
    });
    meta.nextCursor = "second";
    expect(page.nextCursor).toBe("second");
    expect(page.hasMore).toBe(true);
    await page.nextPage();
    expect(fetched).toEqual(["second"]);
    meta.nextCursor = "";
    expect(page.hasMore).toBe(false);
    expect(await page.nextPage()).toBeNull();
  }
});

test("native Blaxel wrapper fetches the cursor its authoritative metadata advertises", async () => {
  const fetched: string[] = [];
  const native = new Page([1], "first", async (cursor) => {
    fetched.push(cursor);
    return new Page<number>([], null, async () => {
      throw new Error("Terminal page must never fetch");
    });
  });
  const wrapped = paginate(native, (item) => item);
  wrapped.meta.nextCursor = "second";
  expect(wrapped.nextCursor).toBe("second");
  expect((await wrapped.nextPage())?.data).toEqual([]);
  expect(fetched).toEqual(["second"]);
});
