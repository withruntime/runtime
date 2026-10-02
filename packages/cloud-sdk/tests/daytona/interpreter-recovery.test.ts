import { expect, test } from "bun:test";
import { CodeInterpreter, Sandbox } from "../../src/daytona/sandbox";
import type { RuntimeSandbox } from "../../src/daytona/client";
import type { Runtime } from "../../src/client";

test("transient default context failure is retryable and concurrent retries share one creation", async () => {
  let attempts = 0;
  const contexts: string[] = [];
  const runtime = {
    interpreter: {
      contexts: {
        async create() {
          attempts++;
          if (attempts === 1) throw new Error("temporary context failure");
          await Promise.resolve();
          return { id: "recovered" };
        },
      },
      async run(_code: string, { context }: { context: string }) {
        contexts.push(context);
        return { stdout: "ok", stderr: "", error: null };
      },
    },
  } as unknown as RuntimeSandbox;
  const interpreter = new CodeInterpreter(
    async () => runtime,
    () => ({ TOKEN: "private" }),
  );
  await expect(interpreter.runCode("1")).rejects.toThrow("temporary context failure");
  const results = await Promise.all([interpreter.runCode("2"), interpreter.runCode("3")]);
  expect(attempts).toBe(2);
  expect(contexts).toEqual(["recovered", "recovered"]);
  expect(results.map((result) => result.stdout)).toEqual(["ok", "ok"]);
});

test("Daytona labels replace customer labels and preserve reserved reconnect metadata", async () => {
  const updates: unknown[] = [];
  const info = {
    labels: { old: "removed", "code-toolbox-language": "typescript", "compat.provider": "daytona" },
  };
  const runtime = {
    info,
    async update(settings: { labels: Record<string, string> }) {
      updates.push(settings);
      info.labels = settings.labels as typeof info.labels;
    },
  } as unknown as RuntimeSandbox;
  const sandbox = new Sandbox(runtime, {} as Runtime, {
    env: {},
    language: "typescript",
    public: false,
    lifecycle: {
      windowSeconds: 900,
      ephemeral: false,
      autoStopInterval: 15,
      autoArchiveInterval: 0,
      autoDeleteInterval: -1,
    },
  });
  expect(
    await sandbox.setLabels({
      team: "new",
      "code-toolbox-language": "python",
      "compat.provider": "foreign",
    }),
  ).toEqual({
    team: "new",
    "code-toolbox-language": "typescript",
    "compat.provider": "daytona",
  });
  expect(updates).toEqual([
    {
      labels: { team: "new", "code-toolbox-language": "typescript", "compat.provider": "daytona" },
    },
  ]);
  expect(sandbox.labels).not.toHaveProperty("old");
  await sandbox.setLabels({});
  expect(sandbox.labels).toEqual({
    "code-toolbox-language": "typescript",
    "compat.provider": "daytona",
  });
});

test("failed label update leaves the previous labels intact", async () => {
  const runtime = {
    info: { labels: { team: "old" } },
    async update() {
      throw new Error("update failed");
    },
  } as unknown as RuntimeSandbox;
  const sandbox = new Sandbox(runtime, {} as Runtime, {
    env: {},
    language: "python",
    public: false,
    lifecycle: {
      windowSeconds: 900,
      ephemeral: false,
      autoStopInterval: 15,
      autoArchiveInterval: 0,
      autoDeleteInterval: -1,
    },
  });
  await expect(sandbox.setLabels({ team: "new" })).rejects.toThrow("update failed");
  expect(sandbox.labels).toEqual({ team: "old" });
});
