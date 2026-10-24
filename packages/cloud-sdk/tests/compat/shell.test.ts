import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
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
  // A client process for the first command, which starts the broker, and for
  // one later, so state is shown to outlive its client; every other command
  // speaks the client's protocol on the socket itself, as a python3 client
  // each took 50 ms of the test's 1.2 s (24 October 2026).
  const client = (command: string) =>
    spawnSync("python3", [script, "client", root, request(command)], {
      encoding: "utf8",
      timeout: 5000,
    });
  const connect = (command: string, env: Record<string, string> = {}, baseEnv = {}) => {
    const socket = createConnection(join(root, "socket"));
    socket.write(
      JSON.stringify({ command, env, baseEnv, initialEnv: process.env, initialCwd: root }) + "\n",
    );
    return socket;
  };
  const run = (command: string, env: Record<string, string> = {}, baseEnv = {}) =>
    new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
      const socket = connect(command, env, baseEnv);
      const out = { status: -1, stdout: "", stderr: "" };
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
          const event = JSON.parse(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
          if (event.type === "exit") out.status = event.code;
          else if (event.type === "error") reject(new Error(event.message));
          else out[event.type as "stdout" | "stderr"] += atob(event.base64);
        }
      });
      socket.once("error", reject);
      socket.once("close", () => resolve(out));
    });
  try {
    expect(
      client(
        "LOCAL=one; function hello() { printf '%s' \"$LOCAL\"; }; alias greet=hello; set -o noclobber; cd /tmp",
      ),
    ).toMatchObject({ status: 0, stderr: "" });
    expect(
      client("greet; printf ':%s:' \"$PWD\"; set -o | awk '/noclobber/ { print $2 }'").stdout,
    ).toBe("one:/tmp:on\n");
    expect((await run("return 7")).status).toBe(7);
    expect((await run('printf "%s" "$REMOVED"', {}, { REMOVED: "old" })).stdout).toBe("old");
    expect((await run('printf "%s" "${REMOVED-unset}"')).stdout).toBe("unset");
    expect(await run('printf() { builtin printf "<%s>" "$*"; }; printf hello')).toMatchObject({
      status: 0,
      stdout: "<hello>",
      stderr: "",
    });
    expect(await run("unset -f printf; export PATH=/not-a-directory; printf hello")).toMatchObject({
      status: 0,
      stdout: "hello",
      stderr: "",
    });
    expect((await run("export PATH=/usr/bin:/bin")).status).toBe(0);
    expect((await run("printf marker-like-stdout")).stdout).toBe("marker-like-stdout");
    expect((await run("export command=wrong; false")).status).toBe(1);
    expect((await run("printf '%s' \"$LOCAL\"", { LOCAL: "override" })).stdout).toBe("override");
    expect((await run("exec bash -c 'exit 9'")).status).toBe(9);
    expect((await run("exit 7")).status).toBe(7);
    expect((await run("printf '%s' \"${LOCAL-unset}\"")).stdout).toBe("unset");
    // Client cancellation must abort a running shell, not leave it mutating files.
    const canceled = connect(`printf started; sleep 10; printf unsafe > ${root}/canceled`);
    await new Promise((resolve) => canceled.once("data", resolve));
    canceled.destroy();
    expect((await run("printf ready")).stdout).toBe("ready");
    expect(existsSync(join(root, "canceled"))).toBe(false);
    // Clients at once are served one after another, each seeing the last's state.
    const jobs = [1, 2, 3].map(() =>
      run(`COUNT=$((\${COUNT:-0}+1)); printf '%s' "$COUNT"; false`).then((out) => {
        expect(out.status).toBe(1);
        return out.stdout;
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
