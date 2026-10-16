import { expect, setSystemTime, spyOn, test } from "bun:test";
import { Runtime } from "../src/client";
import { RuntimeError } from "../src/errors";
import { RENAMED_FIELDS } from "../src/product-renames";

const startupIncluded = [
  {
    pool: "machine-cpu",
    unit: "vCPU-hour",
    quantity: 250,
    used: 1,
    reserved: 0,
    left: 249,
    source: "startup",
    grantedAt: "2026-10-08T00:00:00Z",
  },
];
const startupLimits = { buildsAtOnce: 3, sandboxesAtOnce: 25 };
const canonical = { startupIncluded, startupLimits };
function client(answer: object) {
  return new Runtime({
    apiKey: "rk_test",
    baseUrl: "https://api.example.test",
    fetch: (async () => Response.json(answer)) as unknown as typeof fetch,
  });
}

test("usage aliases are hidden getters that warn once across calls and clients", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    let reads = 0;
    for (const rt of [client(canonical), client(canonical)]) {
      for (let i = 0; i < 2; i++) {
        const value = await rt.usage();
        expect(warn).toHaveBeenCalledTimes(reads++ === 0 ? 0 : 2);
        expect(value.startupIncluded).toEqual(startupIncluded);
        expect(value.startupLimits).toEqual(startupLimits);
        expect(Object.keys(value)).toEqual(["startupIncluded", "startupLimits"]);
        expect(JSON.parse(JSON.stringify(value))).toEqual(canonical);
        expect(typeof Object.getOwnPropertyDescriptor(value, "pot")?.get).toBe("function");
        expect(value.pot).toBe(value.startupIncluded);
        expect(value.pot).toBe(value.startupIncluded);
        expect(value.potLimits).toBe(value.startupLimits);
        expect(value.potLimits).toBe(value.startupLimits);
      }
    }
    expect(warn.mock.calls).toEqual([
      ["Runtime: usage.pot is now usage.startupIncluded."],
      ["Runtime: usage.potLimits is now usage.startupLimits."],
    ]);
  } finally {
    warn.mockRestore();
  }
});

test("usage reads an older server and prefers current fields when both are sent", async () => {
  const legacy = await client({ pot: startupIncluded, potLimits: startupLimits }).usage();
  expect(JSON.parse(JSON.stringify(legacy))).toEqual(canonical);
  const both = await client({ ...canonical, pot: [], potLimits: null }).usage();
  expect(JSON.parse(JSON.stringify(both))).toEqual(canonical);
  const empty = await client({
    startupIncluded: [],
    startupLimits: null,
    pot: startupIncluded,
    potLimits: startupLimits,
  }).usage();
  expect(empty.startupIncluded).toEqual([]);
  expect(empty.startupLimits).toBeNull();
});

test("a retained usage object refuses old names at retirement, with RuntimeError and the new field hint", async () => {
  const saved = RENAMED_FIELDS.map((field) => field.retires);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    // The deploy edits this table. Use a test date without setting a live deadline.
    for (const field of RENAMED_FIELDS)
      (field as { retires: string | null }).retires = "2026-11-07";
    setSystemTime(new Date("2026-11-06T23:59:59.999Z"));
    const value = await client(canonical).usage();
    expect(value.pot).toBe(value.startupIncluded);
    expect(value.potLimits).toBe(value.startupLimits);
    setSystemTime(new Date("2026-11-07T00:00:00Z"));
    for (const field of RENAMED_FIELDS) {
      let thrown: unknown;
      try {
        void value[field.name];
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RuntimeError);
      expect(thrown).toMatchObject({
        code: "name_retired",
        status: 410,
        hint: `Use usage.${field.now}.`,
      });
    }
    expect(JSON.parse(JSON.stringify(value))).toEqual(canonical);
    expect(warn).toHaveBeenCalledTimes(2);
  } finally {
    RENAMED_FIELDS.forEach((field, i) => {
      (field as { retires: string | null }).retires = saved[i]!;
    });
    setSystemTime();
    warn.mockRestore();
  }
});
