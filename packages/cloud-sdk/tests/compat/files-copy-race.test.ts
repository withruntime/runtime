import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuestFiles } from "../../src/compat/files";
import type { Sandbox } from "../../src/sandbox";

test("a file appearing after the existence check survives and the skipped copy fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-copy-race-"));
  try {
    const source = join(directory, "source"),
      target = join(directory, "target");
    await writeFile(source, "new source");
    let checked = false;
    const files = new GuestFiles(
      async () =>
        ({
          files: {
            exists: async () => {
              checked = true;
              return false;
            },
          },
          exec: async (argv: string[]) => {
            expect(checked).toBe(true);
            // GNU -T forbids treating a raced directory as a container. This
            // macOS fixture uses only file targets and drops that unavailable flag.
            const command = argv.map((value) =>
              value.replace("mv -n -T --", 'printf winner > "$2"; mv -n --'),
            );
            if (argv[0] === "cp") await writeFile(target, "winner"); // original source differential
            const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
            const [stdout, stderr, status] = await Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
              child.exited,
            ]);
            if (status !== 0) throw new Error(stderr || stdout || `Command exited ${status}`);
          },
        }) as unknown as Sandbox,
    );
    await expect(files.copy(source, target)).rejects.toThrow("Destination exists");
    expect(await readFile(target, "utf8")).toBe("winner");
    expect((await readdir(directory)).sort()).toEqual(["source", "target"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the original existing-destination refusal performs no command", async () => {
  let commands = 0;
  const files = new GuestFiles(
    async () =>
      ({
        files: { exists: async () => true },
        exec: async () => {
          commands++;
        },
      }) as unknown as Sandbox,
  );
  await expect(files.copy("source", "target")).rejects.toThrow("Destination exists: target");
  expect(commands).toBe(0);
});

test("a successful non-overwriting publication uses a private stage and cleans it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-copy-publish-"));
  try {
    const source = join(directory, "source"),
      target = join(directory, "target");
    await writeFile(source, new Uint8Array([0, 255, 128, 1]));
    const files = new GuestFiles(
      async () =>
        ({
          files: { exists: async () => false },
          exec: async (argv: string[]) => {
            const child = Bun.spawn(
              argv.map((value) => value.replace("mv -n -T --", "mv -n --")),
              { stdout: "pipe", stderr: "pipe" },
            );
            const [stderr, status] = await Promise.all([
              new Response(child.stderr).text(),
              child.exited,
            ]);
            if (status !== 0) throw new Error(stderr);
          },
        }) as unknown as Sandbox,
    );
    await files.copy(source, target);
    expect(await readFile(target)).toEqual(Buffer.from([0, 255, 128, 1]));
    expect((await readdir(directory)).sort()).toEqual(["source", "target"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
