import { expect, test } from "bun:test";
import * as codeInterpreter from "../../src/e2b/code-interpreter";
import * as e2b from "../../src/e2b/index";
import { translate } from "../../src/e2b/errors";
import { RuntimeError } from "../../src/errors";

/* Every name `e2b` 2.55.0 and `@e2b/code-interpreter` 2.8.3 export, read from
   their published builds on 9 October 2026 (2.55.0 added DockerfileSyntaxError
   to 2.53.1's). An import of any of them must
   resolve after the switch, or code written for E2B fails to load before it
   runs a line: until then GitAuthError, VolumeError, SecretPaginator and
   eighteen more were missing. */
const E2B_2_55_0 = [
  "ALL_TRAFFIC",
  "ApiClient",
  "AuthenticationError",
  "BuildError",
  "CommandExitError",
  "ConnectionConfig",
  "DockerfileSyntaxError",
  "E2B",
  "FileNotFoundError",
  "FileType",
  "FileUploadError",
  "FilesystemEventType",
  "Git",
  "GitAuthError",
  "GitUpstreamError",
  "InvalidArgumentError",
  "LogEntry",
  "LogEntryEnd",
  "LogEntryStart",
  "NotEnoughSpaceError",
  "NotFoundError",
  "RateLimitError",
  "ReadyCmd",
  "Sandbox",
  "SandboxError",
  "SandboxNotFoundError",
  "SandboxNotRunningError",
  "SandboxUnreachableError",
  "Secret",
  "SecretError",
  "SecretNotFoundError",
  "SecretPaginator",
  "ServiceBusyError",
  "Template",
  "TemplateBase",
  "TemplateError",
  "TimeoutError",
  "Volume",
  "VolumeError",
  "VolumeFileType",
  "VolumeNotFoundError",
  "VolumePathNotFoundError",
  "default",
  "defaultBuildLogger",
  "getSignature",
  "waitForFile",
  "waitForPort",
  "waitForProcess",
  "waitForTimeout",
  "waitForURL",
];
/* The code interpreter's own names, beside everything e2b exports but ALL_TRAFFIC. */
const CODE_INTERPRETER_2_8_3 = E2B_2_55_0.filter((name) => name !== "ALL_TRAFFIC");

test("withruntime/e2b exports every name e2b 2.55.0 does", () => {
  const ours = new Set(Object.keys(e2b));
  expect(E2B_2_55_0.filter((name) => !ours.has(name))).toEqual([]);
});

test("withruntime/e2b/code-interpreter exports every name @e2b/code-interpreter 2.8.3 does", () => {
  const ours = new Set(Object.keys(codeInterpreter));
  expect(CODE_INTERPRETER_2_8_3.filter((name) => !ours.has(name))).toEqual([]);
});

test("the new errors keep E2B's parents, so a catch written for E2B still catches", () => {
  expect(new e2b.GitAuthError("x")).toBeInstanceOf(e2b.AuthenticationError);
  expect(new e2b.GitUpstreamError("x")).toBeInstanceOf(e2b.SandboxError);
  expect(new e2b.FileUploadError("x")).toBeInstanceOf(e2b.BuildError);
  expect(new e2b.VolumeNotFoundError("x")).toBeInstanceOf(e2b.VolumeError);
  expect(new e2b.VolumePathNotFoundError("x")).toBeInstanceOf(e2b.VolumeError);
  expect(new e2b.SecretNotFoundError("x")).toBeInstanceOf(e2b.SecretError);
  expect(e2b.ALL_TRAFFIC).toBe("0.0.0.0/0");
});

for (const name of ["SandboxNotRunningError", "SandboxUnreachableError"] as const) {
  test(`${name} keeps E2B 2.53.1's constructor, parents and cause`, () => {
    const ErrorClass = e2b[name];
    expect(codeInterpreter[name]).toBe(ErrorClass);
    for (const cause of [undefined, null, false, 0, "lost", new Error("socket closed")]) {
      const error = new ErrorClass("unavailable", { cause });
      expect(error).toBeInstanceOf(e2b.TimeoutError);
      expect(error).toBeInstanceOf(e2b.SandboxError);
      expect(error.name).toBe(name);
      expect(error.message).toBe("unavailable");
      expect(error.cause).toBe(cause);
      expect(Object.hasOwn(error, "cause")).toBe(cause !== undefined);
    }
    expect(new ErrorClass("unavailable")).not.toHaveProperty("cause");
  });
}

for (const [code, status, name] of [
  ["sandbox_stopped", 409, "SandboxNotRunningError"],
  ["sandbox_paused", 409, "SandboxNotRunningError"],
  ["sandbox_not_running", 409, "SandboxNotRunningError"],
  ["sandbox_not_ready", 409, "SandboxUnreachableError"],
  ["host_unavailable", 503, "SandboxUnreachableError"],
] as const) {
  test(`${code} maps to ${name}, keeping the server's explanation`, () => {
    const cause = new RuntimeError({
      code,
      status,
      message: "Server explanation",
      hint: "Recovery step",
      requestId: "req-1",
    });
    const error = translate(cause);
    expect(error).toBeInstanceOf(e2b[name]);
    expect(error).toBeInstanceOf(e2b.TimeoutError);
    expect(error).toMatchObject({
      name,
      code,
      statusCode: status,
      hint: "Recovery step",
      requestId: "req-1",
      cause,
      message: "Server explanation\nHint: Recovery step\nRequest: req-1",
    });
  });
}

test("an unknown connection failure, deadline, missing sandbox and disabled feature stay distinct", () => {
  for (const [code, status, name] of [
    ["connection_error", 0, "SandboxError"],
    ["request_failed", 502, "SandboxError"],
    ["command_timeout", 0, "TimeoutError"],
    ["not_found", 404, "SandboxNotFoundError"],
    ["fork_unavailable", 503, "NotSupportedError"],
  ] as const) {
    const cause = new RuntimeError({ code, status, message: "failure" });
    expect(translate(cause, "sandbox")).toMatchObject({ name, cause });
  }
  const original = new TypeError("Failed to fetch");
  expect(translate(original)).toBe(original);
});
