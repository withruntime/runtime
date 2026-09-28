import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { RuntimeError } from "../../src/errors";
import {
  APIError,
  AuthenticationError,
  CommandFinished,
  Drive,
  NotSupportedError,
  Sandbox,
  Snapshot,
  networkRules,
  toRuntimePath,
  type CreateSandboxParams,
} from "../../src/vercel/index";
import { pickKey } from "../../src/vercel/client";
import { DropInWorld } from "../drop-in-fake";

let world: DropInWorld;
const withruntime = () => ({ client: world.client() });
const create = (params: CreateSandboxParams = {}) =>
  Sandbox.create({ ...params, withruntime: { ...withruntime(), ...params.withruntime } });
const fake = (sandbox: Sandbox) => world.sandboxes.get(sandbox.withruntime.id)!;
const lastCreate = () => world.called("sandboxes.create").at(-1)![0] as Record<string, unknown>;
const execs = () => world.called("sandbox.exec");

beforeEach(() => {
  world = new DropInWorld();
});

describe("Sandbox.create", () => {
  test("gives Vercel's defaults: 2 vCPUs with 2048 MiB each, 5 minutes, persistent", async () => {
    const sandbox = await create();
    expect(lastCreate()).toEqual({
      vcpu: 2,
      memoryMiB: 4096,
      timeoutSeconds: 300,
      onLeaseEnd: "pause",
    });
    expect(sandbox.persistent).toBe(true);
    expect(sandbox.status).toBe("running");
    expect(sandbox.cwd).toBe("/vercel/sandbox");
    expect(world.called("images.list")).toEqual([]);
  });

  test("maps name, resources, timeout, tags, network and persistence", async () => {
    await create({
      name: "agent-1",
      resources: { vcpus: 4 },
      timeout: 600_500,
      tags: { env: "ci" },
      networkPolicy: { allow: ["*.npmjs.org", "github.com"], subnets: { deny: ["10.0.0.0/8"] } },
      persistent: false,
    });
    expect(lastCreate()).toEqual({
      vcpu: 4,
      memoryMiB: 8192,
      timeoutSeconds: 601,
      onLeaseEnd: "stop",
      name: "agent-1",
      labels: { env: "ci" },
      network: { internet: true, allow: ["*.npmjs.org", "github.com"], deny: ["10.0.0.0/8"] },
    });
  });

  test("passes Runtime-only fields over the adapter's", async () => {
    await create({ withruntime: { create: { funding: "trial", memoryMiB: 2048 } } });
    expect(lastCreate()).toMatchObject({ funding: "trial", memoryMiB: 2048, vcpu: 2 });
  });

  test("shares listed ports publicly and answers domain() from them", async () => {
    const sandbox = await create({ ports: [3000] });
    expect(world.called("previews.create")).toEqual([[3000, { visibility: "public" }]]);
    expect(sandbox.domain(3000)).toBe(
      `https://3000-${sandbox.withruntime.id.replaceAll("-", "")}.runtimehost.com`,
    );
    expect(sandbox.routes[0]).toMatchObject({ port: 3000 });
    expect(() => sandbox.domain(4000)).toThrow(/ports: \[4000\]/);
  });

  test("managed images and legacy runtimes are Runtime's stock image; other names are Runtime images", async () => {
    await create({ image: "vercel/sandbox/universal" });
    await create({ runtime: "node22" });
    expect(world.called("images.list")).toEqual([]);
    world.images.push({ id: "img-1", name: "my-repo:v1", state: "ready" });
    await create({ image: "my-repo:v1" });
    expect(lastCreate()).toMatchObject({ image: "img-1" });
    const missing = await create({ image: "other-repo" }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(NotSupportedError);
    expect((missing as Error).message).toContain("--name other-repo");
  });

  test("a snapshot source starts from the Runtime snapshot with its own shape", async () => {
    await create({ source: { type: "snapshot", snapshotId: "snap-1" } });
    expect(lastCreate()).toEqual({ snapshot: "snap-1", timeoutSeconds: 300, onLeaseEnd: "pause" });
  });

  test("a git source is cloned into the working directory, credentials by environment", async () => {
    await create({
      source: {
        type: "git",
        url: "https://github.com/a/b.git",
        depth: 1,
        username: "u",
        password: "p",
      },
    });
    const [argv, options] = execs().at(-1)!;
    expect(argv).toEqual([
      "git",
      "-c",
      'credential.helper=!f() { echo "username=$GIT_USER"; echo "password=$GIT_PASS"; }; f',
      "clone",
      "--depth",
      "1",
      "--",
      "https://github.com/a/b.git",
      "/workspace",
    ]);
    expect(options).toMatchObject({ env: { GIT_USER: "u", GIT_PASS: "p" } });
    expect(JSON.stringify(argv)).not.toContain('"p"');
  });

  test("a failed source setup stops the sandbox and throws APIError", async () => {
    world.exec = () => ({ exitCode: 128, stderr: "fatal: repository not found" });
    const error = await create({ source: { type: "tarball", url: "https://x/y.tgz" } }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(APIError);
    expect((error as Error).message).toContain("repository not found");
    expect(world.called("sandbox.stop")).toHaveLength(1);
  });

  test("snapshotExpiration becomes the paused retention in days", async () => {
    await create({ snapshotExpiration: 3 * 86_400_000 });
    expect(world.called("sandbox.retention")[0]![1]).toBe(3);
  });

  test("refuses what it cannot honour, before creating anything", async () => {
    const cases: Array<[CreateSandboxParams, RegExp]> = [
      [{ timeout: 2 * 3_600_000 }, /over one hour/],
      [{ mounts: { "/data": {} } }, /Drives/],
      [{ networkId: "net_1" }, /Secure Compute/],
      [{ region: "fra1" }, /fra1/],
      [{ failoverRegions: ["sfo1"] }, /Failover/],
      [{ runtime: "python3.9" }, /runtime python3\.9/],
      [
        { networkPolicy: { allow: { "api.github.com": [{ transform: [] }] } } },
        /transform or forward/,
      ],
    ];
    for (const [params, message] of cases) {
      const error = await create(params).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotSupportedError);
      expect((error as Error).message).toMatch(message);
      expect((error as NotSupportedError).alternative.length).toBeGreaterThan(0);
    }
    // A header rule is how Vercel injects a credential; a Runtime secret does that.
    const transform = await create({
      networkPolicy: { allow: { "api.github.com": [{ transform: [] }] } },
    }).catch((e: unknown) => e);
    expect((transform as NotSupportedError).alternative).toContain(
      "withruntime secrets set NAME --host api.github.com",
    );
    expect(world.called("sandboxes.create")).toEqual([]);
  });
});

describe("network policies", () => {
  test("allow-all, deny-all, a list, a wildcard and an empty custom policy", () => {
    expect(networkRules("allow-all")).toEqual({ internet: true });
    expect(networkRules("deny-all")).toEqual({ internet: false });
    expect(networkRules({ allow: { "pypi.org": [] } })).toEqual({
      internet: true,
      allow: ["pypi.org"],
    });
    expect(networkRules({ allow: ["*"] })).toEqual({ internet: true });
    expect(networkRules({})).toEqual({ internet: false });
    expect(networkRules({ subnets: { allow: ["1.2.3.0/24"] } })).toEqual({
      internet: true,
      allow: ["1.2.3.0/24"],
    });
  });
});

describe("keys", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test("a Vercel token is never sent", () => {
    delete process.env.RUNTIME_API_KEY;
    expect(pickKey()).toBeUndefined();
    expect(() => pickKey("vercel_oidc_token")).toThrow(AuthenticationError);
  });

  test("a Runtime key as token, then RUNTIME_API_KEY", () => {
    process.env.RUNTIME_API_KEY = "rtcloud_env";
    expect(pickKey("rtcloud_given")).toBe("rtcloud_given");
    expect(pickKey("vercel_token")).toBe("rtcloud_env");
    expect(pickKey()).toBe("rtcloud_env");
  });
});

describe("runCommand", () => {
  test("runs argv without a shell in the working directory and returns CommandFinished", async () => {
    world.exec = () => ({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
    const sandbox = await create({ env: { A: "1", B: "2" } });
    const result = await sandbox.runCommand("bash", ["-lc", "exit 3"]);
    expect(result).toBeInstanceOf(CommandFinished);
    expect(result.exitCode).toBe(3);
    expect(await result.stdout()).toBe("out\n");
    expect(await result.stderr()).toBe("err\n");
    expect(await result.output("both")).toBe("out\nerr\n");
    const [argv, options] = execs().at(-1)!;
    expect(argv).toEqual(["bash", "-lc", "exit 3"]);
    expect(options).toMatchObject({
      cwd: "/workspace",
      env: { A: "1", B: "2" },
      timeoutMs: 86_400_000,
    });
  });

  test("params form: cwd, env, sudo, timeout and piped output", async () => {
    const sandbox = await create({ env: { A: "1" } });
    const seen: string[] = [];
    const stdout = new Writable({
      write(chunk: Buffer, _encoding, done) {
        seen.push(chunk.toString());
        done();
      },
    });
    await sandbox.runCommand({
      cmd: "npm",
      args: ["install"],
      cwd: "app",
      env: { A: "2" },
      sudo: true,
      timeoutMs: 5000,
      stdout,
    });
    const [argv, options] = execs().at(-1)!;
    expect(argv).toEqual(["sudo", "--preserve-env", "npm", "install"]);
    expect(options).toMatchObject({ cwd: "/workspace/app", env: { A: "2" }, timeoutMs: 5000 });
    expect(seen.join("")).toContain("ran sudo");
  });

  test("a command past its timeout exits 137, as SIGKILL does", async () => {
    world.exec = () => ({ exitCode: null, timedOut: true });
    const sandbox = await create();
    expect((await sandbox.runCommand("sleep", ["9"], { timeoutMs: 10 })).exitCode).toBe(137);
  });

  test("detached commands stream logs, wait, and kill", async () => {
    world.output = () => [
      { type: "stdout", data: "1\n", offset: 0 },
      { type: "stderr", data: "e\n", offset: 2 },
      { type: "exit", exitCode: 0, state: "exited", timedOut: false },
    ];
    const sandbox = await create();
    const command = await sandbox.runCommand({ cmd: "npm", args: ["run", "dev"], detached: true });
    const lines = [];
    for await (const line of command.logs()) lines.push(line);
    expect(lines).toEqual([
      { stream: "stdout", data: "1\n" },
      { stream: "stderr", data: "e\n" },
    ]);
    const done = await command.wait();
    expect(done.exitCode).toBe(0);
    expect(await command.stdout()).toBe("1\n");
    await command.kill(9);
    expect(world.called("process.kill").at(-1)).toEqual([command.cmdId, "SIGKILL"]);
    expect(world.called("sandbox.spawn")[0]![0]).toEqual(["npm", "run", "dev"]);
  });

  test("getCommand finds a command by its id", async () => {
    const sandbox = await create();
    const started = await sandbox.runCommand({ cmd: "sleep", args: ["1"], detached: true });
    const found = await sandbox.getCommand(started.cmdId);
    expect(found.cmdId).toBe(started.cmdId);
  });

  test("links /vercel/sandbox to /workspace once, when a command names it", async () => {
    const sandbox = await create();
    await sandbox.runCommand("ls");
    await sandbox.runCommand("cat", ["/vercel/sandbox/a"]);
    await sandbox.runCommand("cat", ["/vercel/sandbox/b"]);
    const links = execs().filter(([command]) => String(command).includes("ln -s"));
    expect(links).toHaveLength(1);
  });

  test("a sandbox paused by its lease is woken and the command runs once more", async () => {
    const sandbox = await create();
    const runtime = fake(sandbox);
    let first = true;
    const exec = runtime.exec.bind(runtime);
    runtime.exec = async (command: string, options: Record<string, unknown> = {}) => {
      if (first) {
        first = false;
        runtime.info.state = "paused";
        throw new RuntimeError({ message: "paused", code: "sandbox_paused", status: 409 });
      }
      return exec(command, options);
    };
    const result = await sandbox.runCommand("echo", ["hi"]);
    expect(result.exitCode).toBe(0);
    expect(world.called("sandbox.wake")).toHaveLength(1);
  });
});

describe("files", () => {
  test("writeFiles makes relative paths absolute and sets modes in one command", async () => {
    const sandbox = await create();
    await sandbox.writeFiles([
      { path: "a.sh", content: "echo a", mode: 0o755 },
      { path: "/tmp/b.txt", content: new TextEncoder().encode("b") },
    ]);
    expect(fake(sandbox).fileMap.has("/workspace/a.sh")).toBe(true);
    expect(fake(sandbox).fileMap.has("/tmp/b.txt")).toBe(true);
    expect(execs().at(-1)![0]).toEqual([
      "sh",
      "-c",
      'while [ "$#" -gt 0 ]; do chmod "$1" "$2" || exit 1; shift 2; done',
      "sh",
      "755",
      "/workspace/a.sh",
    ]);
  });

  test("readFileToBuffer and readFile give null for a missing file", async () => {
    const sandbox = await create();
    await sandbox.writeFiles([{ path: "/vercel/sandbox/x.txt", content: "x" }]);
    expect((await sandbox.readFileToBuffer({ path: "x.txt" }))!.toString()).toBe("x");
    expect(await sandbox.readFileToBuffer({ path: "nope" })).toBeNull();
    expect(await sandbox.readFile({ path: "nope" })).toBeNull();
    const stream = await sandbox.readFile({ path: "x.txt" });
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("x");
  });

  test("downloadFile writes a local file, making its directories, and answers null when missing", async () => {
    const sandbox = await create();
    await sandbox.writeFiles([{ path: "out.txt", content: "data" }]);
    const dir = mkdtempSync(join(tmpdir(), "vercel-download-"));
    const written = await sandbox.downloadFile(
      { path: "out.txt" },
      { path: "nested/out.txt", cwd: dir },
      { mkdirRecursive: true },
    );
    expect(written).toBe(join(dir, "nested/out.txt"));
    expect(readFileSync(written!, "utf8")).toBe("data");
    expect(await sandbox.downloadFile({ path: "nope" }, { path: join(dir, "x") })).toBeNull();
  });

  test("fs is node:fs/promises with Node's error codes", async () => {
    const sandbox = await create();
    await sandbox.fs.writeFile("dir/a.txt", "hello");
    expect(await sandbox.fs.readFile("dir/a.txt", "utf8")).toBe("hello");
    expect(await sandbox.fs.readdir("dir")).toEqual(["a.txt"]);
    const [entry] = await sandbox.fs.readdir("dir", { withFileTypes: true });
    expect(entry!.isFile()).toBe(true);
    const stats = await sandbox.fs.stat("dir/a.txt");
    expect([stats.isFile(), stats.size]).toEqual([true, 5]);
    expect(await sandbox.fs.exists("dir/a.txt")).toBe(true);
    await sandbox.fs.appendFile("dir/a.txt", "!");
    expect(await sandbox.fs.readFile("dir/a.txt", { encoding: "utf8" })).toBe("hello!");
    const missing = (await sandbox.fs.readFile("nope").catch((e: unknown) => e)) as {
      code: string;
    };
    expect(missing.code).toBe("ENOENT");
    await sandbox.fs.rename("dir/a.txt", "dir/b.txt");
    expect(world.called("files.rename").at(-1)).toEqual([
      "/workspace/dir/a.txt",
      "/workspace/dir/b.txt",
      { overwrite: true },
    ]);
    world.exec = () => ({
      exitCode: 1,
      stderr: "rm: cannot remove 'x': No such file or directory",
    });
    expect(((await sandbox.fs.unlink("x").catch((e: unknown) => e)) as { code: string }).code).toBe(
      "ENOENT",
    );
  });

  test("paths: relative to /vercel/sandbox, which is /workspace", () => {
    expect(toRuntimePath("a/b")).toBe("/workspace/a/b");
    expect(toRuntimePath("./a")).toBe("/workspace/a");
    expect(toRuntimePath("/vercel/sandbox")).toBe("/workspace");
    expect(toRuntimePath("/vercel/sandbox/x/")).toBe("/workspace/x");
    expect(toRuntimePath("x", "sub")).toBe("/workspace/sub/x");
    expect(toRuntimePath("/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("lifecycle", () => {
  test("stop pauses a persistent sandbox and ends any other", async () => {
    const persistent = await create();
    await persistent.stop();
    expect(world.called("sandbox.pause")).toHaveLength(1);
    expect(persistent.status).toBe("stopped");
    const plain = await create({ persistent: false });
    await plain.stop();
    expect(world.called("sandbox.stop")).toHaveLength(1);
  });

  test("Sandbox.get finds by name and wakes a stopped persistent sandbox", async () => {
    const made = await create({ name: "ws" });
    await made.stop();
    const again = await Sandbox.get({ name: "ws", withruntime: withruntime() });
    expect(again.withruntime.id).toBe(made.withruntime.id);
    expect(world.called("sandbox.wake")).toHaveLength(1);
    const missing = await Sandbox.get({ name: "nope", withruntime: withruntime() }).catch(
      (e: unknown) => e,
    );
    expect(missing).toBeInstanceOf(APIError);
    expect((missing as APIError).response.status).toBe(404);
  });

  test("getOrCreate makes the named sandbox only when it is missing", async () => {
    let made = 0;
    const onCreate = async () => void made++;
    const first = await Sandbox.getOrCreate({ name: "w", onCreate, withruntime: withruntime() });
    const second = await Sandbox.getOrCreate({ name: "w", onCreate, withruntime: withruntime() });
    expect(made).toBe(1);
    expect(second.withruntime.id).toBe(first.withruntime.id);
  });

  test("delete ends it; extendTimeout moves the lease; update refuses what cannot change", async () => {
    const sandbox = await create({ ports: [3000] });
    await sandbox.extendTimeout(90_000);
    expect(world.called("sandbox.extend").at(-1)).toEqual([sandbox.withruntime.id, 90]);
    await sandbox.update({ ports: [8080], networkPolicy: "deny-all" });
    expect(world.called("previews.delete")).toEqual([[3000]]);
    expect(sandbox.domain(8080)).toContain("8080-");
    expect(world.called("network.set").at(-1)![1]).toEqual({ internet: false });
    for (const params of [{ tags: { a: "b" } }, { resources: { vcpus: 8 } }, { persistent: false }])
      expect(await sandbox.update(params).catch((e: unknown) => e)).toBeInstanceOf(
        NotSupportedError,
      );
    await sandbox.delete();
    expect(world.called("sandbox.stop")).toHaveLength(1);
  });

  test("snapshot keeps the machine, then stops the sandbox, as Vercel does", async () => {
    const sandbox = await create();
    const snapshot = await sandbox.snapshot();
    expect(snapshot).toBeInstanceOf(Snapshot);
    expect(world.snapshots.has(snapshot.snapshotId)).toBe(true);
    expect(world.called("sandbox.stop")).toHaveLength(1);
    const found = await Snapshot.get({
      snapshotId: snapshot.snapshotId,
      withruntime: withruntime(),
    });
    expect(found.status).toBe("created");
    await found.delete();
    expect(world.called("snapshots.delete")).toHaveLength(1);
  });

  test("fork copies a named sandbox and refuses overrides", async () => {
    await create({ name: "src" });
    const copy = await Sandbox.fork({
      sourceSandbox: "src",
      name: "copy",
      withruntime: withruntime(),
    });
    expect(world.called("sandbox.fork").at(-1)![1]).toEqual({ name: "copy" });
    expect(copy.withruntime.id).not.toBe("");
    expect(
      await Sandbox.fork({
        sourceSandbox: "src",
        resources: { vcpus: 4 },
        withruntime: withruntime(),
      }).catch((e: unknown) => e),
    ).toBeInstanceOf(NotSupportedError);
  });

  test("list pages through sandboxes with Vercel's paginator", async () => {
    await create({ name: "a", tags: { team: "x" } });
    await create({ name: "b" });
    const result = await Sandbox.list({ tags: { team: "x" }, withruntime: withruntime() });
    expect(result.sandboxes.map((one) => one.name)).toEqual(["a"]);
    expect(result.pagination).toEqual({ count: 1, next: null });
    const all = await (await Sandbox.list({ withruntime: withruntime() })).toArray();
    expect(all.map((one) => one.name)).toEqual(["a", "b"]);
    expect(
      await Sandbox.list({ since: 1, withruntime: withruntime() }).catch((e: unknown) => e),
    ).toBeInstanceOf(NotSupportedError);
  });
});

describe("gaps", () => {
  test("each gap throws NotSupportedError naming what to use", async () => {
    const sandbox = await create();
    const refusals = [
      () => sandbox.openInteractive(),
      () => sandbox.createUser(),
      () => sandbox.listSessions(),
      () => sandbox.listSnapshots(),
      () => Promise.resolve().then(() => sandbox.asUser()),
      () => Promise.resolve().then(() => sandbox.currentSession()),
      () => Promise.resolve().then(() => new Drive()),
      () => sandbox.delete({ deleteOrphanSnapshots: true }),
    ];
    for (const refuse of refusals) {
      const error = await refuse().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotSupportedError);
      expect((error as NotSupportedError).alternative.length).toBeGreaterThan(0);
    }
  });

  test("Runtime errors become APIError with the status, code and hint", async () => {
    const sandbox = await create();
    const runtime = fake(sandbox);
    runtime.exec = async () => {
      throw new RuntimeError({
        message: "No.",
        code: "quota_exceeded",
        status: 429,
        hint: "Wait.",
      });
    };
    const error = (await sandbox.runCommand("ls").catch((e: unknown) => e)) as APIError;
    expect(error).toBeInstanceOf(APIError);
    expect([error.response.status, error.code, error.hint]).toEqual([
      429,
      "quota_exceeded",
      "Wait.",
    ]);
    expect(error.json).toEqual({ error: { code: "quota_exceeded", message: "No." } });
  });
});
