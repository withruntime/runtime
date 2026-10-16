import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Runtime } from "../src/client";
import { RuntimeError } from "../src/errors";
import { PRODUCT_NAMES, type ProductName } from "../src/product-names";
import { installRenamedProducts } from "../src/renamed-products";

/* CLOUD.md section 4: one plural word per product, and an old word answers
 * the product it became for 30 days, warning once, then throws name_retired. */

const OLD = [
  ["sandbox", "sandboxes"],
  ["snapshot", "snapshots"],
  ["image", "images"],
  ["volume", "volumes"],
  ["job", "jobs"],
  ["domain", "domains"],
  ["port", "ports"],
  ["address", "ips"],
  ["addresses", "ips"],
  ["network", "networks"],
] as const;

test("each old word is the product it became, said once, and is not listed", () => {
  const warned = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const runtime = new Runtime({ apiKey: "rk_product_alias_test" });
    for (const [old, plural] of OLD) {
      expect(runtime[old]).toBe(runtime[plural] as never);
      expect(runtime[old]).toBe(runtime[plural] as never);
    }
    expect(runtime.tunnel).toBe(runtime.networks.wireguard);
    expect(warned.mock.calls).toContainEqual([
      "Runtime: runtime.sandbox is now runtime.sandboxes.",
    ]);
    expect(warned.mock.calls).toContainEqual([
      "Runtime: runtime.tunnel is now runtime.networks.wireguard.",
    ]);
    expect(new Set(warned.mock.calls.map(String)).size).toBe(warned.mock.calls.length);
    expect(Object.keys(runtime)).not.toContain("sandbox");
    expect(Object.keys(runtime)).toContain("ips");
    for (const command of [
      "billing",
      "account",
      "secrets",
      "webhooks",
      "events",
      "referrals",
    ] as const)
      expect(runtime[command]).toBeDefined();
    expect("secret" in runtime).toBe(false);
    expect("event" in runtime).toBe(false);
  } finally {
    warned.mockRestore();
  }
});

test("from the table's date an old word throws name_retired naming the new one", () => {
  const dated: ProductName[] = PRODUCT_NAMES.map((product) => ({
    ...product,
    old: product.old.map((old) => ({ ...old, retires: "2026-10-14" })),
  }));
  const client = { ips: { list: () => [] }, networks: { wireguard: { get: () => null } } };
  const lines: string[] = [];
  let now = new Date("2026-10-13T23:59:59Z");
  installRenamedProducts(client, { now: () => now, table: dated, say: (line) => lines.push(line) });
  const old = client as unknown as Record<string, unknown>;
  expect(old.addresses).toBe(client.ips);
  expect(old.tunnel).toBe(client.networks.wireguard);
  expect(lines).toEqual([
    "Runtime: runtime.addresses is now runtime.ips. It stops working on 2026-10-14.",
    "Runtime: runtime.tunnel is now runtime.networks.wireguard. It stops working on 2026-10-14.",
  ]);
  now = new Date("2026-10-14T00:00:00Z");
  let thrown: unknown;
  try {
    void old.addresses;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RuntimeError);
  expect((thrown as RuntimeError).code).toBe("name_retired");
  expect((thrown as RuntimeError).status).toBe(410);
  expect((thrown as RuntimeError).hint).toBe("Use runtime.ips.");
});

test("old and new words share the authenticated client transport", async () => {
  const seen: Array<{ path: string; authorization: string | null }> = [];
  const warned = spyOn(console, "warn").mockImplementation(() => {});
  const runtime = new Runtime({
    apiKey: "rk_product_alias_test",
    baseUrl: "https://product-alias.example.test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
      });
      return Response.json({ id: "fixture", state: "running", data: [], nextCursor: null });
    }) as typeof fetch,
  });
  try {
    for (const product of [runtime.sandbox, runtime.sandboxes]) await product.get("fixture");
    for (const product of [runtime.image, runtime.images]) await product.get("fixture");
    for (const product of [runtime.address, runtime.ips]) await product.list();
  } finally {
    warned.mockRestore();
  }
  expect(seen.map(({ path }) => path)).toEqual(
    ["sandboxes/fixture", "images/fixture", "ips"].flatMap((path) => [
      `/v1/${path}`,
      `/v1/${path}`,
    ]),
  );
  expect(seen.every(({ authorization }) => authorization === "Bearer rk_product_alias_test")).toBe(
    true,
  );
});

test("the Python and Ruby SDKs carry the same old words and date", () => {
  const sdks = new URL("../../../sdks/", import.meta.url);
  const python = readFileSync(new URL("python/withruntime/_renamed.py", sdks), "utf8");
  const words = Object.fromEntries(
    [...python.matchAll(/^ {4}"([a-z-]+)": "([a-z.]+)",$/gm)].map((m) => [m[1]!, m[2]!]),
  );
  const expected = Object.fromEntries(
    PRODUCT_NAMES.flatMap((product) =>
      product.old.map((old) => [old.name, [product.name, old.under].filter(Boolean).join(".")]),
    ),
  );
  expect(words).toEqual(expected);
  const dates = new Set(PRODUCT_NAMES.flatMap((product) => product.old.map((old) => old.retires)));
  expect(dates.size).toBe(1);
  const [date] = [...dates];
  expect(python).toContain(`RETIRES: Optional[str] = ${date === null ? "None" : `"${date}"`}`);
  const ruby = readFileSync(new URL("ruby/lib/withruntime/client.rb", sdks), "utf8");
  expect(ruby).toContain(`RENAME_RETIRES = ${date === null ? "nil" : `"${date}"`}`);
  for (const [old, to] of [
    ["addresses", "ips"],
    ["tunnel", "networks.wireguard"],
  ])
    expect(ruby).toContain(`def ${old} = renamed("${old}", "${to}")`);
});
