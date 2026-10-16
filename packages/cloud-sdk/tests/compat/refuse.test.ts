import { expect, test } from "bun:test";
import {
  CompatibilityError,
  refuse,
  refused,
  type Refused,
  type RefusedAsync,
} from "../../src/compat/core";

class Thing {
  declare readonly later: RefusedAsync;
  declare readonly now: Refused;
}
refuse("Vendor", "Thing", Thing, { later: "use sandbox.later()" });
refuse("Vendor", "Thing", Thing, { now: "use sandbox.now()" }, { sync: true });

test("a refused async method rejects with the vendor, member and alternative", async () => {
  const error = await new Thing().later(1, 2).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CompatibilityError);
  expect((error as Error).message).toBe(
    "Vendor: Thing.later is not supported by this Runtime compatibility adapter; use sandbox.later().",
  );
});

test("a refused sync method throws at the call", () => {
  expect(() => new Thing().now()).toThrow(CompatibilityError);
});

test("a refused export throws when called and when constructed", () => {
  const Namespace = refused("Vendor", "VpcNamespace", "use private networks");
  expect(() => Namespace()).toThrow(
    "Vendor: VpcNamespace is not supported by this Runtime compatibility adapter; use private networks.",
  );
  expect(() => new (Namespace as unknown as new () => object)()).toThrow(CompatibilityError);
});
