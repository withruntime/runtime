/* global Bun, process, URL */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The registry is contacted only to install these frozen packages. The actual
// oracle denies vendor network access and never reads a vendor credential.
let owned;
try {
  const official =
    process.env.RUNTIME_ORACLE_OFFICIAL_ROOT ??
    (owned = await mkdtemp(join(tmpdir(), "runtime-compat-oracle-")));
  if (owned) {
    for (const name of ["package.json", "bun.lock"])
      await copyFile(new URL(name, import.meta.url), join(owned, name));
    const install = Bun.spawn(
      [process.execPath, "install", "--ignore-scripts", "--frozen-lockfile"],
      {
        cwd: owned,
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    if (await install.exited) throw new Error("Pinned oracle package installation failed.");
  }
  const run = Bun.spawn([process.execPath, fileURLToPath(new URL("run.mjs", import.meta.url))], {
    env: { ...process.env, RUNTIME_ORACLE_OFFICIAL_ROOT: official },
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await run.exited;
} finally {
  if (owned) await rm(owned, { recursive: true, force: true });
}
