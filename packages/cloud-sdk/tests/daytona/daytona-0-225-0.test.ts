import { beforeEach, describe, expect, test } from "bun:test";
import {
  Daytona,
  GpuType,
  ListSecretsPaginatedOrderEnum,
  ListSecretsPaginatedSortEnum,
  NotSupportedError,
  SandboxClass,
  SandboxListSortDirection,
  SandboxListSortField,
  SnapshotState,
} from "../../src/daytona/index";
import { DropInWorld } from "../drop-in-fake";

/* What @daytona/sdk 0.225.0 changed, read from its published packages on
   18 October 2026 (DAYTONA.md): only @daytona/api-client's GpuType, which
   gains B200. @daytona/sdk re-exports GpuType and its other API-client enums;
   withruntime/daytona did not, so code importing them failed to compile or
   read undefined. A GPU type on create is refused: Runtime runs CPUs. */

let world: DropInWorld;
let daytona: Daytona;
beforeEach(() => {
  world = new DropInWorld();
  daytona = new Daytona({ withruntime: { client: world.client() } });
});

describe("@daytona/sdk 0.225.0", () => {
  test("the API-client enums @daytona/sdk re-exports carry upstream's values", () => {
    expect(GpuType.B200).toBe("B200");
    expect(GpuType.RTX_PRO_6000).toBe("RTX-PRO-6000");
    expect(SnapshotState.BUILD_FAILED).toBe("build_failed");
    expect(SandboxClass.LINUX_VM).toBe("linux-vm");
    expect(SandboxListSortField.MEMORY_GIB).toBe("memoryGib");
    expect(SandboxListSortDirection.DESC).toBe("desc");
    expect(ListSecretsPaginatedSortEnum.UPDATED_AT).toBe("updatedAt");
    expect(ListSecretsPaginatedOrderEnum.ASC).toBe("asc");
  });

  test("a B200 is refused before anything is made", async () => {
    const error = await daytona
      .create({ image: "python:3.12", resources: { gpuType: GpuType.B200 } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotSupportedError);
    expect((error as Error).message).toContain("gpuType");
    expect(world.calls).toEqual([]);
  });

  test("the sort enums drive list", async () => {
    await daytona.create({ name: "b" });
    await daytona.create({ name: "a" });
    const listed = await daytona.list({
      sort: SandboxListSortField.NAME,
      order: SandboxListSortDirection.ASC,
    });
    expect(listed.items.map((one) => one.name)).toEqual(["a", "b"]);
  });
});
