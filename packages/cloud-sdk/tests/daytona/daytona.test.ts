import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeError } from "../../src/errors";
import type { DaytonaError } from "../../src/daytona/index";
import {
  Daytona,
  DaytonaAuthenticationError,
  DaytonaCommandAlreadyCompletedError,
  DaytonaConflictError,
  DaytonaFileNotFoundError,
  DaytonaNotFoundError,
  DaytonaProcessExecutionTimeoutError,
  DaytonaRateLimitError,
  Image,
  NotSupportedError,
  lifecycleOf,
  resolvePath,
  type CreateSandboxFromSnapshotParams,
} from "../../src/daytona/index";
import { clientFor, pickKey } from "../../src/daytona/client";
import { DropInWorld } from "../drop-in-fake";

let world: DropInWorld;
let daytona: Daytona;
const lastCreate = () => world.called("sandboxes.create").at(-1)![0] as Record<string, unknown>;
const execs = () => world.called("sandbox.exec");
const fake = (id: string) => world.sandboxes.get(id)!;

beforeEach(() => {
  world = new DropInWorld();
  daytona = new Daytona({ withruntime: { client: world.client() } });
});

describe("daytona.create", () => {
  test("gives Daytona's defaults: 1 vCPU, 1 GiB, 3 GiB, pausing after 15 idle minutes", async () => {
    const sandbox = await daytona.create();
    expect(lastCreate()).toEqual({
      vcpu: 1,
      memoryMiB: 1024,
      diskMiB: 3072,
      timeoutSeconds: 900,
      onLeaseEnd: "pause",
    });
    expect([sandbox.state, sandbox.cpu, sandbox.user, sandbox.autoStopInterval]).toEqual([
      "started",
      1,
      "daytona",
      15,
    ]);
  });

  test("maps resources, name, labels, network, volumes and lifecycle", async () => {
    world.volumes.push({
      id: "11111111-2222-4333-8444-555555555555",
      name: "data",
      state: "ready",
    });
    await daytona.create({
      name: "agent",
      labels: { team: "x" },
      resources: { cpu: 2, memory: 4, disk: 10 },
      autoStopInterval: 30,
      networkAllowList: "10.0.0.0/8",
      domainAllowList: "pypi.org, github.com",
      volumes: [{ volumeId: "data", mountPath: "/data" }],
    });
    expect(lastCreate()).toEqual({
      vcpu: 2,
      memoryMiB: 4096,
      diskMiB: 10240,
      timeoutSeconds: 1800,
      onLeaseEnd: "pause",
      name: "agent",
      labels: { team: "x" },
      network: { internet: true, allow: ["10.0.0.0/8", "pypi.org", "github.com"] },
      volumes: [{ volumeId: "11111111-2222-4333-8444-555555555555", path: "/data" }],
    });
  });

  test("ephemeral sandboxes stop at the end of the lease; autoDeleteInterval sets retention", async () => {
    await daytona.create({ ephemeral: true, networkBlockAll: true });
    expect(lastCreate()).toMatchObject({ onLeaseEnd: "stop", network: { internet: false } });
    await daytona.create({ autoDeleteInterval: 60 * 24 * 3 });
    expect(world.called("sandbox.retention").at(-1)![1]).toBe(3);
  });

  test("lifecycle: autoStop 0 is an hour, renewed; ttl caps it", () => {
    expect(lifecycleOf({ autoStopInterval: 0 }).windowSeconds).toBe(3600);
    expect(lifecycleOf({ autoStopInterval: 120 }).windowSeconds).toBe(3600);
    expect(lifecycleOf({ autoPauseInterval: 5 }).windowSeconds).toBe(300);
    expect(lifecycleOf({ ttlMinutes: 10 }).deadline).toBeGreaterThan(Date.now());
    expect(lifecycleOf({ autoDeleteInterval: 0 }).ephemeral).toBe(true);
  });

  test("Daytona snapshot names: stock, a Runtime image, a Runtime snapshot, or a clear miss", async () => {
    await daytona.create({ snapshot: "daytona-medium" });
    expect(lastCreate()).not.toHaveProperty("image");
    world.images.push({ id: "img-1", name: "my-env", state: "ready" });
    await daytona.create({ snapshot: "my-env" });
    expect(lastCreate()).toMatchObject({ image: "img-1" });
    world.namedSnapshots.push({ id: "snap-9", name: "saved", state: "ready" });
    await daytona.create({ snapshot: "saved" });
    expect(lastCreate()).toEqual({ snapshot: "snap-9", timeoutSeconds: 900, onLeaseEnd: "pause" });
    const error = await daytona.create({ snapshot: "unknown" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaytonaNotFoundError);
    expect((error as Error).message).toContain("daytona.snapshot.create");
  });

  test("an image reference is built once as a Runtime image and reused", async () => {
    await daytona.create({ image: "python:3.12-slim" });
    expect(world.called("images.build")[0]![0]).toEqual({
      name: "python-3.12-slim",
      image: "python:3.12-slim",
    });
    expect(lastCreate()).toMatchObject({ image: world.images[0]!.id, vcpu: 1 });
    await daytona.create({ image: "python:3.12-slim" });
    expect(world.called("images.build")).toHaveLength(1);
  });

  test("a declarative Image becomes a Dockerfile build with its local files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daytona-image-"));
    writeFileSync(join(dir, "requirements.txt"), "requests\n");
    const image = Image.debianSlim("3.12")
      .pipInstall(["numpy", "pandas"])
      .pipInstallFromRequirements(join(dir, "requirements.txt"))
      .runCommands("echo hi")
      .env({ A: "1" })
      .workdir("/app");
    const logs: string[] = [];
    await daytona.create({ image }, { onSnapshotCreateLogs: (chunk) => void logs.push(chunk) });
    const input = world.called("images.build")[0]![0] as {
      dockerfile: string;
      files: { path: string }[];
      name: string;
    };
    expect(input.dockerfile).toContain("FROM python:3.12-slim-bookworm");
    expect(input.dockerfile).toContain('RUN python -m pip install "numpy" "pandas"');
    expect(input.dockerfile).toContain('ENV A="1"');
    expect(input.dockerfile).toContain("WORKDIR /app");
    expect(input.files).toHaveLength(1);
    expect(input.name).toMatch(/^daytona-image-[0-9a-f]{16}$/);
  });

  test("refuses what it cannot honour, before creating anything", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ resources: { gpu: 1 } }, /GPUs/],
      [{ spot: true }, /Spot/],
      [{ linkedSandbox: "x" }, /Linked/],
      [{ secrets: { A: "s" } }, /secrets/],
      [{ language: "rust" }, /language rust/],
      [{ otelEndpointOverride: "http://x" }, /telemetry/],
    ];
    for (const [params, message] of cases) {
      const error = await daytona
        .create(params as CreateSandboxFromSnapshotParams)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotSupportedError);
      expect((error as Error).message).toMatch(message);
    }
    expect(() => pickImage()).toThrow(NotSupportedError);
    expect(world.called("sandboxes.create")).toEqual([]);
    function pickImage() {
      return Image.base("x").pipInstallFromPyproject();
    }
  });

  test("unsupported GPU preferences and volume subpaths fail before image builds or lookups", async () => {
    const cases = [
      { resources: { gpuType: "a100" } },
      { resources: { gpu: 0, gpuType: ["a100", "h100"] } },
      { volumes: [{ volumeId: "data", mountPath: "/data", subpath: "private" }] },
      {
        volumes: [
          { volumeId: "first", mountPath: "/first" },
          { volumeId: "data", mountPath: "/data", subpath: "private" },
        ],
      },
    ];
    for (const params of cases) {
      await expect(daytona.create({ image: "python:3.12-slim", ...params })).rejects.toBeInstanceOf(
        NotSupportedError,
      );
      expect(world.calls).toEqual([]);
    }
  });

  test("omitted and empty GPU preferences retain CPU create defaults", async () => {
    for (const resources of [{}, { gpu: 0 }, { gpuType: [] }, { gpuType: null }]) {
      await daytona.create({ resources });
      expect(lastCreate()).toEqual({
        vcpu: 1,
        memoryMiB: 1024,
        diskMiB: 3072,
        timeoutSeconds: 900,
        onLeaseEnd: "pause",
      });
    }
  });

  test("explicit snapshot regions fail before image lookup or build", async () => {
    await expect(
      daytona.snapshot.create({ name: "placed", image: "python:3.12-slim", regionId: "us" }),
    ).rejects.toBeInstanceOf(NotSupportedError);
    expect(world.calls).toEqual([]);
    // The pinned SDK treats an empty region as its configured default.
    await daytona.snapshot.create({ name: "default", image: "python:3.12-slim", regionId: "" });
    expect(world.called("images.build")).toHaveLength(1);
  });
});

describe("keys and configuration", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test("a Daytona key is never sent", () => {
    delete process.env.RUNTIME_API_KEY;
    process.env.DAYTONA_API_KEY = "dtn_abc";
    expect(pickKey()).toBeUndefined();
    expect(() => pickKey("dtn_abc")).toThrow(DaytonaAuthenticationError);
  });

  test("a Runtime key given, then RUNTIME_API_KEY, then a Runtime key in DAYTONA_API_KEY", () => {
    process.env.RUNTIME_API_KEY = "rtcloud_env";
    process.env.DAYTONA_API_KEY = "rtcloud_other";
    expect(pickKey("rtcloud_given")).toBe("rtcloud_given");
    expect(pickKey("dtn_abc")).toBe("rtcloud_env");
    delete process.env.RUNTIME_API_KEY;
    expect(pickKey()).toBe("rtcloud_other");
  });

  test("the us target and Daytona's API address are accepted; other targets and JWTs are refused", () => {
    const client = world.client();
    expect(
      clientFor({ target: "us", apiUrl: "https://app.daytona.io/api", withruntime: { client } }),
    ).toBe(client);
    expect(() => clientFor({ target: "eu", withruntime: { client } })).toThrow(NotSupportedError);
    expect(() =>
      clientFor({ jwtToken: "j", organizationId: "o", withruntime: { client } }),
    ).toThrow(NotSupportedError);
  });
});

describe("process", () => {
  test("executeCommand returns combined output and a non-zero exit as a result", async () => {
    world.exec = () => ({ exitCode: 2, stdout: "out\nerr\n" });
    const sandbox = await daytona.create({ envVars: { A: "1" } });
    const response = await sandbox.process.executeCommand("ls", "src", { B: "2" }, 5);
    expect(response).toEqual({
      exitCode: 2,
      result: "out\nerr\n",
      artifacts: { stdout: "out\nerr\n" },
    });
    const [command, options] = execs().at(-1)!;
    expect(command).toBe("{ ls\n} 2>&1");
    expect(options).toMatchObject({
      cwd: "/workspace/src",
      env: { A: "1", B: "2" },
      timeoutMs: 5000,
    });
  });

  test("executeCommand, codeRun and findFiles return the whole output, past the 64 KiB an exec result holds", async () => {
    const big = `${"x".repeat(70_000)}\n`;
    world.exec = (command) =>
      String(command).startsWith("grep")
        ? { exitCode: 0, stdout: "/workspace/a.py:1:x\n".repeat(4_000) }
        : { exitCode: 0, stdout: big };
    const sandbox = await daytona.create();
    // A timeout of a minute or less is an exec that is not otherwise streamed.
    expect((await sandbox.process.executeCommand("cat big", undefined, undefined, 30)).result).toBe(
      big,
    );
    expect((await sandbox.process.codeRun("print('x'*70000)", {}, 30)).result).toBe(big);
    expect(await sandbox.fs.findFiles(".", "x")).toHaveLength(4_000);
  });

  test("a timeout throws DaytonaProcessExecutionTimeoutError", async () => {
    world.exec = () => ({ exitCode: null, timedOut: true });
    const sandbox = await daytona.create();
    expect(
      await sandbox.process
        .executeCommand("sleep 9", undefined, undefined, 1)
        .catch((e: unknown) => e),
    ).toBeInstanceOf(DaytonaProcessExecutionTimeoutError);
  });

  test("codeRun runs the sandbox's language", async () => {
    const python = await daytona.create();
    await python.process.codeRun("print(1)", { argv: ["a"] });
    expect(execs().at(-1)![0]).toEqual([
      "sh",
      "-c",
      'exec "$@" 2>&1',
      "sh",
      "python3",
      "-c",
      "print(1)",
      "a",
    ]);
    const ts = await daytona.create({ language: "typescript" });
    expect(lastCreate().labels).toEqual({ "code-toolbox-language": "typescript" });
    await ts.process.codeRun("console.log(1)");
    expect((execs().at(-1)![0] as string[]).slice(4, 6)).toEqual(["bun", "-e"]);
    // Found again later, the sandbox keeps its language, as Daytona's label does.
    await (await daytona.get(ts.id)).process.codeRun("console.log(2)");
    expect((execs().at(-1)![0] as string[]).slice(4, 6)).toEqual(["bun", "-e"]);
  });

  test("links /home/daytona to /workspace once, when something names it", async () => {
    const sandbox = await daytona.create();
    await sandbox.process.executeCommand("ls /home/daytona");
    await sandbox.fs.uploadFile(Buffer.from("x"), "/home/daytona/a.txt");
    const links = execs().filter(([command]) => String(command).includes("ln -s"));
    expect(links).toEqual([["[ -e /home/daytona ] || sudo ln -s /workspace /home/daytona", {}]]);
  });

  test("sessions run commands in one bash, one at a time, with markers and exit codes", async () => {
    world.output = () => [{ type: "stdout", data: "", offset: 0 }];
    const sandbox = await daytona.create();
    await sandbox.process.createSession("s1");
    const spawned = world.called("sandbox.spawn")[0]!;
    expect(spawned[0]).toEqual(["bash", "--noprofile", "--norc", "-s", "daytona-session:s1"]);
    expect(spawned[1]).toMatchObject({ stdin: "pipe", cwd: "/workspace" });
    const shell = fake(sandbox.id).processList[0]!;
    // The shell answers each command line with its output and the markers.
    const events: Array<{ type: "stdout" | "stderr"; data: string; offset: number }> = [];
    const written = shell.write.bind(shell);
    shell.write = async (data: string | Uint8Array, options: { eof?: boolean } = {}) => {
      await written(data, options);
      const line = String(data);
      const match = /^__rt_run (\S+) (\S+)\n$/.exec(line);
      if (!match) return;
      const command = Buffer.from(match[1]!, "base64").toString();
      const id = match[2]!;
      const code = command === "false" ? 1 : 0;
      events.push(
        { type: "stdout", data: `ran ${command}\n\x1eRT${id}:${code}`, offset: 0 },
        { type: "stdout", data: "\x1e", offset: 0 },
        { type: "stderr", data: `\x1eRT${id}\x1e`, offset: 0 },
      );
    };
    shell.output = async function* () {
      while (!events.length) await new Promise((resolve) => setTimeout(resolve, 1));
      yield* events.splice(0);
    };
    const result = await sandbox.process.executeSessionCommand("s1", { command: "cd /tmp && pwd" });
    expect(result).toMatchObject({
      output: "ran cd /tmp && pwd\n",
      stdout: "ran cd /tmp && pwd\n",
      stderr: "",
      exitCode: 0,
    });
    const failed = await sandbox.process.executeSessionCommand("s1", { command: "false" });
    expect(failed.exitCode).toBe(1);
    const background = await sandbox.process.executeSessionCommand("s1", {
      command: "npm run dev",
      runAsync: true,
    });
    const seen: string[] = [];
    await sandbox.process.getSessionCommandLogs(
      "s1",
      background.cmdId!,
      (chunk) => void seen.push(chunk),
      () => {},
    );
    expect(seen.join("")).toBe("ran npm run dev\n");
    expect(await sandbox.process.getSessionCommand("s1", background.cmdId!)).toMatchObject({
      exitCode: 0,
    });
    expect((await sandbox.process.getSession("s1")).commands).toHaveLength(3);
    expect(
      await sandbox.process
        .sendSessionCommandInput("s1", background.cmdId!, "y\n")
        .catch((e: unknown) => e),
    ).toBeInstanceOf(DaytonaCommandAlreadyCompletedError);
    expect(await sandbox.process.createSession("s1").catch((e: unknown) => e)).toBeInstanceOf(
      DaytonaConflictError,
    );
    await sandbox.process.deleteSession("s1");
    expect(world.called("process.kill").at(-1)).toEqual([shell.id, "SIGKILL"]);
    expect(await sandbox.process.getSession("s1").catch((e: unknown) => e)).toBeInstanceOf(
      DaytonaNotFoundError,
    );
  });

  test("the entrypoint session is refused with the alternative", async () => {
    const sandbox = await daytona.create();
    for (const refuse of [
      () => sandbox.process.getEntrypointSession(),
      () => sandbox.process.getEntrypointLogs(),
    ])
      expect(await refuse().catch((e: unknown) => e)).toBeInstanceOf(NotSupportedError);
  });

  test("secrets, metrics, SSH and telemetry refusals point at what Runtime has", async () => {
    const sandbox = await daytona.create();
    const alternative = async (refuse: () => Promise<unknown>) =>
      ((await refuse().catch((e: unknown) => e)) as NotSupportedError).alternative;
    expect(await alternative(() => sandbox.updateSecrets())).toContain("withruntime secrets set");
    expect(await alternative(() => sandbox.getMetrics())).toContain("sandbox.withruntime.metrics(");
    expect(await alternative(() => sandbox.createSshAccess())).toContain("withruntime sandbox ssh");
    expect(await alternative(() => daytona.create({ secrets: { A: "b" } }))).toContain(
      "withruntime secrets set",
    );
    expect(
      await alternative(() => daytona.create({ otelEndpointOverride: "https://otel.example.com" })),
    ).toContain("runtime.otel.create()");
  });
});

describe("fs and git", () => {
  test("upload, download, list, details, move, replace and delete", async () => {
    const sandbox = await daytona.create();
    await sandbox.fs.uploadFile(Buffer.from("hello world"), "docs/a.txt");
    await sandbox.fs.uploadFiles([{ source: Buffer.from("b"), destination: "/tmp/b.txt" }]);
    expect((await sandbox.fs.downloadFile("docs/a.txt")).toString()).toBe("hello world");
    expect((await sandbox.fs.listFiles("docs")).map((one) => one.name)).toEqual(["a.txt"]);
    expect(await sandbox.fs.getFileDetails("docs/a.txt")).toMatchObject({
      isDir: false,
      size: 11,
      permissions: "0755",
    });
    await sandbox.fs.replaceInFiles(["docs/a.txt"], "world", "there");
    expect((await sandbox.fs.downloadFile("docs/a.txt")).toString()).toBe("hello there");
    await sandbox.fs.moveFiles("docs/a.txt", "docs/c.txt");
    expect(await sandbox.fs.downloadFile("docs/a.txt").catch((e: unknown) => e)).toBeInstanceOf(
      DaytonaFileNotFoundError,
    );
    const results = await sandbox.fs.downloadFiles([{ source: "docs/c.txt" }, { source: "nope" }]);
    expect(results[0]!.result!.toString()).toBe("hello there");
    expect(results[1]!.error).toContain("does not exist");
    await sandbox.fs.deleteFile("docs", true);
    expect(world.called("files.remove").at(-1)).toEqual(["/workspace/docs", { recursive: true }]);
  });

  test("downloadFile to a local path writes the file there, making its directories", async () => {
    const sandbox = await daytona.create();
    await sandbox.fs.uploadFile(Buffer.from("data"), "out.txt");
    const target = join(mkdtempSync(join(tmpdir(), "daytona-download-")), "nested", "out.txt");
    await sandbox.fs.downloadFile("out.txt", target);
    expect(readFileSync(target, "utf8")).toBe("data");
  });

  test("findFiles parses grep; createFolder sets its mode", async () => {
    world.exec = (command) =>
      String(command).startsWith("grep")
        ? { exitCode: 0, stdout: "/workspace/a.py:3:import os\n" }
        : { exitCode: 0 };
    const sandbox = await daytona.create();
    expect(await sandbox.fs.findFiles(".", "import")).toEqual([
      { file: "/workspace/a.py", line: 3, content: "import os" },
    ]);
    await sandbox.fs.createFolder("out", "755");
    expect(execs().at(-1)![0]).toEqual(["mkdir", "-p", "-m", "755", "--", "/workspace/out"]);
  });

  test("git clone passes credentials through the environment, never the command line", async () => {
    const sandbox = await daytona.create();
    await sandbox.git.clone(
      "https://github.com/a/b.git",
      "repo",
      "main",
      undefined,
      "user",
      "secret",
    );
    const [argv, options] = execs().at(-1)!;
    expect(argv).toContain("--branch");
    expect(argv).toContain("/workspace/repo");
    expect(JSON.stringify(argv)).not.toContain("secret");
    expect(options).toMatchObject({ env: { GIT_USER: "user", GIT_PASS: "secret" } });
  });

  test("paths resolve from the working directory", () => {
    expect(resolvePath("a")).toBe("/workspace/a");
    expect(resolvePath("~/a")).toBe("/workspace/a");
    expect(resolvePath("/etc")).toBe("/etc");
  });
});

describe("lifecycle", () => {
  test("stop pauses, start wakes, delete ends; an ephemeral stop ends", async () => {
    const sandbox = await daytona.create();
    await sandbox.stop();
    expect(sandbox.state).toBe("stopped");
    await sandbox.start();
    expect(world.called("sandbox.wake").at(-1)![1]).toEqual({ timeoutSeconds: 900 });
    await sandbox.delete();
    expect(world.called("sandbox.stop")).toHaveLength(1);
    const ephemeral = await daytona.create({ ephemeral: true });
    await ephemeral.stop();
    expect(world.called("sandbox.pause")).toHaveLength(1);
    expect(world.called("sandbox.stop")).toHaveLength(2);
  });

  test("a call close to the end of the lease moves it on (activity)", async () => {
    const sandbox = await daytona.create();
    const runtime = fake(sandbox.id);
    runtime.info.expiresAt = new Date(Date.now() + 60_000).toISOString();
    await sandbox.process.executeCommand("true");
    const [, seconds] = world.called("sandbox.extend").at(-1)!;
    expect(seconds as number).toBeGreaterThanOrEqual(839);
    await sandbox.process.executeCommand("true");
    expect(world.called("sandbox.extend")).toHaveLength(1);
  });

  test("get by id or name, list by labels and state, the old awaited shape", async () => {
    const made = await daytona.create({ name: "one", labels: { a: "b" } });
    await daytona.create({ name: "two" });
    expect((await daytona.get(made.id)).id).toBe(made.id);
    expect((await daytona.get("one")).id).toBe(made.id);
    expect(await daytona.get("none").catch((e: unknown) => e)).toBeInstanceOf(DaytonaNotFoundError);
    const listed = [];
    for await (const one of daytona.list({ labels: { a: "b" } })) listed.push(one.id);
    expect(listed).toEqual([made.id]);
    const paged = await daytona.list();
    expect(paged.items).toHaveLength(2);
    expect(() => daytona.list({ isPublic: true })).toThrow(NotSupportedError);
  });

  test("preview links, fork and snapshots", async () => {
    const sandbox = await daytona.create({ public: true });
    const link = await sandbox.getPreviewLink(3000);
    expect(world.called("previews.create").at(-1)).toEqual([3000, { visibility: "public" }]);
    expect(link.url).toBe(`https://3000-${sandbox.id.replaceAll("-", "")}.runtimehost.com`);
    const copy = await sandbox.fork({ name: "copy" });
    expect(copy.id).not.toBe(sandbox.id);
    await sandbox.createSnapshot("saved");
    expect(world.called("sandbox.snapshot").at(-1)![1]).toEqual({ name: "saved" });
  });

  test("the snapshot service builds, finds and deletes Runtime images", async () => {
    const made = await daytona.snapshot.create({ name: "my env", image: "node:22" });
    expect(world.called("images.build")[0]![0]).toEqual({ name: "my-env", image: "node:22" });
    expect((await daytona.snapshot.get("my env")).id).toBe(made.id);
    expect((await daytona.snapshot.list()).total).toBe(1);
    await daytona.snapshot.delete("my env");
    expect(world.called("images.delete")).toEqual([[made.id]]);
    expect(
      await daytona.snapshot
        .create({ name: "x", image: "y", resources: { cpu: 2 } })
        .catch((e: unknown) => e),
    ).toBeInstanceOf(NotSupportedError);
  });
});

describe("errors and gaps", () => {
  test("Runtime errors become Daytona's classes with the code and hint", async () => {
    const sandbox = await daytona.create();
    fake(sandbox.id).exec = async () => {
      throw new RuntimeError({
        message: "Slow down.",
        code: "rate_limited",
        status: 429,
        hint: "Wait.",
      });
    };
    const error = (await sandbox.process
      .executeCommand("ls")
      .catch((e: unknown) => e)) as DaytonaError;
    expect(error).toBeInstanceOf(DaytonaRateLimitError);
    expect([error.statusCode, error.code, error.hint]).toEqual([429, "rate_limited", "Wait."]);
  });

  test("each gap throws NotSupportedError naming what to use", async () => {
    const sandbox = await daytona.create();
    const refusals = [
      () => sandbox.resize(),
      () => sandbox.getMetrics(),
      () => sandbox.getSignedPreviewUrl(),
      () => sandbox.createSshAccess(),
      () => sandbox.uploadUrl(),
      () => sandbox.recover(),
      () => sandbox.codeInterpreter.runCode("1", { envs: { A: "1" } }),
      () => sandbox.computerUse.accessibility.getTree(),
      () => sandbox.computerUse.screenshot.takeRegion({ x: 0, y: 0, width: 1, height: 1 }),
      () => Promise.resolve().then(() => sandbox.createLspServer()),
      () => daytona.volume.create("v"),
      () => (daytona.secret as { list(): Promise<unknown> }).list(),
    ];
    for (const refuse of refusals) {
      const error = await refuse().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotSupportedError);
      expect((error as NotSupportedError).alternative.length).toBeGreaterThan(0);
    }
  });

  test("the code interpreter runs Python in Runtime's interpreter, envVars in their own context", async () => {
    const sandbox = await daytona.create({ envVars: { A: "1" } });
    const seen: string[] = [];
    const result = await sandbox.codeInterpreter.runCode("1 + 1", {
      onStdout: (m) => void seen.push(m.output),
    });
    expect(result).toEqual({ stdout: "out 1 + 1\n", stderr: "" });
    expect(world.called("contexts.create")[0]![0]).toEqual({
      language: "python",
      cwd: "/workspace",
      env: { A: "1" },
    });
    expect(world.called("interpreter.run")[0]![1]).toMatchObject({
      language: "python",
      context: "ctx-1",
    });
    expect(seen).toEqual(["out 1 + 1\n"]);
  });
});
