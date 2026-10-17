import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { editorLaunch } from "../src/ssh";

/* `runtime sandboxes code`: a sandbox opened in VS Code, Cursor or Windsurf in
   one step, against a fake API and a fake editor program that records what it
   was handed. */

const SANDBOX = "11111111-2222-4333-8444-555555555555";
const info = {
  id: SANDBOX,
  orgId: "org-1",
  name: "web",
  labels: {},
  state: "running",
  spec: { region: "r", vcpu: 2, cpuMode: "shared", memoryMiB: 4096, diskMiB: 4096 },
  createdAt: 0,
};
const execs: string[][] = [];
let server: ReturnType<typeof Bun.serve>;
let root: string;
const keygen = spawnSync("sh", ["-c", "command -v ssh-keygen"]).stdout.toString().trim();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "runtime-editor-"));
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === `/v1/sandboxes/${SANDBOX}`)
        return Response.json(info);
      if (request.method === "GET" && path === "/v1/sandboxes")
        return Response.json({ data: [info], nextCursor: null });
      if (request.method === "POST" && path === `/v1/sandboxes/${SANDBOX}:exec`) {
        execs.push(((await request.json()) as { argv: string[] }).argv);
        return Response.json({ exitCode: 0, stdout: "/usr/sbin/sshd\n", stderr: "" });
      }
      return new Response("not here", { status: 404 });
    },
  });
});
afterAll(async () => {
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

/** A machine of its own: a home, and a PATH holding only ssh-keygen and the
 * given fake programs, each of which records its arguments. */
function machine(programs: string[]) {
  const home = mkdtempSync(join(root, "home-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  symlinkSync(keygen, join(bin, "ssh-keygen"));
  for (const name of programs) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" > "${home}/${name}.args"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PATH: bin,
    RUNTIME_API_KEY: "key",
    RUNTIME_API_URL: `http://localhost:${server.port}`,
    RUNTIME_NO_LOGIN: "1",
  };
  const lines: string[] = [];
  const out = {
    json: false,
    write: (text: string) => lines.push(text),
    error: (text: string) => lines.push(text),
  };
  const args = (name: string) =>
    existsSync(join(home, `${name}.args`))
      ? readFileSync(join(home, `${name}.args`), "utf8")
          .trim()
          .split("\n")
      : undefined;
  return { home, env, lines, out, args };
}

test("the link and program for each editor name the sandbox's ssh host", () => {
  expect(editorLaunch("vscode", SANDBOX, "/workspace")).toEqual({
    host: `${SANDBOX}.runtime`,
    bin: "code",
    args: ["--remote", `ssh-remote+${SANDBOX}.runtime`, "/workspace"],
    link: `vscode://vscode-remote/ssh-remote+${SANDBOX}.runtime/workspace`,
  });
  expect(editorLaunch("cursor", SANDBOX, "/srv/app").link).toBe(
    `cursor://vscode-remote/ssh-remote+${SANDBOX}.runtime/srv/app`,
  );
  expect(editorLaunch("windsurf", SANDBOX, "/workspace").bin).toBe("windsurf");
});

test.skipIf(!keygen)(
  "runtime sandboxes code <name>: checks for sshd, installs the ssh entry once, and starts VS Code on the remote",
  async () => {
    const m = machine(["code"]);
    execs.length = 0;
    expect(await run(["sandboxes", "code", "web"], m.env, m.out)).toBe(0);
    expect(m.args("code")).toEqual(["--remote", `ssh-remote+${SANDBOX}.runtime`, "/workspace"]);
    expect(execs[0]!.join(" ")).toContain("sshd");
    const config = readFileSync(join(m.home, ".ssh", "config"), "utf8");
    const include = `Include "${join(m.home, ".config", "runtime-cloud", "ssh", "config")}"`;
    expect(config).toBe(`${include}\n`);
    expect(
      readFileSync(join(m.home, ".config", "runtime-cloud", "ssh", "config"), "utf8"),
    ).toContain("Host *.runtime");
    expect(m.lines.join("\n")).toContain("in VS Code over SSH");
    // Again: the Include is not added twice.
    expect(await run(["sandbox", "code", SANDBOX], m.env, m.out)).toBe(0);
    expect(readFileSync(join(m.home, ".ssh", "config"), "utf8")).toBe(`${include}\n`);
  },
);

test.skipIf(!keygen)("--editor cursor --path starts Cursor on that folder", async () => {
  const m = machine(["cursor", "code"]);
  expect(
    await run(
      ["sandboxes", "code", "web", "--editor", "cursor", "--path", "/srv/app"],
      m.env,
      m.out,
    ),
  ).toBe(0);
  expect(m.args("cursor")).toEqual(["--remote", `ssh-remote+${SANDBOX}.runtime`, "/srv/app"]);
  expect(m.args("code")).toBeUndefined();
});

test.skipIf(!keygen)("--print --json gives the link and starts nothing", async () => {
  const m = machine(["code"]);
  m.out.json = true;
  expect(await run(["sandboxes", "code", "web", "--print", "--json"], m.env, m.out)).toBe(0);
  expect(m.args("code")).toBeUndefined();
  expect(JSON.parse(m.lines.at(-1)!)).toEqual({
    sandboxId: SANDBOX,
    editor: "vscode",
    host: `${SANDBOX}.runtime`,
    path: "/workspace",
    link: `vscode://vscode-remote/ssh-remote+${SANDBOX}.runtime/workspace`,
    opened: false,
  });
});

test.skipIf(!keygen || process.platform !== "linux")(
  "with no editor program, the link opens through the desktop's opener",
  async () => {
    const m = machine(["xdg-open"]);
    expect(await run(["sandboxes", "code", "web", "--editor", "windsurf"], m.env, m.out)).toBe(0);
    expect(m.args("xdg-open")).toEqual([
      `windsurf://vscode-remote/ssh-remote+${SANDBOX}.runtime/workspace`,
    ]);
  },
);

test.skipIf(!keygen || process.platform !== "linux")(
  "with neither, it says so, prints the link and the command, and exits 1",
  async () => {
    const m = machine([]);
    expect(await run(["sandboxes", "code", "web"], m.env, m.out)).toBe(1);
    const said = m.lines.join("\n");
    expect(said).toContain("Could not start code or open a link here.");
    expect(said).toContain(`vscode://vscode-remote/ssh-remote+${SANDBOX}.runtime/workspace`);
    expect(said).toContain(`code --remote ssh-remote+${SANDBOX}.runtime /workspace`);
  },
);

test("an editor it does not know is refused before any call", async () => {
  const m = machine([]);
  const code = await run(["sandboxes", "code", "web", "--editor", "emacs"], m.env, m.out).catch(
    (error: Error) => error,
  );
  const said = code instanceof Error ? code.message : m.lines.join("\n");
  expect(said).toContain("emacs is not an editor this opens.");
});
