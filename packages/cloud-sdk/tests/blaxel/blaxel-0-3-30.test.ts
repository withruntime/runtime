import { describe, expect, test } from "bun:test";
import * as blaxel from "../../src/blaxel/index";
import { NotSupportedError } from "../../src/blaxel/index";

/* What @blaxel/core 0.3.30 added over 0.3.29: workspace secrets and a drive
   folder delete in its generated API. Each imports and refuses, naming
   Runtime's alternative; before, the imports were undefined. */

describe("@blaxel/core 0.3.30", () => {
  test("the secrets API refuses on use and names Runtime secrets", () => {
    const stand = blaxel as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of ["listSecrets", "upsertSecret", "deleteSecret", "deleteSecretByQuery"]) {
      expect(typeof stand[name]).toBe("function");
      let error: unknown;
      try {
        stand[name]!({ body: { name: "TOKEN", value: "v" } });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(NotSupportedError);
      expect((error as NotSupportedError).alternative).toContain("runtime.secrets.set");
    }
  });

  test("deleteDriveFolder refuses like the other drive calls", () => {
    const stand = blaxel as unknown as Record<string, (...args: unknown[]) => unknown>;
    expect(() => stand.deleteDriveFolder!({ path: { driveName: "d" } })).toThrow(NotSupportedError);
  });
});
