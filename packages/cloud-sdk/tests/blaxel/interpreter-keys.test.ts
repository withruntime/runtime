import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeError } from "../../src/errors";
import * as blaxel from "../../src/blaxel/index";
import {
  CodeInterpreter,
  CredentialsError,
  NotSupportedError,
  ResponseError,
  SandboxGatewayError,
  SandboxInstance,
  initialize,
  isGatewayError,
  isGatewayTimeout,
} from "../../src/blaxel/index";
import { pickKey, resetClients } from "../../src/blaxel/client";
import { translate } from "../../src/blaxel/errors";
import { BlaxelWorld } from "./fake";

let world: BlaxelWorld;
const withruntime = () => ({ client: world.client() });

beforeEach(() => {
  world = new BlaxelWorld();
});

describe("CodeInterpreter", () => {
  test("Blaxel's defaults: the Jupyter image is Runtime's stock image, deleted 30 idle minutes on", async () => {
    const interpreter = await CodeInterpreter.create({
      withruntime: { ...withruntime(), create: { funding: "paid" } },
    });
    expect(interpreter).toBeInstanceOf(CodeInterpreter);
    expect(interpreter).toBeInstanceOf(SandboxInstance);
    expect(world.called("images.list")).toEqual([]);
    expect(world.called("sandbox.retention").at(-1)![1]).toBe(1);
    expect(interpreter.spec.runtime?.ports).toEqual([{ target: 8888, protocol: "HTTP" }]);
    expect(interpreter.spec.runtime?.image).toBe("blaxel/jupyter-server");
  });

  test("runCode runs in Runtime's interpreter and answers Blaxel's Execution", async () => {
    world.interpreter = () => ({
      id: "e1",
      contextId: "python",
      language: "python",
      executionCount: 3,
      status: "ok",
      stdout: "a\nb\n",
      stderr: "",
      results: [{ main: true, data: { "text/plain": "2", "image/png": "iVBOR" }, refs: {} }],
      error: null,
      overflow: [],
      durationMs: 1,
      contextStarted: false,
      lostBytes: 0,
    });
    const interpreter = await CodeInterpreter.create({ withruntime: withruntime() });
    const results: unknown[] = [];
    const execution = await interpreter.runCode("1 + 1", {
      onResult: (result) => void results.push(result),
    });
    expect(world.called("interpreter.run").at(-1)).toEqual([
      "1 + 1",
      { language: "python", timeoutMs: 60_000 },
    ]);
    expect(execution).toBeInstanceOf(CodeInterpreter.Execution);
    expect(execution.logs.stdout).toEqual(["a\n", "b\n"]);
    expect(execution.executionCount).toBe(3);
    expect(execution.results[0]).toMatchObject({ text: "2", png: "iVBOR", is_main_result: true });
    expect(results).toHaveLength(1);
  });

  test("an error in the code is execution.error; a run past its timeout throws Request timeout", async () => {
    world.interpreter = () => ({
      id: "e",
      contextId: "python",
      language: "python",
      executionCount: 1,
      status: "error",
      stdout: "",
      stderr: "",
      results: [],
      error: { name: "ZeroDivisionError", value: "division by zero", traceback: "tb" },
      overflow: [],
      durationMs: 1,
      contextStarted: false,
      lostBytes: 0,
    });
    const interpreter = await CodeInterpreter.create({ withruntime: withruntime() });
    const execution = await interpreter.runCode("1/0");
    expect(execution.error).toEqual(
      new CodeInterpreter.ExecutionError("ZeroDivisionError", "division by zero", "tb"),
    );
    const errored = world.interpreter;
    world.interpreter = (code, options) => ({
      ...errored(code, options),
      status: "timeout",
      error: null,
    });
    expect(
      (
        (await interpreter
          .runCode("while True: pass", { timeout: 1 })
          .catch((e: unknown) => e)) as Error
      ).message,
    ).toBe("Request timeout");
  });

  test("contexts: the sandbox's envs reach them; envs for one run are refused", async () => {
    const interpreter = await CodeInterpreter.create({
      envs: [{ name: "API_URL", value: "https://x" }],
      withruntime: withruntime(),
    });
    const context = await interpreter.createCodeContext({ language: "python", cwd: "/blaxel/app" });
    expect(world.called("contexts.create").at(-1)![0]).toEqual({
      language: "python",
      cwd: "/workspace/app",
      env: { API_URL: "https://x" },
    });
    await interpreter.runCode("x", { context });
    expect(world.called("interpreter.run").at(-1)![1]).toMatchObject({ context: context.id });
    await interpreter.runCode("y");
    await interpreter.runCode("z");
    expect(
      world
        .called("contexts.create")
        .filter(([input]) => (input as { id?: string }).id === "blaxel-python"),
    ).toHaveLength(1);
    expect(world.called("interpreter.run").at(-1)![1]).toMatchObject({ context: "blaxel-python" });
    expect(
      await interpreter.runCode("a", { envs: { A: "1" } }).catch((e: unknown) => e),
    ).toBeInstanceOf(NotSupportedError);
    expect(
      await interpreter.runCode("a", { language: "cobol" }).catch((e: unknown) => e),
    ).toBeInstanceOf(NotSupportedError);
    expect(
      (
        (await interpreter
          .runCode("a", { language: "python", context })
          .catch((e: unknown) => e)) as Error
      ).message,
    ).toContain("not both");
  });

  test("a code interpreter from a fresh client reads the sandbox's envs from the sandbox", async () => {
    await CodeInterpreter.create({
      name: "ci",
      envs: [{ name: "TOKEN", value: "t'1" }],
      withruntime: withruntime(),
    });
    const [, options] = world.called("sandbox.exec")[0]!;
    const fresh = await CodeInterpreter.get("ci", { withruntime: withruntime() });
    world.sandboxes
      .get(fresh.withruntime.id)!
      .fileMap.set(
        "/etc/runtime-blaxel/env",
        new TextEncoder().encode((options as { stdin: string }).stdin),
      );
    await fresh.runCode("import os");
    expect(world.called("contexts.create").at(-1)![0]).toEqual({
      id: "blaxel-python",
      language: "python",
      env: { TOKEN: "t'1" },
    });
  });
});

describe("keys", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetClients();
  });

  test("a Blaxel key is never sent; a Runtime key in BL_API_KEY is used", () => {
    delete process.env.RUNTIME_API_KEY;
    process.env.BL_API_KEY = "bl_abc";
    expect(pickKey()).toBeUndefined();
    process.env.BL_API_KEY = "rtcloud_in_bl";
    expect(pickKey()).toBe("rtcloud_in_bl");
    process.env.RUNTIME_API_KEY = "rtcloud_env";
    expect(pickKey()).toBe("rtcloud_env");
  });

  test("initialize takes a Runtime key and refuses a Blaxel one", () => {
    delete process.env.RUNTIME_API_KEY;
    expect(() => initialize({ apikey: "bl_secret", workspace: "w" })).toThrow(CredentialsError);
    initialize({ apikey: "rtcloud_given" });
    expect(pickKey()).toBe("rtcloud_given");
    expect(() => initialize({ clientCredentials: "x" })).toThrow(NotSupportedError);
  });

  test("no Runtime key at all is Blaxel's CredentialsError, saying the Blaxel key was not sent", () => {
    const error = translate(
      new RuntimeError({ message: "No Runtime key found", code: "missing_api_key", status: 0 }),
    );
    expect(error).toBeInstanceOf(CredentialsError);
    expect((error as Error).message).toContain("BL_API_KEY");
  });
});

describe("errors", () => {
  test("Runtime's errors as Blaxel's, carrying Runtime's code, hint and request id", () => {
    const notFound = translate(
      new RuntimeError({
        message: "No sandbox.",
        code: "not_found",
        status: 404,
        hint: "Check.",
        requestId: "req_9",
      }),
    ) as ResponseError;
    expect(notFound).toBeInstanceOf(ResponseError);
    expect([
      notFound.status,
      notFound.code,
      notFound.runtimeCode,
      notFound.hint,
      notFound.requestId,
    ]).toEqual([404, 404, "not_found", "Check.", "req_9"]);
    expect(notFound.data).toMatchObject({ code: "not_found" });
    expect(notFound.message).toContain("Request: req_9");
    const busy = translate(new RuntimeError({ message: "busy", code: "no_capacity", status: 503 }));
    expect(busy).toBeInstanceOf(SandboxGatewayError);
    expect([isGatewayError(busy), isGatewayTimeout(busy)]).toEqual([true, false]);
    expect(
      isGatewayTimeout(translate(new RuntimeError({ message: "t", code: "timeout", status: 504 }))),
    ).toBe(true);
    const off = translate(
      new RuntimeError({ message: "off", code: "fork_unavailable", status: 503, hint: "Later." }),
    );
    expect(off).toBeInstanceOf(NotSupportedError);
    const plain = new Error("x");
    expect(translate(plain)).toBe(plain);
  });
});

describe("exports", () => {
  const names = JSON.parse(
    readFileSync(join(import.meta.dir, "blaxel-exports.json"), "utf8"),
  ) as string[];

  test("every value @blaxel/core 0.3.23 exports can be imported", () => {
    const missing = names.filter((name) => !(name in blaxel));
    expect(missing).toEqual([]);
    expect(names.length).toBe(262);
  });

  test("the ones Runtime has no counterpart for throw NotSupportedError naming the alternative on use", async () => {
    const stand = blaxel as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of [
      "blModel",
      "blTools",
      "createSandbox",
      "postProcess",
      "VolumeInstance",
      "ImageInstance",
      "SandboxSessions",
    ]) {
      let error: unknown;
      try {
        stand[name]!();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(NotSupportedError);
      expect((error as NotSupportedError).alternative.length).toBeGreaterThan(0);
    }
    const sandbox = await SandboxInstance.create({ withruntime: withruntime() });
    for (const part of [
      sandbox.sessions,
      sandbox.codegen,
      sandbox.schedules,
      sandbox.system,
      sandbox.drives,
    ]) {
      const method = Object.values({
        call: (part as Record<string, () => Promise<never>>).create!,
      })[0]!;
      expect(await method().catch((e: unknown) => e)).toBeInstanceOf(NotSupportedError);
    }
    expect(
      await SandboxInstance.fromSession({
        name: "s",
        url: "u",
        token: "t",
        expiresAt: new Date(),
      }).catch((e: unknown) => e),
    ).toBeInstanceOf(NotSupportedError);
    expect(() => blaxel.settings.baseUrl).toThrow(NotSupportedError);
    expect(blaxel.settings.env).toBe("prod");
  });
});
