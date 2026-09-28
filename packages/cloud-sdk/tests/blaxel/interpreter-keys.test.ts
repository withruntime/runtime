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
    expect(world.called("images.resolve")).toEqual([]);
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

describe("Runtime's words in Blaxel's", () => {
  test("a trial create over the trial's size speaks of Blaxel's memory, keeping code and request id", () => {
    const error = translate(
      new RuntimeError({
        message:
          "A trial sandbox is at most 2 vCPU and 4 GiB: vcpu must be at most 2; memoryMiB must be at most 4096.",
        code: "invalid_trial",
        status: 400,
        hint: "Omit vcpu, memoryMiB, diskMiB and cpu for the default.",
        requestId: "req_t",
      }),
    ) as ResponseError;
    expect(error.message).toBe(
      "Sandbox request failed with status 400: A trial sandbox has at most 4096 MB of memory (2 vCPUs); pass memory 4096 or add credit.\nRequest: req_t",
    );
    expect([error.status, error.runtimeCode, error.hint, error.requestId]).toEqual([
      400,
      "invalid_trial",
      undefined,
      "req_t",
    ]);
  });

  test("hints that name Runtime's calls name Blaxel's", () => {
    const taken = translate(
      new RuntimeError({
        message: "Sandbox x is already named 'a'.",
        code: "name_taken",
        status: 409,
        hint: "Pass getOrCreate: true (Sandbox.getOrCreate in the SDKs) to get that sandbox, woken if it is paused, or choose another name.",
      }),
    ) as ResponseError;
    expect(taken.hint).toBe(
      "SandboxInstance.createIfNotExists({ name }) answers the sandbox that has the name.",
    );
    expect(taken.message).not.toContain("getOrCreate");
    for (const code of ["file_not_found", "path_not_found"]) {
      const missing = translate(
        new RuntimeError({
          message: "No such file.",
          code,
          status: 404,
          hint: "Check the path; list the directory with GET /v1/sandboxes/{id}/files/list?path=... or runtime sandbox files <id> <dir>.",
        }),
      ) as ResponseError;
      expect(missing.hint).toBe("List the directory with sandbox.fs.ls(path).");
      expect(missing.message).not.toContain("/v1/");
    }
    const table: Array<[string, number, string]> = [
      [
        "is_a_directory",
        400,
        "That path is a directory: list it with sandbox.fs.ls(path), or name a file in it.",
      ],
      [
        "cwd_not_found",
        400,
        "Make the directory with sandbox.fs.mkdir(path), or pass an existing workingDir to sandbox.process.exec.",
      ],
      ["sandbox_paused", 409, "Call sandbox.unarchive(), then try again."],
      [
        "not_running",
        409,
        "The sandbox is not running: call sandbox.unarchive() if it was archived, or make a new one with SandboxInstance.create if it was deleted.",
      ],
      [
        "trial_busy",
        429,
        "The trial's sandboxes are all in use: delete one you no longer need (sandbox.delete()) or archive it (sandbox.archive()), then try again. Moving to paid credit is the account owner's decision.",
      ],
      [
        "public_preview_not_allowed",
        403,
        "On the trial, share the port privately: sandbox.previews.create({ metadata: { name }, spec: { port, public: false } }) and a token from preview.tokens.create(expiresAt). A public preview needs a paid sandbox, which is the account owner's decision.",
      ],
      ["busy", 409, "Try again in a moment."],
      ["guest_busy", 429, "Try again in a moment."],
      ["rate_limited", 429, "Try again in a moment."],
      [
        "unauthorized",
        401,
        "Set RUNTIME_API_KEY to a Runtime key (https://withruntime.com/account/keys), or run `npx withruntime login` once. A Blaxel key (BL_API_KEY) is never sent.",
      ],
    ];
    for (const [code, status, hint] of table) {
      const out = translate(
        new RuntimeError({
          message: "Refused.",
          code,
          status,
          hint: "Runtime's own hint: POST /v1/sandboxes/{id}:wake, the x-runtime-preview-token header, Idempotency-Key.",
          requestId: "req_h",
        }),
      ) as ResponseError;
      expect([out.status, out.runtimeCode, out.requestId, out.hint]).toEqual([
        status,
        code,
        "req_h",
        hint,
      ]);
      expect(out.message).toBe(
        `Sandbox request failed with status ${status}: Refused.\nHint: ${hint}\nRequest: req_h`,
      );
      expect(out.message).not.toMatch(
        /\/v1\/|x-runtime|Idempotency-Key|visibility|urlWithToken|:wake/,
      );
    }
    const other = translate(
      new RuntimeError({
        message: "No.",
        code: "quota_exceeded",
        status: 429,
        hint: "Stop something.",
      }),
    ) as ResponseError;
    expect(other.hint).toBe("Stop something.");
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
    for (const part of [sandbox.codegen, sandbox.schedules, sandbox.system, sandbox.drives]) {
      const method = Object.values({
        call: (part as Record<string, () => Promise<never>>).create!,
      })[0]!;
      expect(await method().catch((e: unknown) => e)).toBeInstanceOf(NotSupportedError);
    }
    // A session Runtime did not make (Blaxel's own) is refused, never sent.
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
