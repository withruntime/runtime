import { expect, test } from "bun:test";
import { Runtime } from "../src/client";

test("canonical product names retain each existing product instance", () => {
  const runtime = new Runtime({ apiKey: "rk_product_alias_test" });
  for (const [singular, plural] of [
    ["sandbox", "sandboxes"],
    ["snapshot", "snapshots"],
    ["image", "images"],
    ["volume", "volumes"],
    ["job", "jobs"],
    ["domain", "domains"],
    ["port", "ports"],
    ["address", "addresses"],
  ] as const)
    expect(runtime[singular]).toBe(runtime[plural]);
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
});

test("canonical and historical product calls share the authenticated client transport", async () => {
  const seen: Array<{ path: string; authorization: string | null }> = [];
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
  expect(seen).toEqual([]);
  for (const product of [runtime.sandbox, runtime.sandboxes]) await product.get("fixture");
  for (const product of [runtime.snapshot, runtime.snapshots]) await product.get("fixture");
  for (const product of [runtime.image, runtime.images]) await product.get("fixture");
  for (const product of [runtime.volume, runtime.volumes]) await product.get("fixture");
  for (const product of [runtime.job, runtime.jobs]) await product.get("fixture");
  for (const product of [runtime.domain, runtime.domains]) await product.get("app.example.test");
  for (const product of [runtime.port, runtime.ports]) await product.list();
  for (const product of [runtime.address, runtime.addresses]) await product.list();
  expect(seen.map(({ path }) => path)).toEqual(
    [
      "sandboxes/fixture",
      "snapshots/fixture",
      "images/fixture",
      "volumes/fixture",
      "jobs/fixture",
      "domains/app.example.test",
      "ports",
      "addresses",
    ].flatMap((path) => [`/v1/${path}`, `/v1/${path}`]),
  );
  expect(seen.every(({ authorization }) => authorization === "Bearer rk_product_alias_test")).toBe(
    true,
  );
});
