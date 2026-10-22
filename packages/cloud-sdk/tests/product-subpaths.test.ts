import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime } from "../src/client";
import { PRODUCT_NAMES } from "../src/product-names";

/* CLOUD.md section 4: one package, withruntime, and each product can be
 * imported alone as withruntime/<product>, by the same plural word. */

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as {
  exports: Record<string, { types: string; browser?: string; import: string; default: string }>;
};

/** What a product imported alone has beyond the client's. */
const ALONE_ADDS: Record<string, string[]> = { agents: ["deploy"] };

test("every product the client has is a subpath export by its plural word", async () => {
  const runtime = new Runtime({ apiKey: "rk_subpath_test" });
  // Products the client carries; the top level (billing, secrets, audit...) spans products and has no subpath.
  const sold = PRODUCT_NAMES.filter(
    (product) =>
      product.engine !== "identity" &&
      product.engine !== "meter" &&
      !["events", "webhooks"].includes(product.name) &&
      (runtime as unknown as Record<string, unknown>)[product.name] !== undefined,
  ).map((product) => product.name);
  expect(sold).toEqual(
    expect.arrayContaining([
      "sandboxes",
      "snapshots",
      "images",
      "volumes",
      "jobs",
      "domains",
      "ports",
      "ips",
      "networks",
    ]),
  );
  for (const name of sold) {
    expect(manifest.exports[`./${name}`]).toEqual({
      types: `./dist/${name}/index.d.ts`,
      // A product with a browser build of its own (agents' chat) names it
      // for bundlers.
      ...(existsSync(join(import.meta.dir, `../src/${name}/browser.ts`))
        ? { browser: `./dist/${name}/browser.js` }
        : {}),
      import: `./dist/${name}/index.js`,
      default: `./dist/${name}/index.js`,
    });
    const module = (await import(`../src/${name}/index.ts`)) as Record<
      string,
      (options: { apiKey: string }) => object
    >;
    const alone = module[name]!({ apiKey: "rk_subpath_test" });
    // Each is the client's own product, and withruntime/agents adds deploy,
    // which runs a runtime.yml as CI does (agents-deploy.ts withDeploy).
    expect(Object.keys(alone).sort()).toEqual(
      [
        ...Object.keys((runtime as unknown as Record<string, object>)[name]!),
        ...(ALONE_ADDS[name] ?? []),
      ].sort(),
    );
  }
});
