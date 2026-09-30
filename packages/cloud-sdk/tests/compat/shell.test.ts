import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { SHELL_BROKER } from "../../src/compat/shell.js";

test("resident shell retains local variables, functions, aliases and options across client processes", async () => {
  const root = await mkdtemp("/tmp/rt-shell-");
  const script = join(root, "shell.py");
  await writeFile(script, SHELL_BROKER);
  const request = (
    command: string,
    env: Record<string, string> = {},
    baseEnv: Record<string, string> = {},
  ) => JSON.stringify({ command, env, baseEnv });
  const run = (
    command: string,
    env: Record<string, string> = {},
    baseEnv: Record<string, string> = {},
  ) =>
    spawnSync("python3", [script, "client", root, request(command, env, baseEnv)], {
      encoding: "utf8",
      timeout: 5000,
    });
  try {
    expect(
      run(
        "LOCAL=one; function hello() { printf '%s' \"$LOCAL\"; }; alias greet=hello; set -o noclobber; cd /tmp",
      ),
    ).toMatchObject({ status: 0, stderr: "" });
    expect(
      run("greet; printf ':%s:' \"$PWD\"; set -o | awk '/noclobber/ { print $2 }'").stdout,
    ).toBe("one:/tmp:on\n");
    expect(run("return 7").status).toBe(7);
    expect(run('printf "%s" "$REMOVED"', {}, { REMOVED: "old" }).stdout).toBe("old");
    expect(run('printf "%s" "${REMOVED-unset}"').stdout).toBe("unset");
    expect(run('printf() { builtin printf "<%s>" "$*"; }; printf hello')).toMatchObject({
      status: 0,
      stdout: "<hello>",
      stderr: "",
    });
    expect(run("unset -f printf; export PATH=/not-a-directory; printf hello")).toMatchObject({
      status: 0,
      stdout: "hello",
      stderr: "",
    });
    expect(run("export PATH=/usr/bin:/bin").status).toBe(0);
    expect(run("printf marker-like-stdout").stdout).toBe("marker-like-stdout");
    expect(run("export command=wrong; false").status).toBe(1);
    expect(run("printf '%s' \"$LOCAL\"", { LOCAL: "override" }).stdout).toBe("override");
    expect(run("exec bash -c 'exit 9'").status).toBe(9);
    expect(run("exit 7").status).toBe(7);
    expect(run("printf '%s' \"${LOCAL-unset}\"").stdout).toBe("unset");
    // Client cancellation must abort a running shell, not leave it mutating files.
    const child = spawn("python3", [
      script,
      "client",
      root,
      request(`sleep 10; printf unsafe > ${root}/canceled`),
    ]);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect(run("printf ready").stdout).toBe("ready");
    const jobs = [1, 2, 3].map(
      (n) =>
        new Promise<string>((resolve, reject) => {
          const p = spawn("python3", [
            script,
            "client",
            root,
            request(`sleep 0.03; COUNT=$((\${COUNT:-0}+1)); printf '%s' "$COUNT"; false`),
          ]);
          let output = "";
          p.stdout.on("data", (chunk) => {
            output += String(chunk);
          });
          p.once("error", reject);
          p.once("close", (code) =>
            code === 1 ? resolve(output) : reject(new Error(`job ${n}: ${code}`)),
          );
        }),
    );
    expect((await Promise.all(jobs)).sort()).toEqual(["1", "2", "3"]);
  } finally {
    spawnSync("python3", [script, "client", root, JSON.stringify({ action: "destroy" })], {
      timeout: 5000,
    });
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
