import { expect, test } from "bun:test";
import { isNewer, LATEST_URL, outdatedLine } from "../src/cli-update";

// A usage error from an old CLI says a later one exists (26 October 2026: a
// global withruntime 0.12.0 refused `secrets scope --only-label`, which
// 0.37.0 takes), and says nothing when this CLI is the latest, npm can't be
// read, or the check is off.
const npm = (version: unknown, status = 200) =>
  (async (url: string) => {
    expect(url).toBe(LATEST_URL);
    return Response.json({ version }, { status });
  }) as unknown as typeof fetch;

test("a later release is newer, part by part; anything not x.y.z never is", () => {
  expect(isNewer("0.37.0", "0.12.0")).toBe(true);
  expect(isNewer("0.10.0", "0.9.9")).toBe(true);
  expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  expect(isNewer("0.37.0", "0.37.0")).toBe(false);
  expect(isNewer("0.37.0", "0.43.0")).toBe(false);
  expect(isNewer("0.44.0-beta.1", "0.43.0")).toBe(false);
  expect(isNewer("latest", "0.43.0")).toBe(false);
});

test("an old CLI is told the latest version and how to run it", async () => {
  const line = await outdatedLine({ env: {}, fetch: npm("0.37.0"), version: "0.12.0" });
  expect(line).toContain("withruntime 0.12.0");
  expect(line).toContain("the latest is 0.37.0");
  expect(line).toContain("npm install -g withruntime@latest");
  expect(line).toContain("npx withruntime@latest");
});

test("nothing is said when this CLI is current or ahead", async () => {
  expect(await outdatedLine({ env: {}, fetch: npm("0.37.0"), version: "0.37.0" })).toBe("");
  expect(await outdatedLine({ env: {}, fetch: npm("0.37.0"), version: "0.43.0" })).toBe("");
});

test("nothing is said when npm fails, is slow or says no version", async () => {
  expect(await outdatedLine({ env: {}, fetch: npm("9.9.9", 503), version: "0.1.0" })).toBe("");
  expect(await outdatedLine({ env: {}, fetch: npm(undefined), version: "0.1.0" })).toBe("");
  const down = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  expect(await outdatedLine({ env: {}, fetch: down, version: "0.1.0" })).toBe("");
  const slow = ((_: unknown, init?: RequestInit) =>
    new Promise((_, fail) =>
      init?.signal?.addEventListener("abort", () => fail(new Error("timeout"))),
    )) as unknown as typeof fetch;
  const started = Date.now();
  expect(await outdatedLine({ env: {}, fetch: slow, version: "0.1.0", timeoutMs: 50 })).toBe("");
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("npm is never asked in CI or with RUNTIME_NO_UPDATE_CHECK", async () => {
  let asked = 0;
  const counted = (async () => {
    asked++;
    return Response.json({ version: "9.9.9" });
  }) as unknown as typeof fetch;
  expect(await outdatedLine({ env: { CI: "true" }, fetch: counted, version: "0.1.0" })).toBe("");
  expect(
    await outdatedLine({ env: { RUNTIME_NO_UPDATE_CHECK: "1" }, fetch: counted, version: "0.1.0" }),
  ).toBe("");
  expect(asked).toBe(0);
});
