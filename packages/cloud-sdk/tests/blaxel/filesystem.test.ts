import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toBlaxelPath, toRuntimePath } from "../../src/blaxel/context";
import type { ResponseError } from "../../src/blaxel/index";
import { NotSupportedError, SandboxInstance } from "../../src/blaxel/index";
import { BlaxelWorld, requests } from "./fake";

let world: BlaxelWorld;
const create = () => SandboxInstance.create({ withruntime: { client: world.client() } });
const fake = (sandbox: SandboxInstance) => world.sandboxes.get(sandbox.withruntime.id)!;
const execs = () => world.called("sandbox.exec");
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

beforeEach(() => {
  world = new BlaxelWorld();
});

describe("paths", () => {
  test("relative, ~ and /blaxel resolve against /workspace, as against /blaxel on Blaxel", () => {
    expect(toRuntimePath("/blaxel/app/config.json")).toBe("/workspace/app/config.json");
    expect(toRuntimePath("/blaxel")).toBe("/workspace");
    expect(toRuntimePath("src/app.js")).toBe("/workspace/src/app.js");
    expect(toRuntimePath("./a//b/")).toBe("/workspace/a/b");
    expect(toRuntimePath("~/notes")).toBe("/workspace/notes");
    expect(toRuntimePath("")).toBe("/workspace");
    expect(toRuntimePath("/tmp/image.webp")).toBe("/tmp/image.webp");
    expect(toRuntimePath("/blaxelish")).toBe("/blaxelish");
    expect(toRuntimePath("/blaxel/../etc/x")).toBe("/etc/x");
    expect(toBlaxelPath("/workspace/app")).toBe("/blaxel/app");
    expect(toBlaxelPath("/tmp")).toBe("/tmp");
  });
});

describe("files", () => {
  test("write, read, readBinary and writeBinary with Blaxel's answers", async () => {
    const sandbox = await create();
    expect(await sandbox.fs.write("/blaxel/app/config.json", "{}")).toEqual({
      message: "File created/updated successfully",
      path: "/blaxel/app/config.json",
    });
    expect(text(fake(sandbox).fileMap.get("/workspace/app/config.json"))).toBe("{}");
    expect(await sandbox.fs.read("/blaxel/app/config.json")).toBe("{}");
    await sandbox.fs.writeBinary("/tmp/a.bin", Buffer.from([1, 2, 3]));
    await sandbox.fs.writeBinary("/tmp/b.bin", new Blob([new Uint8Array([4, 5])]));
    const local = join(mkdtempSync(join(tmpdir(), "blaxel-")), "image.webp");
    writeFileSync(local, "local bytes");
    expect((await sandbox.fs.writeBinary("/tmp/c.bin", local)).message).toBe(
      "Binary file uploaded successfully",
    );
    expect(text(fake(sandbox).fileMap.get("/tmp/c.bin"))).toBe("local bytes");
    const blob = await sandbox.fs.readBinary("/tmp/a.bin");
    expect(blob).toBeInstanceOf(Blob);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
    const missing = (await sandbox.fs.read("/nope").catch((e: unknown) => e)) as ResponseError;
    expect([missing.status, missing.code, missing.runtimeCode]).toEqual([
      404,
      404,
      "file_not_found",
    ]);
  });

  test("a path the sandbox user may not write goes through /workspace and sudo, as root could write it", async () => {
    world.readOnly = ["/app/"];
    const sandbox = await create();
    const from = world.calls.length;
    await sandbox.fs.write("/app/config.json", "{}");
    expect(requests(world, from)).toEqual(["files.write.denied", "files.write", "sandbox.exec"]);
    const [argv] = execs().at(-1)!;
    expect((argv as string[]).slice(0, 4)).toEqual([
      "sudo",
      "sh",
      "-c",
      'mkdir -p "$(dirname "$2")" && mv -f "$1" "$2"',
    ]);
    expect((argv as string[])[6]).toBe("/app/config.json");
    expect((argv as string[])[5]).toMatch(/^\/workspace\/\.runtime-blaxel-/);
  });

  test("a missing directory outside /workspace is made with sudo, as root would", async () => {
    world.noParent = ["/opt/"];
    const sandbox = await create();
    const from = world.calls.length;
    await sandbox.fs.write("/opt/app/config.json", "{}");
    expect(requests(world, from)).toEqual(["files.write.missing", "files.write", "sandbox.exec"]);
    world.noParent = ["/workspace/"];
    const error = (await sandbox.fs
      .write("/blaxel/x/y", "z")
      .catch((e: unknown) => e)) as ResponseError;
    expect(error.status).toBe(404);
  });

  test("a tree under a root the sandbox user may not write is written file by file through sudo", async () => {
    world.readOnly = ["/opt/"];
    const sandbox = await create();
    let first = true;
    world.exec = () => {
      if (first) {
        first = false;
        return { exitCode: 3, stdout: '{"status":403,"error":"error writing file: denied"}' };
      }
      return {
        exitCode: 0,
        stdout: '{"name":"tree","path":"/opt/tree","files":[],"subdirectories":[]}',
      };
    };
    const tree = await sandbox.fs.writeTree([{ path: "a/c.txt", content: "c" }], "/opt/tree");
    expect(tree!.path).toBe("/opt/tree");
    expect(world.called("files.write.denied")).toEqual([["/opt/tree/a/c.txt"]]);
  });

  test("files a root process made stay usable: a root-only directory or file goes through sudo", async () => {
    world.readOnly = ["/workspace/built/"];
    world.unreadable = ["/workspace/built/secret"];
    const sandbox = await create();
    const runtime = fake(sandbox);
    await sandbox.fs.write("/blaxel/built/out.txt", "mine");
    expect(world.called("files.write.denied")).toEqual([["/workspace/built/out.txt"]]);
    expect((execs().at(-1)![0] as string[]).slice(0, 2)).toEqual(["sudo", "sh"]);
    runtime.fileMap.set("/workspace/built/secret", new TextEncoder().encode("s3cret"));
    world.exec = (command) => {
      const argv = command as unknown as string[];
      if (argv[3]?.startsWith("install -m 0600"))
        runtime.fileMap.set(argv[6]!, runtime.fileMap.get(argv[5]!)!);
      return { exitCode: 0 };
    };
    expect(await sandbox.fs.read("/blaxel/built/secret")).toBe("s3cret");
    const [argv] = execs().at(-1)!;
    expect((argv as string[]).slice(3, 6)).toEqual([
      'install -m 0600 -o "$SUDO_UID" -g "$SUDO_GID" -- "$1" "$2"',
      "sh",
      "/workspace/built/secret",
    ]);
    const staged = (argv as string[])[6]!;
    expect(staged).toMatch(/^\/tmp\/\.runtime-blaxel-/);
    expect(world.called("files.remove").at(-1)![0]).toBe(staged);
    expect(
      [...new Uint8Array(await (await sandbox.fs.readBinary("/blaxel/built/secret")).arrayBuffer())]
        .length,
    ).toBe(6);
  });

  test("a large file outside /workspace goes straight through /workspace", async () => {
    const sandbox = await create();
    const from = world.calls.length;
    await sandbox.fs.writeBinary("/opt/big.bin", new Uint8Array(1_048_577));
    expect(requests(world, from)).toEqual(["files.write", "sandbox.exec"]);
  });

  test("rm answers as Blaxel: which kind it removed, 404 when missing, 422 when not empty", async () => {
    const sandbox = await create();
    world.exec = () => ({ exitCode: 0, stdout: "File\n" });
    expect(await sandbox.fs.rm("/blaxel/app/config.json")).toEqual({
      message: "File deleted successfully",
      path: "/blaxel/app/config.json",
    });
    expect((execs().at(-1)![0] as string[]).slice(-2)).toEqual(["/workspace/app/config.json", "0"]);
    world.exec = () => ({ exitCode: 0, stdout: "Directory\n" });
    expect((await sandbox.fs.rm("/blaxel/app", true)).message).toBe(
      "Directory deleted successfully",
    );
    expect((execs().at(-1)![0] as string[]).at(-1)).toBe("1");
    world.exec = () => ({ exitCode: 2 });
    expect(((await sandbox.fs.rm("/x").catch((e: unknown) => e)) as ResponseError).status).toBe(
      404,
    );
    world.exec = () => ({ exitCode: 4, stderr: "directory not empty" });
    const full = (await sandbox.fs.rm("/d").catch((e: unknown) => e)) as ResponseError;
    expect([full.status, full.message]).toEqual([
      422,
      "Sandbox request failed with status 422: error deleting directory: directory not empty",
    ]);
  });

  test("mkdir makes parents, sets other permissions, and falls back to sudo", async () => {
    const sandbox = await create();
    expect(await sandbox.fs.mkdir("/blaxel/app/uploads")).toEqual({
      message: "Directory created successfully",
      path: "/blaxel/app/uploads",
    });
    expect(world.called("files.mkdir").at(-1)).toEqual([
      "/workspace/app/uploads",
      { parents: true },
    ]);
    expect(execs()).toEqual([]);
    await sandbox.fs.mkdir("/blaxel/private", "0700");
    expect(execs().at(-1)![0]).toEqual(["chmod", "0700", "--", "/workspace/private"]);
  });

  test("cp copies recursively, with Blaxel's failure message", async () => {
    const sandbox = await create();
    expect(
      await sandbox.fs.cp("/blaxel/app/config.json", "/blaxel/app/config.backup.json"),
    ).toEqual({
      message: "Files copied",
      source: "/blaxel/app/config.json",
      destination: "/blaxel/app/config.backup.json",
    });
    expect((execs().at(-1)![0] as string[]).slice(-2)).toEqual([
      "/workspace/app/config.json",
      "/workspace/app/config.backup.json",
    ]);
    world.exec = () => ({ exitCode: 1, stderr: "cp: cannot stat 'x'" });
    expect(((await sandbox.fs.cp("x", "y").catch((e: unknown) => e)) as Error).message).toBe(
      "Could not copy x to y cause: cp: cannot stat 'x'",
    );
  });

  test("download writes the local file with Blaxel's mode", async () => {
    const sandbox = await create();
    fake(sandbox).fileMap.set("/tmp/foo.bin", new TextEncoder().encode("foo"));
    const target = join(mkdtempSync(join(tmpdir(), "blaxel-")), "foo2.bin");
    await sandbox.fs.download("/tmp/foo.bin", target);
    expect(readFileSync(target, "utf8")).toBe("foo");
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });
});

describe("listing and searching", () => {
  test("ls, find, grep and search are one command each, with Blaxel's defaults", async () => {
    const sandbox = await create();
    world.exec = () => ({
      exitCode: 0,
      stdout: JSON.stringify({ name: "app", path: "/blaxel/app", files: [], subdirectories: [] }),
    });
    const from = world.calls.length;
    expect((await sandbox.fs.ls("/blaxel/app")).path).toBe("/blaxel/app");
    expect(requests(world, from)).toEqual(["sandbox.exec"]);
    expect((execs().at(-1)![0] as string[]).slice(-2)).toEqual(["/workspace/app", "/blaxel/app"]);
    world.exec = () => ({ exitCode: 0, stdout: '{"matches":[],"total":0}' });
    await sandbox.fs.find("/app", { type: "file", patterns: ["*.md", "*.html"], maxResults: 1000 });
    expect(JSON.parse((execs().at(-1)![0] as string[]).at(-1)!)).toMatchObject({
      root: "/app",
      type: "file",
      patterns: ["*.md", "*.html"],
      max: 1000,
      hidden: true,
      exclude: expect.arrayContaining(["node_modules", ".git"]),
    });
    await sandbox.fs.grep("agentic", "/app", {
      caseSensitive: true,
      maxResults: 5,
      filePattern: "*.mdx",
      excludeDirs: ["images"],
    });
    expect(JSON.parse((execs().at(-1)![0] as string[]).at(-1)!)).toMatchObject({
      root: "/app",
      case: true,
      max: 5,
      pattern: "*.mdx",
      exclude: ["images"],
    });
    await sandbox.fs.grep("x");
    expect(JSON.parse((execs().at(-1)![0] as string[]).at(-1)!)).toMatchObject({
      root: "/workspace",
      max: 100,
    });
    await sandbox.fs.search("readme", "/", { maxResults: 0 });
    expect(JSON.parse((execs().at(-1)![0] as string[]).at(-1)!)).toMatchObject({
      root: "/workspace",
      max: -1,
    });
    expect(
      ((await sandbox.fs.find("/", { maxResults: -1 }).catch((e: unknown) => e)) as ResponseError)
        .status,
    ).toBe(400);
  });

  test("a script's own failure is its ResponseError; an image without python3 lists through the files API", async () => {
    const sandbox = await create();
    world.exec = () => ({
      exitCode: 3,
      stdout: '{"status":404,"error":"directory not found: /x"}',
    });
    const missing = (await sandbox.fs.ls("/x").catch((e: unknown) => e)) as ResponseError;
    expect([missing.status, missing.message]).toEqual([
      404,
      "Sandbox request failed with status 404: directory not found: /x",
    ]);
    world.exec = () => ({ exitCode: 127, stderr: "python3: not found" });
    fake(sandbox).fileMap.set("/workspace/app/a.txt", new TextEncoder().encode("a"));
    const listed = await sandbox.fs.ls("/blaxel/app");
    expect(listed.files.map((file) => [file.name, file.path])).toEqual([
      ["a.txt", "/blaxel/app/a.txt"],
    ]);
    expect(await sandbox.fs.find("/app").catch((e: unknown) => e)).toBeInstanceOf(
      NotSupportedError,
    );
  });

  test("a listing over 64 KiB is read again in full", async () => {
    const sandbox = await create();
    let calls = 0;
    world.exec = () => ({ exitCode: 0, stdout: `{"matches":[],"total":${++calls}}`, lost: false });
    const runtime = fake(sandbox);
    const exec = runtime.exec.bind(runtime);
    runtime.exec = async (command: string, options: Record<string, unknown> = {}) => {
      const result = await exec(command, options);
      return Number(options.timeoutMs) <= 60_000 ? { ...result, stdoutTruncated: true } : result;
    };
    expect((await sandbox.fs.find("/app")).total).toBe(2);
  });

  test("writeTree is one command for a small tree, answered with the listing", async () => {
    const sandbox = await create();
    world.exec = () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        name: "app",
        path: "/blaxel/app",
        files: [],
        subdirectories: [{ name: "src", path: "/blaxel/app/src" }],
      }),
    });
    const from = world.calls.length;
    const tree = await sandbox.fs.writeTree(
      [
        { path: "src/app.js", content: "console.log('Hello');" },
        { path: "package.json", content: '{"name": "my-app"}' },
      ],
      "/blaxel/app",
    );
    expect(requests(world, from)).toEqual(["sandbox.exec"]);
    expect(tree!.subdirectories[0]!.name).toBe("src");
    const stdin = JSON.parse((execs().at(-1)![1] as { stdin: string }).stdin);
    expect(stdin).toEqual({
      root: "/workspace/app",
      shown: "/blaxel/app",
      files: { "src/app.js": "console.log('Hello');", "package.json": '{"name": "my-app"}' },
    });
  });
});

describe("watch", () => {
  test("events as Blaxel's: op, the directory and the name, with content when asked", async () => {
    const sandbox = await create();
    fake(sandbox).fileMap.set("/workspace/folder/a.txt", new TextEncoder().encode("hello"));
    fake(sandbox).watchEvents = [
      { type: "write", path: "/workspace/folder/a.txt", isDir: false },
      { type: "remove", path: "/workspace/folder/old", isDir: true },
    ];
    const seen: unknown[] = [];
    const handle = sandbox.fs.watch("/blaxel/folder/**", (event) => void seen.push(event), {
      withContent: true,
      ignore: ["/blaxel/folder/node_modules"],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(world.called("files.watch")[0]).toEqual([
      "/workspace/folder",
      { recursive: true, exclude: ["node_modules", "node_modules/**"], onExit: undefined },
    ]);
    expect(seen).toEqual([
      { op: "WRITE", path: "/blaxel/folder", name: "a.txt", content: "hello" },
      { op: "REMOVE", path: "/blaxel/folder", name: "old" },
    ]);
    handle.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(world.called("files.watch.stop")).toHaveLength(1);
  });
});
