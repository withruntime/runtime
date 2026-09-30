import { expect, test } from "bun:test";
import { Daytona, resolvePath } from "../src/daytona/index";
import { Sandbox, toRuntimePath } from "../src/vercel/index";
import { DropInWorld } from "./drop-in-fake";

for (const path of [".env", ".git/config", "..hidden", "../outside", "./.env"])
  test(`Daytona and Vercel preserve dot components in ${path}`, async () => {
    const suffix = path.startsWith("./") ? path.slice(2) : path;
    expect(resolvePath(path)).toBe(`/workspace/${suffix}`);
    expect(toRuntimePath(path)).toBe(`/workspace/${suffix}`);
    expect(toRuntimePath(path, ".config")).toBe(`/workspace/.config/${suffix}`);
    const world = new DropInWorld();
    const daytona = await new Daytona({ withruntime: { client: world.client() } }).create();
    await daytona.fs.uploadFile(Buffer.from("daytona"), path);
    const vercel = await Sandbox.create({ withruntime: { client: world.client() } });
    await vercel.fs.writeFile(path, "vercel");
    const writes = world.called("files.write");
    expect(writes.map(([destination]) => destination)).toEqual([
      `/workspace/${suffix}`,
      `/workspace/${suffix}`,
    ]);
  });

test("Daytona and Vercel resolve the current directory to the working directory itself", () => {
  // Keeping dotfiles intact must not turn "." into a "/workspace/." path.
  for (const path of [".", "./", "", "./."]) {
    expect(resolvePath(path)).toBe("/workspace");
    expect(toRuntimePath(path)).toBe("/workspace");
    expect(toRuntimePath(path, ".config")).toBe("/workspace/.config");
    expect(toRuntimePath("a", path)).toBe("/workspace/a");
  }
});
