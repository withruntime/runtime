import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import type { Files } from "../../src/sandbox";
import { FileSystem } from "../../src/vercel/filesystem";

// Run the adapter's guest commands against a real temporary filesystem. A
// recording SDK fake cannot reveal races between independent append callers.
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function filesystem() {
  const directory = await mkdtemp(join(tmpdir(), "runtime-vercel-fs-"));
  directories.push(directory);
  const fs = new FileSystem({
    name: "local-regression",
    resolve: (path) => (isAbsolute(path) ? path : join(directory, path)),
    files: async () =>
      ({
        read: (path: string) => readFile(path),
        write: async (path: string, bytes: Uint8Array) => {
          const local = path.startsWith("/workspace/.runtime/append/")
            ? join(directory, path.split("/").at(-1)!)
            : path;
          await writeFile(local, bytes);
        },
        remove: (path: string) => rm(join(directory, path.split("/").at(-1)!)),
      }) as unknown as Files,
    run: async (argv, options) => {
      options?.signal?.throwIfAborted();
      expect(options?.stdin?.byteLength ?? 0).toBeLessThanOrEqual(1_048_576);
      const mapped = argv.map((part) =>
        part.startsWith("/workspace/.runtime/append/")
          ? join(directory, part.split("/").at(-1)!)
          : part,
      );
      const child = Bun.spawn(mapped, {
        stdin: options?.stdin ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    },
  });
  return { fs, directory };
}

test("independent concurrent appends retain every byte without reading the old file", async () => {
  const { fs } = await filesystem();
  await fs.writeFile("log", "initial\n");
  const lines = Array.from({ length: 12 }, (_, n) => String.fromCharCode(65 + n).repeat(70_000));
  await Promise.all(lines.map((line) => fs.appendFile("log", line)));
  const result = await fs.readFile("log", "utf8");
  expect(result.startsWith("initial\n")).toBe(true);
  expect(result.length).toBe(8 + 12 * 70_000);
  for (let n = 0; n < 12; n++)
    expect(result.split(String.fromCharCode(65 + n)).length - 1).toBe(70_000);
}, 20_000);

test("exists and access follow symlink targets, including dangling links", async () => {
  const { fs, directory } = await filesystem();
  await symlink("target", join(directory, "link"));
  expect(await fs.exists("link")).toBe(false);
  await expect(fs.access("link")).rejects.toMatchObject({ code: "ENOENT", syscall: "access" });
  await writeFile(join(directory, "target"), "present");
  expect(await fs.exists("link")).toBe(true);
  await fs.access("link");
});

test("append creates a file, preserves binary bytes and handles hostile filenames literally", async () => {
  const { fs } = await filesystem();
  const name = "a ' $(touch SHOULD_NOT_EXIST) ;.bin";
  await fs.appendFile(name, Uint8Array.from([0, 255, 128, 10]));
  await fs.appendFile(name, "00fe", "hex");
  expect(await fs.readFile(name)).toEqual(Buffer.from([0, 255, 128, 10, 0, 254]));
});

test("append reports missing parents and directories with Node error codes", async () => {
  const { fs, directory } = await filesystem();
  await expect(fs.appendFile("absent/file", "x")).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(join(directory, "folder"));
  await expect(fs.appendFile("folder", "x")).rejects.toMatchObject({ code: "EISDIR" });
});

test("an already aborted append makes no file", async () => {
  const { fs, directory } = await filesystem();
  await expect(
    fs.appendFile("cancelled", "x", { signal: AbortSignal.abort() }),
  ).rejects.toBeDefined();
  await expect(readFile(join(directory, "cancelled"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("append larger than the exec input limit uploads in chunks and cleans its staging file", async () => {
  const { fs, directory } = await filesystem();
  const data = Buffer.alloc(2 * 1024 * 1024, 255);
  await fs.appendFile("large", data);
  expect(await fs.readFile("large")).toEqual(data);
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(directory)).toEqual(["large"]);
});

test("aborted filesystem mutations leave existing bytes and directories untouched", async () => {
  const { fs, directory } = await filesystem();
  const { readdir } = await import("node:fs/promises");
  await writeFile(join(directory, "kept"), "original");
  await mkdir(join(directory, "folder"));
  const options = { signal: AbortSignal.abort() };
  for (const operation of [
    () => fs.mkdir("new", options),
    () => fs.unlink("kept", options),
    () => fs.rm("kept", options),
    () => fs.rmdir("folder", options),
    () => fs.rename("kept", "new", options),
    () => fs.copyFile("kept", "new", options),
    () => fs.chmod("kept", 0, options),
    () => fs.chown("kept", 0, 0, options),
    () => fs.symlink("kept", "new", options),
    () => fs.truncate("kept", 0, options),
    () => fs.mkdtemp("new", options),
  ])
    await expect(operation()).rejects.toBeDefined();
  expect(await readFile(join(directory, "kept"), "utf8")).toBe("original");
  expect((await readdir(directory)).sort()).toEqual(["folder", "kept"]);
  expect(await fs.mkdir("new", { recursive: true })).toBeUndefined();
});
