import { expect, test } from "bun:test";
import { run } from "../src/cli";
import { productWords } from "../src/cli-words";
import { RuntimeError } from "../src/errors";
import { PRODUCT_NAMES, type ProductName } from "../src/product-names";

/* CLOUD.md section 4: `runtime <plural>` names the product, the singular is
 * a silent shortcut, and an old word works for 30 days with a warning, then
 * fails with name_retired naming the new command. */

const dated: ProductName[] = PRODUCT_NAMES.map((product) => ({
  ...product,
  old: product.old.map((old) => ({ ...old, retires: "2026-10-14" })),
}));
const before = new Date("2026-10-13T23:59:59Z");

test("the plural and the singular reach the product silently", () => {
  expect(productWords(["sandboxes", "ls"], before, dated)).toEqual({ argv: ["sandboxes", "ls"] });
  expect(productWords(["sandbox", "ls"], before, dated)).toEqual({ argv: ["sandboxes", "ls"] });
  expect(productWords(["login"], before, dated)).toEqual({ argv: ["login"] });
});

test("an old word reaches the new command with the warning, then is retired", () => {
  expect(productWords(["tunnel", "peer", "add", "office"], before, dated)).toEqual({
    argv: ["networks", "wireguard", "peer", "add", "office"],
    warning: "runtime tunnel is now runtime networks wireguard. It stops working on 2026-10-14.",
  });
  expect(productWords(["address", "ls"], before, dated).argv).toEqual(["ips", "ls"]);
  let thrown: unknown;
  try {
    productWords(["address", "ls"], new Date("2026-10-14T00:00:00Z"), dated);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RuntimeError);
  expect((thrown as RuntimeError).code).toBe("name_retired");
  expect((thrown as RuntimeError).hint).toBe("Use runtime ips.");
});

test("runtime tunnel help prints WireGuard's help and says the new command", async () => {
  const written: string[] = [];
  const said: string[] = [];
  const out = {
    json: false,
    write: (t: string) => written.push(t),
    error: (t: string) => said.push(t),
  };
  expect(await run(["tunnel", "help"], { RUNTIME_API_KEY: "rk_cli" }, out)).toBe(0);
  expect(said).toEqual(["Warning: runtime tunnel is now runtime networks wireguard."]);
  expect(written.join("")).toContain("runtime networks wireguard <command>");
  written.length = 0;
  expect(await run(["networks", "wireguard", "help"], { RUNTIME_API_KEY: "rk_cli" }, out)).toBe(0);
  expect(said).toHaveLength(1);
  expect(written.join("")).toContain("peer add <name>");
});
