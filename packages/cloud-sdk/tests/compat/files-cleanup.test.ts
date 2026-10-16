import { expect, test } from "bun:test";
import { GuestFiles } from "../../src/compat/files";
import type { Sandbox } from "../../src/sandbox";

function fixture(commandError?: Error) {
  let commands = 0;
  const removed: string[] = [];
  const files = new GuestFiles(async () => {
    return {
      files: {
        write: async () => undefined,
        remove: async (path: string) => {
          removed.push(path);
          throw new Error("staging cleanup connection lost");
        },
      },
      exec: async () => {
        commands++;
        if (commandError) throw commandError;
      },
    } as unknown as Sandbox;
  });
  return { files, removed, commands: () => commands };
}

test("staging cleanup cannot turn a completed append or write into a retryable failure", async () => {
  const bytes = new Uint8Array(1_048_577);
  for (const operation of ["append", "write"] as const) {
    const f = fixture();
    if (operation === "append") await f.files.appendFile("data", bytes);
    else await f.files.writeFile("/tmp/data", bytes);
    expect(f.commands()).toBe(1);
    expect(f.removed).toHaveLength(1);
    expect(f.removed[0]).toContain(`/workspace/.runtime-compat/${operation}-`);
  }
});

test("staging cleanup preserves the original failed append or write", async () => {
  const bytes = new Uint8Array(1_048_577);
  const failure = new Error("destination is full");
  for (const operation of ["append", "write"] as const) {
    const f = fixture(failure);
    const result =
      operation === "append"
        ? f.files.appendFile("data", bytes)
        : f.files.writeFile("/tmp/data", bytes);
    await expect(result).rejects.toBe(failure);
    expect(f.commands()).toBe(1);
    expect(f.removed).toHaveLength(1);
  }
});

test("an uncertain staging upload is cleaned without applying the destination mutation", async () => {
  const bytes = new Uint8Array(1_048_577);
  const failure = new Error("staging reply was lost");
  for (const operation of ["append", "write"] as const) {
    const removed: string[] = [];
    let commands = 0;
    const files = new GuestFiles(
      async () =>
        ({
          files: {
            write: async () => {
              throw failure;
            },
            remove: async (path: string) => {
              removed.push(path);
            },
          },
          exec: async () => {
            commands++;
          },
        }) as unknown as Sandbox,
    );
    const result =
      operation === "append"
        ? files.appendFile("data", bytes)
        : files.writeFile("/tmp/data", bytes);
    await expect(result).rejects.toBe(failure);
    expect(commands).toBe(0);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain(`/workspace/.runtime-compat/${operation}-`);
  }
});

test("a staging copy whose removal failed is removed by the next staged write or append", async () => {
  const bytes = new Uint8Array(1_048_577);
  for (const next of ["append", "write"] as const) {
    const removed: string[] = [];
    let failing = true;
    const files = new GuestFiles(
      async () =>
        ({
          files: {
            write: async () => undefined,
            remove: async (path: string) => {
              removed.push(path);
              if (failing) throw new Error("connection lost");
            },
          },
          exec: async () => undefined,
        }) as unknown as Sandbox,
    );
    await files.writeFile("/tmp/first", bytes);
    expect(removed).toHaveLength(1);
    const first = removed[0]!;
    failing = false;
    if (next === "append") await files.appendFile("data", bytes);
    else await files.writeFile("/tmp/second", bytes);
    // The sweep tried the first copy again, then the new call cleaned its own.
    expect(removed).toHaveLength(3);
    expect(removed[1]).toBe(first);
    expect(removed[2]).not.toBe(first);
    // Removed once, it is not tried a third time.
    await files.writeFile("/tmp/third", bytes);
    expect(removed).toHaveLength(4);
    expect(removed.filter((p) => p === first)).toHaveLength(2);
  }
});
