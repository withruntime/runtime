/** Install dependency trees around copied, pinned official packages. The verified
 * cache is read-only; package lifecycle scripts never execute. The target's Bun
 * lockfile records the dependency resolution for replay. */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { prepare } from "../../scripts/prepare-compatibility.js";
import type { CompatibilityLock } from "../../scripts/check-upstream.js";
const cache = process.argv[2],
  targetArg = process.argv[3];
if (!cache || !targetArg)
  throw new Error("Usage: prepare-runtime.ts <verified-cache> <isolated-runtime-directory>");
const target = resolve(targetArg);
if (target === resolve(cache) || target.startsWith(resolve(cache) + "/"))
  throw new Error("Runtime directory must be outside the immutable cache");
const lock = JSON.parse(
  await readFile(new URL("../../compatibility-lock.json", import.meta.url), "utf8"),
) as CompatibilityLock;
await mkdir(join(target, "packages"), { recursive: true });
const dependencies: Record<string, string> = { miniflare: "4.20260730.0" };
for (const id of ["runloop", "codesandbox", "sprites", "freestyle", "modal", "cloudflare"]) {
  const pin = lock.providers.find((p) => p.id === id)?.upstreams.find((p) => p.registry === "npm");
  if (!pin) throw new Error(`No npm pin for ${id}`);
  const source = join(await prepare(pin, cache), "package");
  const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as {
    name: string;
    version: string;
    devDependencies?: unknown;
  };
  if (pkg.name !== pin.name || pkg.version !== pin.version)
    throw new Error(`${id}: cache pin mismatch`);
  await cp(source, join(target, "packages", id), { recursive: true, errorOnExist: false });
  // Local file packages make Bun resolve development dependencies even with --production.
  // These are build-only; the published JS is already built. Keep artifact source untouched.
  delete pkg.devDependencies;
  await writeFile(
    join(target, "packages", id, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
  );
  dependencies[pin.name] = `file:./packages/${id}`;
}
await writeFile(
  join(target, "package.json"),
  JSON.stringify(
    { name: "runtime-compatibility-reference", private: true, type: "module", dependencies },
    null,
    2,
  ) + "\n",
);
await cp(new URL("./reference.bun.lock", import.meta.url), join(target, "bun.lock"));
const install = Bun.spawn(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], {
  cwd: target,
  stdout: "inherit",
  stderr: "inherit",
});
if (await install.exited) throw new Error("Reference dependency installation failed");
console.log(`Pinned reference packages ready in ${target}; preserve bun.lock for repeatability.`);
