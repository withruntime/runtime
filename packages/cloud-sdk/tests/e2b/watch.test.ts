import { expect, test } from "bun:test";
import type { SandboxContext } from "../../src/e2b/commands";
import { Filesystem } from "../../src/e2b/filesystem";

function fixture(done: Promise<void> = new Promise(() => {})) {
  let starts = 0,
    stops = 0;
  const files = new Filesystem({
    ensureHome: async () => {},
    runtime: {
      files: {
        stat: async () => ({ exists: true, type: "directory" }),
        watch: async () => {
          starts++;
          return {
            done,
            stop: async () => {
              stops++;
            },
          };
        },
      },
    },
  } as unknown as SandboxContext);
  return { files, starts: () => starts, stops: () => stops };
}

test("an already aborted watch creates no remote watcher", async () => {
  const f = fixture();
  await expect(
    f.files.watchDir("app", () => {}, { signal: AbortSignal.abort() }),
  ).rejects.toBeDefined();
  expect(f.starts()).toBe(0);
});
test("abort after creation stops the remote watcher and reports one exit", async () => {
  const f = fixture();
  const abort = new AbortController();
  const errors: Array<Error | undefined> = [];
  const handle = await f.files.watchDir("app", () => {}, {
    signal: abort.signal,
    onExit: (error) => {
      errors.push(error);
    },
  });
  abort.abort(new Error("cancelled"));
  await handle.stop();
  expect(f.stops()).toBeGreaterThanOrEqual(1);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.message).toBe("cancelled");
});
test("a transport failure reaches onExit exactly once", async () => {
  let reject!: (reason: Error) => void;
  const done = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const f = fixture(done);
  const errors: Array<Error | undefined> = [];
  const handle = await f.files.watchDir("app", () => {}, {
    onExit: (error) => {
      errors.push(error);
    },
  });
  reject(new Error("connection lost"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await handle.stop();
  expect(errors.map((error) => error?.message)).toEqual(["connection lost"]);
});
test("a throwing terminal callback cannot reject stop or leak a rejection", async () => {
  const f = fixture();
  const handle = await f.files.watchDir("app", () => {}, {
    onExit: async () => {
      throw new Error("callback");
    },
  });
  await handle.stop();
});

test("watch metadata is best effort for removed files and includes existing dotfiles", async () => {
  const events: unknown[] = [];
  let deliver!: (event: { path: string; type: string }) => Promise<void>;
  const files = new Filesystem({
    ensureHome: async () => {},
    runtime: {
      files: {
        watch: async (_: string, onEvent: typeof deliver) => {
          deliver = onEvent;
          return { done: new Promise(() => {}), stop: async () => {} };
        },
        stat: async (path: string) =>
          path.endsWith("missing")
            ? { exists: false }
            : path.endsWith("/app")
              ? { exists: true, type: "directory" }
              : {
                  exists: true,
                  name: ".env",
                  path,
                  type: "file",
                  size: 3,
                  mode: "0600",
                  modifiedAt: 1000,
                },
      },
    },
  } as unknown as SandboxContext);
  const handle = await files.watchDir(
    "app",
    (event) => {
      events.push(event);
    },
    { includeEntry: true },
  );
  await deliver({ path: "/workspace/app/.env", type: "write" });
  await deliver({ path: "/workspace/app/missing", type: "remove" });
  expect(events).toEqual([
    expect.objectContaining({
      name: ".env",
      type: "write",
      entry: expect.objectContaining({ name: ".env", size: 3 }),
    }),
    { name: "missing", type: "remove" },
  ]);
  await handle.stop();
});

test("lost events stop delivery and report one failure, including notices during creation", async () => {
  let stops = 0;
  const failures: string[] = [];
  const files = new Filesystem({
    ensureHome: async () => {},
    runtime: {
      files: {
        stat: async () => ({ exists: true, type: "directory" }),
        watch: async (
          _: string,
          callback: (event: unknown) => Promise<void>,
          options: { onNotice: (notice: unknown) => void },
        ) => {
          options.onNotice({ k: "overflow", dropped: 3 });
          await callback({ path: "/workspace/app/.env", type: "write" });
          return {
            done: new Promise(() => {}),
            stop: async () => {
              stops++;
            },
          };
        },
      },
    },
  } as unknown as SandboxContext);
  let events = 0;
  await files.watchDir(
    "app",
    () => {
      events++;
    },
    {
      onExit: (error) => {
        failures.push(error?.message ?? "clean");
      },
    },
  );
  expect(stops).toBe(1);
  expect(events).toBe(0);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("events were lost");
});

test("network mount option is refused before starting a watcher", async () => {
  const f = fixture();
  await expect(
    f.files.watchDir("app", () => {}, { allowNetworkMounts: true }),
  ).rejects.toMatchObject({ name: "NotSupportedError" });
  expect(f.starts()).toBe(0);
});

test("subsecond watch deadline uses an unbounded native watcher and stops it exactly once", async () => {
  let nativeTimeout: number | undefined,
    stops = 0;
  const exits: (Error | undefined)[] = [];
  const files = new Filesystem({
    ensureHome: async () => {},
    runtime: {
      files: {
        stat: async () => ({ exists: true, type: "directory" }),
        watch: async (
          _path: string,
          _callback: unknown,
          opts: { timeoutMs: number; onExit: (reason: string) => void },
        ) => {
          nativeTimeout = opts.timeoutMs;
          return {
            done: new Promise(() => {}),
            stop: async () => {
              stops++;
              opts.onExit("stopped");
            },
          };
        },
      },
    },
  } as unknown as SandboxContext);
  const handle = await files.watchDir("app", () => {}, {
    timeoutMs: 20,
    onExit: (error) => {
      exits.push(error);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(nativeTimeout).toBe(0);
  expect(stops).toBe(1);
  expect(exits).toHaveLength(1);
  expect(exits[0]?.name).toBe("TimeoutError");
  await handle.stop();
  expect(stops).toBe(1);
  expect(exits).toHaveLength(1);
});
test("zero and over-one-day watch lifetimes never receive a clamped native deadline", async () => {
  for (const timeoutMs of [0, 86400001]) {
    let nativeTimeout: number | undefined;
    const exits: unknown[] = [];
    const files = new Filesystem({
      ensureHome: async () => {},
      runtime: {
        files: {
          stat: async () => ({ exists: true, type: "directory" }),
          watch: async (_path: string, _callback: unknown, opts: { timeoutMs: number }) => {
            nativeTimeout = opts.timeoutMs;
            return { done: new Promise(() => {}), stop: async () => {} };
          },
        },
      },
    } as unknown as SandboxContext);
    const handle = await files.watchDir("app", () => {}, {
      timeoutMs,
      onExit: (error) => {
        exits.push(error);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(nativeTimeout).toBe(0);
    expect(exits).toHaveLength(0);
    await handle.stop();
    expect(exits).toEqual([undefined]);
  }
});
test("watch callback may stop itself without deadlock or another event", async () => {
  let deliver!: (event: { path: string; type: string }) => Promise<void>;
  let stops = 0,
    events = 0,
    exits = 0;
  const files = new Filesystem({
    ensureHome: async () => {},
    runtime: {
      files: {
        stat: async () => ({ exists: true, type: "directory" }),
        watch: async (
          _path: string,
          callback: typeof deliver,
          opts: { onExit: (reason: string) => void },
        ) => {
          deliver = callback;
          return {
            done: new Promise(() => {}),
            stop: async () => {
              stops++;
              opts.onExit("stopped");
            },
          };
        },
      },
    },
  } as unknown as SandboxContext);
  const handle = await files.watchDir(
    "app",
    async () => {
      events++;
      await handle.stop();
    },
    {
      timeoutMs: 20,
      onExit: () => {
        exits++;
      },
    },
  );
  await deliver({ path: "/workspace/app/file", type: "write" });
  await deliver({ path: "/workspace/app/later", type: "write" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect([stops, events, exits]).toEqual([1, 1, 1]);
});
test("watch timeout during remote creation cleans a late returned watcher", async () => {
  let stops = 0;
  const exits: (Error | undefined)[] = [];
  const files = new Filesystem({
    ensureHome: async () => {},
    runtime: {
      files: {
        stat: async () => ({ exists: true, type: "directory" }),
        watch: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return {
            done: new Promise(() => {}),
            stop: async () => {
              stops++;
            },
          };
        },
      },
    },
  } as unknown as SandboxContext);
  const handle = await files.watchDir("app", () => {}, {
    timeoutMs: 10,
    onExit: (error) => {
      exits.push(error);
    },
  });
  expect(stops).toBe(1);
  expect(exits.map((e) => e?.name)).toEqual(["TimeoutError"]);
  await handle.stop();
  expect(stops).toBe(1);
});
