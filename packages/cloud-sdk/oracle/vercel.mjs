/* global Buffer */
import { assert, fs, join, check, outcome, shell, loadOfficial, loadRuntime } from "./context.mjs";
import { tmpdir } from "node:os";
export async function runVercel() {
  const { FileSystem: Official } = await loadOfficial("@vercel/sandbox", "dist/filesystem.js"),
    { FileSystem: Runtime } = await loadRuntime("vercel/filesystem.ts"),
    entry = {
      name: "hello.txt",
      path: "/fixture/hello.txt",
      type: "file",
      size: 3,
      mode: "644",
      modifiedAt: 1000,
    },
    a = new Official({
      runCommand: async () => ({
        exitCode: 0,
        stdout: async () => `hello.txt|f
`,
        stderr: async () => "",
      }),
    }),
    b = new Runtime({
      name: "fixture",
      resolve: (p) => p,
      files: async () => ({ list: async () => [entry] }),
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
  await check("Vercel Dirent path and parentPath", async () => {
    const x = (await a.readdir("/fixture", { withFileTypes: !0 }))[0],
      y = (await b.readdir("/fixture", { withFileTypes: !0 }))[0];
    assert.deepEqual(
      { path: y.path, parentPath: y.parentPath },
      { path: x.path, parentPath: x.parentPath },
    );
  });
  const base = await fs.mkdtemp(join(tmpdir(), "runtime-vercel-oracle-")),
    nativeFs = {
      exists: async (p) =>
        fs.lstat(p).then(
          () => !0,
          () => !1,
        ),
      stat: async (p) =>
        fs
          .lstat(p)
          .then((s) => ({
            exists: !0,
            type: s.isDirectory() ? "directory" : s.isSymbolicLink() ? "symlink" : "file",
            size: s.size,
            mode: (s.mode & 4095).toString(8),
            modifiedAt: s.mtimeMs,
          }))
          .catch((e) => (e.code === "ENOENT" ? { exists: !1 } : Promise.reject(e))),
      list: async (p, options) =>
        Promise.all(
          (await fs.readdir(p))
            .filter((name) => options.hidden || !name.startsWith("."))
            .map(async (name) => {
              const s = await fs.lstat(join(p, name));
              return {
                name,
                path: join(p, name),
                type: s.isDirectory() ? "directory" : "file",
                size: s.size,
                mode: (s.mode & 4095).toString(8),
                modifiedAt: s.mtimeMs,
              };
            }),
        ),
      write: async (p, b) => fs.writeFile(p, b),
      read: async (p) => fs.readFile(p),
      rename: async (a, b) => fs.rename(a, b),
      remove: async (p) => fs.rm(p, { recursive: !0, force: !0 }),
    },
    original = new Official({
      runCommand: async (cmd, args, options) => {
        const r = await shell([cmd, ...args], options);
        return { exitCode: r.exitCode, stdout: async () => r.stdout, stderr: async () => r.stderr };
      },
      readFileToBuffer: async ({ path: p }) =>
        fs.readFile(p).catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e))),
      writeFiles: async (items) => {
        for (const i of items) await fs.writeFile(i.path, i.content);
      },
      mkDir: async (p) => fs.mkdir(p),
    }),
    runtime = new Runtime({
      name: "fixture",
      resolve: (p) => p,
      files: async () => nativeFs,
      run: shell,
    });
  try {
    for (const [name, setup, fn] of [
      ["mkdir recursive", async () => {}, (api, p) => api.mkdir(p, { recursive: !0 })],
      [
        "rmdir nonempty",
        async (p) => {
          await fs.mkdir(p);
          await fs.writeFile(join(p, "x"), "x");
        },
        (api, p) => api.rmdir(p),
      ],
      ["unlink directory", async (p) => fs.mkdir(p), (api, p) => api.unlink(p)],
      ["readlink regular", async (p) => fs.writeFile(p, "x"), (api, p) => api.readlink(p)],
      ["chmod missing", async () => {}, (api, p) => api.chmod(p, 384)],
      ["access missing", async () => {}, (api, p) => api.access(p)],
      ["symlink exists", async (p) => fs.writeFile(p, "x"), (api, p) => api.symlink("target", p)],
    ])
      await check("Vercel " + name, async () => {
        const p = join(base, "official-" + name.replaceAll(" ", "-")),
          q = join(base, "runtime-" + name.replaceAll(" ", "-"));
        await setup(p);
        await setup(q);
        assert.deepEqual(await outcome(() => fn(runtime, q)), await outcome(() => fn(original, p)));
      });
    await check("Vercel default readdir excludes dotfiles", async () => {
      const dir = join(base, "hidden");
      await fs.mkdir(dir);
      await fs.writeFile(join(dir, ".env"), "secret");
      await fs.writeFile(join(dir, "hello.txt"), "hello");
      assert.deepEqual(await runtime.readdir(dir), await original.readdir(dir));
    });
    await check("Vercel dangling symlink existence follows target", async () => {
      const link = join(base, "dangling-link");
      await fs.symlink("missing-target", link);
      assert.equal(await runtime.exists(link), await original.exists(link));
      assert.deepEqual(
        await outcome(() => runtime.access(link)),
        await outcome(() => original.access(link)),
      );
    });
    await check("Vercel write/read byte fidelity", async () => {
      const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
        p = join(base, "bytes");
      await original.writeFile(p, bytes);
      assert.deepEqual(await runtime.readFile(p), await original.readFile(p));
      await runtime.writeFile(p, bytes);
      assert.deepEqual(await original.readFile(p), bytes);
    });
  } finally {
    await fs.rm(base, { recursive: !0, force: !0 });
  }
}
