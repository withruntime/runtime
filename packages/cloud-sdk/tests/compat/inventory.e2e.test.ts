import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { refresh, readInventory, SOURCES } from "../../scripts/compat-inventory";

/* compat-inventory.json, the counts COMPATIBILITY.md and each provider's
   page state, against the adapters as TypeScript's checker and Python's ast
   read them. The checker over the whole SDK is 3 s of one core, three times
   a test file's budget, so this runs on main's check, after merge
   (.runtime/e2e-files.sh), until it reads the adapters by syntax alone. */

const saved = readInventory();
const fresh = refresh(saved);

for (const { provider } of SOURCES)
  test(`${provider}: no inventory item the adapter had is lost`, () => {
    const lost = Object.entries(saved[provider]!.items)
      .filter(([key, status]) => status !== "missing" && fresh[provider]!.items[key] === "missing")
      .map(([key]) => key);
    expect(lost).toEqual([]);
  });

test("compat-inventory.json matches the adapters (bun scripts/compat-inventory.ts --write)", () => {
  for (const { provider } of SOURCES)
    expect(fresh[provider]!.items).toEqual(saved[provider]!.items);
});

test("a refused option is not counted as implemented", () => {
  // Freestyle's update checks its options with only(): ttlSeconds is refused.
  expect(saved.freestyle!.items["Vm.update(ttlSeconds)"]).toBe("refused");
});

test("every inventory source reads the version compatibility-lock.json pins", () => {
  const lock = JSON.parse(
    readFileSync(new URL("../../compatibility-lock.json", import.meta.url), "utf8"),
  ) as { providers: { upstreams: { registry: string; name: string; version: string }[] }[] };
  const pins = new Set(
    lock.providers.flatMap((p) =>
      p.upstreams.map((u) => `${u.registry}/${encodeURIComponent(u.name)}@${u.version}`),
    ),
  );
  for (const { provider, upstream } of SOURCES) {
    const dir = upstream.dir.replace(/\/package$/, "");
    expect({ provider, pinned: pins.has(dir) || pins.has(dir.replace("%2F", "/")) }).toEqual({
      provider,
      pinned: true,
    });
  }
});
