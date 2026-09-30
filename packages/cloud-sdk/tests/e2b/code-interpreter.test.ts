import { beforeEach, describe, expect, test } from "bun:test";
import {
  CommandExitError,
  Execution,
  NotSupportedError,
  OutputMessage,
  Result,
  Sandbox,
  TimeoutError,
} from "../../src/e2b/code-interpreter";
import { FakeWorld } from "./fake";

let world: FakeWorld;
const create = (envs?: Record<string, string>) =>
  Sandbox.create({ ...(envs ? { envs } : {}), runtime: { client: world.client() } });

beforeEach(() => {
  world = new FakeWorld();
});

describe("runCode", () => {
  test("runs Python by default and answers E2B's Execution", async () => {
    const sbx = await create();
    const execution = await sbx.runCode("1 + 1");
    expect(execution).toBeInstanceOf(Execution);
    expect(execution.text).toBe("2");
    expect(execution.results[0]).toBeInstanceOf(Result);
    expect(execution.results[0]!.formats()).toEqual(["text"]);
    expect(execution.logs).toEqual({ stdout: ["out 1 + 1\n"], stderr: [] });
    expect(execution.executionCount).toBe(1);
    expect(execution.error).toBeUndefined();
    expect(world.called("interpreter.run")[0]).toMatchObject([
      "1 + 1",
      { language: "python", timeoutMs: 0, requestTimeoutMs: 0, interruptOnDisconnect: false },
    ]);
  });

  test("the base sandbox's commands still work, with E2B's errors", async () => {
    world.exec = () => ({ exitCode: 1, stderr: "no\n" });
    const sbx = await create();
    expect(await sbx.commands.run("false").catch((e: unknown) => e)).toBeInstanceOf(
      CommandExitError,
    );
  });

  test("maps rich results, inlines large ones, and keeps what E2B has no field for", async () => {
    world.interpreter = () => ({
      status: "ok",
      stdout: "a\nb\npartial",
      stderr: "warn\n",
      executionCount: 4,
      results: [
        {
          main: false,
          data: { "image/png": "iVBOR", "text/plain": "<Figure>" },
          refs: {},
        },
        {
          main: true,
          data: { "application/vnd.runtime.table+json": { columns: ["a"] } },
          refs: {
            "text/html": {
              path: "/workspace/.runtime/interpreter/python/out/1.html",
              bytes: 9,
              sha256: "x",
            },
          },
        },
      ],
      error: null,
    });
    const sbx = await create();
    const execution = await sbx.runCode("df");
    expect(execution.logs.stdout).toEqual(["a\n", "b\n", "partial"]);
    expect(execution.logs.stderr).toEqual(["warn\n"]);
    const [figure, table] = execution.results;
    expect([figure!.png, figure!.text, figure!.isMainResult]).toEqual(["iVBOR", "<Figure>", false]);
    expect(table!.html).toBe("bytes of /workspace/.runtime/interpreter/python/out/1.html");
    expect(table!.extra).toEqual({ "application/vnd.runtime.table+json": { columns: ["a"] } });
    expect(table!.data).toBeUndefined();
    expect(table!.chart).toBeUndefined();
  });

  test("an error in the code comes back in execution.error, not as a throw", async () => {
    world.interpreter = () => ({
      status: "error",
      stdout: "",
      stderr: "",
      results: [],
      executionCount: 2,
      error: { name: "ZeroDivisionError", value: "division by zero", traceback: "Traceback..." },
    });
    const sbx = await create();
    const execution = await sbx.runCode("1/0");
    expect(execution.error).toMatchObject({ name: "ZeroDivisionError", value: "division by zero" });
  });

  test("a timeout throws TimeoutError", async () => {
    world.interpreter = () => ({
      status: "timeout",
      stdout: "",
      stderr: "",
      results: [],
      error: null,
    });
    const sbx = await create();
    expect(
      await sbx.runCode("while True: pass", { timeoutMs: 1000 }).catch((e: unknown) => e),
    ).toBeInstanceOf(TimeoutError);
  });

  test("streams stdout as OutputMessage and results after the run", async () => {
    const sbx = await create();
    const out: OutputMessage[] = [];
    const results: Result[] = [];
    await sbx.runCode("print(1)", {
      onStdout: (message) => void out.push(message),
      onResult: (result) => void results.push(result),
    });
    expect(out[0]).toBeInstanceOf(OutputMessage);
    expect([out[0]!.line, out[0]!.error]).toEqual(["out print(1)\n", false]);
    expect(results.map((one) => one.text)).toEqual(["2"]);
  });

  test("all interpreter languages reach native contexts; unknown languages and per-run envs are refused", async () => {
    const sbx = await create();
    await sbx.runCode("1", { language: "js" });
    expect(world.called("interpreter.run")[0]![1]).toMatchObject({ language: "javascript" });
    for (const language of ["bash", "r", "typescript", "java", "go"]) {
      await sbx.runCode("1", { language });
      expect(world.called("interpreter.run").at(-1)![1]).toMatchObject({ language });
      const context = await sbx.createCodeContext({ language });
      expect(context.language).toBe(language);
    }
    expect(await sbx.runCode("1", { language: "cobol" }).catch((e: unknown) => e)).toBeInstanceOf(
      NotSupportedError,
    );
    expect(await sbx.runCode("1", { envs: { A: "1" } }).catch((e: unknown) => e)).toBeInstanceOf(
      NotSupportedError,
    );
  });

  test("the sandbox's envs are Runtime's, so code in any context, from any client, has them", async () => {
    const sbx = await create({ TOKEN: "t" });
    expect(world.called("sandboxes.create").at(-1)![0]).toMatchObject({ env: { TOKEN: "t" } });
    await sbx.runCode("import os");
    const again = await Sandbox.connect(sbx.sandboxId, { runtime: { client: world.client() } });
    await again.runCode("os.environ['TOKEN']");
    // No context is made to carry them: the default one already has them.
    expect(world.called("contexts.create")).toEqual([]);
    expect(world.called("interpreter.run").map(([, options]) => options)).toMatchObject([
      { language: "python", timeoutMs: 0 },
      { language: "python", timeoutMs: 0 },
    ]);
  });
});

describe("code contexts", () => {
  test("create, list, run in, restart and remove", async () => {
    const sbx = await create();
    const context = await sbx.createCodeContext({ language: "javascript", cwd: "/tmp" });
    expect(context).toEqual({ id: "ctx-1", language: "javascript", cwd: "/tmp" });
    expect(await sbx.listCodeContexts()).toEqual([context]);
    await sbx.runCode("x", { context });
    expect(world.called("interpreter.run")[0]![1]).toMatchObject({
      context: "ctx-1",
      timeoutMs: 0,
    });
    await sbx.restartCodeContext(context);
    await sbx.removeCodeContext("ctx-1");
    expect(world.called("contexts.remove")).toEqual([["ctx-1"]]);
    expect(
      await sbx.createCodeContext({ language: "cobol" }).catch((e: unknown) => e),
    ).toBeInstanceOf(NotSupportedError);
  });

  test("defaults to the code interpreter template, which is Runtime's stock image", async () => {
    await create();
    expect(world.called("sandboxes.create")[0]![0]).not.toHaveProperty("image");
  });
});
