import { expect, test } from "bun:test";
import type { Runtime } from "../../src/client.js";
import { App, CompatibilityError, Image, SandboxService } from "../../src/modal/index.js";

test("Modal unsupported region refuses before image build or sandbox allocation", async () => {
  for (const placement of ["eu-west", "us-west", "ap-south"]) {
    const calls: string[] = [];
    const runtime = {
      images: {
        async build() {
          calls.push("image build");
          return { id: "image" };
        },
      },
      sandboxes: {
        async create() {
          calls.push("sandbox create");
          throw new Error("Must not allocate");
        },
      },
    } as unknown as Runtime;
    await expect(
      new SandboxService(runtime).create(new App("app"), new Image(runtime, "ubuntu:latest"), {
        regions: [placement],
      }),
    ).rejects.toBeInstanceOf(CompatibilityError);
    expect(calls).toEqual([]);
  }
});

test("Modal default and supported region still reach image build", async () => {
  for (const regions of [undefined, ["us-east"]]) {
    const calls: string[] = [];
    const expected = new Error("controlled image build failure");
    const runtime = {
      images: {
        async build() {
          calls.push("image build");
          throw expected;
        },
      },
    } as unknown as Runtime;
    await expect(
      new SandboxService(runtime).create(new App("app"), new Image(runtime, "ubuntu:latest"), {
        regions,
      }),
    ).rejects.toBe(expected);
    expect(calls).toEqual(["image build"]);
  }
});
